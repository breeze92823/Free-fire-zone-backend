import { matchMaker } from "colyseus";

import { apiUrl } from "./auth.js";
import { REPORT_BATCH, REPORT_EVERY_MS } from "./constants.js";

// Bloxity reporting, all best-effort and silent without the env Legion injects into the pod:
// - installRoomReporter(): the cross-pod room directory behind the game page's Open Rooms list and
//   friend joins (MATCHMAKER_REPORT_URL + BLOXITY_REPORT_TOKEN + BLOXITY_GAME_ID).
// - queueScores() / queueStats(): server-side leaderboard scores and player stats, batched every
//   REPORT_EVERY_MS and at round end (flushReports), only for verified `legion_` identities.

const env = () => ({
  token: process.env.BLOXITY_REPORT_TOKEN || "",
  gameId: process.env.BLOXITY_GAME_ID || "",
  reportUrl: (process.env.MATCHMAKER_REPORT_URL || "").replace(/\/$/, ""),
});

async function post(url: string, token: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  return res.json().catch((): null => null);
}

// --- Open Rooms ---------------------------------------------------------------------------------
export function installRoomReporter(): void {
  const { token, gameId, reportUrl } = env();
  if (!token || !gameId || !reportUrl) return;
  const podName = process.env.POD_NAME || process.env.HOSTNAME || "";
  const tick = async () => {
    try {
      const listings = await matchMaker.query({});
      const rooms = listings.map((l: any) => ({
        colyseusRoomId: l.roomId,
        name: l.name || undefined,
        clients: l.clients ?? 0,
        maxClients: l.maxClients ?? 0,
        locked: !!l.locked,
        private: !!l.private,
        // Always false: the Open Rooms list shows `started` rooms as "Locked", and ours stay joinable.
        started: false,
        metadata: l.metadata ?? {},
      }));
      const players = rooms.reduce((n, r) => n + r.clients, 0);
      await post(`${reportUrl}/${gameId}/rooms`, token, { podName, players, rooms });
    } catch {
      // Best effort: the directory tolerates gaps.
    }
  };
  void tick();
  setInterval(() => void tick(), 2000).unref();
}

// --- Leaderboards + stats ----------------------------------------------------------------------
// Board ids match the client's config.js LEADERBOARDS (declared there with leaderboard.define).
export const BOARDS = [
  { id: "eliminations", label: "Total eliminations", order: "desc", mode: "sum", format: "compact", reset: "none" },
  { id: "wins", label: "Match wins", order: "desc", mode: "sum", format: "number", reset: "none" },
  { id: "best_match", label: "Best match (eliminations)", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "weekly_elims", label: "Eliminations this week", order: "desc", mode: "sum", format: "compact", reset: "weekly" },
];

export const STAT_DEFINITIONS = [
  { key: "eliminations", label: "Eliminations", type: "number", sortOrder: 1 },
  { key: "wins", label: "Wins", type: "number", sortOrder: 2 },
  { key: "matches", label: "Matches played", type: "number", sortOrder: 3 },
  { key: "deaths", label: "Times eliminated", type: "number", sortOrder: 4 },
  { key: "damage", label: "Damage dealt", type: "number", sortOrder: 5 },
  { key: "best", label: "Best match (eliminations)", type: "number", sortOrder: 6 },
  { key: "coins", label: "Coins", type: "currency", sortOrder: 7 },
];
const STAT_CEILING = { number: 1_000_000_000, currency: 1_000_000_000_000 } as const;

let scores: { board: string; userId: string; score: number }[] = [];
const stats = new Map<string, Record<string, number>>(); // userId -> latest values

export function queueScores(userId: string | null, entries: Record<string, number>) {
  if (!userId) return;
  for (const [board, score] of Object.entries(entries)) {
    if (Number.isFinite(score) && score > 0) scores.push({ board, userId, score: Math.round(score) });
  }
}

export function queueStats(userId: string | null, values: Record<string, number>) {
  if (!userId) return;
  const clean: Record<string, number> = {};
  for (const d of STAT_DEFINITIONS) {
    const v = values[d.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    clean[d.key] = Math.max(0, Math.min(STAT_CEILING[d.type as keyof typeof STAT_CEILING], Math.round(v)));
  }
  stats.set(userId, clean);
}

let flushing = false;
export async function flushReports() {
  const { token, gameId } = env();
  if (!token || !gameId) {
    scores = [];
    stats.clear();
    return;
  }
  if (flushing) return;
  flushing = true;
  try {
    while (scores.length) {
      const batch = scores.splice(0, REPORT_BATCH);
      try {
        await post(`${apiUrl()}/v1/leaderboards/hosted/${gameId}/report`, token, { boards: BOARDS, scores: batch });
      } catch (err) {
        console.warn("[report] leaderboard report failed", (err as Error).message);
      }
    }
    const players = [...stats.entries()].map(([userId, values]) => ({ userId, values }));
    stats.clear();
    for (let i = 0; i < players.length; i += REPORT_BATCH) {
      try {
        await post(`${apiUrl()}/v1/games/${gameId}/stats`, token, { definitions: STAT_DEFINITIONS, players: players.slice(i, i + REPORT_BATCH) });
      } catch (err) {
        console.warn("[report] stats report failed", (err as Error).message);
      }
    }
  } finally {
    flushing = false;
  }
}

export function installReporters() {
  installRoomReporter();
  setInterval(() => void flushReports(), REPORT_EVERY_MS).unref();
}
