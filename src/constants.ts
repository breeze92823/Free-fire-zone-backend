// Server limits and timings. Game rules shared with the client live in rules.ts / catalog.ts.

// Players per room (the deploy reads this number as `roomSize`): two teams of TEAM_MAX.
export const ROOM_MAX_CLIENTS = 18;
export const TEAM_MAX = 9;
// A round needs this many players who pressed Play; fewer and the room waits.
export const MIN_PLAYERS = 2;

// The room's simulation step (zone, regen, bleed-out, timers). Patches go out at patchRate.
export const TICK_MS = 50;
export const PATCH_MS = 50;

// Longest accepted strings.
export const NAME_MAX = 32;
export const PFP_MAX_LEN = 512;
// The player's Bloxity look (equipped ids + proportions, JSON), relayed for the others to draw.
export const AVATAR_MAX_LEN = 4000;
export const PARTY_MAX_LEN = 128;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Positions: the island fits well inside this box (m); anything outside is rejected.
export const WORLD_BOUND = 400;
// The fastest a player may move between two poses (m/s: sprint + overdrive + dash + falling), and
// the slack added for network jitter (m). A pose beyond it is ignored (the player is not moved).
export const MAX_SPEED = 32;
export const MOVE_SLACK = 6;
// Hit checks run against the server's last known positions, which trail the shooter's view.
export const RANGE_SLACK = 12;
// A shot may come this much faster than the weapon's fire interval (jitter, bunched packets).
export const FIRE_RATE_SLACK = 0.6;
// The shortest wait before a respawn is accepted (the portal's death screen counts >= 4 s).
export const RESPAWN_MIN_S = 3.5;
// Shots relayed for the others' tracers, at most this many end points per message.
export const SHOT_POINTS_MAX = 12;
// Timings tests may shorten: how long after a (re)spawn poses may jump (teleports), in ms.
export const TIMING = { spawnGraceMs: 4000, joinGraceMs: 5000 };

// Close code for a session replaced by a newer one of the same account (client net.js NET_REPLACED).
export const REPLACED_CODE = 4100;

// Ids from the client's catalogs: lowercase slugs.
export const ID_PATTERN = /^[a-z0-9_:-]{1,40}$/;

// Players with no verified Bloxity token get a server-made id with this prefix; they are never
// saved or reported.
export const GUEST_ID_PREFIX = "guest_";

// Leaderboard / stats reporting cadence (docs: batch every 10-30 s and at round end).
export const REPORT_EVERY_MS = 20_000;
export const REPORT_BATCH = 200;
