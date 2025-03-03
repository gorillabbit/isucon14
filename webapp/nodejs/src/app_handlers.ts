import { ulid } from "ulid";
import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import { secureRandomStr } from "./utils/random.js";
import type {
  RowDataPacket,
  Connection,
} from "mysql2/promise";
import type {
  PaymentToken,
  Chair,
  Coordinate,
  Coupon,
  Ride,
  RideStatus,
  User,
  ChairLocation,
} from "./types/models.js";
import { setCookie } from "hono/cookie";
import {
  calculateDistance,
  calculateFare,
  ErroredUpstream,
  FARE_PER_DISTANCE,
  INITIAL_FARE,
  updateLatestRideStatus,
} from "./common.js";
import { requestPaymentGatewayPostPayment } from "./payment_gateway.js";
import { atoi } from "./utils/integer.js";

type AppPostUserRequest = Readonly<{
  username: string;
  firstname: string;
  lastname: string;
  date_of_birth: string;
  invitation_code: string;
}>;

export const appPostUsers = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<AppPostUserRequest>();
  if (
    reqJson.username === "" ||
    reqJson.firstname === "" ||
    reqJson.lastname === "" ||
    reqJson.date_of_birth === ""
  ) {
    return ctx.text(
      "required fields(username, firstname, lastname, date_of_birth) are empty",
      400,
    );
  }
  const userId = ulid();
  const accessToken = secureRandomStr(32);
  const invitationCode = secureRandomStr(15);
  await ctx.var.dbConn.beginTransaction();
  try {
    await ctx.var.dbConn.query(
      "INSERT INTO users (id, username, firstname, lastname, date_of_birth, access_token, invitation_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        reqJson.username,
        reqJson.firstname,
        reqJson.lastname,
        reqJson.date_of_birth,
        accessToken,
        invitationCode,
      ],
    );

    // 初回登録キャンペーンのクーポンを付与
    await ctx.var.dbConn.query(
      "INSERT INTO coupons (user_id, code, discount) VALUES (?, ?, ?)",
      [userId, "CP_NEW2024", 3000],
    );

    // 招待コードを使った登録
    if (reqJson.invitation_code) {
      // 招待する側の招待数をチェック
      const [coupons] = await ctx.var.dbConn.query<
        Array<Coupon & RowDataPacket>
      >(
        "SELECT * FROM coupons WHERE code = ? FOR UPDATE",
        `INV_${reqJson.invitation_code}`,
      );
      if (coupons.length >= 3) {
        return ctx.text("この招待コードは使用できません。", 400);
      }

      // ユーザーチェック
      const [inviter] = await ctx.var.dbConn.query<Array<User & RowDataPacket>>(
        "SELECT * FROM users WHERE invitation_code = ?",
        [reqJson.invitation_code],
      );
      if (inviter.length === 0) {
        return ctx.text("この招待コードは使用できません。", 400);
      }

      // 招待クーポン付与 & 招待した人にもRewardを付与
      await ctx.var.dbConn.query(
        `INSERT INTO coupons (user_id, code, discount) 
        VALUES 
        (?, ?, ?), 
        (?, CONCAT(?, '_', FLOOR(UNIX_TIMESTAMP(NOW(3))*1000)), ?)
        `,
        [
          userId,
          `INV_${reqJson.invitation_code}`,
          1500,
          inviter[0].id,
          `RWD_${reqJson.invitation_code}`,
          1000,
        ],
      );
    }

    await ctx.var.dbConn.commit();
    setCookie(ctx, "app_session", accessToken, {
      path: "/",
    });

    return ctx.json(
      {
        id: userId,
        invitation_code: invitationCode,
      },
      201,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostPaymentMethods = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{ token: string }>();
  if (reqJson.token === "") {
    return ctx.text("token is required but was empty", 400);
  }
  const user = ctx.var.user;
  await ctx.var.dbConn.query(
    "INSERT INTO payment_tokens (user_id, token) VALUES (?, ?)",
    [user.id, reqJson.token],
  );
  return ctx.body(null, 204);
};

type GetAppRidesResponseItem = {
  id: string;
  pickup_coordinate: Coordinate;
  destination_coordinate: Coordinate;
  chair: {
    id: string;
    owner: string;
    name: string;
    model: string;
  };
  fare: number;
  evaluation: number | null;
  requested_at: number;
  completed_at: number;
};

export const appGetRides = async (ctx: Context<Environment>) => {
  const user = ctx.var.user;
  await ctx.var.dbConn.beginTransaction();
  const items: GetAppRidesResponseItem[] = [];
  try {
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      `
      SELECT 
          r.*, 
          c.id as chair_id,
          c.name as chair_name,
          c.model as chair_model,
          o.name as owner_name
      FROM 
          rides r
      INNER JOIN chairs c ON r.chair_id = c.id
      INNER JOIN owners o ON c.owner_id = o.id
      WHERE r.user_id = ?
      AND r.latest_status = 'COMPLETED'
      ORDER BY r.created_at DESC
      `,
      [user.id],
    );
    for (const ride of rides) {
      const fare = await calculateDiscountedFare(
        ctx.var.dbConn,
        user.id,
        ride,
        ride.pickup_latitude,
        ride.pickup_longitude,
        ride.destination_latitude,
        ride.destination_longitude,
      );
      const item = {
        id: ride.id,
        pickup_coordinate: {
          latitude: ride.pickup_latitude,
          longitude: ride.pickup_longitude,
        },
        destination_coordinate: {
          latitude: ride.destination_latitude,
          longitude: ride.destination_longitude,
        },
        fare,
        evaluation: ride.evaluation,
        requested_at: ride.created_at.getTime(),
        completed_at: ride.updated_at.getTime(),
        chair: {
          id: ride.chair_id,
          name: ride.chair_name,
          model: ride.chair_model,
          owner: ride.owner_name,
        },
      };
      items.push(item);
    }
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        rides: items,
      },
      200,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRides = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{
    pickup_coordinate: Coordinate;
    destination_coordinate: Coordinate;
  }>();
  if (!reqJson.pickup_coordinate || !reqJson.destination_coordinate) {
    return ctx.text(
      "required fields(pickup_coordinate, destination_coordinate) are empty",
      400,
    );
  }
  const user = ctx.var.user;
  const rideId = ulid();
  await ctx.var.dbConn.beginTransaction();
  try {
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      `
      SELECT r.*
      FROM rides r
      WHERE r.user_id = ?`,
      [user.id],
    );
    let continuingRideCount = 0;
    for (const ride of rides) {
      if (ride.latest_status !== "COMPLETED") {
        continuingRideCount++;
      }
    }
    if (continuingRideCount > 0) {
      return ctx.text("ride already exists", 409);
    }
    await ctx.var.dbConn.query(
      `INSERT INTO rides (id, user_id, pickup_latitude, pickup_longitude, destination_latitude, destination_longitude) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        rideId,
        user.id,
        reqJson.pickup_coordinate.latitude,
        reqJson.pickup_coordinate.longitude,
        reqJson.destination_coordinate.latitude,
        reqJson.destination_coordinate.longitude,
      ],
    );
    await updateLatestRideStatus(ctx, "MATCHING", rideId);
    const rideCount = rides.length;
    const [allCoupons] = await ctx.var.dbConn.query<
      Array<Coupon & RowDataPacket>
    >("SELECT code FROM coupons WHERE user_id = ? AND used_by IS NULL ORDER BY created_at FOR UPDATE", [user.id]);
    if (rideCount === 1) {
      console.log("##### allCoupons:", allCoupons);
      if (allCoupons.find((coupon) => coupon.code === "CP_NEW2024")) {
        await ctx.var.dbConn.query(
          "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = 'CP_NEW2024'",
          [rideId, user.id],
        );
      } else if (allCoupons.length > 0) {
        await ctx.var.dbConn.query(
          "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = ?",
          [rideId, user.id, allCoupons[0].code],
        );
      }
    } else {
      if (allCoupons.length > 0) {
        await ctx.var.dbConn.query(
          "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = ?",
          [rideId, user.id, allCoupons[0].code],
        );
      }
    }
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ?",
      [rideId],
    );
    const fare = await calculateDiscountedFare(
      ctx.var.dbConn,
      user.id,
      ride,
      reqJson.pickup_coordinate.latitude,
      reqJson.pickup_coordinate.longitude,
      reqJson.destination_coordinate.latitude,
      reqJson.destination_coordinate.longitude,
    );
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        ride_id: rideId,
        fare,
      },
      202,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRidesEstimatedFare = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{
    pickup_coordinate: Coordinate;
    destination_coordinate: Coordinate;
  }>();
  if (!reqJson.pickup_coordinate || !reqJson.destination_coordinate) {
    return ctx.text(
      "required fields(pickup_coordinate, destination_coordinate) are empty",
      400,
    );
  }
  const user = ctx.var.user;
  await ctx.var.dbConn.beginTransaction();
  try {
    const discounted = await calculateDiscountedFare(
      ctx.var.dbConn,
      user.id,
      null,
      reqJson.pickup_coordinate.latitude,
      reqJson.pickup_coordinate.longitude,
      reqJson.destination_coordinate.latitude,
      reqJson.destination_coordinate.longitude,
    );
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        fare: discounted,
        discount:
          calculateFare(
            reqJson.pickup_coordinate.latitude,
            reqJson.pickup_coordinate.longitude,
            reqJson.destination_coordinate.latitude,
            reqJson.destination_coordinate.longitude,
          ) - discounted,
      },
      200,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRideEvaluatation = async (ctx: Context<Environment>) => {
  const rideId = ctx.req.param("ride_id");
  const reqJson = await ctx.req.json<{ evaluation: number }>();
  if (reqJson.evaluation < 1 || reqJson.evaluation > 5) {
    return ctx.text("evaluation must be between 1 and 5", 400);
  }
  await ctx.var.dbConn.beginTransaction();
  try {
    let [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      ` SELECT 
        r.*
      FROM 
        rides r
      INNER JOIN ride_statuses rs 
        ON r.id = rs.ride_id
      WHERE 
        rs.created_at = (
          SELECT MAX(rs_inner.created_at)
          FROM ride_statuses rs_inner
          WHERE rs_inner.ride_id = r.id
          AND rs_inner.status = 'ARRIVED'
        )
      AND r.id = ?
      `,
      rideId,
    );
    if (!ride) {
      return ctx.text("ride not found", 404);
    }

    await ctx.var.dbConn.query(
      "UPDATE rides SET evaluation = ? WHERE id = ?",
      [reqJson.evaluation, rideId],
    );
    await updateLatestRideStatus(ctx, "COMPLETED", rideId);

    // 更新されたupdate_atを取得するために再取得
    [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ?",
      rideId,
    );
    if (!ride) {
      return ctx.text("ride not found", 404);
    }

    const [[paymentToken]] = await ctx.var.dbConn.query<
      Array<PaymentToken & RowDataPacket>
    >("SELECT token FROM payment_tokens WHERE user_id = ?", [ride.user_id]);
    if (!paymentToken) {
      return ctx.text("payment token not registered", 400);
    }
    const fare = await calculateDiscountedFare(
      ctx.var.dbConn,
      ride.user_id,
      ride,
      ride.pickup_latitude,
      ride.pickup_longitude,
      ride.destination_latitude,
      ride.destination_longitude,
    );

    const [[{ value: paymentGatewayURL }]] = await ctx.var.dbConn.query<
      Array<string & RowDataPacket>
    >("SELECT value FROM settings WHERE name = 'payment_gateway_url'");
    const err = await requestPaymentGatewayPostPayment(
      paymentGatewayURL,
      paymentToken.token,
      { amount: fare },
      async () => {
        const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
          "SELECT * FROM rides WHERE user_id = ? ORDER BY created_at ASC",
          [ride.user_id],
        );
        return rides;
      },
    );
    if (err instanceof ErroredUpstream) {
      console.error(err);
      return ctx.text(`${err}`, 502);
    }
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        completed_at: ride.updated_at.getTime(),
      },
      200,
    );
  } catch (err) {
    await ctx.var.dbConn.rollback();
    console.error(err);
    return ctx.text(`${err}`, 500);
  }
};

type AppGetNotificationResponseData = {
  ride_id: string;
  pickup_coordinate: Coordinate;
  destination_coordinate: Coordinate;
  fare: number;
  status: string;
  chair?: {
    id: string;
    name: string;
    model: string;
    stats: {
      total_rides_count: number;
      total_evaluation_avg: number;
    };
  };
  created_at: number;
  updated_at: number;
};

type AppGetNotificationResponse = {
  data: AppGetNotificationResponseData;
  retry_after_ms?: number;
};

export const appGetNotification = async (ctx: Context<Environment>) => {
  let response: AppGetNotificationResponse;
  const user = ctx.var.user;
  ctx.var.dbConn.beginTransaction();
  try {
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    if (!ride) {
      return ctx.json({ retry_after_ms: 1000 }, 200);
    }
    const [[yetSentRideStatus]] = await ctx.var.dbConn.query<
      Array<RideStatus & RowDataPacket>
    >(
      `
      SELECT * 
      FROM ride_statuses 
      WHERE ride_id = ? 
      AND app_sent_at IS NULL 
      ORDER BY created_at ASC 
      LIMIT 1
      `,
      [ride.id],
    );
    const status = yetSentRideStatus
      ? yetSentRideStatus.status
      : ride.latest_status;

    const fare = await calculateDiscountedFare(
      ctx.var.dbConn,
      user.id,
      ride,
      ride.pickup_latitude,
      ride.pickup_longitude,
      ride.destination_latitude,
      ride.destination_longitude,
    );

    response = {
      data: {
        ride_id: ride.id,
        pickup_coordinate: {
          latitude: ride.pickup_latitude,
          longitude: ride.pickup_longitude,
        },
        destination_coordinate: {
          latitude: ride.destination_latitude,
          longitude: ride.destination_longitude,
        },
        fare,
        status,
        created_at: ride.created_at.getTime(),
        updated_at: ride.updated_at.getTime(),
      },
      retry_after_ms: 1000,
    };
    if (ride.chair_id !== null) {
      const [[chair]] = await ctx.var.dbConn.query<
        Array<Chair & RowDataPacket>
      >("SELECT * FROM chairs WHERE id = ?", [ride.chair_id]);
      const stats = await getChairStats(ctx.var.dbConn, chair.id);
      response.data.chair = {
        id: chair.id,
        name: chair.name,
        model: chair.model,
        stats: {
          total_rides_count: stats.total_rides_count,
          total_evaluation_avg: stats.total_evaluation_avg,
        },
      };
    }

    if (yetSentRideStatus?.id) {
      await ctx.var.dbConn.query(
        "UPDATE ride_statuses SET app_sent_at = CURRENT_TIMESTAMP(6) WHERE id = ?",
        [yetSentRideStatus.id],
      );
    }

    await ctx.var.dbConn.commit();
    return ctx.json(response, 200);
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

type AppGetNotificationResponseChairStats = {
  total_rides_count: number;
  total_evaluation_avg: number;
};

async function getChairStats(
  dbConn: Connection,
  chairId: string,
): Promise<AppGetNotificationResponseChairStats> {
  const [rides] = await dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id = ? ORDER BY updated_at DESC",
    [chairId],
  );

  let totalRidesCount = 0;
  let totalEvaluation = 0.0;
  for (const ride of rides) {
    const [rideStatuses] = await dbConn.query<
      Array<RideStatus & RowDataPacket>
    >("SELECT * FROM ride_statuses WHERE ride_id = ? ORDER BY created_at", [
      ride.id,
    ]);
    let arrivedAt: Date | undefined;
    let pickupedAt: Date | undefined;
    let isCompleted = false;
    for (const status of rideStatuses) {
      if (status.status === "ARRIVED") {
        arrivedAt = status.created_at;
      } else if (status.status === "CARRYING") {
        pickupedAt = status.created_at;
      }
      if (status.status === "COMPLETED") {
        isCompleted = true;
      }
      if (!arrivedAt || !pickupedAt) {
        continue;
      }
      if (!isCompleted) {
        continue;
      }

      totalRidesCount++;
      totalEvaluation += ride.evaluation ?? 0;
    }
  }
  return {
    total_rides_count: totalRidesCount,
    total_evaluation_avg:
      totalRidesCount > 0 ? totalEvaluation / totalRidesCount : 0,
  };
}

export const appGetNearbyChairs = async (ctx: Context<Environment>) => {
  const latStr = ctx.req.query("latitude");
  const lonStr = ctx.req.query("longitude");
  const distanceStr = ctx.req.query("distance");
  if (!latStr || !lonStr) {
    return ctx.text("latitude and longitude is empty", 400);
  }

  const lat = atoi(latStr);
  if (lat === false) {
    return ctx.text("latitude is invalid", 400);
  }
  const lon = atoi(lonStr);
  if (lon === false) {
    return ctx.text("longitude is invalid", 400);
  }

  let distance: number | false = 50;
  if (distanceStr) {
    distance = atoi(distanceStr);
    if (distance === false) {
      return ctx.text("distance is invalid", 400);
    }
  }

  const coordinate: Coordinate = { latitude: lat, longitude: lon };

  await ctx.var.dbConn.beginTransaction();
  try {
    const [chairs] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
      "SELECT * FROM chairs WHERE is_active = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL",
    );
    const nearbyChairs: Array<{
      id: string;
      name: string;
      model: string;
      current_coordinate: Coordinate;
    }> = [];
    for (const chair of chairs) {
      const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
        "SELECT * FROM rides WHERE chair_id = ? AND latest_status != 'COMPLETED' ORDER BY created_at DESC",
        [chair.id],
      );
      if (rides.length !== 0) {
        continue;
      }

      if (
        calculateDistance(
          coordinate.latitude,
          coordinate.longitude,
          chair.latitude,
          chair.longitude,
        ) <= distance
      ) {
        nearbyChairs.push({
          id: chair.id,
          name: chair.name,
          model: chair.model,
          current_coordinate: {
            latitude: chair.latitude,
            longitude: chair.longitude,
          },
        });
      }
    }

    const [[{ "CURRENT_TIMESTAMP(6)": retrievedAt }]] =
      await ctx.var.dbConn.query<
        Array<{ "CURRENT_TIMESTAMP(6)": Date } & RowDataPacket>
      >("SELECT CURRENT_TIMESTAMP(6)");
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        chairs: nearbyChairs,
        retrieved_at: retrievedAt.getTime(),
      },
      200,
    );
  } catch (err) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${err}`, 500);
  }
};

async function calculateDiscountedFare(
  dbConn: Connection,
  userId: string,
  ride: Ride | null,
  _pickupLatitude: number,
  _pickupLongitude: number,
  _destinationLatitude: number,
  _destinationLongitude: number,
): Promise<number> {
  let discount = 0;
  let destinationLatitude = _destinationLatitude;
  let destinationLongitude = _destinationLongitude;
  let pickupLatitude = _pickupLatitude;
  let pickupLongitude = _pickupLongitude;
  if (ride) {
    destinationLatitude = ride.destination_latitude;
    destinationLongitude = ride.destination_longitude;
    pickupLatitude = ride.pickup_latitude;
    pickupLongitude = ride.pickup_longitude;

    // すでにクーポンが紐づいているならそれの割引額を参照
    const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
      "SELECT * FROM coupons WHERE used_by = ?",
      ride.id,
    );
    if (coupon) {
      discount = coupon.discount;
    }
  } else {
    // 初回利用クーポンを最優先で使う
    const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
      "SELECT * FROM coupons WHERE user_id = ? AND code = 'CP_NEW2024' AND used_by IS NULL",
      [userId],
    );
    if (coupon) {
      discount = coupon.discount;
    } else {
      // 無いなら他のクーポンを付与された順番に使う
      const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
        "SELECT * FROM coupons WHERE user_id = ? AND used_by IS NULL ORDER BY created_at LIMIT 1",
        [userId],
      );
      if (coupon) {
        discount = coupon.discount;
      }
    }
  }
  const meteredFare =
    FARE_PER_DISTANCE *
    calculateDistance(
      pickupLatitude,
      pickupLongitude,
      destinationLatitude,
      destinationLongitude,
    );
  const discountedMeteredFare = Math.max(meteredFare - discount, 0);

  return INITIAL_FARE + discountedMeteredFare;
}
