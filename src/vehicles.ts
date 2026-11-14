// Vehicles in a round (Dustline Ridge): who sits where is decided here; how a vehicle moves comes from
// the client that simulates it (its `owner`: whoever drives it, or the last driver until it reports
// the vehicle at rest). Poses are bounded like player poses, with their own speed limit.
//
// Messages (MatchRoom wires them): `enter { v, s }` (vehicle id, seat), `exit`, `vpose { v, x, y, z,
// qx, qy, qz, qw, vx, vy, vz, st, r }` (r = at rest: the owner lets go once nobody drives it).
import { MapSchema, ArraySchema } from "@colyseus/schema";

import { VehicleState, type MatchState, type PlayerState } from "./rooms/schema/MatchState.js";
import { VEHICLE_ENTER_RANGE, VEHICLE_MAX_SPEED, VEHICLE_SLACK, WORLD_BOUND } from "./constants.js";
import { VEHICLE_SPAWNS, VEHICLE_TYPES, type WorldId } from "./rules.js";

export const PARKED_Y = -100; // VehicleState.y before its first pose: on the ground at its spawn

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Server-side bookkeeping per vehicle (never synced).
export interface VehicleMeta {
  spawn: { x: number; z: number };
  at: number; // ms of the last accepted pose
  x: number;
  z: number;
}

export class Vehicles {
  meta = new Map<string, VehicleMeta>();
  constructor(private state: MatchState) {}

  // The round's vehicles for `world` (everyone unseated first).
  spawn(world: WorldId) {
    this.clear();
    for (const sp of VEHICLE_SPAWNS[world] ?? []) {
      const v = new VehicleState();
      v.type = sp.type;
      v.x = sp.x;
      v.z = sp.z;
      v.y = PARKED_Y;
      v.qy = Math.sin(sp.yaw / 2);
      v.qw = Math.cos(sp.yaw / 2);
      v.seats = new ArraySchema<string>(...Array.from({ length: VEHICLE_TYPES[sp.type]?.seats ?? 1 }, () => ""));
      this.state.vehicles.set(sp.id, v);
      this.meta.set(sp.id, { spawn: { x: sp.x, z: sp.z }, at: 0, x: sp.x, z: sp.z });
    }
  }

  clear() {
    for (const p of this.state.players.values()) {
      p.veh = "";
      p.seat = -1;
    }
    this.state.vehicles.clear();
    this.meta.clear();
  }

  // Gets `sid` into seat `s` of vehicle `id` (alive, in the round, close enough, the seat free).
  enter(sid: string, p: PlayerState, id: unknown, s: unknown): boolean {
    if (typeof id !== "string") return false;
    const v = this.state.vehicles.get(id);
    const seat = num(s);
    if (!v || seat === null || !Number.isInteger(seat) || seat < 0 || seat >= v.seats.length) return false;
    if (p.life !== "alive" || !p.inMatch || !p.team || p.veh) return false;
    if (v.seats[seat]) return false;
    if (Math.hypot(p.x - v.x, p.z - v.z) > VEHICLE_ENTER_RANGE) return false;
    v.seats[seat] = sid;
    p.veh = id;
    p.seat = seat;
    if (seat === 0) v.owner = sid; // the driver's client simulates it from now on
    return true;
  }

  // Out of whatever `sid` sits in (exit, knocked, eliminated, respawned, left). The owner keeps
  // simulating a vehicle it got out of until it reports it at rest.
  eject(sid: string) {
    const p = this.state.players.get(sid);
    if (p) {
      const v = p.veh ? this.state.vehicles.get(p.veh) : undefined;
      if (v && p.seat >= 0 && p.seat < v.seats.length && v.seats[p.seat] === sid) v.seats[p.seat] = "";
      p.veh = "";
      p.seat = -1;
    }
    // Belt and braces: no seat anywhere still names them.
    for (const v of this.state.vehicles.values()) for (let i = 0; i < v.seats.length; i++) if (v.seats[i] === sid) v.seats[i] = "";
  }

  // `sid` is gone from the round: out of its seat, and it no longer simulates anything (a vehicle with
  // nobody simulating it stays where it last was until someone drives it).
  release(sid: string) {
    this.eject(sid);
    for (const v of this.state.vehicles.values()) if (v.owner === sid) v.owner = v.seats[0] || "";
  }

  // A pose from the vehicle's owner. Returns false when refused (not the owner, out of bounds, too fast).
  pose(sid: string, msg: any): boolean {
    if (!msg || typeof msg.v !== "string") return false;
    const v = this.state.vehicles.get(msg.v);
    const m = this.meta.get(msg.v);
    if (!v || !m || v.owner !== sid) return false;
    const x = num(msg.x), y = num(msg.y), z = num(msg.z);
    const qx = num(msg.qx), qy = num(msg.qy), qz = num(msg.qz), qw = num(msg.qw);
    if (x === null || y === null || z === null || qx === null || qy === null || qz === null || qw === null) return false;
    if (Math.abs(x) > WORLD_BOUND || Math.abs(z) > WORLD_BOUND || y < -60 || y > 300) return false;
    const ql = Math.hypot(qx, qy, qz, qw);
    if (ql < 0.5 || ql > 1.5) return false;
    const now = Date.now();
    if (m.at) {
      const dt = Math.max(0.05, (now - m.at) / 1000);
      const moved = Math.hypot(x - m.x, z - m.z);
      // Too fast, unless it was put back at its own spawn (it fell off the world).
      const home = Math.hypot(x - m.spawn.x, z - m.spawn.z) < 4;
      if (moved > VEHICLE_MAX_SPEED * dt + VEHICLE_SLACK && !home) return false;
    }
    m.at = now;
    m.x = x;
    m.z = z;
    v.x = x;
    v.y = y;
    v.z = z;
    v.qx = qx / ql;
    v.qy = qy / ql;
    v.qz = qz / ql;
    v.qw = qw / ql;
    const clampV = (n: number | null) => (n === null ? 0 : Math.max(-80, Math.min(80, n)));
    v.vx = clampV(num(msg.vx));
    v.vy = clampV(num(msg.vy));
    v.vz = clampV(num(msg.vz));
    v.steer = Math.max(-1, Math.min(1, num(msg.st) ?? 0));
    v.n = (v.n + 1) & 0xffff;
    // At rest with nobody driving: the owner lets go; every client keeps it parked there.
    if (msg.r === 1 && !v.seats[0]) v.owner = "";
    return true;
  }
}

export type VehicleMap = MapSchema<VehicleState>;
