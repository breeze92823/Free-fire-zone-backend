// Server limits and timings. Game rules shared with the client live in rules.ts / catalog.ts.

// Connections per room (the deploy reads this number as `roomSize`): the lobby holds up to this many.
// Kept equal to a round's seats (2 x TEAM_MAX) so nobody waits in a queue: when a room is full the
// matchmaker sends the next player to another room. Keep it a literal integer (the deploy greps it).
export const ROOM_MAX_CLIENTS = 10;
// Players per side in a round; a round seats MATCH_MAX = 2 x TEAM_MAX (10). With a room of 10
// everyone fits; if the room is ever larger, players who pressed Play beyond the seats wait in the
// queue for the next round (those who sat out go first).
export const TEAM_MAX = 5;
// A round needs this many players who pressed Play; fewer and the room waits.
export const MIN_PLAYERS = 2;
// The in-game team (lobby squad): up to a whole side. Invites from the lobby's "Players online" list
// expire after INVITE_TTL_S; one invite per INVITE_GAP_MS from a player, at most INVITE_MAX_PENDING open.
export const SQUAD_MAX = TEAM_MAX;
export const INVITE_TTL_S = 20;
export const INVITE_GAP_MS = 500;
export const INVITE_MAX_PENDING = 10;

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
// Vehicles (vehicles.ts): the fastest a vehicle (and anyone seated in it) may move between two poses,
// m/s (the buggy tops out at 29 on the flat; downhill and jumps go faster), plus its jitter slack (m);
// how far (m, horizontal) a player may be from a vehicle to get in.
export const VEHICLE_MAX_SPEED = 45;
export const VEHICLE_SLACK = 8;
export const VEHICLE_ENTER_RANGE = 6;
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

// Spectating (eliminated players watch others): one heart per HEART_GAP_MS from a spectator and at
// most HEARTS_PER_TARGET to one player per round; one reaction per REACT_GAP_MS; one public profile
// request per PROFILE_GAP_MS.
export const HEART_GAP_MS = 400;
export const HEARTS_PER_TARGET = 20;
export const REACT_GAP_MS = 1200;
export const PROFILE_GAP_MS = 400;
