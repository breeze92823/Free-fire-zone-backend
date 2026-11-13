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
}

export const WEAPONS: Record<string, WeaponRule> = {
  striker: { slot: "primary", damage: 34, interval: 0.1, range: 140, headMul: 2 },
  viper: { slot: "secondary", damage: 23, interval: 0.072, range: 70, headMul: 1.8 },
  hornet: { slot: "secondary", damage: 42, interval: 0.2, range: 80, headMul: 2 },
  thunder: { slot: "primary", damage: 19, pellets: 8, interval: 0.8, range: 28, headMul: 1.5 },
  tempest: { slot: "primary", damage: 31, interval: 0.085, range: 130, headMul: 1.8 },
  marksman: { slot: "primary", damage: 72, interval: 0.32, range: 260, headMul: 2.2 },
  hawk: { slot: "primary", damage: 165, interval: 1.25, range: 400, headMul: 2.5 },
  knife: { slot: "melee", damage: 60, interval: 0.55, range: 2.7, headMul: 1 },
  fists: { slot: "fists", damage: 22, interval: 0.42, range: 2.1, headMul: 1 },
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

export function damageFalloff(w: WeaponRule, dist: number): number {
  const start = w.range * FALLOFF_START;
  if (dist <= start) return 1;
  return 1 - 0.4 * Math.min(1, (dist - start) / (w.range - start));
}
