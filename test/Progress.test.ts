import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { PHASES } from "../src/rules.js";
import { TIMING } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { normalizeProfile } from "../src/catalog.js";
import { MISSIONS, claimMission, countRound, dayKey, emptyMissions, normalizeMissions, payRankUps, refreshMissions, weekKey } from "../src/progress.js";
import { sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

const NONE = { play: 0, win: 0, elims: 0, knocks: 0, damage: 0, headshots: 0, assists: 0, revives: 0, wrecks: 0, rams: 0 };

describe("missions and rank rewards (progress.ts)", () => {
  it("rolls a daily set each UTC day and a weekly set each Monday", () => {
    const m = emptyMissions();
    const mon = Date.UTC(2026, 10, 9, 12); // Monday 9 Nov 2026
    assert.strictEqual(refreshMissions(m, mon), true);
    assert.strictEqual(m.daily.length, MISSIONS.perDay);
    assert.strictEqual(m.weekly.length, MISSIONS.perWeek);
    assert.strictEqual(new Set(m.daily.map((s) => s.id)).size, MISSIONS.perDay, "no repeats");
    assert.strictEqual(refreshMissions(m, mon + 3600e3), false, "same day: kept");
    const weekly = JSON.stringify(m.weekly);
    assert.strictEqual(refreshMissions(m, Date.UTC(2026, 10, 15, 23)), true, "Sunday: a new day");
    assert.strictEqual(JSON.stringify(m.weekly), weekly, "still the same week");
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 15, 23)), "2026-11-09");
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 16, 0)), "2026-11-16");
    assert.strictEqual(dayKey(Date.UTC(2026, 10, 16, 0)), "2026-11-16");
  });

  it("counts a round, caps at the goal, and pays a finished mission once", () => {
    const p = { coins: 0, gems: 0, rp: 0, rankReward: 0, missions: emptyMissions() };
    p.missions.daily = [{ id: "d_elims", n: 8, claimed: false }];
    assert.deepStrictEqual(claimMission(p, "daily", 0), { error: "unfinished" });
    assert.deepStrictEqual(countRound(p.missions, { ...NONE, elims: 5 }), ["d_elims"]);
    assert.strictEqual(p.missions.daily[0].n, 10, "capped at the goal");
    assert.deepStrictEqual(countRound(p.missions, { ...NONE, elims: 5 }), [], "finished once");
    assert.deepStrictEqual(claimMission(p, "daily", 0), { id: "d_elims", coins: 150, gems: 20 });
    assert.deepStrictEqual([p.coins, p.gems], [150, 20]);
    assert.deepStrictEqual(claimMission(p, "daily", 0), { error: "claimed" });
    assert.deepStrictEqual(claimMission(p, "weekly", 5), { error: "unknown" });
    assert.deepStrictEqual(claimMission(p, "monthly", 0), { error: "unknown" });
  });

  it("drops forged mission data", () => {
    const m = normalizeMissions({ day: "2026-11-14", daily: [{ id: "d_elims", n: 999, claimed: true }, { id: "fake", n: 1 }, { id: "d_elims", n: 1 }], weekly: "x" });
    assert.deepStrictEqual(m.daily, [{ id: "d_elims", n: 10, claimed: true }]);
    assert.strictEqual(m.day, "", "an incomplete set is rolled again");
    assert.deepStrictEqual(normalizeMissions({ daily: [{ id: "d_win", n: 1, claimed: true }] }).daily[0].claimed, false, "unfinished cannot be claimed");
  });

  it("pays each rank once, and old saves get no back pay", () => {
    const p = { coins: 0, gems: 0, rp: 700, rankReward: 0, missions: emptyMissions() };
    assert.deepStrictEqual(payRankUps(p).map((r) => r.name), ["Silver", "Gold"]);
    assert.deepStrictEqual([p.coins, p.gems, p.rankReward], [800, 80, 2]);
    p.rp = 100;
    assert.deepStrictEqual(payRankUps(p), []);
    p.rp = 700;
    assert.deepStrictEqual(payRankUps(p), [], "regaining a rank pays nothing");
    const old = normalizeProfile({ rp: 2100, stats: { matches: 40 } });
    assert.strictEqual(old.rankReward, 4, "Diamond counts as paid");
    assert.strictEqual(old.tutorial, true, "a player with rounds behind them skips the tips");
    assert.strictEqual(normalizeProfile(null).tutorial, false);
  });
});

describe("missions in a round", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("a round finishes missions and a rank; the lobby claims the mission", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await colyseus.connectTo(room, { name: "Ann" });
    const b = await colyseus.connectTo(room, { name: "Bob" });
    const sa = (room as any).sessions.get(a.sessionId);
    await until(() => sa.loaded, 2000, "profile loaded");
    sa.profile.rp = 240;
    sa.profile.missions.day = dayKey(Date.now());
    sa.profile.missions.daily = [
      { id: "d_elims", n: 9, claimed: false },
      { id: "d_play", n: 2, claimed: false },
      { id: "d_win", n: 1, claimed: false },
    ];
    const got: any[] = [];
    const claims: any[] = [];
    const profiles: any[] = [];
    a.onMessage("rewards", (r) => got.push(r));
    a.onMessage("claimed", (r) => claims.push(r));
    a.onMessage("profile", (m) => profiles.push(m.profile));
    for (const c of [a, b]) c.send("play", { mode: "squad" });
    await until(() => room.state.phase === "playing", 3000, "playing");
    room.state.scoreToWin = 1;
    a.send("pose", { x: 0, y: 0, z: 0 });
    b.send("pose", { x: 0, y: 0, z: 5 });
    await sleep(60);
    for (let s = 1; s <= 8 && room.state.players.get(b.sessionId)!.life !== "dead"; s++) {
      a.send("hit", { t: b.sessionId, w: "striker", s, n: 1, h: 1, d: 5 });
      await sleep(110);
    }
    await until(() => got.length > 0, 2000, "rewards");
    assert.deepStrictEqual(got[0].missions.sort(), ["d_elims", "d_play", "d_win"]);
    assert.deepStrictEqual(got[0].rankUp, [{ rank: 1, name: "Silver", coins: 300, gems: 30 }]);
    const coins = sa.profile.coins;
    a.send("claim", { m: "daily", i: 0 });
    await until(() => claims.length > 0, 2000, "claimed");
    assert.deepStrictEqual(claims[0], { m: "daily", i: 0, id: "d_elims", coins: 150, gems: 20 });
    assert.strictEqual(sa.profile.coins, coins + 150);
    await until(() => profiles.some((p) => p.missions.daily[0].claimed), 2000, "profile shows it claimed");
    a.send("claim", { m: "daily", i: 0 });
    await until(() => claims.length > 1, 2000, "second claim");
    assert.strictEqual(claims[1].error, "claimed");
    assert.strictEqual(sa.profile.tutorial, false);
    a.send("tutorialDone");
    await until(() => sa.profile.tutorial === true, 2000, "tips remembered");
  });
});
