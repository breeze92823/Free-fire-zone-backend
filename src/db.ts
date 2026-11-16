import { MongoClient, type Collection } from "mongodb";

import { normalizeProfile, type Profile } from "./catalog.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// One player's saved progress, keyed by the verified Bloxity user id (never a client-sent id).
export interface PlayerDoc extends Profile {
  _id: string;
  username?: string; // display name as of the last save
  carried?: boolean; // a guest's progress was already carried into this account (once)
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    // The friend invite offer counts the accounts an inviter brought in (saveProfile writes offer.by / offer.at).
    await players.createIndex({ "offer.by": 1, "offer.at": 1 }, { sparse: true }).catch((err) => console.warn("[db] index failed", err));
    console.log("[db] connected to MongoDB");
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}

// The profile for an account: its saved doc, else (a brand new account that played as a guest
// before signing in) the newest of the guest saves listed in `carriedFrom`, else a fresh one.
// `found` is false when nothing was stored. Throws when the database errors (the caller keeps
// saving off so a save that could not be read is never overwritten).
export async function loadProfile(userId: string, carriedFrom: string[] = []): Promise<{ profile: Profile; found: boolean; carried: boolean }> {
  const col = getPlayers();
  if (!col) return { profile: normalizeProfile(null), found: false, carried: false };
  const doc = await col.findOne({ _id: userId });
  if (doc) return { profile: normalizeProfile(doc), found: true, carried: false };
  let best: PlayerDoc | null = null;
  for (const id of carriedFrom.slice(0, 5)) {
    if (typeof id !== "string" || !id || id === userId) continue;
    const g = await col.findOne({ _id: id });
    if (g && !g.carried && (!best || g.updatedAt > best.updatedAt)) best = g;
  }
  if (!best) return { profile: normalizeProfile(null), found: false, carried: false };
  // Carried once: the guest save is marked so it never seeds a second account.
  await col.updateOne({ _id: best._id }, { $set: { carried: true } });
  return { profile: normalizeProfile(best), found: false, carried: true };
}

export async function saveProfile(userId: string, username: string, profile: Profile): Promise<boolean> {
  const col = getPlayers();
  if (!col) return false;
  try {
    await col.updateOne(
      { _id: userId },
      { $set: { ...profile, username, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    console.warn("[db] saveProfile failed", err);
    return false;
  }
}

// Friend invite offer without Mongo (a plain local `npm start`): nothing is saved, so the offer
// would never count a join and its window would restart on every load. This process-lifetime copy
// keeps each account's window start and who was brought in by whom, for local testing only (a
// real deploy always has Mongo, which keeps the same facts on the player documents).
const memStarts = new Map<string, number>();
const memJoins = new Map<string, { by: string; at: number }>(); // joiner -> credited inviter

// The moment an account's offer window opened: now, or (no Mongo) the first time this process saw it.
export function offerStartFor(userId: string): number {
  if (getPlayers()) return Date.now();
  let t = memStarts.get(userId);
  if (!t) memStarts.set(userId, (t = Date.now()));
  return t;
}

// No Mongo: credit `joiner` to `inviter` once. Returns false when this joiner was already credited.
export function recordMemInvite(inviter: string, joiner: string, at: number): boolean {
  if (getPlayers() || memJoins.has(joiner)) return false;
  memJoins.set(joiner, { by: inviter, at });
  return true;
}

// Test-only seam: forget the in-memory offer data.
export function __resetOfferMemoryForTest(): void {
  memStarts.clear();
  memJoins.clear();
}

// How many accounts joined through `inviterId`'s invite link between two moments (ms, inclusive):
// the friend invite offer's progress. 0 when Mongo errors.
export async function countInvited(inviterId: string, from: number, to: number): Promise<number> {
  const col = getPlayers();
  if (!inviterId) return 0;
  if (!col) return [...memJoins.values()].filter((j) => j.by === inviterId && j.at >= from && j.at <= to).length;
  try {
    return await col.countDocuments({ "offer.by": inviterId, "offer.at": { $gte: from, $lte: to } });
  } catch (err) {
    console.warn("[db] countInvited failed", err);
    return 0;
  }
}
