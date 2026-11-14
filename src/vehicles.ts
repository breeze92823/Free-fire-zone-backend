// Vehicles in a round (Dustline Ridge): who sits where is decided here; how a vehicle moves comes from
// the client that simulates it (its `owner`: whoever drives it, or the last driver until it reports
// the vehicle at rest). Poses are bounded like player poses, with their own speed limit.
//
// Messages (MatchRoom wires them): `enter { v, s }` (vehicle id, seat), `exit`, `vpose { v, x, y, z,
// qx, qy, qz, qw, vx, vy, vz, st, r }` (r = at rest: the owner lets go once nobody drives it).
//
// Health: bullets, blasts and sticky charges hurt it (MatchRoom works out how much: VEHICLE_DAMAGE);
// below burnBelow it burns down on its own; at 0 it is a wreck (MatchRoom blows it up: everyone
// seated is thrown out and hurt) and after VEHICLE_DAMAGE.respawn s a new one is parked at its spawn.
import { MapSchema, ArraySchema } from "@colyseus/schema";

import { VehicleState, type MatchState, type PlayerState } from "./rooms/schema/MatchState.js";
import { VEHICLE_ENTER_RANGE, VEHICLE_MAX_SPEED, VEHICLE_SLACK, WORLD_BOUND } from "./constants.js";
import { VEHICLE_DAMAGE, VEHICLE_PARKING, VEHICLE_SPAWNS, VEHICLE_TYPES, type WorldId } from "./rules.js";

export const PARKED_Y = -100; // VehicleState.y before its first pose: on the ground at its spawn

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Server-side bookkeeping per vehicle (never synced).
export interface VehicleMeta {
  home: { x: number; z: number; yaw: number }; // its camp spot (VEHICLE_SPAWNS)
  spawn: { x: number; z: number; yaw: number }; // where this one was parked (home, or a VEHICLE_PARKING spot)
  at: number; // ms of the last accepted pose
  x: number;
  z: number;
  lastHitBy: string; // sessionId of the last player who hurt it (credited if it burns down)
  respawnAt: number; // round clock a wreck is replaced (0 = not a wreck)
}

export class Vehicles {
  meta = new Map<string, VehicleMeta>();
  private world: WorldId = "coral";
  constructor(private state: MatchState) {}

  // The round's vehicles for `world` (everyone unseated first).
  spawn(world: WorldId) {
    this.clear();
    this.world = world;
    for (const sp of VEHICLE_SPAWNS[world] ?? []) {
      const v = new VehicleState();
      v.type = sp.type;
      v.seats = new ArraySchema<string>(...Array.from({ length: VEHICLE_TYPES[sp.type]?.seats ?? 1 }, () => ""));
      this.state.vehicles.set(sp.id, v);
      const home = { x: sp.x, z: sp.z, yaw: sp.yaw };
      this.meta.set(sp.id, { home, spawn: home, at: 0, x: sp.x, z: sp.z, lastHitBy: "", respawnAt: 0 });
      this.park(sp.id);
    }
  }

  // A new vehicle at `spot` (default: where the last one was parked): parked, full health, nobody in
  // it or simulating it.
  private park(id: string, spot?: { x: number; z: number; yaw: number }) {
    const v = this.state.vehicles.get(id);
    const m = this.meta.get(id);
    if (!v || !m) return;
    if (spot) m.spawn = spot;
    for (const p of this.state.players.values()) if (p.veh === id) (p.veh = ""), (p.seat = -1);
    v.x = m.spawn.x;
    v.z = m.spawn.z;
    v.y = PARKED_Y;
    v.qx = 0;
    v.qz = 0;
    v.qy = Math.sin(m.spawn.yaw / 2);
    v.qw = Math.cos(m.spawn.yaw / 2);
    v.vx = v.vy = v.vz = 0;
    v.steer = 0;
    v.owner = "";
    for (let i = 0; i < v.seats.length; i++) v.seats[i] = "";
    v.hp = VEHICLE_TYPES[v.type]?.hp ?? 1000;
    v.wreck = false;
    v.n = (v.n + 1) & 0xffff;
    m.at = 0;
    m.x = m.spawn.x;
    m.z = m.spawn.z;
    m.lastHitBy = "";
    m.respawnAt = 0;
  }

  // Where it is for hit checks; `parked`: never moved (y unknown: compare horizontally).
  where(id: string): { x: number; y: number; z: number; parked: boolean } | null {
    const v = this.state.vehicles.get(id);
    if (!v) return null;
    return { x: v.x, y: v.y, z: v.z, parked: v.y === PARKED_Y };
  }

  // The mounted gun `p` mans (its seat is its vehicle's gunner seat), or "".
  mountOf(p: PlayerState): string {
    const v = p.veh ? this.state.vehicles.get(p.veh) : undefined;
    const type = v ? VEHICLE_TYPES[v.type] : undefined;
    return type?.mount && type.gunSeat === p.seat && !v!.wreck ? type.mount : "";
  }

  // May a player of `team` (session `sid`) hurt vehicle `id`? Not a wreck, not one they sit in, and
  // nobody on their own side sits in it (empty vehicles are anyone's target).
  canHurt(id: string, team: string, sid: string): boolean {
    const v = this.state.vehicles.get(id);
    if (!v || v.wreck) return false;
    for (const s of v.seats) {
      if (!s) continue;
      if (s === sid || this.state.players.get(s)?.team === team) return false;
    }
    return true;
  }

  // Takes `amount` off its health; true when that destroyed it (MatchRoom then blows it up).
  damage(id: string, amount: number, by: string | null, clock: number): boolean {
    const v = this.state.vehicles.get(id);
    const m = this.meta.get(id);
    if (!v || !m || v.wreck || !(amount > 0)) return false;
    if (by) m.lastHitBy = by;
    v.hp = Math.max(0, v.hp - amount);
    if (v.hp > 0) return false;
    v.wreck = true;
    m.respawnAt = clock + VEHICLE_DAMAGE.respawn;
    return true;
  }

  // Where a wreck's replacement goes: of its home spot and the world's VEHICLE_PARKING spots, those
  // inside the zone (`inZone`) and clear of other vehicles, the nearest to home; with none inside,
  // the one deepest in the zone.
  private respawnSpot(id: string, inZone: (x: number, z: number) => number) {
    const m = this.meta.get(id)!;
    const clear = (x: number, z: number) => {
      for (const [oid, o] of this.state.vehicles) if (oid !== id && Math.hypot(o.x - x, o.z - z) < 8) return false;
      return true;
    };
    let best = m.home;
    let score = Infinity;
    for (const sp of [m.home, ...(VEHICLE_PARKING[this.world] ?? [])]) {
      if (!clear(sp.x, sp.z)) continue;
      const out = inZone(sp.x, sp.z); // m outside the zone's edge (negative inside)
      const s = out < -12 ? Math.hypot(sp.x - m.home.x, sp.z - m.home.z) : 1e6 + out;
      if (s < score) {
        score = s;
        best = sp;
      }
    }
    return best;
  }

  // Once per server tick in a round: burning vehicles lose health (returns those that just burnt
  // out, with who to credit) and wrecks past their time are replaced (inside the zone: `inZone`
  // gives how far (m) a point is outside its edge).
  tick(dt: number, clock: number, inZone: (x: number, z: number) => number = () => -1e9): { id: string; by: string }[] {
    const out: { id: string; by: string }[] = [];
    for (const [id, v] of this.state.vehicles) {
      const m = this.meta.get(id);
      if (!m) continue;
      if (v.wreck) {
        if (m.respawnAt && clock >= m.respawnAt) {
          this.park(id, this.respawnSpot(id, inZone));
          v.life = (v.life + 1) & 0xff; // a new one: every client rebuilds it
        }
        continue;
      }
      const max = VEHICLE_TYPES[v.type]?.hp ?? 1000;
      if (v.hp < max * VEHICLE_DAMAGE.burnBelow && this.damage(id, max * VEHICLE_DAMAGE.burnRate * dt, null, clock)) out.push({ id, by: m.lastHitBy });
    }
    return out;
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
    if (!v || v.wreck || seat === null || !Number.isInteger(seat) || seat < 0 || seat >= v.seats.length) return false;
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
