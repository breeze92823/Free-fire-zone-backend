// The game rules the server enforces: damage, health, armour, the zone, match timings, rewards.
// A copy of the client's src/config.js values (WEAPONS, HEALTH, ITEMS, OPERATIVES, MATCH,
// MATCH_MODES, ZONE, LOOT, REWARDS). Keep in step with it by hand: a contract change goes in
// both projects.

export interface WeaponRule {
  slot: "primary" | "secondary" | "melee" | "fists";
  damage: number;
  interval: number; // s between shots
  range: number; // m
  headMul: number;
  pellets?: number;
  melee?: boolean; // a blade / fists blow (no headshots, melee range slack)
  pierce?: number; // share of the armour's damage cut ignored (0..1)
  heal?: number; // HP a hit gives a teammate (medic weapons); enemies take `damage`
}

export const WEAPONS: Record<string, WeaponRule> = {
  striker: { slot: "primary", damage: 34, interval: 0.1, range: 140, headMul: 2 },
  viper: { slot: "secondary", damage: 23, interval: 0.072, range: 70, headMul: 1.8 },
  hornet: { slot: "secondary", damage: 42, interval: 0.2, range: 80, headMul: 2 },
  thunder: { slot: "primary", damage: 19, pellets: 8, interval: 0.8, range: 28, headMul: 1.5 },
  tempest: { slot: "primary", damage: 31, interval: 0.085, range: 130, headMul: 1.8 },
  marksman: { slot: "primary", damage: 72, interval: 0.32, range: 260, headMul: 2.2 },
  hawk: { slot: "primary", damage: 165, interval: 1.25, range: 400, headMul: 2.5 },
  talon: { slot: "secondary", damage: 68, interval: 0.42, range: 90, headMul: 2.2 },
  wasp: { slot: "secondary", damage: 19, interval: 0.058, range: 60, headMul: 1.7 },
  ridgeback: { slot: "primary", damage: 41, interval: 0.125, range: 150, headMul: 2 },
  kestrel: { slot: "primary", damage: 33, interval: 0.095, range: 160, headMul: 2, pierce: 0.5 },
  breaker: { slot: "primary", damage: 24, pellets: 9, interval: 0.3, range: 22, headMul: 1.5 },
  cyclone: { slot: "primary", damage: 14, pellets: 7, interval: 0.28, range: 24, headMul: 1.4 },
  ronin: { slot: "secondary", damage: 70, interval: 0.6, range: 3.2, headMul: 1, melee: true },
  mender: { slot: "secondary", damage: 12, interval: 0.25, range: 35, headMul: 1.5, heal: 10 },
  knife: { slot: "melee", damage: 60, interval: 0.55, range: 2.7, headMul: 1, melee: true },
  fists: { slot: "fists", damage: 22, interval: 0.42, range: 2.1, headMul: 1, melee: true },
};
// Throwables (T). The loadout picks one; `frag` is the starter. Client config.js GRENADES.
export const GRENADES: Record<string, { damage: number; radius: number; fuse: number }> = {
  frag: { damage: 170, radius: 6.5, fuse: 1.9 },
  pulse: { damage: 120, radius: 8.5, fuse: 1.2 },
  breach: { damage: 230, radius: 5, fuse: 2.4 },
};
export const FALLOFF_START = 0.6; // share of range after which damage falls to 60% at full range

export const HEALTH = {
  max: 200,
  regenDelay: 6,
  regen: 4,
  regenCap: 120,
  knockedHp: 80,
  bleed: 5,
  reviveTime: 3,
  reviveHp: 70,
  reviveRange: 3.5, // m between reviver and the knocked teammate (server positions, with slack)
  vest: [0, 0.18, 0.28, 0.38],
  helmet: [0, 0.22, 0.36, 0.5],
  armorDurability: [0, 180, 260, 340],
  spawnProtection: 2.5, // s a respawned player cannot be hurt
};

export const ITEMS = {
  frag: { damage: 170, radius: 6.5, fuse: 1.9 },
  medkit: { heal: 80, time: 2.2 },
};

export const OPERATIVES: Record<string, { duration: number; charge: number }> = {
  rook: { duration: 6, charge: 50 }, // Iron Skin: damage taken x0.55
  nova: { duration: 6, charge: 45 }, // Overdrive (client: speed, fire rate)
  jin: { duration: 0, charge: 40 }, // Pulse Heal: +90 self, +60 squadmates within 10 m
  shade: { duration: 5, charge: 55 }, // Ghost Step (client: near invisible)
};
export const ROOK_DAMAGE_TAKEN = 0.55;
export const JIN_HEAL = { self: 90, ally: 60, range: 10 };
// Abilities charge on the client (time + damage dealt); the server only refuses one sooner than this.
export const ULT_MIN_GAP_S = 18;

export const MODES: Record<string, { name: string; duration: number; scoreToWin: number }> = {
  clash: { name: "Team Clash", duration: 240, scoreToWin: 45 },
  squad: { name: "Squad Showdown", duration: 180, scoreToWin: 25 },
};
// The voted maps (client MAPS, same order): a district of Coral Key + a time of day. The safe zone
// closes in on the map's district (zone.ts), so each map plays out somewhere else on the island.
export const MAP_FOCUS: [number, number][] = [
  [0, 0], // The Villa · day
  [-66, 34], // Old Farm · sunset
  [-98, -14], // Dockyard · night
];
export const MAP_COUNT = MAP_FOCUS.length;

// Round phases, seconds each (playing lasts the mode's duration).
export const PHASES = {
  vote: 15, // client MATCH.voteTime
  intro: 3.2,
  countdown: 4,
  ending: 2.4,
  results: 12,
};
export const STREAK_WINDOW = 6;
export const ASSIST_WINDOW = 10;

// The safe zone (client zone.js, same seeded random sequence: zone.ts).
export const ISLAND_RADIUS = 125;
export const ZONE = {
  start: 150,
  phases: [
    { at: 35, shrink: 30, radius: 105 },
    { at: 95, shrink: 30, radius: 72 },
    { at: 160, shrink: 30, radius: 46 },
  ],
  damage: [4, 7, 11],
};

export const LOOT = {
  crates: 200, // crate indexes accepted (the island has fewer)
  respawn: 40, // s before an opened crate refills
  airdropAt: [70, 150],
  airdropFall: 9,
};

export const REWARDS = {
  perElimination: 12,
  perKnock: 3,
  perDamage: 1 / 25,
  win: 70,
  loss: 25,
  mvp: 30,
  rpWin: 40,
  rpLoss: -12,
  rpPerElim: 3,
  leavePenaltyRp: -12, // leaving a running round: half the coins and at least this rank loss
};

// Gems: the game's own currency (NOT Bloxity Gems, not premium currency). Earned only by playing,
// never sold for real money or Bloxity Gems. Granted at once by `eliminate` / `knock` (an enemy,
// during `playing`) and announced to the shooter with `reward`; client config.js GEMS.
export const GEMS = {
  perElimination: 12,
  perKnock: 3,
  headshot: 3, // extra on a headshot elimination
  streak: 4, // extra per elimination beyond the first in a streak (Double +4, Triple +8, ...)
  streakCap: 5, // the streak bonus stops growing here
  win: 40, // at the results (not when leaving a running round)
  loss: 15,
  mvp: 25,
};
export const GEMS_MAX = 1e9;

export function damageFalloff(w: WeaponRule, dist: number): number {
  const start = w.range * FALLOFF_START;
  if (dist <= start) return 1;
  return 1 - 0.4 * Math.min(1, (dist - start) / (w.range - start));
}

// Player level (shown on the spectate card and the public profile): from career stats, never bought.
// xp = matches * matchXp + wins * winXp + eliminations * elimXp; level = 1 + floor(sqrt(xp / per)).
export const LEVEL = { matchXp: 20, winXp: 20, elimXp: 10, per: 50, max: 999 };
export function levelOf(stats: { matches: number; wins: number; eliminations: number }): number {
  const xp = stats.matches * LEVEL.matchXp + stats.wins * LEVEL.winXp + stats.eliminations * LEVEL.elimXp;
  return Math.min(LEVEL.max, 1 + Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL.per)));
}

// Spectator reactions (`react`): ids only, the client draws them (config.js REACTIONS).
export const REACTIONS = ["laugh", "fire", "clap", "wow", "gg"] as const;
