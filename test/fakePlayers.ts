import type { Collection } from "mongodb";

import type { PlayerDoc } from "../src/db.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits until fn() is truthy (polls every 10 ms), or throws after `ms`.
export async function until(fn: () => unknown, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Just what the server calls: findOne() and updateOne() (upsert, $set, $setOnInsert).
export function fakePlayers(seed: Partial<PlayerDoc>[] = []) {
  const docs = new Map<string, any>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    // The friend invite offer's count: { "offer.by": id, "offer.at": { $gte, $lte } }.
    async countDocuments(filter: any) {
      const range = filter["offer.at"] ?? {};
      return [...docs.values()].filter((d) => d.offer?.by === filter["offer.by"] && d.offer.at >= (range.$gte ?? 0) && d.offer.at <= (range.$lte ?? Infinity)).length;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return { modifiedCount: 0 };
      const next: any = { ...(existing ?? { _id: filter._id, ...(update.$setOnInsert ?? {}) }), ...(update.$set ?? {}) };
      docs.set(filter._id, next);
      return { modifiedCount: 1 };
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, any> };
}
