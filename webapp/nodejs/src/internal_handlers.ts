import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  // MEMO: 一旦最も待たせているリクエストに適当な空いている椅子マッチさせる実装とする。おそらくもっといい方法があるはず…
  const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id IS NULL"
  );
  console.log(rides);
  if (rides.length < 1) {
    return ctx.body(null, 204);
  }
  for (const ride of rides) {
    let matched!: Chair & RowDataPacket;
    let empty = false;
    for (let i = 0; i < 10; i++) {
      [[matched]] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
        "SELECT * FROM chairs INNER JOIN (SELECT id FROM chairs WHERE is_active = TRUE LIMIT 1) AS tmp ON chairs.id = tmp.id LIMIT 1"
      );
      console.log(matched);
      if (!matched) {
        return ctx.body(null, 204);
      }
      const [[result]] = await ctx.var.dbConn.query<
        Array<{ "COUNT(*) = 0": number } & RowDataPacket>
      >(
        "SELECT COUNT(*) = 0 FROM (SELECT COUNT(chair_sent_at) = 6 AS completed FROM ride_statuses WHERE ride_id IN (SELECT id FROM rides WHERE chair_id = ?) GROUP BY ride_id) is_completed WHERE completed = FALSE",
        [matched.id]
      );
      empty = !!result["COUNT(*) = 0"];
      if (empty) {
        break;
      }
    }
    if (!empty) {
      return ctx.body(null, 204);
    }
    console.log(ride.id);
    await ctx.var.dbConn.query("UPDATE rides SET chair_id = ? WHERE id = ?", [
      matched.id,
      ride.id,
    ]);
  }
  return ctx.body(null, 204);
};
