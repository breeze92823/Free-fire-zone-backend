// Shop prices and the starting profile: a copy of the client's src/config.js WEAPONS / SKINS /
// OPERATIVES / STORE / START_PROFILE / RANKS. Keep in step with it by hand. Everything is priced
// in coins earned by playing: nothing is ever sold for premium currency (Gems).

export const WEAPON_PRICES: Record<string, { slot: "primary" | "secondary" | "melee" | "fists"; price: number }> = {
  striker: { slot: "primary", price: 0 },
  viper: { slot: "secondary", price: 0 },
  hornet: { slot: "secondary", price: 400 },
  thunder: { slot: "primary", price: 1500 },
  tempest: { slot: "primary", price: 2500 },
  marksman: { slot: "primary", price: 2200 },
  hawk: { slot: "primary", price: 3200 },
  knife: { slot: "melee", price: 0 },
  fists: { slot: "fists", price: 0 },
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
  rp: number;
  owned: { weapons: string[]; skins: string[]; operatives: string[]; emotes: string[] };
  loadout: { primary: string; secondary: string; operative: string; emote: string; skin: Record<string, string> };
  upgrades: Record<string, number>;
  stats: { matches: number; wins: number; eliminations: number; deaths: number; damage: number; best: number };
  mode: string;
}

export const START_PROFILE: Profile = {
  coins: 600,
  rp: 0,
  owned: { weapons: ["striker", "viper", "knife", "fists"], skins: ["standard"], operatives: ["rook"], emotes: ["wave"] },
  loadout: { primary: "striker", secondary: "viper", operative: "rook", emote: "wave", skin: { striker: "standard", viper: "standard" } },
  upgrades: {},
  stats: { matches: 0, wins: 0, eliminations: 0, deaths: 0, damage: 0, best: 0 },
  mode: "clash",
};

export const COINS_MAX = 1e12;
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
  p.rp = num(raw.rp, RP_MAX);
  p.owned.weapons = [...new Set([...START_PROFILE.owned.weapons, ...ids(raw.owned?.weapons, (id) => id in WEAPON_PRICES)])];
  p.owned.skins = [...new Set([...START_PROFILE.owned.skins, ...ids(raw.owned?.skins, (id) => id in SKIN_PRICES)])];
  p.owned.operatives = [...new Set([...START_PROFILE.owned.operatives, ...ids(raw.owned?.operatives, (id) => id in OPERATIVE_PRICES)])];
  p.owned.emotes = [...new Set([...START_PROFILE.owned.emotes, ...ids(raw.owned?.emotes, (id) => EMOTES.includes(id))])];
  const lo = raw.loadout ?? {};
  if (p.owned.weapons.includes(lo.primary) && WEAPON_PRICES[lo.primary].slot === "primary") p.loadout.primary = lo.primary;
  if (p.owned.weapons.includes(lo.secondary) && WEAPON_PRICES[lo.secondary].slot === "secondary") p.loadout.secondary = lo.secondary;
  if (p.owned.operatives.includes(lo.operative)) p.loadout.operative = lo.operative;
  if (p.owned.emotes.includes(lo.emote)) p.loadout.emote = lo.emote;
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
  return p;
}

// --- Shop: each returns an error string, or null when the profile was changed ---------------
function spend(p: Profile, price: number): boolean {
  if (p.coins < price) return false;
  p.coins -= price;
  return true;
}

export function buy(p: Profile, kind: unknown, id: unknown): string | null {
  if (typeof id !== "string") return "unknown";
  if (kind === "weapon") {
    const w = WEAPON_PRICES[id];
    if (!w) return "unknown";
    if (p.owned.weapons.includes(id)) return "owned";
    if (!spend(p, w.price)) return "coins";
    p.owned.weapons.push(id);
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
  if (kind === "mode") {
    if (!MODES.includes(id)) return "unknown";
    p.mode = id;
    return null;
  }
  return "unknown";
}

export const skinFor = (p: Profile, weapon: string) => p.loadout.skin[weapon] || "standard";
