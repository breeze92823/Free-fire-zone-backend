import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { MatchState } from "../src/rooms/schema/MatchState.js";
import { __resetOfferMemoryForTest, __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { normalizeProfile } from "../src/catalog.js";
import { FRIEND_OFFER } from "../src/rules.js";
import { fakePlayers, sleep, until } from "./fakePlayers.js";
import { testServer } from "./server.js";

// Friend invite offer: two NEW accounts through an invite link = the Bulldog Drum, free.
describe("friend invite offer", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    __setPlayersForTest(null);
    __setVerifierForTest(null);
    await colyseus.cleanup();
  });
  after(() => __setPlayersForTest(null));

  const join = async (room: any, devUser: string, inv?: string) => {
    const c = await colyseus.connectTo(room, { devUser, name: devUser, inv });
    const msgs: any[] = [];
    c.onMessage("inviteOffer", (m) => msgs.push(m));
    const s = () => (room as any).sessions.get(c.sessionId);
    // Ask for the status now (the rate limit is shortened by resetting its clock).
    const poll = () => {
      s().offerAt = 0;
      c.send("offerPoll");
    };
    return { c, msgs, s, poll };
  };

  it("opens the window on first load, counts new friends, grants the weapon once", async () => {
    const db = fakePlayers();
    __setPlayersForTest(db);
    const room = await colyseus.createRoom<MatchState>("match", {});
    const host = await join(room, "dev-host1");
    await until(() => host.s().loaded && host.s().profile.offer.start > 0, 2000, "window opened");
    host.poll();
    await until(() => host.msgs.length > 0, 2000, "first offer status");
    assert.strictEqual(host.msgs[0].joined, 0);
    assert.strictEqual(host.msgs[0].me, "dev-host1");
    assert.strictEqual(host.msgs[0].end - host.msgs[0].start, FRIEND_OFFER.hours * 3600e3);
    assert.strictEqual(host.s().profile.owned.weapons.includes("bulldog"), false);

    // The friend arrives through the link: credited to the host.
    const f1 = await join(room, "dev-friend1", "dev-host1");
    await until(() => f1.s().loaded && db.docs.get("dev-friend1")?.offer?.by === "dev-host1", 2000, "friend credited");
    host.poll();
    await until(() => host.msgs.some((m) => m.joined === 1), 2000, "one friend");
    assert.strictEqual(host.s().profile.offer.claimed, false);

    // The same friend again, or an existing account, or oneself, never counts.
    await join(room, "dev-friend1", "dev-host1");
    const solo = await join(room, "dev-solo1", "dev-solo1");
    await until(() => solo.s().loaded && solo.s().profile.offer.start > 0, 2000, "solo loaded");
    assert.strictEqual(solo.s().profile.offer.by, "", "no self invite");
    const old = fakePlayers([{ _id: "dev-old1", ...normalizeProfile(null) } as any]);
    for (const [k, v] of old.docs) db.docs.set(k, v);
    await join(room, "dev-old1", "dev-host1");
    assert.strictEqual(db.docs.get("dev-old1")?.offer?.by ?? "", "");

    const f2 = await join(room, "dev-friend2", "dev-host1");
    await until(() => db.docs.get("dev-friend2")?.offer?.by === "dev-host1", 2000, "second friend credited");
    host.poll();
    await until(() => host.msgs.some((m) => m.granted), 2000, "reward granted");
    assert.strictEqual(host.s().profile.owned.weapons.includes("bulldog"), true);
    assert.strictEqual(host.s().profile.offer.claimed, true);
    assert.strictEqual(db.docs.get("dev-host1").owned.weapons.includes("bulldog"), true, "saved");
    // Not granted again.
    host.poll();
    await until(() => host.msgs.filter((m) => m.claimed).length >= 2, 2000, "claimed status twice");
    assert.strictEqual(host.msgs.filter((m) => m.granted).length, 1);
    void f2;
  });

  it("only joins inside the window count, and the popup is shown once", async () => {
    const db = fakePlayers([
      { _id: "dev-late1", ...normalizeProfile({ offer: { start: Date.now() - (FRIEND_OFFER.hours + 1) * 3600e3 } }) } as any,
    ]);
    __setPlayersForTest(db);
    const room = await colyseus.createRoom<MatchState>("match", {});
    // Two friends came, but after the window closed.
    for (const id of ["dev-fa1", "dev-fb1"]) db.docs.set(id, { _id: id, ...normalizeProfile({ offer: { start: 1, by: "dev-late1", at: Date.now() } }) });
    const late = await join(room, "dev-late1");
    await until(() => late.s().loaded && late.s().profile.offer.start > 0, 2000, "loaded");
    late.poll();
    await until(() => late.msgs.length > 0, 2000, "status");
    assert.strictEqual(late.msgs[0].joined, 0);
    assert.strictEqual(late.msgs[0].claimed, false);
    assert.strictEqual(late.msgs[0].seen, false);
    late.c.send("offerSeen");
    await until(() => late.s().profile.offer.seen === true, 2000, "seen");
    assert.strictEqual(db.docs.get("dev-late1").offer.seen, true);
  });

  it("counts joins without Mongo too (local testing), keeping the window across reloads", async () => {
    __setPlayersForTest(null);
    __resetOfferMemoryForTest();
    const room = await colyseus.createRoom<MatchState>("match", {});
    const host = await join(room, "dev-nodbhost");
    await until(() => host.s().loaded && host.s().profile.offer.start > 0, 2000, "window opened");
    const start = host.s().profile.offer.start;
    await sleep(30);
    await join(room, "dev-nodbf1", "dev-nodbhost");
    await join(room, "dev-nodbf2", "dev-nodbhost");
    await sleep(100);
    host.poll();
    await until(() => host.msgs.some((m) => m.granted), 2000, "reward without a database");
    assert.strictEqual(host.s().profile.owned.weapons.includes("bulldog"), true);
    // The host reloads: same window start, nothing counted twice.
    const again = await join(room, "dev-nodbhost");
    await until(() => again.s().loaded && again.s().profile.offer.start > 0, 2000, "reloaded");
    assert.strictEqual(again.s().profile.offer.start, start);
  });

  it("ignores a forged inviter id and never credits guests", async () => {
    __setPlayersForTest(fakePlayers());
    const room = await colyseus.createRoom<MatchState>("match", {});
    const g = await join(room, "x", "../../etc");
    await until(() => g.s()?.loaded, 2000, "guest loaded");
    assert.strictEqual(g.s().inviter, "");
    assert.strictEqual(g.s().profile.offer.by, "");
  });
});
