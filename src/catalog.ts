import { GEMS_MAX } from "./rules.js";
import { ID_PATTERN_USER } from "./constants.js";
import { RANKS, emptyMissions, normalizeMissions, rankOf, type Missions } from "./progress.js";

// Shop prices and the starting profile: a copy of the client's src/config.js WEAPONS / SKINS /
// OPERATIVES / STORE / GRENADES / PASSES / START_PROFILE (RANKS and MISSIONS: progress.ts). Keep in
// step with it by hand.
// Skins, operatives and the Store are priced in coins; weapons, grenades and passes in the game's
// own Gems (`gems`, earned by eliminations and rounds, rules.ts GEMS). Both are earned by playing
// only: nothing is ever sold for premium currency (Bloxity Gems) or real money.

// Weapons are priced in the game's own Gems (earned by playing, never sold). Weapons already
// bought with coins before the Gem store stay owned.
export const WEAPON_PRICES: Record<string, { slot: "primary" | "secondary" | "melee" | "fists"; price: number }> = {
  striker: { slot: "primary", price: 0 },
  viper: { slot: "secondary", price: 0 },
  hornet: { slot: "secondary", price: 600 },
  talon: { slot: "secondary", price: 1200 },
  wasp: { slot: "secondary", price: 900 },
  ridgeback: { slot: "primary", price: 1500 },
  kestrel: { slot: "primary", price: 1800 },
  tempest: { slot: "primary", price: 2400 },
  marksman: { slot: "primary", price: 2200 },
  hawk: { slot: "primary", price: 3500 },
  thunder: { slot: "primary", price: 1200 },
  breaker: { slot: "primary", price: 1500 },
  cyclone: { slot: "primary", price: 2600 },
  ronin: { slot: "secondary", price: 2500 },
  mender: { slot: "secondary", price: 3000 },
  // Second wave
  gnat: { slot: "secondary", price: 1100 },
  mantis: { slot: "secondary", price: 1300 },
  drifter: { slot: "secondary", price: 800 },
  falcon: { slot: "primary", price: 2000 },
  sentinel: { slot: "primary", price: 1900 },
  sparrow: { slot: "primary", price: 2000 },
  whisper: { slot: "primary", price: 2300 },
  osprey: { slot: "primary", price: 2600 },
  ranger: { slot: "primary", price: 1400 },
  bulldog: { slot: "secondary", price: 1600 },
  swarm: { slot: "secondary", price: 1700 },
  sawback: { slot: "secondary", price: 1300 },
  rattler: { slot: "primary", price: 1800 },
  machete: { slot: "melee", price: 700 },
  crowbar: { slot: "melee", price: 600 },
  pan: { slot: "melee", price: 900 },
  quill: { slot: "primary", price: 2100 },
  thumper: { slot: "primary", price: 3200 },
  rhino: { slot: "primary", price: 4000 },
  knife: { slot: "melee", price: 0 },
  fists: { slot: "fists", price: 0 },
};
// Throwables (T), in Gems; `frag` is the starter.
export const GRENADE_PRICES: Record<string, number> = { frag: 0, pulse: 800, breach: 1200, leech: 1000, molotov: 1100, smoke: 500, flash: 700 };
// A pass unlocks a set of weapons for good (also ones added to it later), in Gems.
export const PASSES: Record<string, { price: number; weapons: string[] }> = {
  basic: { price: 3500, weapons: ["hornet", "talon", "wasp", "ridgeback", "thunder", "breaker"] },
};

export const SKIN_PRICES: Record<string, number> = {
  standard: 0,
  desert: 600,
  jungle: 900,
  arctic: 1100,
  crimson: 1500,
  neon: 1800,
  gold: 2600,
};

export const OPERATIVE_PRICES: Record<string, number> = { rook: 0, nova: 1200, jin: 1500, shade: 2000 };

export type StoreItem =
  | { id: string; type: "upgrade"; max: number; price: number }
  | { id: string; type: "emote"; emote: string; price: number };

export const STORE: StoreItem[] = [
  { id: "medkits", type: "upgrade", max: 2, price: 900 },
  { id: "walls", type: "upgrade", max: 2, price: 1000 },
  { id: "frags", type: "upgrade", max: 2, price: 1100 },
  { id: "armor", type: "upgrade", max: 2, price: 2400 },
  { id: "emote_dance", type: "emote", emote: "dance", price: 500 },
  { id: "emote_salute", type: "emote", emote: "salute", price: 350 },
  { id: "emote_flex", type: "emote", emote: "flex", price: 650 },
  { id: "emote_cheer", type: "emote", emote: "cheer", price: 450 },
];

export const EMOTES = ["wave", "dance", "salute", "flex", "cheer"];
export const MODES = ["clash", "squad"];

export interface Profile {
  coins: number;
  gems: number; // the game's own currency, earned by eliminations (never bought)
  rp: number;
  owned: { weapons: string[]; skins: string[]; operatives: string[]; emotes: string[]; grenades: string[]; passes: string[] };
  loadout: { primary: string; secondary: string; melee: string; operative: string; emote: string; grenade: string; skin: Record<string, string> };
  upgrades: Record<string, number>;
  stats: { matches: number; wins: number; eliminations: number; deaths: number; damage: number; best: number };
  mode: string;
  missions: Missions; // daily / weekly missions (progress.ts)
  rankReward: number; // highest RANKS index whose one-time reward was paid
  tutorial: boolean; // the first-round tips were finished (or skipped)
  newsSeen: number; // the newest lobby announcement (client config.js NEWS.id) the player has closed
  offer: FriendOffer; // the friend invite offer (rules.ts FRIEND_OFFER)
}

// The friend invite offer's state on this account. `start` (ms) is when its window opened (0 = not yet:
// the server sets it the first time the account loads), `seen` = the lobby popup was closed, `claimed` =
// the reward was granted, `by` / `at` = the account whose link brought this one in and when (only a
// brand-new account can be brought in, once).
export interface FriendOffer {
  start: number;
  seen: boolean;
  claimed: boolean;
  by: string;
  at: number;
}

export const START_PROFILE: Profile = {
  coins: 600,
  gems: 0,
  rp: 0,
  owned: { weapons: ["striker", "viper", "knife", "fists"], skins: ["standard"], operatives: ["rook"], emotes: ["wave"], grenades: ["frag"], passes: [] },
  loadout: { primary: "striker", secondary: "viper", melee: "knife", operative: "rook", emote: "wave", grenade: "frag", skin: { striker: "standard", viper: "standard" } },
  upgrades: {},
  stats: { matches: 0, wins: 0, eliminations: 0, deaths: 0, damage: 0, best: 0 },
  mode: "clash",
  missions: emptyMissions(),
  rankReward: 0,
  tutorial: false,
  newsSeen: 0,
  offer: { start: 0, seen: false, claimed: false, by: "", at: 0 },
};

export const COINS_MAX = 1e12;
export const NEWS_MAX = 1e6; // announcement ids are small counters
export const RP_MAX = 1e9;

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
const ids = (v: unknown, known: (id: string) => boolean) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && known(x)))] : [];

// A stored (or legacy) document -> a valid profile: unknown ids dropped, starter items always
// owned, equipped items always owned.
export function normalizeProfile(raw: any): Profile {
  const p = clone(START_PROFILE);
  if (!raw || typeof raw !== "object") return p;
  p.coins = num(raw.coins, COINS_MAX);
  p.gems = num(raw.gems, GEMS_MAX);
  p.rp = num(raw.rp, RP_MAX);
  p.owned.weapons = [...new Set([...START_PROFILE.owned.weapons, ...ids(raw.owned?.weapons, (id) => id in WEAPON_PRICES)])];
  p.owned.skins = [...new Set([...START_PROFILE.owned.skins, ...ids(raw.owned?.skins, (id) => id in SKIN_PRICES)])];
  p.owned.operatives = [...new Set([...START_PROFILE.owned.operatives, ...ids(raw.owned?.operatives, (id) => id in OPERATIVE_PRICES)])];
  p.owned.emotes = [...new Set([...START_PROFILE.owned.emotes, ...ids(raw.owned?.emotes, (id) => EMOTES.includes(id))])];
  p.owned.grenades = [...new Set([...START_PROFILE.owned.grenades, ...ids(raw.owned?.grenades, (id) => id in GRENADE_PRICES)])];
  p.owned.passes = ids(raw.owned?.passes, (id) => id in PASSES);
  // A pass keeps unlocking its whole set, including weapons added to it later.
  for (const pass of p.owned.passes) p.owned.weapons = [...new Set([...p.owned.weapons, ...PASSES[pass].weapons])];
  const lo = raw.loadout ?? {};
  if (p.owned.weapons.includes(lo.primary) && WEAPON_PRICES[lo.primary].slot === "primary") p.loadout.primary = lo.primary;
  if (p.owned.weapons.includes(lo.secondary) && WEAPON_PRICES[lo.secondary].slot === "secondary") p.loadout.secondary = lo.secondary;
  if (p.owned.weapons.includes(lo.melee) && WEAPON_PRICES[lo.melee].slot === "melee") p.loadout.melee = lo.melee;
  if (p.owned.operatives.includes(lo.operative)) p.loadout.operative = lo.operative;
  if (p.owned.emotes.includes(lo.emote)) p.loadout.emote = lo.emote;
  if (p.owned.grenades.includes(lo.grenade)) p.loadout.grenade = lo.grenade;
  if (lo.skin && typeof lo.skin === "object") {
    for (const [w, s] of Object.entries(lo.skin)) {
      if (w in WEAPON_PRICES && typeof s === "string" && p.owned.skins.includes(s)) p.loadout.skin[w] = s;
    }
  }
  for (const item of STORE) {
    if (item.type === "upgrade") {
      const lv = num(raw.upgrades?.[item.id], item.max);
      if (lv) p.upgrades[item.id] = lv;
    }
  }
  for (const k of Object.keys(p.stats) as (keyof Profile["stats"])[]) p.stats[k] = num(raw.stats?.[k], 1e12);
  if (MODES.includes(raw.mode)) p.mode = raw.mode;
  p.missions = normalizeMissions(raw.missions);
  // A save from before rank rewards existed counts its current rank as paid (no back pay).
  p.rankReward = typeof raw.rankReward === "number" ? Math.max(0, Math.min(RANKS.length - 1, Math.floor(raw.rankReward))) : rankOf(p.rp);
  // Players who already finished a round before the tips existed do not get them.
  p.tutorial = raw.tutorial === true || (raw.tutorial === undefined && p.stats.matches > 0);
  p.newsSeen = num(raw.newsSeen, NEWS_MAX);
  const o = raw.offer;
  if (o && typeof o === "object") {
    p.offer = {
      start: num(o.start, 1e15),
      seen: o.seen === true,
      claimed: o.claimed === true,
      by: typeof o.by === "string" && ID_PATTERN_USER.test(o.by) ? o.by : "",
      at: num(o.at, 1e15),
    };
  }
  return p;
}

// --- Shop: each returns an error string, or null when the profile was changed ---------------
function spend(p: Profile, price: number): boolean {
  if (p.coins < price) return false;
  p.coins -= price;
  return true;
}
// Gems are only ever earned in matches; spending them is the only way they leave the profile.
function spendGems(p: Profile, price: number): boolean {
  if (p.gems < price) return false;
  p.gems -= price;
  return true;
}

export function buy(p: Profile, kind: unknown, id: unknown): string | null {
  if (typeof id !== "string") return "unknown";
  if (kind === "weapon") {
    const w = WEAPON_PRICES[id];
    if (!w) return "unknown";
    if (p.owned.weapons.includes(id)) return "owned";
    if (!spendGems(p, w.price)) return "gems";
    p.owned.weapons.push(id);
    return null;
  }
  if (kind === "grenade") {
    if (!(id in GRENADE_PRICES)) return "unknown";
    if (p.owned.grenades.includes(id)) return "owned";
    if (!spendGems(p, GRENADE_PRICES[id])) return "gems";
    p.owned.grenades.push(id);
    return null;
  }
  if (kind === "pass") {
    const pass = PASSES[id];
    if (!pass) return "unknown";
    if (p.owned.passes.includes(id)) return "owned";
    if (!spendGems(p, pass.price)) return "gems";
    p.owned.passes.push(id);
    p.owned.weapons = [...new Set([...p.owned.weapons, ...pass.weapons])];
    return null;
  }
  if (kind === "skin") {
    if (!(id in SKIN_PRICES)) return "unknown";
    if (p.owned.skins.includes(id)) return "owned";
    if (!spend(p, SKIN_PRICES[id])) return "coins";
    p.owned.skins.push(id);
    return null;
  }
  if (kind === "operative") {
    if (!(id in OPERATIVE_PRICES)) return "unknown";
    if (p.owned.operatives.includes(id)) return "owned";
    if (!spend(p, OPERATIVE_PRICES[id])) return "coins";
    p.owned.operatives.push(id);
    return null;
  }
  if (kind === "store") {
    const item = STORE.find((s) => s.id === id);
    if (!item) return "unknown";
    if (item.type === "upgrade") {
      const lv = p.upgrades[id] || 0;
      if (lv >= item.max) return "owned";
      if (!spend(p, item.price)) return "coins";
      p.upgrades[id] = lv + 1;
      return null;
    }
    if (p.owned.emotes.includes(item.emote)) return "owned";
    if (!spend(p, item.price)) return "coins";
    p.owned.emotes.push(item.emote);
    return null;
  }
  return "unknown";
}

export function equip(p: Profile, kind: unknown, id: unknown, weapon?: unknown): string | null {
  if (typeof id !== "string") return "unknown";
  if (kind === "weapon") {
    const w = WEAPON_PRICES[id];
    if (!w || !p.owned.weapons.includes(id)) return "locked";
    if (w.slot === "primary") p.loadout.primary = id;
    else if (w.slot === "secondary") p.loadout.secondary = id;
    else if (w.slot === "melee") p.loadout.melee = id;
    else return "slot";
    return null;
  }
  if (kind === "skin") {
    if (typeof weapon !== "string" || !(weapon in WEAPON_PRICES) || !p.owned.skins.includes(id)) return "locked";
    p.loadout.skin[weapon] = id;
    return null;
  }
  if (kind === "operative") {
    if (!p.owned.operatives.includes(id)) return "locked";
    p.loadout.operative = id;
    return null;
  }
  if (kind === "emote") {
    if (!p.owned.emotes.includes(id)) return "locked";
    p.loadout.emote = id;
    return null;
  }
  if (kind === "grenade") {
    if (!p.owned.grenades.includes(id)) return "locked";
    p.loadout.grenade = id;
    return null;
  }
  if (kind === "mode") {
    if (!MODES.includes(id)) return "unknown";
    p.mode = id;
    return null;
  }
  return "unknown";
}

export const skinFor = (p: Profile, weapon: string) => p.loadout.skin[weapon] || "standard";
