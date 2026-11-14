import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { MAPS, PHASES, VEHICLE_DAMAGE, VEHICLE_PARKING, VEHICLE_SPAWNS, VEHICLE_TYPES, WEAPONS } from "../src/rules.js";
import { TIMING, VEHICLE_MAX_SPEED } from "../src/constants.js";
import { PARKED_Y } from "../src/vehicles.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

const RIDGE = MAPS.findIndex((m) => m.world === "ridge");

// A round on map `map` (everyone votes for it during a slightly longer vote).
async function startRound(colyseus: ColyseusTestServer<typeof appConfig>, map: number, n = 2) {
  const vote = PHASES.vote;
  PHASES.vote = 0.5;
  try {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const clients = [];
    for (let i = 0; i < n; i++) clients.push(await colyseus.connectTo(room, { name: `P${i}` }));
    for (const c of clients) c.send("play", { mode: "squad" });
    await until(() => room.state.phase === "vote", 3000, "vote");
    for (const c of clients) c.send("vote", { map });
    await until(() => room.state.phase === "playing", 4000, "playing");
    return { room, clients };
  } finally {
    PHASES.vote = vote;
  }
}

const pose = (x: number, z: number, y = 4.6) => ({ x, y, z, yaw: 0, pitch: 0, speed: 0, flags: 4, slot: 0 });
const vpose = (v: string, x: number, z: number, extra: any = {}) => ({ v, x, y: 5.3, z, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071, vx: 0, vy: 0, vz: 0, st: 0, ...extra });

describe("vehicles (vehicles.ts)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("parks the world's vehicles at the start of a Dustline Ridge round (none on Coral Key)", async () => {
    const { room } = await startRound(colyseus, RIDGE);
    assert.strictEqual(room.state.map, RIDGE);
    const ids = [...room.state.vehicles.keys()].sort();
    assert.deepStrictEqual(ids, VEHICLE_SPAWNS.ridge.map((s) => s.id).sort());
    const jeep = room.state.vehicles.get("wj")!;
    assert.strictEqual(jeep.type, "jeep");
    assert.strictEqual(jeep.seats.length, 4);
    assert.strictEqual(jeep.y, PARKED_Y, "parked: each client puts it on the ground");
    assert.strictEqual(room.state.vehicles.get("wb")!.seats.length, 2);

    const coral = await startRound(colyseus, 0);
    assert.strictEqual(coral.room.state.vehicles.size, 0);
  });

  it("seats: close enough, one per seat, the driver owns it; exit and knocks get you out", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE, 3);
    const [a, b, c] = clients;
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    // too far
    c.send("pose", pose(-150, 22));
    await sleep(80);
    c.send("enter", { v: "wj", s: 1 });
    await sleep(80);
    assert.strictEqual(room.state.players.get(c.sessionId)!.veh, "", "too far to get in");
    // close: the driver's seat, and ownership
    a.send("pose", pose(-174, 8));
    b.send("pose", pose(-176, 7));
    await sleep(120);
    a.send("enter", { v: "wj", s: 0 });
    await until(() => pa.veh === "wj", 1000, "a seated");
    const jeep = room.state.vehicles.get("wj")!;
    assert.strictEqual(pa.seat, 0);
    assert.strictEqual(jeep.seats[0], a.sessionId);
    assert.strictEqual(jeep.owner, a.sessionId, "the driver simulates it");
    // the same seat is taken; another one is free; a bad seat index is refused
    b.send("enter", { v: "wj", s: 0 });
    b.send("enter", { v: "wj", s: 9 });
    await sleep(80);
    assert.strictEqual(pb.veh, "");
    b.send("enter", { v: "wj", s: 2 });
    await until(() => pb.veh === "wj", 1000, "b seated");
    assert.strictEqual(pb.seat, 2);
    // a seated player may not sit twice
    b.send("enter", { v: "wb", s: 0 });
    await sleep(80);
    assert.strictEqual(room.state.vehicles.get("wb")!.seats[0], "");
    // exit
    b.send("exit");
    await until(() => pb.veh === "", 1000, "b out");
    assert.strictEqual(jeep.seats[2], "");
    // knocked out of the seat (the room's own knock path)
    (room as any).knock(a.sessionId, b.sessionId, {});
    assert.strictEqual(pa.veh, "");
    assert.strictEqual(jeep.seats[0], "");
    assert.strictEqual(jeep.owner, a.sessionId, "the last driver still simulates it until it is at rest");
  });

  it("vehicle poses: only the owner, bounded speed (a fall back to its spawn is allowed), rest lets go", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [a, b] = clients;
    a.send("pose", pose(-175, 8));
    await sleep(80);
    a.send("enter", { v: "wj", s: 0 });
    const jeep = room.state.vehicles.get("wj")!;
    await until(() => jeep.owner === a.sessionId, 1000, "owner");
    // not the owner
    b.send("vpose", vpose("wj", -100, 0));
    await sleep(80);
    assert.strictEqual(jeep.y, PARKED_Y);
    // the owner
    a.send("vpose", vpose("wj", -176, 9.9, { vx: 3, st: 0.4 }));
    await until(() => jeep.y > 0, 1000, "first pose");
    assert.ok(Math.abs(jeep.x + 176) < 1e-3);
    assert.ok(Math.abs(jeep.steer - 0.4) < 1e-3);
    // a jump far faster than VEHICLE_MAX_SPEED is ignored
    a.send("vpose", vpose("wj", -176 + VEHICLE_MAX_SPEED * 3, 9.9));
    await sleep(100);
    assert.ok(Math.abs(jeep.x + 176) < 1e-3, "too fast: not moved");
    // a plausible move is accepted
    await sleep(400);
    a.send("vpose", vpose("wj", -166, 9.9));
    await until(() => Math.abs(jeep.x + 166) < 1e-3, 1000, "moved");
    // fell off the world: put back at its own spawn, far away, is allowed
    a.send("vpose", vpose("wj", 20, 9.9));
    await sleep(100);
    a.send("vpose", vpose("wj", -177, 9.9));
    await until(() => Math.abs(jeep.x + 177) < 1e-3, 1000, "back home");
    // out, then at rest: the owner lets go
    a.send("exit");
    await sleep(80);
    a.send("vpose", vpose("wj", -177, 9.9, { r: 1 }));
    await until(() => jeep.owner === "", 1000, "released");
  });

  it("a seated player's poses may move at vehicle speed; on foot they may not", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [a] = clients;
    const pa = room.state.players.get(a.sessionId)!;
    a.send("pose", pose(-175, 8));
    await sleep(80);
    a.send("enter", { v: "wj", s: 0 });
    await until(() => pa.veh === "wj", 1000, "seated");
    // ~46 m in ~1 s: within a vehicle's limit (45 m/s + 8), over a runner's (32 m/s + 6)
    await sleep(1000);
    a.send("pose", pose(-175 + 46, 8));
    await until(() => Math.abs(pa.x - (-175 + 46)) < 1e-3, 1000, "seated pose accepted");
    a.send("exit");
    await until(() => pa.veh === "", 1000, "out");
    await sleep(1000);
    a.send("pose", pose(pa.x + 46, 8));
    await sleep(120);
    assert.ok(Math.abs(pa.x - (-175 + 46)) < 1e-3, "on foot: refused");
  });

  it("leaving the round frees the seat and the vehicle it simulated", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE, 3);
    const [a] = clients;
    const pa = room.state.players.get(a.sessionId)!;
    a.send("pose", pose(-175, 8));
    await sleep(80);
    a.send("enter", { v: "wj", s: 0 });
    await until(() => pa.veh === "wj", 1000, "seated");
    a.send("leave");
    const jeep = room.state.vehicles.get("wj")!;
    await until(() => jeep.seats[0] === "" && jeep.owner === "", 1000, "freed");
  });

  it("bullets and blasts wear a vehicle down; a wreck throws everyone out, hurts them and respawns", async () => {
    const respawn = VEHICLE_DAMAGE.respawn;
    VEHICLE_DAMAGE.respawn = 0.4;
    try {
      const { room, clients } = await startRound(colyseus, RIDGE);
      const [a, b] = clients;
      const pa = room.state.players.get(a.sessionId)!;
      const pb = room.state.players.get(b.sessionId)!;
      assert.notStrictEqual(pa.team, pb.team);
      const jeep = room.state.vehicles.get("wj")!;
      const buggy = room.state.vehicles.get("wb")!;
      assert.strictEqual(jeep.hp, VEHICLE_TYPES.jeep.hp);
      a.send("pose", pose(-175, 8));
      b.send("pose", pose(-160, 15));
      await sleep(100);
      a.send("enter", { v: "wj", s: 0 });
      await until(() => pa.veh === "wj", 1000, "a seated");
      // a bullet: its damage x VEHICLE_DAMAGE.bullet
      const w = pb.primary;
      b.send("vhit", { v: "wj", w, s: 1, n: 1, d: 15 });
      await until(() => jeep.hp < VEHICLE_TYPES.jeep.hp, 1000, "hit");
      assert.ok(Math.abs(VEHICLE_TYPES.jeep.hp - jeep.hp - WEAPONS[w].damage * VEHICLE_DAMAGE.bullet) < 0.01);
      // not its own vehicle, nor a weapon it does not carry
      const hp = jeep.hp;
      a.send("vhit", { v: "wj", w: pa.primary, s: 1, n: 1, d: 1 });
      b.send("vhit", { v: "wj", w: "hawk" === w ? "rhino" : "hawk", s: 2, n: 1, d: 15 });
      await sleep(120);
      assert.strictEqual(jeep.hp, hp);
      // a frag next to the parked buggy (thrown first), measured to its surface
      b.send("throw", { p: [-170, 6, 18], v: [0, 0, 0] });
      await sleep(60);
      b.send("boom", { x: -177, y: 5, z: 20.1, t: [], vt: ["wb"] });
      await until(() => buggy.hp < VEHICLE_TYPES.buggy.hp, 1000, "blast");
      assert.ok(Math.abs(VEHICLE_TYPES.buggy.hp - buggy.hp - 170 * VEHICLE_DAMAGE.blast) < 0.5);
      // the last hits: a wreck; the driver is thrown out and hurt through armour
      jeep.hp = 1;
      await sleep(150);
      b.send("vhit", { v: "wj", w, s: 3, n: 1, d: 15 });
      await until(() => jeep.wreck, 1000, "wrecked");
      assert.strictEqual(pa.veh, "");
      assert.strictEqual(jeep.seats[0], "");
      assert.notStrictEqual(pa.life, "alive");
      // nobody gets into a wreck; then a new one is parked at its spawn
      b.send("pose", pose(-176, 8));
      await sleep(80);
      b.send("enter", { v: "wj", s: 1 });
      await sleep(80);
      assert.strictEqual(pb.veh, "");
      const life = jeep.life;
      await until(() => !jeep.wreck, 2000, "respawned");
      assert.strictEqual(jeep.hp, VEHICLE_TYPES.jeep.hp);
      assert.strictEqual(jeep.y, PARKED_Y);
      assert.strictEqual(jeep.life, (life + 1) & 0xff);
      assert.strictEqual(jeep.owner, "");
    } finally {
      VEHICLE_DAMAGE.respawn = respawn;
    }
  });

  it("burns down below its burn line and credits the last attacker", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [, b] = clients;
    const buggy = room.state.vehicles.get("wb")!;
    b.send("pose", pose(-165, 18));
    await sleep(80);
    buggy.hp = VEHICLE_TYPES.buggy.hp * VEHICLE_DAMAGE.burnBelow * 0.5;
    const before = buggy.hp;
    await sleep(300);
    assert.ok(buggy.hp < before, "burning");
    buggy.hp = 0.5;
    await until(() => buggy.wreck, 1000, "burnt out");
  });

  it("the Jeep's mounted gun fires only from its gunner seat", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [a, b] = clients;
    const pb = room.state.players.get(b.sessionId)!;
    const gun = VEHICLE_TYPES.jeep.gunSeat!;
    a.send("pose", pose(-175, 8));
    b.send("pose", pose(-160, 8));
    await sleep(100);
    // on foot: refused
    a.send("hit", { t: b.sessionId, w: "mg", s: 1, n: 1, h: 0, d: 15 });
    await sleep(80);
    assert.strictEqual(pb.hp, 200);
    a.send("enter", { v: "wj", s: gun });
    await until(() => room.state.players.get(a.sessionId)!.seat === gun, 1000, "gunner");
    a.send("hit", { t: b.sessionId, w: "mg", s: 2, n: 1, h: 0, d: 15 });
    await until(() => pb.hp < 200, 1000, "mg hit");
  });

  it("running someone over: the driver only, fast enough, close enough, once in a while", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [a, b] = clients;
    const pb = room.state.players.get(b.sessionId)!;
    a.send("pose", pose(-175, 8));
    b.send("pose", pose(-170, 10));
    await sleep(100);
    a.send("enter", { v: "wj", s: 0 });
    const jeep = room.state.vehicles.get("wj")!;
    await until(() => jeep.owner === a.sessionId, 1000, "driving");
    await sleep(300);
    a.send("vpose", vpose("wj", -172, 9.9, { vx: 20 }));
    await until(() => jeep.vx === 20, 1000, "moving");
    // too slow: nothing
    a.send("ram", { v: "wj", t: b.sessionId, sp: 5 });
    await sleep(80);
    assert.strictEqual(pb.hp, 200);
    a.send("ram", { v: "wj", t: b.sessionId, sp: 20 });
    const R = VEHICLE_DAMAGE.ram;
    await until(() => pb.hp < 200, 1000, "rammed");
    assert.ok(Math.abs(200 - pb.hp - (R.base + (20 - R.minSpeed) * R.perMs)) < 0.5);
    // again at once: within the gap
    const hp = pb.hp;
    a.send("ram", { v: "wj", t: b.sessionId, sp: 20 });
    await sleep(100);
    assert.strictEqual(pb.hp, hp);
    // far away: nothing
    await sleep(R.gapMs);
    b.send("pose", pose(-150, 30));
    await sleep(100);
    a.send("ram", { v: "wj", t: b.sessionId, sp: 20 });
    await sleep(100);
    assert.strictEqual(pb.hp, hp);
  });

  it("a wreck's replacement is parked inside the safe zone, nearest its camp", async () => {
    const { room } = await startRound(colyseus, RIDGE);
    const vs = (room as any).vehicles;
    const jeep = room.state.vehicles.get("wj")!;
    const clock = room.state.clock;
    vs.damage("wj", 1e6, null, clock);
    assert.ok(jeep.wreck);
    // a zone of radius 100 round the town: the camp (x -177) is outside; the nearest spot inside is
    // the main road west of town
    const inZone = (x: number, z: number) => Math.hypot(x, z) - 100;
    vs.tick(0.05, clock + VEHICLE_DAMAGE.respawn + 1, inZone);
    assert.ok(!jeep.wreck);
    assert.deepStrictEqual([jeep.x, jeep.z], [VEHICLE_PARKING.ridge[0].x, VEHICLE_PARKING.ridge[0].z]);
    assert.strictEqual(jeep.y, PARKED_Y);
    // with the camp inside the zone it goes home
    vs.damage("wj", 1e6, null, clock);
    vs.tick(0.05, clock + VEHICLE_DAMAGE.respawn + 1, () => -1000);
    assert.ok(Math.abs(jeep.x + 177) < 1e-3 && Math.abs(jeep.z - 9.9) < 1e-3, "home");
  });

  it("a Firebottle's flames burn a vehicle standing in them", async () => {
    const { room, clients } = await startRound(colyseus, RIDGE);
    const [a] = clients;
    const pa = room.state.players.get(a.sessionId)!;
    const buggy = room.state.vehicles.get("eb")!;
    (room as any).fires.push({ owner: a.sessionId, team: pa.team, kind: "molotov", x: 177, y: 5, z: -20.1, r: 3.6, dps: 24, until: room.state.clock + 5, tick: 0 });
    await until(() => buggy.hp < VEHICLE_TYPES.buggy.hp, 1500, "burning");
  });
});
