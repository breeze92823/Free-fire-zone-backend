import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { MAPS, PHASES, VEHICLE_SPAWNS } from "../src/rules.js";
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
});
