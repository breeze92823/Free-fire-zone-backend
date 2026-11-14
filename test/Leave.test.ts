import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { PHASES, REWARDS } from "../src/rules.js";
import { TIMING } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

// Fast phases so a round starts within a test (the same values as Match.test.ts).
Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

async function startRound(colyseus: ColyseusTestServer<typeof appConfig>, n = 2) {
  const room = await colyseus.createRoom<MatchState>("match", {});
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await colyseus.connectTo(room, { name: `P${i}` }));
  for (const c of clients) c.send("play", { mode: "squad" });
  await until(() => room.state.phase === "playing", 3000, "playing");
  return { room, clients };
}

describe("leaving a round", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("a player who leaves right after being hit is eliminated by the shooter; an early forfeit is a no contest", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    const aGot: any[] = [];
    const bGot: any[] = [];
    const aKill: any[] = [];
    const ends: any[] = [];
    a.onMessage("rewards", (r) => aGot.push(r));
    a.onMessage("reward", (r) => aKill.push(r));
    a.onMessage("matchEnd", (m) => ends.push(m));
    b.onMessage("rewards", (r) => bGot.push(r));
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 5 });
    await sleep(60);
    a.send("hit", { t: b.sessionId, w: "striker", s: 1, n: 1, h: 0, d: 5 });
    await until(() => room.state.players.get(b.sessionId)!.hp < 200, 1000, "hit");
    b.send("leave");
    await until(() => bGot.length > 0, 1000, "leaver's rewards");
    const pa = room.state.players.get(a.sessionId)!;
    assert.strictEqual(pa.kills, 1, "the shooter gets the elimination");
    assert.strictEqual(aKill.length, 1, "and its reward");
    assert.strictEqual(aKill[0].k, "elim");
    // The leaver: the penalty, flagged as a leave.
    assert.strictEqual(bGot[0].left, true);
    assert.strictEqual(bGot[0].won, false);
    assert.strictEqual(bGot[0].rp, REWARDS.leavePenaltyRp);
    assert.strictEqual(bGot[0].coins, 0, "no fighting coins, no result bonus");
    assert.strictEqual(bGot[0].gemsRound, 0);
    assert.strictEqual(bGot[0].deaths, 1);
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(pb.inMatch, false);
    assert.strictEqual(pb.team, "");
    // The side left empty at the very start: the round ends, nobody wins it.
    await until(() => aGot.length > 0, 2000, "remaining player's rewards");
    assert.deepStrictEqual(ends[0], { winner: pa.team, forfeit: true, noContest: true });
    assert.strictEqual(aGot[0].won, false, "no win for a no contest");
    assert.strictEqual(aGot[0].noContest, true);
    assert.strictEqual(aGot[0].forfeit, true);
    assert.strictEqual(aGot[0].rp, REWARDS.rpPerElim, "no rank lost; the elimination still counts");
    assert.strictEqual(aGot[0].coins, Math.round(REWARDS.perElimination + 34 * REWARDS.perDamage + REWARDS.loss));
  });

  it("a forfeit late in the round still pays the win", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    const aGot: any[] = [];
    a.onMessage("rewards", (r) => aGot.push(r));
    room.state.clock = room.state.duration * REWARDS.forfeitMinShare + 1;
    b.send("leave");
    await until(() => aGot.length > 0, 2000, "rewards");
    assert.strictEqual(aGot[0].won, true);
    assert.strictEqual(aGot[0].noContest, false);
    assert.strictEqual(aGot[0].forfeit, true);
    assert.strictEqual(aGot[0].rp, REWARDS.rpWin);
  });

  it("a knocked player who leaves is eliminated and credited to the enemy who knocked them", async () => {
    const { room, clients } = await startRound(colyseus, 3);
    const team = room.state.players.get(clients[0].sessionId)!.team;
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
    assert.strictEqual(pv.life, "knocked");
    // Wait past the recent-hit window would need 10 s; a knocked player is credited regardless.
    const kills: any[] = [];
    shooter.onMessage("reward", (r) => kills.push(r));
    const before = room.state[room.state.players.get(shooter.sessionId)!.team as "blue" | "orange"];
    victim.send("leave");
    await until(() => !pv.inMatch, 1000, "left");
    const ps = room.state.players.get(shooter.sessionId)!;
    assert.strictEqual(ps.kills, 1, "the knock becomes an elimination");
    assert.strictEqual(room.state[ps.team as "blue" | "orange"], before + 1, "and a point");
    await until(() => kills.length > 0, 1000, "elim reward");
    assert.strictEqual(kills[0].k, "elim");
    assert.strictEqual(room.state.phase, "playing", "a teammate is still in: the round goes on");
  });

  it("the last player standing leaving takes the knocked teammates out", async () => {
    const { room, clients } = await startRound(colyseus, 3);
    const team = room.state.players.get(clients[0].sessionId)!.team;
    const mates = clients.filter((c) => room.state.players.get(c.sessionId)!.team === team);
    const foes = clients.filter((c) => room.state.players.get(c.sessionId)!.team !== team);
    const [victim, helper] = mates.length === 2 ? mates : foes;
    const shooter = mates.length === 2 ? foes[0] : mates[0];
    for (const [c, z] of [[shooter, 0], [victim, 5], [helper, 40]] as const) c.send("pose", { x: 0, y: 0, z });
    await sleep(60);
    const pv = room.state.players.get(victim.sessionId)!;
    for (let s = 1; s <= 10 && pv.life === "alive"; s++) {
      shooter.send("hit", { t: victim.sessionId, w: "striker", s, n: 1, h: 1, d: 5 });
      await sleep(110);
    }
    assert.strictEqual(pv.life, "knocked");
    helper.send("leave"); // never hit: just leaves
    await until(() => pv.life === "dead", 1000, "wiped");
    assert.strictEqual(room.state.players.get(shooter.sessionId)!.kills, 1, "credited to the knocker");
  });

  it("leaving before the fight (vote, intro, countdown) costs nothing", async () => {
    const { room, clients } = await startRound(colyseus);
    const [a, b] = clients;
    const bGot: any[] = [];
    b.onMessage("rewards", (r) => bGot.push(r));
    // Hold the round in its countdown.
    (room as any).setPhase("countdown", 30);
    b.send("leave");
    await until(() => !room.state.players.get(b.sessionId)!.inMatch, 1000, "left");
    await sleep(150);
    assert.strictEqual(bGot.length, 0, "no penalty, no rewards");
    assert.strictEqual((room as any).sessions.get(b.sessionId).profile.stats.matches, 0, "not counted as a match");
    assert.ok(["ending", "results", "waiting"].includes(room.state.phase), "the other side forfeits");
    void a;
  });

  it("a grenade thrown before leaving does no damage after", async () => {
    const { room, clients } = await startRound(colyseus, 3);
    const team = room.state.players.get(clients[0].sessionId)!.team;
    const mates = clients.filter((c) => room.state.players.get(c.sessionId)!.team === team);
    const foes = clients.filter((c) => room.state.players.get(c.sessionId)!.team !== team);
    const [thrower, mate] = mates.length === 2 ? mates : foes;
    const enemy = mates.length === 2 ? foes[0] : mates[0];
    for (const [c, z] of [[thrower, 0], [mate, 3], [enemy, 3.5]] as const) c.send("pose", { x: 0, y: 0, z });
    await sleep(60);
    thrower.send("throw", { p: [0, 1, 0], v: [0, 4, 10] });
    await sleep(40);
    thrower.send("leave");
    await sleep(60);
    thrower.send("boom", { x: 0, y: 1, z: 3, t: [mate.sessionId, enemy.sessionId] });
    await sleep(100);
    assert.strictEqual(room.state.players.get(mate.sessionId)!.hp, 200, "former teammate untouched");
    assert.strictEqual(room.state.players.get(enemy.sessionId)!.hp, 200, "enemy untouched");
  });
});
