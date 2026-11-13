import { schema, t, type SchemaType } from "@colyseus/schema";

// What every client sees of the room. Server-only bookkeeping (armour durability, fire-rate
// clocks, identities, progress) lives in MatchRoom, never here.

// Pose flags (client net.js FLAGS): bit set = true.
export const FLAG = { crouch: 1, aim: 2, grounded: 4, reload: 8, heal: 16, throw: 32, swing: 64, sprint: 128 } as const;

export const PlayerState = schema(
  {
    name: t.string().default(""),
    pfp: t.string().default(""), // Bloxity profile picture URL, "" = none
    signedIn: t.boolean().default(false),
    uid: t.string().default(""), // verified Bloxity user id ("" = guest): matches chat messages' userId
    avatar: t.string().default(""), // Bloxity look JSON { equipped (ids only), proportions }, "" = default
    party: t.string().default(""), // Bloxity party room key: party members share a team

    inMatch: t.boolean().default(false), // pressed Play (in the round or waiting for one)
    team: t.string().default(""), // "blue" | "orange" | "" (in the menus)
    vote: t.int8().default(-1), // map index voted for this round, -1 = none
    voteMode: t.string().default(""),

    life: t.string().default("dead"), // "alive" | "knocked" | "dead"
    hp: t.float32().default(200),
    downHp: t.float32().default(0),
    vest: t.uint8().default(0),
    helmet: t.uint8().default(0),
    protectedUntil: t.float32().default(0), // round clock
    deadAt: t.float32().default(0), // round clock of the last elimination
    killer: t.string().default(""), // sessionId of who eliminated this player last ("" = zone / self)

    // Pose, from the player's own client ~20x/s.
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0),
    pitch: t.float32().default(0),
    speed: t.float32().default(0),
    flags: t.uint16().default(0),
    slot: t.uint8().default(0),

    // Loadout, from the server-side profile (never the client's word).
    primary: t.string().default("striker"),
    secondary: t.string().default("viper"),
    skinPrimary: t.string().default("standard"),
    skinSecondary: t.string().default("standard"),
    operative: t.string().default("rook"),

    emote: t.string().default(""), // playing now ("" = none), e.g. "wave" or "portal:<id>"
    ultUntil: t.float32().default(0), // round clock the ability ends (rook / nova / shade)

    // This round's scoreboard.
    kills: t.uint16().default(0),
    deaths: t.uint16().default(0),
    assists: t.uint16().default(0),
    knocks: t.uint16().default(0),
    headshots: t.uint16().default(0),
    damage: t.float32().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const DropState = schema(
  {
    id: t.uint16().default(0),
    x: t.float32().default(0),
    z: t.float32().default(0),
    at: t.float32().default(0), // round clock it was dropped
    opened: t.boolean().default(false),
  },
  "DropState",
);
export type DropState = SchemaType<typeof DropState>;

export const MatchState = schema(
  {
    // waiting -> vote -> intro -> countdown -> playing -> ending -> results -> vote | waiting
    phase: t.string().default("waiting"),
    phaseLeft: t.float32().default(0), // s left in this phase (not used while waiting / playing)
    clock: t.float32().default(0), // round clock, s of play (drives the zone, airdrops, respawns)
    duration: t.float32().default(240),
    mode: t.string().default("clash"),
    scoreToWin: t.uint16().default(45),
    map: t.uint8().default(0),
    zoneSeed: t.uint32().default(1),
    round: t.uint16().default(0),
    blue: t.uint16().default(0),
    orange: t.uint16().default(0),
    winner: t.string().default(""),
    players: t.map(PlayerState), // keyed by sessionId
    crates: t.map("float32"), // crate index -> round clock it refills (opened crates only)
    drops: t.array(DropState),
  },
  "MatchState",
);
export type MatchState = SchemaType<typeof MatchState>;
