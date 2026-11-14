import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { PHASES } from "../src/rules.js";
import { INVITE_GAP_MS, TIMING } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

Object.assign(PHASES, { vote: 0.1, intro: 0.05, countdown: 0.05, ending: 0.05, results: 0.2 });
Object.assign(TIMING, { spawnGraceMs: 0, joinGraceMs: 0 });

// Connects a player that records the squad messages it receives.
async function join(colyseus: ColyseusTestServer<typeof appConfig>, room: any, name: string) {
  const c: any = await colyseus.connectTo(room, { name });
  c.notes = [] as any[];
  c.invites = [] as any[];
  c.ended = [] as any[];
  c.onMessage("squadNote", (m: any) => c.notes.push(m));
  c.onMessage("invite", (m: any) => c.invites.push(m));
  c.onMessage("inviteEnd", (m: any) => c.ended.push(m));
  return c;
}

describe("squad (lobby team)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });

  it("invite -> accept makes a squad with a leader; decline tells the inviter", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    const c = await join(colyseus, room, "Cy");
    a.send("invite", { to: b.sessionId });
    await until(() => b.invites.length === 1, 1000, "invite arrives");
    assert.strictEqual(b.invites[0].name, "Ann");
    assert.ok(a.notes.some((n: any) => n.kind === "sent" && n.name === "Bo"));
    b.send("inviteReply", { id: b.invites[0].id, accept: true });
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    await until(() => pb.squad && pb.squad === pa.squad, 1000, "same squad");
    assert.ok(pa.squadLead && !pb.squadLead, "the inviter leads");
    assert.ok(a.notes.some((n: any) => n.kind === "joined" && n.name === "Bo"));

    await sleep(INVITE_GAP_MS + 50);
    a.send("invite", { to: c.sessionId });
    await until(() => c.invites.length === 1, 1000, "second invite");
    c.send("inviteReply", { id: c.invites[0].id, accept: false });
    await until(() => a.notes.some((n: any) => n.kind === "declined" && n.name === "Cy"), 1000, "declined note");
    assert.strictEqual(room.state.players.get(c.sessionId)!.squad, "");
  });

  it("refuses invites to players in a team or a match, and past the team size", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    const c = await join(colyseus, room, "Cy");
    const d = await join(colyseus, room, "Di");
    const invite = async (from: any, to: any) => {
      await sleep(INVITE_GAP_MS + 50);
      from.send("invite", { to: to.sessionId });
    };
    await invite(a, b);
    await until(() => b.invites.length === 1);
    b.send("inviteReply", { id: b.invites[0].id, accept: true });
    await invite(a, c);
    await until(() => c.invites.length === 1);
    c.send("inviteReply", { id: c.invites[0].id, accept: true });
    const pa = room.state.players.get(a.sessionId)!;
    await until(() => room.state.players.get(c.sessionId)!.squad === pa.squad, 1000, "three in the squad");
    await invite(a, d);
    await until(() => a.notes.some((n: any) => n.kind === "full"), 1000, "full team");
    assert.strictEqual(d.invites.length, 0);
    // A player already in a team cannot be invited by someone else.
    const e = await join(colyseus, room, "Ed");
    await invite(e, b);
    await until(() => e.notes.some((n: any) => n.kind === "inTeam" && n.name === "Bo"), 1000, "already in a team");
    // A player who pressed Play (in the queue / a round) cannot view invitations.
    d.send("play", {});
    await until(() => room.state.players.get(d.sessionId)!.inMatch, 1000, "queued");
    await invite(e, d);
    await until(() => e.notes.some((n: any) => n.kind === "busy" && n.name === "Di"), 1000, "busy note");
  });

  it("invites expire", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    const priv = room as any;
    a.send("invite", { to: b.sessionId });
    await until(() => b.invites.length === 1);
    for (const inv of priv.invites.values()) inv.expires = Date.now() - 1;
    await until(() => b.ended.length === 1, 1000, "inviteEnd");
    assert.ok(a.notes.some((n: any) => n.kind === "expired" && n.name === "Bo"));
    b.send("inviteReply", { id: b.invites[0].id, accept: true });
    await sleep(80);
    assert.strictEqual(room.state.players.get(b.sessionId)!.squad, "", "an expired invite cannot be accepted");
  });

  it("only the leader presses Play, and the whole squad is queued and seated together", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    const solos = [await join(colyseus, room, "S1"), await join(colyseus, room, "S2"), await join(colyseus, room, "S3")];
    a.send("invite", { to: b.sessionId });
    await until(() => b.invites.length === 1);
    b.send("inviteReply", { id: b.invites[0].id, accept: true });
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    await until(() => pb.squad === pa.squad && !!pa.squad);
    b.send("play", {});
    await until(() => b.notes.some((n: any) => n.kind === "notLeader"), 1000, "member cannot start");
    assert.ok(!pb.inMatch && !pa.inMatch);
    for (const s of solos) s.send("play", {});
    a.send("play", { mode: "squad" });
    await until(() => pa.inMatch && pb.inMatch, 1000, "both queued by the leader");
    await until(() => room.state.phase === "playing", 3000, "playing");
    assert.ok(pa.team && pa.team === pb.team, "the squad shares a team");
    const sameSide = solos.filter((s) => room.state.players.get(s.sessionId)!.team === pa.team).length;
    assert.strictEqual(sameSide, 1, "3 per side: one solo joins the squad's side");
  });

  it("leaving hands the lead over; a squad of one dissolves; leaving the room leaves the squad", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    const c = await join(colyseus, room, "Cy");
    const team = async (inviter: any, to: any) => {
      await sleep(INVITE_GAP_MS + 50);
      const n = to.invites.length;
      inviter.send("invite", { to: to.sessionId });
      await until(() => to.invites.length === n + 1);
      to.send("inviteReply", { id: to.invites[n].id, accept: true });
      await until(() => room.state.players.get(to.sessionId)!.squad);
    };
    await team(a, b);
    await team(a, c);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    const pc = room.state.players.get(c.sessionId)!;
    a.send("leaveSquad");
    await until(() => !pa.squad, 1000, "leader left");
    assert.ok(pb.squad && pb.squad === pc.squad);
    assert.ok(pb.squadLead !== pc.squadLead, "exactly one new leader");
    assert.ok(b.notes.some((n: any) => n.kind === "left" && n.name === "Ann"));
    await c.leave();
    await until(() => !pb.squad, 2000, "a squad of one dissolves");
    assert.ok(!pb.squadLead);
  });

  it("the leader can remove a member before queueing", async () => {
    const room = await colyseus.createRoom<MatchState>("match", {});
    const a = await join(colyseus, room, "Ann");
    const b = await join(colyseus, room, "Bo");
    a.send("invite", { to: b.sessionId });
    await until(() => b.invites.length === 1);
    b.send("inviteReply", { id: b.invites[0].id, accept: true });
    const pb = room.state.players.get(b.sessionId)!;
    await until(() => !!pb.squad);
    b.send("kick", { t: a.sessionId }); // a member cannot
    await sleep(60);
    assert.ok(pb.squad, "unchanged");
    a.send("kick", { t: b.sessionId });
    await until(() => !pb.squad, 1000, "kicked");
    assert.ok(b.notes.some((n: any) => n.kind === "youKicked"));
    assert.strictEqual(room.state.players.get(a.sessionId)!.squad, "", "a squad of one dissolves");
  });
});
