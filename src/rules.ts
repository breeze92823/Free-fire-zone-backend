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
  burst?: number; // shots per trigger pull: `burstGap` s apart, `interval` from one burst's start to the next
  burstGap?: number;
  blast?: number; // launchers: the round goes off (`blast` message) with `damage` at the centre in this radius (m)
  block?: number; // melee slot: carried on the back, it cuts this share of body-shot damage from behind (the pan)
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
  // Second wave
  gnat: { slot: "secondary", damage: 17, interval: 0.062, range: 50, headMul: 1.7 },
  mantis: { slot: "secondary", damage: 21, interval: 0.08, range: 65, headMul: 1.8 },
  drifter: { slot: "secondary", damage: 62, interval: 0.38, range: 110, headMul: 2.4 },
  falcon: { slot: "primary", damage: 27, interval: 0.07, range: 120, headMul: 2 },
  sentinel: { slot: "primary", damage: 38, interval: 0.34, range: 170, headMul: 2, burst: 3, burstGap: 0.06 },
  sparrow: { slot: "primary", damage: 52, interval: 0.2, range: 220, headMul: 2.1 },
  whisper: { slot: "primary", damage: 46, interval: 0.16, range: 120, headMul: 2.1 },
  osprey: { slot: "primary", damage: 132, interval: 1.05, range: 330, headMul: 2.5 },
  ranger: { slot: "primary", damage: 88, interval: 0.6, range: 200, headMul: 2.3 },
  bulldog: { slot: "secondary", damage: 26, interval: 0.085, range: 65, headMul: 1.8 },
  swarm: { slot: "secondary", damage: 18, interval: 0.06, range: 70, headMul: 1.7 },
  sawback: { slot: "secondary", damage: 20, pellets: 8, interval: 0.25, range: 16, headMul: 1.4 },
  rattler: { slot: "primary", damage: 17, pellets: 8, interval: 0.36, range: 26, headMul: 1.5 },
  machete: { slot: "melee", damage: 78, interval: 0.7, range: 2.9, headMul: 1, melee: true },
  crowbar: { slot: "melee", damage: 64, interval: 0.6, range: 2.6, headMul: 1, melee: true },
  pan: { slot: "melee", damage: 58, interval: 0.62, range: 2.4, headMul: 1, melee: true, block: 0.65 },
  quill: { slot: "primary", damage: 120, interval: 0.4, range: 160, headMul: 2.2 },
  thumper: { slot: "primary", damage: 165, interval: 0.5, range: 120, headMul: 1, blast: 4.5 },
  rhino: { slot: "primary", damage: 210, interval: 0.5, range: 220, headMul: 1, blast: 5.2 },
  knife: { slot: "melee", damage: 60, interval: 0.55, range: 2.7, headMul: 1, melee: true },
  fists: { slot: "fists", damage: 22, interval: 0.42, range: 2.1, headMul: 1, melee: true },
};
// Throwables (T). The loadout picks one; `frag` is the starter. Client config.js GRENADES.
// effect: "blast" (default: `damage` at the centre, falling off to the edge of `radius`), "sticky"
// (a blast that sticks where it lands), "fire" (a burning patch: `damage` HP per second for `burn` s
// to anyone standing in `radius`; the server burns them), "smoke" / "flash" (no damage: drawn by
// the clients).
export interface GrenadeRule {
  damage: number;
  radius: number;
  fuse: number;
  effect?: "blast" | "sticky" | "fire" | "smoke" | "flash";
  burn?: number;
}
export const GRENADES: Record<string, GrenadeRule> = {
  frag: { damage: 170, radius: 6.5, fuse: 1.9 },
  pulse: { damage: 120, radius: 8.5, fuse: 1.2 },
  breach: { damage: 230, radius: 5, fuse: 2.4 },
  leech: { damage: 185, radius: 5, fuse: 2, effect: "sticky" },
  molotov: { damage: 24, radius: 3.6, fuse: 5, effect: "fire", burn: 7 },
  smoke: { damage: 0, radius: 6, fuse: 1.4, effect: "smoke" },
  flash: { damage: 0, radius: 15, fuse: 1.6, effect: "flash" },
};
// A fire burns in ticks of this many seconds (damage per tick = burn damage x tick).
export const FIRE_TICK = 0.5;
// The pan stops shots from behind: the angle between the target's facing and the direction to the
// shooter must be wider than this (cos -0.45 ~ 117 degrees).
export const PAN_BEHIND_COS = -0.45;
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
// The voted maps (client MAPS, same order): a world (WORLDS) + where on it the safe zone closes in
// (zone.ts) + (client only) a time of day. The first three are districts of Coral Key; Dustline Ridge
// is its own, larger island.
export type WorldId = "coral" | "ridge";
export const MAPS: { world: WorldId; focus: [number, number] }[] = [
  { world: "coral", focus: [0, 0] }, // The Villa · day
  { world: "coral", focus: [-66, 34] }, // Old Farm · sunset
  { world: "coral", focus: [-98, -14] }, // Dockyard · night
  { world: "ridge", focus: [0, 0] }, // Dustline Ridge · desert
];
export const MAP_FOCUS: [number, number][] = MAPS.map((m) => m.focus);
export const MAP_COUNT = MAPS.length;

// Vehicles (vehicles.ts; client config.js VEHICLES): seats per type, and where each world's are parked
// at the start of a round (yaw: 0 = facing +z, PI/2 = +x). Dustline Ridge: a Jeep and a Dune Buggy
// in each camp's vehicle bay (West Camp = blue, East Camp = orange; anyone may take any).
// hp: its health (VehicleState.hp); gunSeat: the seat that mans its mounted gun (MOUNTS[mount]).
export const VEHICLE_TYPES: Record<string, { seats: number; hp: number; gunSeat?: number; mount?: string }> = {
  jeep: { seats: 4, hp: 1200, gunSeat: 3, mount: "mg" },
  buggy: { seats: 2, hp: 750 },
};
// Mounted guns (client config.js MOUNTS): fired only from their vehicle's gunner seat, with no ammo
// (the client overheats it). Checked like any weapon (fire rate, range, falloff).
export const MOUNTS: Record<string, WeaponRule> = {
  mg: { slot: "primary", damage: 26, interval: 0.085, range: 170, headMul: 1.6 },
};
// Damage to vehicles (vehicles.ts, MatchRoom vhit / boom / blast / ram). Client config.js VEHICLE_DAMAGE.
export const VEHICLE_DAMAGE = {
  bullet: 0.6, // share of a bullet's damage a vehicle takes (no headshots, no armour)
  blast: 1.4, // frags and launcher rounds, with the usual falloff
  sticky: 2.0, // a sticky charge that went off on it (within stickyReach m of its centre)
  fire: 1.0, // a Firebottle's burning patch under it (its dps, per FIRE_TICK)
  stickyReach: 2.6,
  size: 2.2, // m: a vehicle is big (added to ranges; a blast measures to its surface, about this far in)
  burnBelow: 0.2, // share of its hp below which it burns down on its own (get out!)
  burnRate: 0.05, // share of its full hp lost per second while burning
  wreckRadius: 7, // m: the explosion when it is destroyed
  wreckDamage: 150, // at the centre, falling off (armour helps)
  seatedDamage: 230, // to everyone still seated in it (armour does not help)
  respawn: 30, // s a wreck stays before a new one is parked at its spawn
  // Running someone over (the driver's client reports `ram`): base + perMs per m/s above minSpeed,
  // at most max; once per target per gapMs; the target must be within reach m of the vehicle.
  ram: { minSpeed: 8, base: 30, perMs: 7, max: 200, gapMs: 900, reach: 4.5 },
};
export const VEHICLE_SPAWNS: Record<WorldId, { id: string; type: string; x: number; z: number; yaw: number }[]> = {
  coral: [],
  ridge: [
    { id: "wj", type: "jeep", x: -177, z: 9.9, yaw: Math.PI / 2 },
    { id: "wb", type: "buggy", x: -177, z: 20.1, yaw: Math.PI / 2 },
    { id: "ej", type: "jeep", x: 177, z: -9.9, yaw: -Math.PI / 2 },
    { id: "eb", type: "buggy", x: 177, z: -20.1, yaw: -Math.PI / 2 },
  ],
};

// Where a destroyed vehicle's replacement may be parked (on roads, clear of buildings), besides its own
// spawn: the one inside the current safe zone nearest its spawn (vehicles.ts tick). Dustline Ridge's
// zone leaves the camps after about two minutes, so later vehicles come back on the town roads.
export const VEHICLE_PARKING: Record<WorldId, { x: number; z: number; yaw: number }[]> = {
  coral: [],
  ridge: [
    { x: -70, z: 4, yaw: Math.PI / 2 }, // main road, west of town
    { x: 70, z: -4, yaw: -Math.PI / 2 }, // main road, east of town
    { x: -65.1, z: 65.1, yaw: Math.atan2(-Math.sin((3 * Math.PI) / 4), Math.cos((3 * Math.PI) / 4)) }, // town ring
    { x: 65.1, z: -65.1, yaw: Math.atan2(-Math.sin(-Math.PI / 4), Math.cos(-Math.PI / 4)) },
    { x: 65.1, z: 65.1, yaw: Math.atan2(-Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)) },
    { x: -65.1, z: -65.1, yaw: Math.atan2(-Math.sin((-3 * Math.PI) / 4), Math.cos((-3 * Math.PI) / 4)) },
    { x: -38, z: 2.2, yaw: Math.PI / 2 }, // main road, town edge
    { x: 38, z: -2.2, yaw: -Math.PI / 2 },
  ],
};

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

// The safe zone (client zone.js, same seeded random sequence: zone.ts). Each world has its own plan
// and land radius (client config.js WORLDS): the circles never centre further out than
// radius - 0.6 x their own radius.
export interface ZonePlan {
  start: number;
  phases: { at: number; shrink: number; radius: number }[];
  damage: number[];
}
export const ISLAND_RADIUS = 125; // Coral Key
export const ZONE: ZonePlan = {
  start: 150,
  phases: [
    { at: 35, shrink: 30, radius: 105 },
    { at: 95, shrink: 30, radius: 72 },
    { at: 160, shrink: 30, radius: 46 },
  ],
  damage: [4, 7, 11],
};
export const WORLDS: Record<WorldId, { radius: number; zone: ZonePlan }> = {
  coral: { radius: ISLAND_RADIUS, zone: ZONE },
  ridge: {
    radius: 250,
    zone: {
      start: 330,
      phases: [
        { at: 30, shrink: 35, radius: 190 },
        { at: 95, shrink: 35, radius: 115 },
        { at: 160, shrink: 30, radius: 60 },
      ],
      damage: [4, 7, 11],
    },
  },
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
  leavePenaltyRp: -12, // leaving a round in play: half the fighting coins and this rank change
  forfeitMinShare: 0.5, // a side that leaves before this share of the round was played: a no contest (no win bonus)
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

// Friend invite offer (client config.js FRIEND_OFFER): every account gets a `hours`-long window from the
// first time the server sees it; when `need` NEW accounts join through its invite link inside that
// window, `weapon` is added to the inviter's owned weapons for free. Never bought, never a premium item.
export const FRIEND_OFFER = { weapon: "bulldog", need: 2, hours: 48 };
