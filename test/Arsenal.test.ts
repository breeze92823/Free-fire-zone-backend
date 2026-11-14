import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { PHASES } from "../src/rules.js";
import { TIMING } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { fakePlayers, sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

// The second arsenal wave: burst fire, launcher blasts, fire pools, smoke / stun grenades, the
// melee slot and the frying pan's block.
Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

// Two players in a round; `a` owns and carries what `loadout` names (dev account dev-ars-<tag>).
async function duel(colyseus: ColyseusTestServer<typeof appConfig>, tag: string, owned: string[], loadout: any, bLoadout: any = null) {
  const docs: any[] = [{ _id: `dev-ars-${tag}`, gems: 0, owned: { weapons: owned, grenades: owned }, loadout, updatedAt: new Date() }];
  if (bLoadout) docs.push({ _id: `dev-arsb-${tag}`, gems: 0, owned: { weapons: Object.values(bLoadout) }, loadout: bLoadout, updatedAt: new Date() });
  __setPlayersForTest(fakePlayers(docs));
  const room = await colyseus.createRoom<MatchState>("match", {});
  const a = await colyseus.connectTo(room, { name: "A", devUser: `dev-ars-${tag}` });
  const b = await colyseus.connectTo(room, { name: "B", ...(bLoadout ? { devUser: `dev-arsb-${tag}` } : {}) });
  for (const c of [a, b]) c.send("play", { mode: "squad" });
  await until(() => room.state.phase === "playing", 3000, "playing");
  const pa = room.state.players.get(a.sessionId)!;
  const pb = room.state.players.get(b.sessionId)!;
  return { room, a, b, pa, pb };
}

describe("second arsenal wave", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("burst fire: three quick shots per burst, then the burst interval", async () => {
    const { a, b, pa, pb } = await duel(colyseus, "burst", ["sentinel"], { primary: "sentinel" });
    await until(() => pa.primary === "sentinel", 2000, "sentinel");
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 10 });
    await sleep(60);
    for (let s = 1; s <= 4; s++) {
      a.send("hit", { t: b.sessionId, w: "sentinel", s, n: 1, h: 0, d: 10 });
      await sleep(45);
    }
    await sleep(60);
    assert.strictEqual(pb.hp, 200 - 38 * 3, "the 4th shot right after a burst is refused");
    await sleep(300);
    a.send("hit", { t: b.sessionId, w: "sentinel", s: 5, n: 1, h: 0, d: 10 });
    await until(() => pb.hp < 200 - 38 * 3, 1000, "next burst");
  });

  it("a launcher blast: carried weapon, radius falloff, relayed to the others", async () => {
    const { a, b, pa, pb } = await duel(colyseus, "gl", ["rhino"], { primary: "rhino" });
    await until(() => pa.primary === "rhino", 2000, "rhino");
    const blasts: any[] = [];
    b.onMessage("blast", (m) => blasts.push(m));
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 20 });
    await sleep(60);
    a.send("blast", { w: "thumper", s: 1, x: 0, y: 1, z: 20, t: [b.sessionId] }); // not carried
    await sleep(80);
    assert.strictEqual(pb.hp, 200, "a launcher not in the loadout is refused");
    a.send("blast", { w: "rhino", s: 2, x: 0, y: 1, z: 20, t: [b.sessionId] });
    await until(() => pb.hp < 200, 1000, "blast");
    assert.ok(pb.hp < 30, "a rocket at your feet takes nearly everything");
    await until(() => blasts.length === 1, 1000, "relay");
    assert.strictEqual(blasts[0].w, "rhino");
    const hp = pb.hp;
    a.send("blast", { w: "rhino", s: 3, x: 0, y: 1, z: 20, t: [b.sessionId] }); // faster than the weapon
    await sleep(80);
    assert.strictEqual(pb.hp, hp, "a second blast at once is refused");
  });

  it("a Firebottle burns whoever stands in it, over time; smoke and stun grenades do no damage", async () => {
    const { a, b, pa, pb } = await duel(colyseus, "fire", ["molotov", "smoke"], { grenade: "molotov" });
    const booms: any[] = [];
    b.onMessage("boom", (m) => booms.push(m));
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 8 });
    await sleep(60);
    a.send("throw", { p: [0, 1, 0], v: [0, 4, 10] });
    await sleep(40);
    a.send("boom", { x: 0, y: 0, z: 8, t: [] });
    await until(() => booms.length === 1, 1000, "boom relay");
    assert.strictEqual(booms[0].k, "molotov", "the relay names the grenade");
    await until(() => pb.hp < 200, 1500, "burning");
    const first = pb.hp;
    await sleep(1100);
    assert.ok(pb.hp < first - 15, "keeps burning while standing in it");
    b.send("pose", { x: 0, y: 0, z: 14 }); // step out
    await sleep(150);
    const out = pb.hp;
    await sleep(700);
    assert.ok(pb.hp >= out, "no burn outside the fire");
    assert.strictEqual(pa.hp, 200, "the thrower outside it is fine");
    // Smoke: no damage at all.
    a.send("equip", { kind: "grenade", id: "smoke" });
    await sleep(500);
    b.send("pose", { x: 0, y: 0, z: 3 });
    await sleep(60);
    const before = pb.hp;
    a.send("throw", { p: [0, 1, 0], v: [0, 4, 10] });
    await sleep(40);
    a.send("boom", { x: 0, y: 0, z: 3, t: [b.sessionId] });
    await sleep(300);
    assert.ok(pb.hp >= before, "smoke never hurts");
  });

  it("the melee slot: an owned machete replaces the knife; the knife is then not carried", async () => {
    const { a, b, pa, pb } = await duel(colyseus, "mel", ["machete"], { melee: "machete" });
    await until(() => pa.melee === "machete", 2000, "machete in the state");
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 2 });
    await sleep(60);
    a.send("hit", { t: b.sessionId, w: "knife", s: 1, n: 1, h: 0, d: 2 });
    await sleep(80);
    assert.strictEqual(pb.hp, 200, "the knife is not carried");
    a.send("hit", { t: b.sessionId, w: "machete", s: 2, n: 1, h: 0, d: 2 });
    await until(() => pb.hp === 200 - 78, 1000, "machete blow");
  });

  it("the lobby's 'new weapons' window: the seen announcement is saved, only moves forward, comes back on the next join", async () => {
    const db = fakePlayers([{ _id: "dev-news1", gems: 0, updatedAt: new Date() } as any]);
    __setPlayersForTest(db);
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { name: "N", devUser: "dev-news1" });
    const profiles: any[] = [];
    a.onMessage("profile", (m) => profiles.push(m.profile));
    a.send("getProfile");
    await until(() => profiles.length > 0, 2000, "profile");
    assert.strictEqual(profiles[0].newsSeen, 0, "an old save has seen nothing");
    a.send("newsSeen", { id: 2 });
    await until(() => db.docs.get("dev-news1")?.newsSeen === 2, 2000, "saved");
    a.send("newsSeen", { id: 1 }); // older: ignored
    a.send("newsSeen", { id: "3" }); // not a number: ignored
    await sleep(150);
    assert.strictEqual(db.docs.get("dev-news1").newsSeen, 2);
    const b = await colyseus.connectTo(room, { name: "N", devUser: "dev-news1" }); // a new session
    const prof2: any[] = [];
    b.onMessage("profile", (m) => prof2.push(m.profile));
    b.send("getProfile");
    await until(() => prof2.length > 0, 2000, "profile 2");
    assert.strictEqual(prof2[0].newsSeen, 2, "remembered on the account");
  });

  it("the frying pan on your back cuts body shots from behind, not from the front or to the head", async () => {
    const { a, b, pb } = await duel(colyseus, "pan", [], {}, { melee: "pan" });
    await until(() => pb.melee === "pan", 2000, "pan in the state");
    const dmg: any[] = [];
    a.onMessage("dmg", (m) => dmg.push(m));
    // b faces +z (yaw 0); a stands behind at z -10.
    a.send("pose", { x: 0, y: 0, z: -10, yaw: 0 });
    b.send("pose", { x: 0, y: 0, z: 0, yaw: 0, slot: 0 });
    await sleep(60);
    a.send("hit", { t: b.sessionId, w: "striker", s: 1, n: 1, h: 0, d: 10 });
    await until(() => pb.hp < 200, 1000, "hit from behind");
    assert.ok(Math.abs(pb.hp - (200 - 34 * 0.35)) < 0.2, `65% stopped (hp ${pb.hp})`);
    await until(() => dmg.length === 1, 1000, "dmg");
    assert.strictEqual(dmg[0].b, true, "the clients hear the clang");
    // Turned round to face the shooter: full damage.
    b.send("pose", { x: 0, y: 0, z: 0, yaw: Math.PI, slot: 0 });
    await sleep(150);
    const hp = pb.hp;
    a.send("hit", { t: b.sessionId, w: "striker", s: 2, n: 1, h: 0, d: 10 });
    await until(() => pb.hp < hp, 1000, "hit from the front");
    assert.ok(Math.abs(hp - pb.hp - 34) < 0.2, "no block from the front");
  });
});
