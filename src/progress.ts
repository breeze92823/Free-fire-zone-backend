// Long-term goals that bring players back: daily / weekly missions and rank-up rewards.
//
// Missions: each UTC day the profile gets MISSIONS.perDay random daily missions, each week (Monday
// 00:00 UTC) MISSIONS.perWeek weekly ones. The server counts progress from what a round recorded
// (MatchRoom.grant); a finished mission is claimed from the lobby with `claim` and pays coins and the
// game's own Gems. Rank rewards: the first time a player's rank points reach a rank of RANKS, its
// reward is paid once (`rankReward` remembers the highest rank paid, so losing and regaining rank
// points never pays twice). Gems from here are earned by playing only; nothing here can be bought.
//
// Mirrored by hand in the client's config.js (MISSIONS, RANKS): ids, goals and rewards must match.
import { GEMS_MAX } from "./rules.js";

export type MissionStat = "play" | "win" | "elims" | "knocks" | "damage" | "headshots" | "assists" | "revives" | "wrecks" | "rams";
export interface MissionDef {
  id: string;
  stat: MissionStat;
  goal: number;
  coins: number;
  gems: number;
}
export type MissionKind = "daily" | "weekly";

export const MISSIONS: { perDay: number; perWeek: number; daily: MissionDef[]; weekly: MissionDef[] } = {
  perDay: 3,
  perWeek: 3,
  daily: [
    { id: "d_play", stat: "play", goal: 3, coins: 120, gems: 15 },
    { id: "d_win", stat: "win", goal: 2, coins: 150, gems: 20 },
    { id: "d_elims", stat: "elims", goal: 10, coins: 150, gems: 20 },
    { id: "d_knocks", stat: "knocks", goal: 8, coins: 120, gems: 15 },
    { id: "d_damage", stat: "damage", goal: 2500, coins: 150, gems: 20 },
    { id: "d_heads", stat: "headshots", goal: 15, coins: 130, gems: 15 },
    { id: "d_assists", stat: "assists", goal: 5, coins: 120, gems: 15 },
    { id: "d_revives", stat: "revives", goal: 2, coins: 120, gems: 15 },
    { id: "d_wreck", stat: "wrecks", goal: 1, coins: 140, gems: 18 }, // vehicles (Dustline Ridge)
  ],
  weekly: [
    { id: "w_play", stat: "play", goal: 20, coins: 600, gems: 80 },
    { id: "w_win", stat: "win", goal: 10, coins: 800, gems: 100 },
    { id: "w_elims", stat: "elims", goal: 60, coins: 800, gems: 100 },
    { id: "w_damage", stat: "damage", goal: 15000, coins: 700, gems: 90 },
    { id: "w_heads", stat: "headshots", goal: 80, coins: 700, gems: 90 },
    { id: "w_revives", stat: "revives", goal: 10, coins: 600, gems: 80 },
    { id: "w_wrecks", stat: "wrecks", goal: 5, coins: 700, gems: 90 },
    { id: "w_rams", stat: "rams", goal: 4, coins: 700, gems: 90 },
  ],
};

// Rank thresholds (the client's RANKS, same order) and the one-time reward for reaching each.
export const RANKS: { name: string; rp: number; coins: number; gems: number }[] = [
  { name: "Bronze", rp: 0, coins: 0, gems: 0 },
  { name: "Silver", rp: 250, coins: 300, gems: 30 },
  { name: "Gold", rp: 650, coins: 500, gems: 50 },
  { name: "Platinum", rp: 1200, coins: 800, gems: 80 },
  { name: "Diamond", rp: 2000, coins: 1200, gems: 120 },
  { name: "Heroic", rp: 3200, coins: 1800, gems: 180 },
  { name: "Grandmaster", rp: 5000, coins: 3000, gems: 300 },
];

export interface MissionSlot {
  id: string;
  n: number; // progress, capped at the goal
  claimed: boolean;
}
export interface Missions {
  day: string; // UTC date of the daily set ("2026-11-14"), "" = roll a new set
  week: string; // UTC date of the Monday that starts the weekly set
  daily: MissionSlot[];
  weekly: MissionSlot[];
}

const byId = new Map<string, MissionDef>([...MISSIONS.daily, ...MISSIONS.weekly].map((m) => [m.id, m]));
export const missionDef = (id: string) => byId.get(id);

export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
export function weekKey(now: number): string {
  const d = new Date(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
}

export const emptyMissions = (): Missions => ({ day: "", week: "", daily: [], weekly: [] });

function pick(pool: MissionDef[], count: number): MissionSlot[] {
  const left = [...pool];
  const out: MissionSlot[] = [];
  while (out.length < count && left.length) {
    const [m] = left.splice(Math.floor(Math.random() * left.length), 1);
    out.push({ id: m.id, n: 0, claimed: false });
  }
  return out;
}

// A new day / week replaces that set (unclaimed rewards of the old one are lost). True when changed.
export function refreshMissions(m: Missions, now = Date.now()): boolean {
  let changed = false;
  const day = dayKey(now);
  if (m.day !== day || m.daily.length !== MISSIONS.perDay) {
    m.day = day;
    m.daily = pick(MISSIONS.daily, MISSIONS.perDay);
    changed = true;
  }
  const week = weekKey(now);
  if (m.week !== week || m.weekly.length !== MISSIONS.perWeek) {
    m.week = week;
    m.weekly = pick(MISSIONS.weekly, MISSIONS.perWeek);
    changed = true;
  }
  return changed;
}

// A stored value -> valid missions (unknown ids dropped; a broken set is rolled again on refresh).
export function normalizeMissions(raw: any): Missions {
  const m = emptyMissions();
  if (!raw || typeof raw !== "object") return m;
  const slots = (v: unknown, pool: MissionDef[]): MissionSlot[] => {
    if (!Array.isArray(v)) return [];
    const out: MissionSlot[] = [];
    for (const s of v) {
      const def = pool.find((d) => d.id === s?.id);
      if (!def || out.some((o) => o.id === def.id)) continue;
      const n = typeof s.n === "number" && Number.isFinite(s.n) ? Math.max(0, Math.min(def.goal, Math.floor(s.n))) : 0;
      out.push({ id: def.id, n, claimed: s.claimed === true && n >= def.goal });
    }
    return out;
  };
  m.daily = slots(raw.daily, MISSIONS.daily);
  m.weekly = slots(raw.weekly, MISSIONS.weekly);
  if (typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) && m.daily.length === MISSIONS.perDay) m.day = raw.day;
  if (typeof raw.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.week) && m.weekly.length === MISSIONS.perWeek) m.week = raw.week;
  return m;
}

// Adds a round's numbers to every unclaimed mission; returns the ids that this round finished.
export function countRound(m: Missions, stats: Record<MissionStat, number>): string[] {
  const done: string[] = [];
  for (const s of [...m.daily, ...m.weekly]) {
    const def = byId.get(s.id);
    if (!def || s.claimed || s.n >= def.goal) continue;
    const add = Math.max(0, Math.floor(stats[def.stat] || 0));
    if (!add) continue;
    s.n = Math.min(def.goal, s.n + add);
    if (s.n >= def.goal) done.push(s.id);
  }
  return done;
}

interface Wallet {
  coins: number;
  gems: number;
  rp: number;
  rankReward: number;
  missions: Missions;
}

// Claims a finished mission: { m: "daily" | "weekly", i: slot index }. An error string, or what it paid.
export function claimMission(p: Wallet, kind: unknown, index: unknown): { error: string } | { id: string; coins: number; gems: number } {
  if (kind !== "daily" && kind !== "weekly") return { error: "unknown" };
  const list = p.missions[kind];
  const i = typeof index === "number" ? Math.floor(index) : -1;
  const s = list[i];
  const def = s && byId.get(s.id);
  if (!s || !def) return { error: "unknown" };
  if (s.claimed) return { error: "claimed" };
  if (s.n < def.goal) return { error: "unfinished" };
  s.claimed = true;
  p.coins += def.coins;
  p.gems = Math.min(GEMS_MAX, p.gems + def.gems);
  return { id: s.id, coins: def.coins, gems: def.gems };
}

export function rankOf(rp: number): number {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if (rp >= RANKS[i].rp) r = i;
  return r;
}

// Pays every rank reached for the first time; returns what was paid (empty when nothing new).
export function payRankUps(p: Wallet): { rank: number; name: string; coins: number; gems: number }[] {
  const out: { rank: number; name: string; coins: number; gems: number }[] = [];
  const now = rankOf(p.rp);
  while (p.rankReward < now) {
    p.rankReward++;
    const r = RANKS[p.rankReward];
    p.coins += r.coins;
    p.gems = Math.min(GEMS_MAX, p.gems + r.gems);
    out.push({ rank: p.rankReward, name: r.name, coins: r.coins, gems: r.gems });
  }
  return out;
}
