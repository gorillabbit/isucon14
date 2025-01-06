import type { Connection, RowDataPacket } from "mysql2/promise";
import type { Ride, RideStatus } from "./types/models.js";
import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import { ulid } from "ulid";

export const INITIAL_FARE = 500;
export const FARE_PER_DISTANCE = 100;

// マンハッタン距離を求める
export const calculateDistance = (
  aLatitude: number,
  aLongitude: number,
  bLatitude: number,
  bLongitude: number,
): number => {
  return Math.abs(aLatitude - bLatitude) + Math.abs(aLongitude - bLongitude);
};

export const calculateFare = (
  pickupLatitude: number,
  pickupLongitude: number,
  destLatitude: number,
  destLongitude: number,
): number => {
  const meterdFare =
    FARE_PER_DISTANCE *
    calculateDistance(
      pickupLatitude,
      pickupLongitude,
      destLatitude,
      destLongitude,
    );
  return INITIAL_FARE + meterdFare;
};

export const calculateSale = (ride: Ride): number => {
  return calculateFare(
    ride.pickup_latitude,
    ride.pickup_longitude,
    ride.destination_latitude,
    ride.destination_longitude,
  );
};

export class ErroredUpstream extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroredUpstream";
  }
}

export const updateLatestRideStatus = async (ctx: Context<Environment>, new_status: string, rideId: string) => {
  await ctx.var.dbConn.query(
    "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
    [ulid(), rideId, new_status],
  );
  await ctx.var.dbConn.query(
    "UPDATE rides SET latest_status = ? WHERE id = ?",
    [new_status, rideId],
  );
}