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

// Fast phases so a round starts within a test.
Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

async function startRound(colyseus: ColyseusTestServer<typeof appConfig>, n = 2, opts: any[] = []) {
  const room = await colyseus.createRoom<MatchState>("match", {});
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await colyseus.connectTo(room, { name: `P${i}`, ...(opts[i] ?? {}) }));
  for (const c of clients) c.send("play", { mode: "squad" });
  await until(() => room.state.phase === "playing", 3000, "playing");
  return { room, clients };
}

describe("match room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("waits for a second player, then runs a round on two balanced teams", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { name: "Ann" });
    a.send("play", {});
    await sleep(150);
    assert.strictEqual(room.state.phase, "waiting", "one player waits");
    const b = await colyseus.connectTo(room, { name: "Bo" });
    b.send("play", { mode: "squad" });
    await until(() => room.state.phase === "playing", 3000, "playing");
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.notStrictEqual(pa.team, pb.team, "one per team");
    assert.ok(["blue", "orange"].includes(pa.team));
    assert.strictEqual(pa.life, "alive");
    assert.strictEqual(room.state.mode, "squad");
    assert.strictEqual(pa.name, "Ann");
  });

  it("seats 3 v 3: the others who pressed Play wait, and sit first next round", async () => {
    const { room, clients } = await startRound(colyseus, 8);
    const teams = (id: string) => room.state.players.get(id)!.team;
    const seated = () => clients.filter((c) => teams(c.sessionId));
    assert.strictEqual(seated().length, 6, "a round seats 6");
    assert.strictEqual(seated().filter((c) => teams(c.sessionId) === "blue").length, 3);
    assert.strictEqual(seated().filter((c) => teams(c.sessionId) === "orange").length, 3);
    const waiting = clients.filter((c) => !teams(c.sessionId)).map((c) => c.sessionId);
    assert.strictEqual(waiting.length, 2);
    for (const id of waiting) assert.ok(room.state.players.get(id)!.inMatch, "queued, not sent to the menus");
    room.state.duration = 0.1; // end the round by the clock
    await until(() => room.state.phase === "results", 4000, "results");
    await until(() => room.state.phase === "playing" && room.state.round === 2, 4000, "round 2");
    for (const id of waiting) assert.ok(teams(id), "players who sat out are seated first");
  });

  it("checks hits: rate, team, range; armour and damage are the server's", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    const pb = room.state.players.get(b.sessionId)!;
    a.send("pose", { x: 0, y: 0, z: 0, yaw: 0 });
    b.send("pose", { x: 0, y: 0, z: 10, yaw: 0 });
    await sleep(60);
    a.send("hit", { t: b.sessionId, w: "striker", s: 1, n: 1, h: 0, d: 10 });
    await until(() => pb.hp < 200, 1000, "hit");
    assert.strictEqual(pb.hp, 166);
    a.send("hit", { t: b.sessionId, w: "striker", s: 2, n: 1, h: 0, d: 10 }); // too soon after shot 1
    await sleep(40);
    assert.strictEqual(pb.hp, 166, "faster than the fire rate is refused");
    a.send("hit", { t: b.sessionId, w: "hawk", s: 3, n: 1, h: 1, d: 10 }); // not carried
    await sleep(80);
    assert.strictEqual(pb.hp, 166, "a weapon not in the loadout is refused");
    b.send("pose", { x: 0, y: 0, z: 200, yaw: 0 }); // teleport: refused, b stays at z 10...
    await sleep(60);
    assert.strictEqual(pb.z, 10, "a teleporting pose is ignored");
  });

  it("eliminates, scores, ends the round and pays rewards", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    room.state.scoreToWin = 1;
    const got: any[] = [];
    const kills: any[] = [];
    a.onMessage("rewards", (r) => got.push(r));
    a.onMessage("reward", (r) => kills.push(r));
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 5 });
    await sleep(60);
    for (let s = 1; s <= 8 && room.state.players.get(b.sessionId)!.life !== "dead"; s++) {
      a.send("hit", { t: b.sessionId, w: "striker", s, n: 1, h: 1, d: 5 });
      await sleep(110);
    }
    const pa = room.state.players.get(a.sessionId)!;
    assert.strictEqual(room.state.players.get(b.sessionId)!.life, "dead", "1 v 1: no teammate to revive, so out");
    assert.strictEqual(pa.kills, 1);
    await until(() => got.length > 0, 2000, "rewards");
    assert.strictEqual(got[0].won, true);
    assert.strictEqual(got[0].eliminations, 1);
    assert.ok(got[0].coins >= 70 + 12);
    // Gems: granted at the kill (12 + 3 headshot), told to the shooter, kept in the profile; the
    // round adds the win (40) and MVP (25) Gems at the results.
    assert.strictEqual(kills.length, 1);
    assert.deepStrictEqual(
      { k: kills[0].k, t: kills[0].t, gems: kills[0].gems, coins: kills[0].coins, rp: kills[0].rp, h: kills[0].h, s: kills[0].s },
      { k: "elim", t: b.sessionId, gems: 15, coins: 12, rp: 3, h: true, s: 1 },
    );
    assert.strictEqual(kills[0].total, 15);
    assert.strictEqual(got[0].gemsRound, 65);
    assert.strictEqual(got[0].gems, 80);
  });

  it("Gems from a kill are saved to the account and come back on the next join", async () => {
    const db = fakePlayers([{ _id: "dev-gem1", coins: 50, gems: 40, updatedAt: new Date() } as any]);
    __setPlayersForTest(db);
    const { room, clients } = await startRound(colyseus, 2, [{ devUser: "dev-gem1" }, { devUser: "dev-gem2" }]);
    const [a, b] = clients;
    const kills: any[] = [];
    a.onMessage("reward", (r) => kills.push(r));
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 5 });
    await sleep(60);
    const pb = room.state.players.get(b.sessionId)!;
    for (let s = 1; s <= 12 && pb.life !== "dead"; s++) {
      a.send("hit", { t: b.sessionId, w: "striker", s, n: 1, h: 0, d: 5 });
      await sleep(110);
    }
    assert.strictEqual(pb.life, "dead");
    await until(() => kills.length > 0, 2000, "reward");
    assert.strictEqual(kills[0].gems, 12, "body-shot elimination, no streak");
    assert.strictEqual(kills[0].total, 52, "added to the saved 40");
    await a.leave();
    await until(() => db.docs.get("dev-gem1")?.gems === 52, 2000, "saved (no round Gems for leaving)");
    const again = await colyseus.connectTo(room, { name: "Ann", devUser: "dev-gem1" });
    const profiles: any[] = [];
    again.onMessage("profile", (m) => profiles.push(m.profile));
    again.send("getProfile");
    await until(() => profiles.length > 0, 2000, "profile");
    assert.strictEqual(profiles[0].gems, 52);
  });

  it("Gem shop: weapons, grenades and the pass cost Gems (never coins)", async () => {
    const db = fakePlayers([{ _id: "dev-shop9", coins: 99999, gems: 4000, updatedAt: new Date() } as any]);
    __setPlayersForTest(db);
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { name: "Bo", devUser: "dev-shop9" });
    const shop: any[] = [];
    const profiles: any[] = [];
    a.onMessage("shop", (m) => shop.push(m));
    a.onMessage("profile", (m) => profiles.push(m.profile));
    a.send("getProfile");
    await until(() => profiles.length > 0, 2000, "profile");
    a.send("buy", { kind: "weapon", id: "hawk" }); // 3500 Gems
    await until(() => shop.length > 0, 2000, "buy hawk");
    assert.strictEqual(shop[0].ok, true);
    a.send("buy", { kind: "pass", id: "basic" }); // 3500 Gems: only 500 left
    await until(() => shop.length > 1, 2000, "buy pass");
    assert.strictEqual(shop[1].error, "gems", "coins never buy Gem items");
    a.send("buy", { kind: "grenade", id: "pulse" }); // 800: refused too
    await until(() => shop.length > 2, 2000, "buy pulse");
    assert.strictEqual(shop[2].error, "gems");
    await until(() => db.docs.get("dev-shop9")?.gems === 500, 2000, "saved");
    assert.strictEqual(db.docs.get("dev-shop9").coins, 99999);
    // The pass unlocks its whole set.
    db.docs.get("dev-shop9").gems = 3600;
    const b = await colyseus.connectTo(room, { name: "Bo", devUser: "dev-shop9" }); // replaces the first session
    const shop2: any[] = [];
    const prof2: any[] = [];
    b.onMessage("shop", (m) => shop2.push(m));
    b.onMessage("profile", (m) => prof2.push(m.profile));
    b.send("getProfile");
    await until(() => prof2.length > 0, 2000, "profile 2");
    b.send("buy", { kind: "pass", id: "basic" });
    await until(() => shop2.length > 0, 2000, "buy pass 2");
    assert.strictEqual(shop2[0].ok, true);
    await until(() => db.docs.get("dev-shop9")?.owned?.passes?.includes("basic"), 2000, "pass saved");
    for (const w of ["hornet", "talon", "wasp", "ridgeback", "thunder", "breaker"]) assert.ok(db.docs.get("dev-shop9").owned.weapons.includes(w), w);
    b.send("equip", { kind: "grenade", id: "pulse" });
    await sleep(100);
    assert.notStrictEqual(db.docs.get("dev-shop9").loadout.grenade, "pulse", "an unowned grenade cannot be equipped");
  });

  it("a medic weapon heals a teammate (knocked: the bleed-out pool) and hurts enemies", async () => {
    const db = fakePlayers([{ _id: "dev-med1", gems: 0, owned: { weapons: ["mender"] }, loadout: { secondary: "mender" }, updatedAt: new Date() } as any]);
    __setPlayersForTest(db);
    const { room, clients } = await startRound(colyseus, 3, [{ devUser: "dev-med1" }]);
    const medic = clients[0];
    const pm = room.state.players.get(medic.sessionId)!;
    await until(() => pm.secondary === "mender", 2000, "mender in the loadout");
    const mate = clients.slice(1).find((c) => room.state.players.get(c.sessionId)!.team === pm.team);
    const foe = clients.slice(1).find((c) => room.state.players.get(c.sessionId)!.team !== pm.team)!;
    medic.send("pose", { x: 0, y: 0, z: 0 });
    foe.send("pose", { x: 0, y: 0, z: 10 });
    if (mate) mate.send("pose", { x: 0, y: 0, z: 5 });
    await sleep(60);
    const pf = room.state.players.get(foe.sessionId)!;
    medic.send("hit", { t: foe.sessionId, w: "mender", s: 1, n: 1, h: 0, d: 10 });
    await until(() => pf.hp < 200, 1000, "enemy hurt");
    assert.ok(pf.hp > 180, "a light hit on enemies");
    if (mate) {
      const pt = room.state.players.get(mate.sessionId)!;
      pt.hp = 30;
      await sleep(300);
      medic.send("hit", { t: mate.sessionId, w: "mender", s: 2, n: 1, h: 0, d: 5 });
      await until(() => pt.hp >= 40, 1000, "ally healed");
      const before = pt.hp;
      medic.send("hit", { t: mate.sessionId, w: "striker", s: 3, n: 1, h: 0, d: 5 });
      await sleep(150);
      assert.ok(pt.hp >= before, "no friendly fire with a normal gun");
    }
  });

  it("knocks when a teammate is standing, and a held revive brings the player back", async () => {
    const { room, clients } = await startRound(colyseus, 3);
    const ps = clients.map((c) => room.state.players.get(c.sessionId)!);
    // Two on one team, one on the other.
    const team = ps[0].team;
    const mates = clients.filter((c) => room.state.players.get(c.sessionId)!.team === team);
    const foes = clients.filter((c) => room.state.players.get(c.sessionId)!.team !== team);
    const [victim, helper] = mates.length === 2 ? mates : foes;
    const shooter = mates.length === 2 ? foes[0] : mates[0];
    for (const [c, z] of [[shooter, 0], [victim, 5], [helper, 6]] as const) c.send("pose", { x: 0, y: 0, z });
    await sleep(60);
    const pv = room.state.players.get(victim.sessionId)!;
    for (let s = 1; s <= 10 && pv.life === "alive"; s++) {
      shooter.send("hit", { t: victim.sessionId, w: "striker", s, n: 1, h: 1, d: 5 });
      await sleep(110);
    }
    assert.strictEqual(pv.life, "knocked", "a teammate is up: knocked, not out");
    helper.send("revive", { t: victim.sessionId });
    await sleep(60);
    assert.strictEqual(pv.life, "knocked", "a revive without the hold is refused");
    helper.send("reviving", { t: victim.sessionId });
    await sleep(2600);
    helper.send("revive", { t: victim.sessionId });
    await until(() => pv.life === "alive", 1000, "revived");
  });

  it("a frag's blast is the server's: radius, falloff, no team damage", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 3 });
    await sleep(60);
    a.send("boom", { x: 0, y: 1, z: 3, t: [b.sessionId] });
    await sleep(80);
    assert.strictEqual(room.state.players.get(b.sessionId)!.hp, 200, "no throw first: refused");
    a.send("throw", { p: [0, 1, 0], v: [0, 4, 10] });
    await sleep(40);
    a.send("boom", { x: 0, y: 1, z: 3, t: [b.sessionId] });
    await until(() => room.state.players.get(b.sessionId)!.hp < 200, 1000, "blast");
    assert.ok(room.state.players.get(b.sessionId)!.hp < 60, "point blank: most of 170");
  });

  it("a second session of the same account replaces the first (no rejoin ping-pong)", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { devUser: "dev-same1" });
    let code = 0;
    a.onLeave((c) => (code = c));
    await colyseus.connectTo(room, { devUser: "dev-same1" });
    await until(() => code !== 0, 2000, "replaced");
    assert.strictEqual(code, 4100);
  });

  it("shop: skins with coins, weapons with Gems; equips; saved per account", async () => {
    const db = fakePlayers();
    __setPlayersForTest(db);
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { name: "Ann", devUser: "dev-ann1" });
    const profiles: any[] = [];
    const shop: any[] = [];
    a.onMessage("profile", (m) => profiles.push(m.profile));
    a.onMessage("shop", (m) => shop.push(m));
    a.send("getProfile");
    await until(() => profiles.length > 0, 2000, "profile");
    assert.strictEqual(profiles[0].coins, 600);
    a.send("buy", { kind: "skin", id: "desert" });
    await until(() => shop.length > 0, 2000, "buy");
    assert.strictEqual(shop[0].ok, true);
    a.send("buy", { kind: "weapon", id: "hornet" });
    await until(() => shop.length > 1, 2000, "buy 2");
    assert.strictEqual(shop[1].error, "gems", "weapons cost Gems, not coins");
    a.send("equip", { kind: "skin", id: "desert", weapon: "striker" });
    await until(() => room.state.players.get(a.sessionId)?.skinPrimary === "desert", 2000, "equip");
    await until(() => db.docs.get("dev-ann1")?.coins === 0, 2000, "saved");
    assert.ok(db.docs.get("dev-ann1").owned.skins.includes("desert"));
  });

  it("verifies the token, uses only the verified id, and carries a guest save into a new account", async () => {
    const db = fakePlayers([{ _id: "guest-old", coins: 4321, updatedAt: new Date() } as any]);
    __setPlayersForTest(db);
    __setVerifierForTest(async (token) => (token === "good-token-123" ? { userId: "acct1", username: "RealName", pfp: "", carriedFrom: ["guest-old"], outfitKey: "o1-verified" } : null));
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { token: "good-token-123", name: "Spoofed", userId: "someone-else" });
    const profiles: any[] = [];
    a.onMessage("profile", (m) => profiles.push(m));
    a.send("getProfile");
    await until(() => profiles.length > 0, 2000, "profile");
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.name, "RealName");
    assert.strictEqual(p.signedIn, true);
    assert.strictEqual(p.outfitKey, "o1-verified", "the verified look is relayed");
    a.send("avatar", { avatar: '{"equipped":{"hatId":"12","characterId":"-1"}}', outfitKey: "o1-new" });
    await until(() => p.outfitKey === "o1-new", 1000, "look update");
    assert.ok(p.avatar.includes("characterId"));
    a.send("avatar", { outfitKey: "bad key <script>" });
    await sleep(60);
    assert.strictEqual(p.outfitKey, "o1-new", "a malformed key is ignored");
    assert.strictEqual(profiles[0].userId, "acct1");
    assert.strictEqual(profiles[0].profile.coins, 4321, "guest progress carried over");
    assert.strictEqual(db.docs.get("guest-old").carried, true, "only once");
    const b = await colyseus.connectTo(room, { token: "bad", name: "Bo" });
    await sleep(50);
    assert.strictEqual(room.state.players.get(b.sessionId)!.signedIn, false, "a refused token is a guest");
  });
});
