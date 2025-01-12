import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, Ride } from "./types/models.js";
import { calculateDistance } from "./common.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  try {
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE chair_id IS NULL",
    );
    if (rides.length < 1) {
      return ctx.body(null, 204);
    }
    const [matched] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
      `
WITH latest_locations AS (
    SELECT chair_id, latitude, longitude
    FROM chair_locations
    WHERE (chair_id, created_at) IN (
        SELECT chair_id, MAX(created_at)
        FROM chair_locations
        GROUP BY chair_id
    )
),
incomplete_rides AS (
    SELECT DISTINCT r.chair_id
    FROM rides r
    WHERE r.latest_status != 'COMPLETED'
)
SELECT c.id, cm.speed, ll.latitude, ll.longitude
FROM chairs c
INNER JOIN chair_models cm ON c.model = cm.name
LEFT JOIN latest_locations ll ON ll.chair_id = c.id
WHERE c.is_active = TRUE
AND NOT EXISTS (
    SELECT 1
    FROM incomplete_rides ir
    WHERE ir.chair_id = c.id
)
      `,
    );
    if (matched.length < 1) {
      return ctx.body(null, 204);
    }
    let i = 0;
    const used_chairs: String[] = [];
    for (const ride of rides) {
      let fastest_chiar = { id: "", time: Infinity };
      for (const match of matched) {
        if (used_chairs.includes(match.id)) {
          continue;
        }
        const distant_1 = calculateDistance(
          match.latitude,
          match.longitude,
          ride.pickup_latitude,
          ride.pickup_longitude,
        );
        const distant_2 = calculateDistance(
          ride.destination_latitude,
          ride.destination_longitude,
          ride.pickup_latitude,
          ride.pickup_longitude,
        );
        const time = (distant_1 + distant_2) / match.speed;
        if (fastest_chiar.time > time) {
          (fastest_chiar.id = match.id), (fastest_chiar.time = time);
        }
      }
      if (fastest_chiar.id) {
        await ctx.var.dbConn.query(
          "UPDATE rides SET chair_id = ? WHERE id = ?",
          [fastest_chiar.id, ride.id],
        );
        used_chairs.push(fastest_chiar.id);
        i++;
      } else {
        break;
      }
    }
    console.log(`##### matched ${i} rides #####`);
    return ctx.body(null, 204);
  } catch (error) {
    console.log(error);
    return ctx.text(`Internal Server Error\n${error}`, 500);
  }
};
