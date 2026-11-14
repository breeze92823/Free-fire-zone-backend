# Free Fire Zone server reference

Developer reference for the game server in this repo (Colyseus 0.18 + MongoDB, TypeScript, ESM). The wire contract with the client is in [`protocol.md`](protocol.md). The client lives in `../Free-fire-zone`.

Everything here was written from the source in `src/`, `test/`, the build/deploy files and the client's network modules. Where a statement was confirmed by running code it says so; the rest is from reading.

## 1. Model in one page

- One room type, `match` (`MatchRoom`). A room holds up to `ROOM_MAX_CLIENTS` (6) connections (the lobby) = a round's seats, two teams of `TEAM_MAX` (3), so the matchmaker opens another room instead of queueing players. The queue still exists as a fallback (e.g. an odd squad split that fits neither side): players who pressed Play without a seat wait (`inMatch`, no team) and are seated first next round (`Session.lastSeat`). Real players only.
- Everyone who joins is "in the menus" (`inMatch = false`, `life = "dead"`, no team). `play` sets `inMatch`. A round needs `MIN_PLAYERS` (2) players with `inMatch`.
- Rounds run in the same room forever: `waiting -> vote -> intro -> countdown -> playing -> ending -> results -> vote | waiting`.
- Authority split:
  - Client-owned: movement (bounded by the server), aiming, what a shot hit, ammo, item counts (frags, walls, medkits), ability charge, loot contents other than armour, spawn positions.
  - Server-owned: phases, clock, teams, health, armour, knock/eliminate, score, zone damage, regen, bleed-out, crate/airdrop state, rewards, the profile (coins, owned items, loadout, stats), the shop.
- Identity: only a Bloxity-verified `user._id` is ever used as an account id. Everything else is a guest (`guest_<sessionId>`, never saved or reported).

## 2. Run, build, test, deploy

Node `>= 22` (`package.json` `engines`; Docker and CI use Node 22). The package is ESM (`"type": "module"`); `tsconfig.json` uses `module`/`moduleResolution: NodeNext`, so relative imports carry a `.js` suffix even in `.ts` files.

| Script | Command | Notes |
|---|---|---|
| `npm start` | `tsx watch src/index.ts` | Dev server with reload, port 2567. `NODE_ENV` unset, so dev-only features are on (see below). |
| `npm run build` | `rimraf build && tsc -p tsconfig.build.json` | Emits `build/` from `src/` only (`tsconfig.build.json` narrows `include`). |
| `npm run clean` | `rimraf build` | |
| `npm test` | `mocha -r tsx test/**.test.ts --exit --timeout 15000` | Runs against TypeScript directly; no build needed. 9 tests pass on the current code (about 9 s). |

`tsconfig.json`: `strict: true` with `strictNullChecks: false`, `target: ESNext`, `outDir: build`, `allowJs`, `useDefineForClassFields: false`, `experimentalDecorators: true` (the schema uses the `schema()` builder, not decorators).

### Environment variables

`@colyseus/tools` loads `.env.<NODE_ENV or "development">` or else `.env` at import time (before `connectDb()` runs). `.env.example` lists the supported keys.

| Variable | Read in | Meaning | Default when unset |
|---|---|---|---|
| `PORT` | `@colyseus/tools` `listen` | HTTP/WebSocket port | 2567 |
| `NODE_ENV` | `app.config.ts`, `MatchRoom` | `production` disables `/monitor`, the playground, `devUser` ids and `ROUND_SECONDS` | dev behaviour |
| `MONGODB_URI` | `db.ts connectDb` | Mongo connection string (injected per game+channel by Bloxity Legion); the database in the URI is used as is | no persistence (warning logged, server still runs) |
| `CLIENT_ORIGIN` | `app.config.ts` | CORS allow-origin | `*` |
| `BLOXITY_API_URL` | `auth.ts apiUrl` | Base URL for token verification, leaderboard and stats reports | `https://api.bloxity.io` |
| `BLOXITY_GAME_ID` | `auth.ts GAME_SLUG`, `reporters.ts` | Game id/slug. Sent as `gameSlug` on verify; required (no default) for all reporting | `free-fire-zone` for verify only |
| `BLOXITY_REPORT_TOKEN` | `reporters.ts` | Bearer token for reports | all reporting is a no-op |
| `MATCHMAKER_REPORT_URL` | `reporters.ts installRoomReporter` | Base URL of the Open Rooms directory | room reporter off |
| `POD_NAME`, `HOSTNAME` | `installRoomReporter` | Pod name sent with room reports | `""` |
| `ROUND_SECONDS` | `MatchRoom.startRound` | Overrides the round duration; ignored when `NODE_ENV=production` | mode duration |

### Docker

`Dockerfile` is two stages on `node:22-alpine`: the build stage runs `npm ci` and `npm run build` with `src/` and both tsconfigs; the runtime stage sets `NODE_ENV=production`, runs `npm ci --omit=dev`, copies `build/`, switches to a non-root user `app`, exposes 2567 and runs `node build/index.js`. `.dockerignore` excludes `build`, `test`, `*.md`, `.env*` (except `.env.example`), so the image always contains a fresh build.

### CI/CD (`.github/workflows/deploy.yml`)

- Triggers: push and pull request on `dev` and `main`, plus manual `workflow_dispatch`.
- Job `test` (always): Node 22, `npm ci`, `npm run build`, `npm test`.
- Job `deploy` (not on pull requests, needs `test`): channel is `prod` when the ref is `main`, otherwise `dev`. Builds and pushes `ghcr.io/<owner>/<game id>-server:<channel>-<sha>`, then `POST https://legion.bloxity.io/v1/apps/<game id>/deploy` with `{ channel, image, version: <sha>, roomSize }`. The step prints the request body and Legion's HTTP status + response body (no `curl -f`, which would hide the reason for a 4xx) and fails on any non-2xx.
- `roomSize` is read from `src/constants.ts` with `grep -m1 -oP '^export const ROOM_MAX_CLIENTS\s*=\s*\K\d+'`: keep that constant a literal integer on its own `export const` line (the grep is anchored so a comment mentioning the name cannot match: a second match makes the JSON body invalid and Legion answers 400). The workflow sends `roomSize`, never `seatCap`.
- Required repo config: variable or secret `LEGION_GAME_ID` (`free-fire-zone`) and secret `LEGION_DEPLOY_TOKEN`. The job fails early if either is missing.

## 3. Source files

### `src/index.ts`
Entry point. `await connectDb()`, `await listen(app)`, then `installReporters()`. No exports.

### `src/app.config.ts`
Default export: the Colyseus server from `defineServer`. `WebSocketTransport({ maxPayload: MAX_PAYLOAD_BYTES })`; rooms `{ match: defineRoom(MatchRoom) }` (no `filterBy`, so `joinOrCreate` takes any open public room); Express: `GET /health` returns 200 (Legion probe), CORS with `CLIENT_ORIGIN || "*"`, and outside production `/monitor` and the playground at `/`.

### `src/constants.ts`
Server limits and timings (rules shared with the client are in `rules.ts` / `catalog.ts`).

| Constant | Value | Use |
|---|---|---|
| `ROOM_MAX_CLIENTS` | 6 | `maxClients` (lobby size, not round size); deploy `roomSize`; cap on `boom` targets |
| `TEAM_MAX` | 3 | seats per side in a round (round = 6); `pickTeam` returns `""` when both are full |
| `MIN_PLAYERS` | 2 | players with `inMatch` needed for a vote/round |
| `TICK_MS` / `PATCH_MS` | 50 / 50 | simulation interval / state patch rate |
| `NAME_MAX` | 32 | display name length |
| `PFP_MAX_LEN` | 512 | profile picture URL length (must be `http(s)://`) |
| `AVATAR_MAX_LEN` | 4000 | look JSON length |
| `PARTY_MAX_LEN` | 128 | party room key length |
| `SQUAD_MAX` | `TEAM_MAX` (3) | members of a lobby squad |
| `INVITE_TTL_S` / `INVITE_GAP_MS` / `INVITE_MAX_PENDING` | 20 / 500 / 6 | a squad invite lives this long / min gap between one player's invites / open invites per sender |
| `MAX_PAYLOAD_BYTES` | 65536 | WebSocket message cap (larger drops the connection) |
| `RECONNECT_SECONDS` | 20 | `allowReconnection` window |
| `WORLD_BOUND` | 400 | max abs x and z of a pose (m) |
| `MAX_SPEED` / `MOVE_SLACK` | 32 m/s / 6 m | pose speed check |
| `RANGE_SLACK` | 12 m | added to weapon range in hit checks; a quarter of it is added to revive range |
| `FIRE_RATE_SLACK` | 0.6 | a new shot may arrive after 60% of the weapon interval |
| `RESPAWN_MIN_S` | 3.5 | round-clock seconds after death before `respawn` is accepted |
| `SHOT_POINTS_MAX` | 12 | tracer end points relayed per `shot` |
| `HEART_GAP_MS`, `HEARTS_PER_TARGET` | 400, 20 | a spectator's hearts: one per 400 ms, at most 20 to one player per round |
| `REACT_GAP_MS`, `PROFILE_GAP_MS` | 1200, 400 | a spectator's reactions; public profile requests |
| `TIMING` | `{ spawnGraceMs: 4000, joinGraceMs: 5000 }` | wall-clock windows in which poses may jump; a mutable object so tests can shorten it |
| `REPLACED_CODE` | 4100 | close code for a session replaced by a newer one |
| `ID_PATTERN` | `/^[a-z0-9_:-]{1,40}$/` | not imported anywhere (unused) |
| `GUEST_ID_PREFIX` | `guest_` | prefix of unverified ids |
| `REPORT_EVERY_MS` / `REPORT_BATCH` | 20000 / 200 | report flush period / rows per request |

### `src/rules.ts`
Game rules the server enforces; a hand-kept copy of the client's `src/config.js`. Exports:

- `WeaponRule` (`slot`, `damage`, `interval` s, `range` m, `headMul`, `pellets?`) and `WEAPONS`:

| id | slot | damage | interval | range | headMul | pellets |
|---|---|---|---|---|---|---|
| `striker` | primary | 34 | 0.1 | 140 | 2 | |
| `viper` | secondary | 23 | 0.072 | 70 | 1.8 | |
| `hornet` | secondary | 42 | 0.2 | 80 | 2 | |
| `thunder` | primary | 19 | 0.8 | 28 | 1.5 | 8 |
| `tempest` | primary | 31 | 0.085 | 130 | 1.8 | |
| `marksman` | primary | 72 | 0.32 | 260 | 2.2 | |
| `hawk` | primary | 165 | 1.25 | 400 | 2.5 | |
| `talon` | secondary | 68 | 0.42 | 90 | 2.2 | |
| `wasp` | secondary | 19 | 0.058 | 60 | 1.7 | |
| `ridgeback` | primary | 41 | 0.125 | 150 | 2 | |
| `kestrel` | primary | 33 | 0.095 | 160 | 2 | `pierce` 0.5 |
| `breaker` | primary | 24 | 0.3 | 22 | 1.5 | 9 pellets |
| `cyclone` | primary | 14 | 0.28 | 24 | 1.4 | 7 pellets |
| `ronin` | secondary | 70 | 0.6 | 3.2 | 1 | `melee` |
| `mender` | secondary | 12 | 0.25 | 35 | 1.5 | `heal` 10 |
| `knife` | melee | 60 | 0.55 | 2.7 | 1 | `melee` |
| `fists` | fists | 22 | 0.42 | 2.1 | 1 | `melee` |

Extra rule fields: `melee` (a blow: melee range slack, never a headshot), `pierce` (share of the vest / helmet damage cut ignored: the Kestrel's armour-piercing rounds), `heal` (HP a hit gives a teammate: the Mender's hits on allies heal instead of being refused).
- `GRENADES` (the loadout's throwable, `onBoom`): `frag` `{ damage 170, radius 6.5, fuse 1.9 }`, `pulse` `{ 120, 8.5, 1.2 }`, `breach` `{ 230, 5, 2.4 }`.

- `FALLOFF_START` 0.6 and `damageFalloff(w, dist)`: 1 up to 60% of range, then linear down to 0.6 at full range.
- `HEALTH`: `max` 200, `regenDelay` 6 s, `regen` 4 HP/s, `regenCap` 120, `knockedHp` 80, `bleed` 5 HP/s, `reviveTime` 3 s, `reviveHp` 70, `reviveRange` 3.5 m, `vest` `[0, 0.18, 0.28, 0.38]`, `helmet` `[0, 0.22, 0.36, 0.5]`, `armorDurability` `[0, 180, 260, 340]`, `spawnProtection` 2.5 s.
- `ITEMS`: `frag` `{ damage 170, radius 6.5, fuse 1.9 }`, `medkit` `{ heal 80, time 2.2 }`.
- `OPERATIVES` (`duration`, `charge`): `rook` 6/50, `nova` 6/45, `jin` 0/40, `shade` 5/55. Only `duration` is used by the server. `ROOK_DAMAGE_TAKEN` 0.55, `JIN_HEAL` `{ self 90, ally 60, range 10 }`, `ULT_MIN_GAP_S` 18.
- `MODES`: `clash` (Team Clash, 240 s, score 45), `squad` (Squad Showdown, 180 s, score 25).
- `MAP_FOCUS`: `[0,0]` Villa, `[-66,34]` Old Farm, `[-98,-14]` Dockyard; `MAP_COUNT` = its length.
- `PHASES` (seconds, mutable object): `vote` 15, `intro` 3.2, `countdown` 4, `ending` 2.4, `results` 12.
- `STREAK_WINDOW` 6 s, `ASSIST_WINDOW` 10 s.
- `ISLAND_RADIUS` 125; `ZONE`: `start` 150, `phases` `[{at 35, shrink 30, radius 105}, {at 95, shrink 30, radius 72}, {at 160, shrink 30, radius 46}]`, `damage` `[4, 7, 11]` HP per second outside.
- `LOOT`: `crates` 200 (accepted crate indexes), `respawn` 40 s, `airdropAt` `[70, 150]`, `airdropFall` 9 s.
- `REWARDS`: `perElimination` 12, `perKnock` 3, `perDamage` 1/25, `win` 70, `loss` 25, `mvp` 30, `rpWin` 40, `rpLoss` -12, `rpPerElim` 3, `leavePenaltyRp` -12.
- `LEVEL` + `levelOf(stats)`: xp = matches x 20 + wins x 20 + eliminations x 10, level = 1 + floor(sqrt(xp / 50)), max 999 (state `level`). `REACTIONS`: the spectator reaction ids (`laugh`, `fire`, `clap`, `wow`, `gg`; client `config.js REACTIONS`).
- `GEMS` (the game's own currency, not Bloxity Gems and not premium currency: earned only by playing, never sold; spent on weapons, grenades and passes): `perElimination` 12, `perKnock` 3, `headshot` +3 on a headshot elimination, `streak` +4 per elimination past the first in a streak, counted up to `streakCap` 5 (Double +4, Triple +8, ... +16); at the results `win` 40, `loss` 15, `mvp` 25. `GEMS_MAX` 1e9.

### `src/catalog.ts`
Prices, the profile shape and the shop logic (pure functions, no I/O).

- `WEAPON_PRICES` (`slot`, `price` in Gems): striker 0, viper 0, hornet 600, talon 1200, wasp 900, ridgeback 1500, kestrel 1800, tempest 2400, marksman 2200, hawk 3500, thunder 1200, breaker 1500, cyclone 2600, ronin 2500, mender 3000, knife 0, fists 0. Weapons bought with coins before the Gem store stay owned.
- `GRENADE_PRICES` (Gems): frag 0, pulse 800, breach 1200.
- `PASSES` (Gems): `basic` 3500 = hornet, talon, wasp, ridgeback, thunder, breaker (the client's `tier: 'basic'` weapons). A pass unlocks its set for good: `normalizeProfile` re-adds the set on every load, so weapons later added to it come with it.
- `SKIN_PRICES`: standard 0, desert 600, jungle 900, arctic 1100, crimson 1500, neon 1800, gold 2600.
- `OPERATIVE_PRICES`: rook 0, nova 1200, jin 1500, shade 2000.
- `STORE` (`StoreItem[]`): upgrades (`max` 2 each) `medkits` 900, `walls` 1000, `frags` 1100, `armor` 2400; emotes `emote_dance` 500, `emote_salute` 350, `emote_flex` 650, `emote_cheer` 450 (each has `emote`: the emote id it unlocks). An upgrade's price is per level.
- `EMOTES` `["wave","dance","salute","flex","cheer"]`; `MODES` `["clash","squad"]` (ids only; not the same export as `rules.MODES`).
- `Profile`: `coins`, `gems`, `rp`, `owned { weapons, skins, operatives, emotes }`, `loadout { primary, secondary, operative, emote, skin: Record<weapon, skin> }`, `upgrades: Record<id, level>`, `stats { matches, wins, eliminations, deaths, damage, best }`, `mode`, `missions`, `rankReward`, `tutorial` (5.13).
- `START_PROFILE`: 600 coins, 0 gems, 0 rp, owns striker/viper/knife/fists, skin standard, operative rook, emote wave, mode clash.
- `COINS_MAX` 1e12, `GEMS_MAX` 1e9 (from `rules.ts`), `RP_MAX` 1e9 (applied when a stored document is normalized, not when rewards are granted).
- `normalizeProfile(raw)`: builds a valid `Profile` from any stored document: numbers clamped and floored, unknown ids dropped, starter items always owned, equipped items must be owned and in the right slot, upgrade levels clamped to `max`, unknown `mode` falls back to `clash`. Anything it does not copy is lost on load.
- `buy(profile, kind, id)` and `equip(profile, kind, id, weapon?)`: mutate the profile and return `null`, or an error string. `buy` kinds: `weapon`, `grenade`, `pass` (paid in Gems, `spendGems`), `skin`, `operative`, `store` (paid in coins); errors `unknown`, `owned`, `gems`, `coins`. `equip` kinds: `weapon`, `skin` (needs `weapon`), `operative`, `emote`, `grenade`, `mode`; errors `unknown`, `locked` (not owned), `slot` (melee/fists cannot be equipped).
- `skinFor(profile, weapon)`: equipped skin or `standard`.

### `src/zone.ts`
`mulberry32(seed)` and class `Zone` (`cx`, `cz`, `radius`, `phase`, `shrinking`, `damage`; `update(t)`, `outside(x, z, margin)`). Deterministic from `(seed, focus)`; see `protocol.md` section 7 for the planner contract.

### `src/auth.ts`
`Identity`, `OUTFIT_KEY` (`/^[A-Za-z0-9_.~-]{1,256}$/`), `GAME_SLUG`, `apiUrl()`, `verifyToken(token)`, `reportId(userId)`, `__setVerifierForTest(fn | null)`. See section 6.

### `src/db.ts`
`PlayerDoc`, `connectDb()`, `getPlayers()`, `loadProfile(userId, carriedFrom)`, `saveProfile(userId, username, profile)`, `__setPlayersForTest(fake | null)`. See section 7.

### `src/reporters.ts`
`installRoomReporter()`, `BOARDS`, `STAT_DEFINITIONS`, `queueScores`, `queueStats`, `flushReports()`, `installReporters()`. See section 8.

### `src/rooms/schema/MatchState.ts`
`FLAG`, `PlayerState`, `DropState`, `MatchState`. See section 4.

### `src/rooms/MatchRoom.ts`
The room: message handlers (`messages`), lifecycle, round machine, simulation, damage, rewards. See section 5.

## 4. `MatchState` schema

Synced to every client by Colyseus patches every `PATCH_MS`. Server-only bookkeeping lives in `MatchRoom.sessions`, never in the schema.

### `PlayerState` (one per connection, in `MatchState.players` keyed by `sessionId`)

| Field | Type | Meaning |
|---|---|---|
| `name` | string | display name (verified Bloxity name, or the guest's own, max 32) |
| `pfp` | string | profile picture URL, `""` = none |
| `signedIn` | boolean | identity was verified by Bloxity |
| `uid` | string | verified Bloxity user id, `""` for guests (matches chat `userId`) |
| `avatar` | string | look JSON (ids only), `""` = default |
| `outfitKey` | string | Bloxity outfit key |
| `party` | string | Bloxity party room key; members share a team |
| `squad` | string | in-game lobby team id (`s<n>`), `""` = solo; members queue and play together (5.4) |
| `squadLead` | boolean | this player leads their squad: only they press Play for it |
| `level` | uint16 | `levelOf(profile.stats)` (`applyPublic`: after the profile loads and after each grant) |
| `rp` | uint32 | the profile's rank points (rank badge) |
| `inMatch` | boolean | pressed Play (in a round or waiting for one) |
| `team` | string | `"blue"`, `"orange"` or `""` |
| `vote` | int8 | map index voted this round, -1 = none |
| `voteMode` | string | preferred mode (`clash`/`squad`/`""`) |
| `life` | string | `"alive"`, `"knocked"`, `"dead"` (default; also the lobby value) |
| `hp` | float32 | 0..200 |
| `downHp` | float32 | bleed-out pool while knocked |
| `vest`, `helmet` | uint8 | armour level 0..3 |
| `protectedUntil` | float32 | round clock until which damage (not zone) is ignored |
| `deadAt` | float32 | round clock of the last elimination |
| `killer` | string | sessionId of the last killer, `""` = zone/self |
| `watch` | string | sessionId this eliminated player spectates (`spectate`), `""` = none; cleared by `spawn` and `leaveMatch` |
| `hearts` | uint16 | hearts spectators gave this player this round (`heart`); reset in `resetForRound` |
| `x`, `y`, `z` | float32 | pose position (m) |
| `yaw`, `pitch` | float32 | radians; pitch clamped to +-1.6 |
| `speed` | float32 | horizontal speed reported by the client, 0..60 |
| `flags` | uint16 | `FLAG` bitmask |
| `slot` | uint8 | held weapon slot 0..3 |
| `primary`, `secondary` | string | loadout weapon ids (from the server profile) |
| `skinPrimary`, `skinSecondary` | string | skin ids |
| `operative` | string | operative id |
| `emote` | string | emote playing now, `""` = none, e.g. `wave` or `portal:<id>` |
| `ultUntil` | float32 | round clock the ability ends (rook/nova/shade) |
| `kills`, `deaths`, `assists`, `knocks`, `headshots` | uint16 | this round's scoreboard |
| `damage` | float32 | damage dealt this round (after armour) |

`FLAG` = `{ crouch: 1, aim: 2, grounded: 4, reload: 8, heal: 16, throw: 32, swing: 64, sprint: 128 }`. The server stores the bitmask without interpreting it.

### `DropState` (airdrops, in `MatchState.drops`)
`id` uint16 (unique for the room's lifetime), `x`, `z` float32 landing point, `at` float32 round clock it was dropped, `opened` boolean.

### `MatchState`

| Field | Type | Meaning |
|---|---|---|
| `phase` | string | `waiting`, `vote`, `intro`, `countdown`, `playing`, `ending`, `results` |
| `phaseLeft` | float32 | seconds left in the phase (0 while `waiting` / `playing`) |
| `clock` | float32 | round clock: seconds of `playing` (frozen in other phases) |
| `duration` | float32 | round length (s) |
| `mode` | string | `clash` or `squad` |
| `scoreToWin` | uint16 | team score that ends the round |
| `map` | uint8 | index into `MAP_FOCUS` / client `MAPS` |
| `zoneSeed` | uint32 | seed of this round's zone plan |
| `round` | uint16 | round counter (increments at each `startRound`) |
| `blue`, `orange` | uint16 | team scores |
| `winner` | string | `""` until the round ends |
| `players` | map of `PlayerState` | keyed by sessionId |
| `crates` | map of float32 | opened crates only: crate index (string key) -> round clock it refills |
| `drops` | array of `DropState` | this round's airdrops |

### State vs messages
- State (continuous or late-join-safe): roster, looks, teams, votes, poses, health, armour levels, loadouts, scoreboard, phase, clock, scores, opened crates, drops.
- Messages (one-off events and private data): `dmg`, `knock`, `elim`, `revive`, `spawn`, `shot`, `throw`, `boom`, `wall`, `ult`, `opened`, `openFail`, `matchEnd`, `round`, and per-client `profile`, `shop`, `rewards`, `reward`, `serverError`.
- Never sent: armour durability, fire-rate clocks, identities other than `uid`, other players' profiles.

## 5. `MatchRoom`

`maxClients = ROOM_MAX_CLIENTS`, `patchRate = PATCH_MS`. Private members: `sessions: Map<sessionId, Session>`, `zone: Zone`, `nextDrop` (index into `LOOT.airdropAt`), `dropId` (next drop id).

Helpers used everywhere: `player(client)`, `fighting()` (phase is `playing` or `ending`), `RUNNING` (`intro`, `countdown`, `playing`, `ending`), `carries(p, w)` (w is the player's `primary`, `secondary`, `knife` or `fists`), `inRound()` (players with `inMatch` and a team), `ready()` (count of `inMatch`), `saved(s)` (verified or dev identity). Input helpers: `num(v)` (finite number or `null`), `str(v, max)`, `pfpOk(v)`, `clampN`.

### 5.1 Per-player server-side fields (`Session`)

| Field | Clock | Meaning |
|---|---|---|
| `identity` | | `Identity` (userId, verified, username, pfp, carriedFrom) |
| `dev` | | local-dev id (`devUser`): saved, never reported |
| `profile` | | the player's `Profile` (in memory; the write source for Mongo) |
| `loaded` | | profile read has answered; only then may it be bought from or saved |
| `vestDur`, `helmetDur` | | remaining armour durability |
| `lastDamageAt` | round | last time damaged (regen delay) |
| `damagers` | round | attacker sessionId -> last damage time (assists) |
| `lastHitBy` | | last enemy attacker (kill credit on bleed-out/zone) |
| `streak`, `lastElimAt` | round | elimination streak |
| `roundGems` | | Gems granted this round (already in `profile.gems`; reported in `rewards.gems`) |
| `zoneTick` | s | accumulator for the once-a-second zone damage |
| `shotSeq`, `shotAt` | wall ms | per weapon: last shot number and its time (fire rate) |
| `throws`, `lastThrowAt` | wall ms | frags thrown and not yet exploded (max 3), last throw |
| `lastHealAt`, `lastUltAt`, `lastWallAt`, `lastOpenAt` | wall ms | per-action rate limits |
| `reviving` | wall ms | `{ target, at }` of a hold in progress |
| `pose` | wall ms | last accepted pose `{ x, y, z, at }` |
| `graceUntil` | wall ms | until then poses may jump |
| `emoteAt` | wall ms | when the emote started (auto-clear after 6 s) |
| `playedRound` | | round index the player fought in, -1 otherwise |
| `heartAt`, `reactAt`, `profileAt` | wall ms | spectator rate limits (`heart`, `react`, `profileOf`) |
| `heartsGiven` | | target sessionId -> hearts given this round (cap `HEARTS_PER_TARGET`); cleared in `resetForRound` |

### 5.2 Lifecycle

- `onCreate(options)`: `options.private === true` calls `setPrivate(true)` (joinable by id only). Sets metadata `{ mode: 1, modeName: "Team Battle" }` (no `started` flag: Open Rooms shows started rooms as "Locked") and starts `tick` every `TICK_MS`.
- `onAuth(client, options, context)`: token from `options.token` (or `context.token`) goes to `verifyToken`. Verified: returns the Bloxity identity with `verified: true, dev: false`. Otherwise a guest: `userId = guest_<sessionId>`, `username = options.name` (max 32) or `"Guest"`, `pfp` if a valid URL. Outside production, `options.devUser` matching `/^dev-[a-z0-9-]{4,40}$/` becomes the `userId` with `dev: true`. `onAuth` never rejects.
- `onJoin(client, options, auth)`: creates the `PlayerState` (name, pfp, `signedIn`, `uid`, `outfitKey` (verified key wins over `options.outfitKey`), `avatar` from `options.avatar`, `party` from `options.party`, `life = "dead"`), creates the `Session` with a default profile and `graceUntil = now + TIMING.joinGraceMs`, calls `evictOthers`, then `loadSession` (async; answers with `profile`).
- `onLeave(client, code)`: any code other than `CloseCode.CONSENTED` first awaits `allowReconnection(client, RECONNECT_SECONDS)`. On reconnect: `graceUntil = now + 3000`, `profile` is re-sent, the player keeps team, life and stats. On timeout or a consented leave: `leaveMatch` (penalty if applicable), `persist`, then the player and session are deleted. During the 20 s window the player stays in the state and in the round.
- `onDispose()`: `await flushReports()`. Rooms auto-dispose when empty (Colyseus default).

### 5.3 Round phase machine

`setPhase(phase, seconds)` writes `phase`/`phaseLeft` (room metadata is not touched: no `started` flag). `tick(dt)` (dt clamped to 0.25 s) first clears emotes older than 6 s, then:

| Phase | Length | On entry | Exit |
|---|---|---|---|
| `waiting` | until `ready() >= MIN_PLAYERS` | | `startVote()` |
| `vote` | `PHASES.vote` 15 s | `startVote`: all `vote = -1`; team cleared for players not `inMatch` | fewer than `MIN_PLAYERS` ready -> `waiting`; timer -> `startRound()` |
| `intro` | `PHASES.intro` 3.2 s | `startRound` (below) | -> `countdown` |
| `countdown` | `PHASES.countdown` 4 s | | -> `playing` |
| `playing` | `state.duration` | | `simulate`; clock reaches `duration` -> `end(leader)` (a tie picks at random); score reaches `scoreToWin` -> `end`; a team with no members -> `end` |
| `ending` | `PHASES.ending` 2.4 s | `end(winner)`: `winner` set, `matchEnd` broadcast | `simulate` still runs (clock frozen, no zone damage, no airdrops); -> `finishRound()` |
| `results` | `PHASES.results` 12 s | `finishRound`: rewards granted, reports flushed | every player's `team = ""`, `life = "dead"`; `ready() >= MIN_PLAYERS` -> `startVote()`, else `waiting` |

`startRound()`:
1. `map` = most-voted map among ready players (random among none); `mode` = most common valid `voteMode` (fallback `clash`). `tally` breaks ties with coin flips.
2. `duration` = the mode's (or `ROUND_SECONDS` outside production), `scoreToWin`, `round++`, `clock = 0`, scores 0, `winner = ""`.
3. `zoneSeed` = random uint32; `zone = new Zone(zoneSeed, MAP_FOCUS[map])`; `crates` and `drops` cleared; `nextDrop = 0`.
4. Teams: every ready player's team cleared, the list shuffled, then stable-sorted by `Session.lastSeat` (the last round that seated them; lowest first, so players who sat out go first), `pickTeam` for each in turn. Only the first `2 x TEAM_MAX` (6) get a team and a `resetForRound`; the rest stay `inMatch` with no team (the client keeps showing the queue panel) and are tried again next round.
5. Phase `intro`; `resetForRound` for each (scoreboard zeroed, streak/damagers reset, `playedRound = round`, `applyLoadout`, `spawn(first = true)`); broadcast `round { round }`.

`end(winner)` is ignored unless the phase is `intro`, `countdown` or `playing`. `checkTeams()` (called from `leaveMatch`): in `vote` with too few ready -> `waiting`; in a running round (not `ending`) with an empty side -> `end(the other side)`, or the score leader if both are empty.

### 5.4 Teams, parties, joining and leaving

- `pickTeam(sessionId, p)`: counts current `inMatch` members per team (excluding the player). If `p.squad` or `p.party` is set and another player of the same squad / party key has a team with fewer than `TEAM_MAX` members, that team is returned (squad and party beat balance). The first member of a squad to be seated prefers a side with room for every squad member still waiting. `startRound` orders the seating so a squad's members follow its first member and bigger groups are seated first (solos placed before a squad could balance the sides 2 / 2 and split it). Otherwise the smaller team that still has room (equal sizes pick at random). When both teams already have `TEAM_MAX` members it returns `""`: the player is not seated.
- Squad (lobby team, the "Players online" invites): any player can `invite` another who is not `inMatch` and not in a squad; the target answers with `inviteReply`; accepting creates the inviter's squad (`squad` = `s<n>`, inviter `squadLead`) or joins it, up to `SQUAD_MAX`. Pending invites live in `MatchRoom.invites` (expire after `INVITE_TTL_S`; dropped when either side queues or leaves). Only the leader's `play` works and it queues every member (`play` for a squad); a leaver or a disconnect goes through `removeFromSquad` (lead passes on, a squad of one dissolves); the leader can `kick` while nobody is `inMatch`. The squad survives rounds (it is a lobby team). All outcomes the players see are `squadNote` messages (protocol.md section 4); tests in `test/Squad.test.ts`.
- Mid-round join: `play` during a `RUNNING` phase calls `joinRound` -> `pickTeam` + `resetForRound` (when `pickTeam` returns `""` both sides are full: the player stays `inMatch` with no team and waits for the next round) (a `first` spawn: full health, upgrade armour, no spawn protection). The client places itself in its team's start area. This includes `intro`, `countdown` and `ending`.
- `play` in `waiting`, `vote` or `results` only sets `inMatch` (and `voteMode`); the player is seated at the next `startRound`.
- `leaveMatch(sessionId)` (message `leave`, or a final disconnect): if the player has a team, the phase is `RUNNING` and `playedRound === round`, the leave penalty is granted (section 5.10). Then `inMatch = false`, `team = ""`, `life = "dead"`, `vote = -1`, emote cleared, `playedRound = -1`, and `checkTeams()`.

### 5.5 Server tick (`simulate`, in `playing` and `ending`)

1. `clock += dt` (only in `playing`); `zone.update(clock)`.
2. Crate refill: entries of `state.crates` whose refill time has passed are deleted.
3. Airdrops (only in `playing`): when `clock >= LOOT.airdropAt[nextDrop]`, a `DropState` is added at a random point within `max(10, zone.radius * 0.6)` of the zone centre (`Math.random`, not the zone seed), with `at = clock`. It can be opened from `at + LOOT.airdropFall - 0.5`.
4. For every player in the round:
   - `alive`: regen `HEALTH.regen * dt` up to `HEALTH.regenCap` once `clock - lastDamageAt > HEALTH.regenDelay`.
   - `knocked`: `downHp -= HEALTH.bleed * dt`; at 0 -> `eliminate` credited to `lastHitBy`.
   - Zone (only in `playing`, not dead): while `zone.outside(x, z)` accumulate `zoneTick`; each full second `applyDamage(zone.damage, null, { zone: true })`. Zone damage ignores armour and spawn protection and never knocks: an alive player at 0 HP is eliminated.

### 5.6 Poses (`pose`)

Checks, in order: all of `x`, `y`, `z` finite; `|x|`, `|z|` <= `WORLD_BOUND`, `-60 <= y <= 300`; then, if there is a previous pose, the grace window is over and the player is not dead: horizontal distance moved must be `<= MAX_SPEED * dt + MOVE_SLACK` with `dt = max(0.05, seconds since the last accepted pose)`. A failing pose is dropped (nothing is sent back; the player simply is not moved). Accepted: position stored; `yaw` (any finite), `pitch` clamped to +-1.6, `speed` to 0..60, `flags` to 0..65535, `slot` to 0..3; a running emote is cleared when `speed > 1.2`. Grace windows: `TIMING.joinGraceMs` after join, `TIMING.spawnGraceMs` after every spawn, 3 s after a reconnect.

### 5.7 Hit validation (`onHit`, message `hit`)

Payload `{ t, w, s, n, h, d }`. Steps in order; any failure silently drops the hit:

1. Attacker state and session exist, `t` is another player in the room, `w` is a key of `WEAPONS`, phase is `fighting()`.
2. Attacker `life === "alive"` and has a team; target is not dead (knocked targets can be hit) and has a team; teams differ; `carries(attacker, w)`. The held `slot` is not checked.
3. Fire rate, per weapon: `seq = s` (or -1). If `seq` differs from the last recorded shot number for `w`, the time since that shot must be at least `rule.interval * 1000 * FIRE_RATE_SLACK` ms; then `seq` and the time are recorded. A hit with the same `seq` as the recorded one skips the check (one shot may hit several players).
4. Range: 3D distance between the two server-side positions must be `<= rule.range + RANGE_SLACK` (guns) or `rule.range + 2.5` (knife, fists).
5. `n` = pellets that hit, clamped to `1..(rule.pellets ?? 1)`; `h` = headshots among them, clamped to `0..n` (0 for melee); `d` = distance for falloff, the client's value clamped to `0..rule.range` (server distance when missing).
6. `amount = rule.damage * falloff(d) * ((n - h) + h * rule.headMul)` (falloff is 1 for melee).
7. `applyDamage(target, amount, attacker, { head: h > 0, weapon: w })`.

Not checked: line of sight, aim direction, ammo, reload, and that `t` was hit by a real ray.

### 5.8 Damage, armour, knock, eliminate (`applyDamage`, `knock`, `eliminate`, `checkWipe`)

`applyDamage(targetId, amount, attackerId | null, opts { head, zone, explosive, weapon })`:
1. Ignored if the target is dead, `amount <= 0`, or the phase is not `fighting()`.
2. Spawn protection: `clock < protectedUntil` blocks everything except zone damage.
3. Rook: `x ROOK_DAMAGE_TAKEN` while the target's `operative === "rook"` and `clock < ultUntil` (zone damage included).
4. Armour, only for an `alive` target and non-zone damage: a headshot with `helmet > 0` removes `dmg * HEALTH.helmet[level]`; a body hit with `vest > 0` removes `dmg * HEALTH.vest[level]`. The removed amount is subtracted from that piece's durability; at 0 the piece drops one level and gets that level's full durability (`setArmor`). A multi-pellet hit with any headshot is treated wholly as a head hit.
5. `lastDamageAt = clock`. If there is an attacker other than the target: `lastHitBy`, `damagers[attacker] = clock`, attacker `damage += dmg`, `headshots++` on a head hit.
6. Target emote cleared; broadcast `dmg`.
7. `alive`: `hp -= dmg`; at 0, if a teammate is `alive` and the damage is not zone -> `knock`, else `eliminate`. `knocked`: `downHp -= dmg`; at 0 -> `eliminate`.

`knock`: `life = "knocked"`, `downHp = HEALTH.knockedHp`, attacker `knocks++`, broadcast `knock`; an enemy attacker in `playing` gets `reward` (kind `knock`: `GEMS.perKnock`, coins `REWARDS.perKnock`); `checkWipe`.

`eliminate`: `life = "dead"`, `deaths++`, `deadAt = clock`, victim's streak reset. Killer = the attacker if on the other team, else `lastHitBy` if still in the room and on the other team, else none. With a killer: `kills++`; streak continues if the previous elimination was within `STREAK_WINDOW`, else restarts at 1; every other damager of the victim within `ASSIST_WINDOW` on the killer's team gets `assists++`. `killer` is written to the victim's state. In `playing` the killer's team scores one point; with no killer the victim's opposing team scores (zone, falls, self-frags). Broadcast `elim`; then, with a killer, `reward` (kind `elim`) to the killer; reaching `scoreToWin` calls `end`. Eliminations in `ending` update personal stats but not the team score. Finally `checkWipe`.

`checkWipe(team)`: when nobody on the team is `alive`, every knocked member is eliminated (credited to their `lastHitBy`).

### 5.9 Other combat messages

- `shot`: relay only. Sender alive, `fighting()`, carries `w`; `o` must be 3 finite numbers; up to `SHOT_POINTS_MAX` valid points of `e`; all rounded to 2 decimals; broadcast to everyone else.
- `throw`: alive, `fighting()`, at least 400 ms since the last throw; `throws = min(throws + 1, 3)`; relayed when `p` and `v` are valid 3-vectors.
- `boom` (`onBoom`): the thrower need not still be alive. Requires `throws > 0`, the last throw at most `ITEMS.frag.fuse + 3` s ago, the blast within 60 m (horizontal) of the thrower's server position. `throws--`, `boom` relayed to the others. For each distinct id in `t` (max 18): target not dead, has a team, is an enemy or the thrower; distance from the blast to the target at `y + 1` must be `<= radius + 2`; damage `ITEMS.frag.damage * (1 - min(dist, R) / R) ^ 0.7`, halved for the thrower; applied when above 0.5 as `{ explosive: true, weapon: "frag" }` (body hit, so the vest applies).
- `wall`: relay; alive, `fighting()`, 300 ms rate limit, placement within 8 m of the sender.
- `heal`: alive, `fighting()`, at least `ITEMS.medkit.time * 800` ms (1760) since the last; `hp += ITEMS.medkit.heal` up to `HEALTH.max`.
- `ult`: alive, `fighting()`, at least `ULT_MIN_GAP_S` since the last. `jin`: self +90, alive teammates within `JIN_HEAL.range + 2` m +60. Others: `ultUntil = clock + duration` (only `rook` has a server effect). Broadcast `ult` to everyone.
- `reviving` then `revive`: `reviving { t }` records the target and time without checks. `revive { t }` needs: reviver alive, target knocked, same team, `fighting()`, a matching `reviving` at least `HEALTH.reviveTime * 800` ms (2400) old, and distance `<= HEALTH.reviveRange + RANGE_SLACK * 0.25` (6.5 m). Result: target `alive`, `hp = HEALTH.reviveHp`, 1 s of protection, broadcast `revive`.
- `fell`: in `playing` and not dead -> `eliminate(self, null, { zone: true })`.
- `respawn`: dead, has a team, phase `playing`, `clock - deadAt >= RESPAWN_MIN_S` -> `spawn(first = false)`.
- Spectating (eliminated players watch the others until they press Revive): `spectate { t }` sets `watch` (only while dead, with a team, `fighting()`, `t` another player with a team; anything else clears it). `heart { t }`: the sender must be dead and watching `t`; `HEART_GAP_MS`, at most `HEARTS_PER_TARGET` per target per round (`heartsGiven`); `t.hearts++`, broadcast `heart { f, t }`. `react { t, e }`: same watching rule, `e` in `REACTIONS`, `REACT_GAP_MS`; broadcast `react { f, t, e }`. `profileOf { t }`: `PROFILE_GAP_MS`; answers `playerProfile` with `t`'s name, `level`, `rp`, loadout, career `stats` (from the session profile, guests included) and this round's numbers. Hearts and reactions are social only: they grant nothing.
- `spawn(sessionId, p, s, first)`: alive, full HP, emote/ult/killer/`watch` cleared. Armour level from the `armor` upgrade: `1 + level` (so 2 or 3), else 0. First spawn: vest and helmet set to that level, no protection. Respawn: each piece becomes `max(current level, 1, upgrade level)` with full durability, and `protectedUntil = clock + HEALTH.spawnProtection`. Resets damage bookkeeping, sets `graceUntil = now + TIMING.spawnGraceMs`, re-applies the loadout, broadcasts `spawn { id, first }`.
- `open`: alive, `fighting()`, 250 ms rate limit.
  - `{ c }`: index `0 <= c < LOOT.crates`. Already open -> `openFail { c }` to the sender. Otherwise `crates[c] = clock + LOOT.respawn`, a 45% chance of +1 armour level (the vest if `vest <= helmet` and below 3, else the helmet if below 3), broadcast `opened { c, by }`.
  - `{ d }`: unknown, already opened or still falling -> `openFail { d }`. Otherwise `opened = true`, vest and helmet set to 3, broadcast `opened { d, by }`.
  - The server does not know crate positions; ammo and utility items inside are the client's.

### 5.10 Map vote, rewards, Gems, leaving penalty

- `GEMS`: `perElimination` 12, `perKnock` 3, `headshot` +3, `streak` +4 per elimination past the first (up to `streakCap` 5), and at the results `win` 40, `loss` 15, `mvp` 25 (`rewardsFor` puts these in `gemsRound`; `grant` adds them; leaving a running round gets none, `leaveMatch` zeroes it).
- Gems are granted kill by kill, not at the results: `reward(sessionId, r)` adds `r.gems` to `profile.gems` (capped at `GEMS_MAX`) and to `roundGems`, then sends the shooter `reward { k, t, gems, coins, rp, h, s, b, total }`. For an elimination `gems = perElimination + (head ? headshot : 0) + streak * (min(s, streakCap) - 1)` (`b` = that streak part; a zone death credited to the last attacker never counts as a headshot), `coins = REWARDS.perElimination`, `rp = REWARDS.rpPerElim`; for a knock `gems = perKnock`, `coins = REWARDS.perKnock`, `rp = 0`. The coins and rank points are the share this kill adds to the round's `rewards` (`rewardsFor` counts kills and knocks); they are sent so the HUD popup shows the server's numbers. Only during `playing` and only for an enemy. The Gems are saved with the next `persist` (round end, leave, final disconnect).

- `vote { map, mode }` is accepted only in phase `vote` from a player with `inMatch`.
- `rewardsFor(sessionId, p, mvpId)`: `won = p.team === state.winner`; `coins = round(kills * 12 + knocks * 3 + damage / 25 + (won ? 70 : 25) + (mvp ? 30 : 0))`; `rp = (won ? 40 : -12) + kills * 3`; `gemsRound` (the round's Gems, granted by `grant`), `gems = roundGems + gemsRound` (everything the round earned, for the results screen); plus the round's stats and final score.
- `finishRound()`: participants are players in the round with `playedRound === round`. MVP is the participant with the most kills (then damage) if they have at least one kill. Each gets `grant`, then `persist`. Then phase `results` and `flushReports()`.
- `grant(sessionId, s, r, finished)`: adds coins, `rp = max(0, rp + r.rp)`, `stats.matches++`, `wins`, `eliminations`, `deaths`, `damage`, `best`; counts the round into the missions (`countRound`; `play` / `win` only when `finished`, i.e. not when leaving) and pays new ranks (`payRankUps`); sends `rewards` (with `missions` and `rankUp`) and `profile`; for verified identities queues leaderboard scores (`eliminations`, `weekly_elims`, `best_match`, `wins`) and stats.
- Leaving a running round (`leaveMatch`): `rewardsFor` with no MVP, then `coins = max(0, round((coins - REWARDS.loss) * 0.5))`, `rp = min(rp, REWARDS.leavePenaltyRp)` (always -12 with the current numbers), `won = false`; granted and persisted at once. The match still counts in `stats.matches`.

### 5.11 Shop and profile persistence

- `loadSession(client, s)`: guests get a fresh `START_PROFILE` (`loaded = true`). Saved identities call `loadProfile`; on a database error the client gets `serverError { reason: "load" }` and `loaded` stays false, so nothing is ever written over a save that could not be read. On success the loadout is applied to the state (unless the player is in a running round) and `profile` is sent. A stale answer (session gone or identity switched meanwhile) is discarded.
- `buy { kind, id }`: replies `shop { ok, kind, id, error }` always (`error: "loading"` before the profile is loaded); on success also `profile`, then `persist`.
- `equip { kind, id, weapon? }`: ignored before the profile is loaded; on error replies `shop { ok: false, ... }`; on success `applyLoadout` at once when the player is not in a running round (otherwise at the next spawn), `profile`, `persist`.
- `getProfile`: re-sends `profile` if loaded.
- Local testing: `DEV_GEMS=<n>` (non-production only) starts a brand-new `dev-...` account with that many Gems, so the Weapons Store can be tried without playing rounds.
- `persist(sessionId)` writes only when `loaded` and `saved(s)`. It is called after a successful `buy`/`equip`, before an identity switch (`auth`), after rewards and penalties, and on the final leave.
- `sendProfile` payload: `{ profile, saved, userId }` (`userId` is `""` unless verified). It first calls `refreshMissions`, so a new UTC day / week rolls new missions.

### 5.13 Missions, rank rewards, first-round tips (`src/progress.ts`)

- `MISSIONS` (`perDay` 3, `perWeek` 3, `daily` 8 and `weekly` 6 definitions `{ id, stat, goal, coins, gems }`) and `RANKS` (`name`, `rp`, one-time `coins` / `gems`) mirror the client's `config.js MISSIONS` / `RANKS`.
- `profile.missions = { day, week, daily, weekly }` (slots `{ id, n, claimed }`). `refreshMissions(m, now)` rolls a random set when the UTC date (`dayKey`) or the Monday of the week (`weekKey`) changed; unclaimed rewards of the old set are lost. Called by `sendProfile`, `grant` and `claim`.
- `countRound(m, stats)` adds a round (`play`, `win`, `elims`, `knocks`, `damage`, `headshots` (headshot hits), `assists`, `revives` from `Session.roundRevives`) to every unclaimed slot, capped at the goal, and returns the ids it finished.
- `claim { m, i }` -> `claimMission`: errors `loading`, `unknown`, `claimed`, `unfinished`; otherwise pays coins and Gems (capped at `GEMS_MAX`), answers `claimed`, sends `profile`, persists.
- `payRankUps(profile)`: pays every rank above `profile.rankReward` that `rp` reaches, once. `normalizeProfile` sets a missing `rankReward` to the current rank (no back pay) and a missing `tutorial` to `stats.matches > 0`.
- `tutorialDone`: sets `profile.tutorial` and persists.
- Missions count whatever a round grants, so the round-reward weaknesses in section 12 (a forfeit win, `play` during `ending`) also advance `win` / `play` missions.
- Tests: `test/Progress.test.ts` (rollover, counting, claim, forged data, rank pay-out, a round that finishes missions and a rank, a claim, `tutorialDone`).

### 5.12 Single-session enforcement (`evictOthers`, close code 4100)

Called from `onJoin` and after an `auth` switch, only for verified or dev identities. Every other session in the same room with the same `userId` is closed with `REPLACED_CODE` (4100). The client treats 4100 as "playing in another tab" and does not reconnect. Scope and timing caveats are in section 12.

## 6. Identity and auth

1. The client sends `Legion.SDK.auth.getToken()` as the join option `token`.
2. `verifyToken(token)`: rejects non-strings and lengths outside 8..4096, then calls the verifier.
3. `verifyWithBloxity`: `POST {apiUrl()}/v1/auth/game-token/verify` with `Authorization: Bearer <token>` and body `{ gameSlug: GAME_SLUG }`, 6 s timeout. `null` on a non-2xx answer, `valid: false`, a missing `user._id`, or any error (logged as `[auth] verify failed`).
4. On success the identity is `userId = user._id`, `username = displayName || username || "Player"`, `pfp`, `carriedFrom` (up to 5 strings from the response), `outfitKey` (if it matches `OUTFIT_KEY`).
5. No client-sent id is ever used. Extra options such as `userId` are ignored.
6. Mid-session sign-in/out: message `auth { token, name, pfp }` re-verifies. If the resulting `userId` differs: the old profile is persisted, the identity replaced (`dev` cleared), `name`/`pfp`/`signedIn`/`uid`/`outfitKey` updated, `evictOthers`, `loadSession`.
7. `reportId(userId)`: strips any `#m...` suffix and prefixes `legion_` (unless already present); used for leaderboard and stats rows.

`__setVerifierForTest(fn)` replaces the Bloxity call in tests (`null` restores it).

## 7. Database layer

- One collection, `players`, in the database named by `MONGODB_URI`. `connectDb()` never throws; without a URI or on a failed connect, `getPlayers()` returns `null` and every caller skips persistence.
- Document (`PlayerDoc`): `_id` (verified Bloxity user id, or a `dev-...` id locally), all `Profile` fields at the top level, `username`, `updatedAt`, `version` (1, set on insert), optional `carried`.
- `loadProfile(userId, carriedFrom)` returns `{ profile, found, carried }`:
  - a document for `userId` -> normalized, `found: true`;
  - else the newest (by `updatedAt`) not-yet-`carried` document among `carriedFrom` (max 5) -> that document is marked `carried: true` and its normalized profile returned with `carried: true`; `loadSession` then saves it under the new id at once;
  - else a fresh profile. Database errors are thrown to the caller.
- `saveProfile(userId, username, profile)`: upsert with `$set: { ...profile, username, updatedAt }` and `$setOnInsert: { version: 1 }`; returns `false` (and logs) on error. The whole profile is written each time (last writer wins).
- `__setPlayersForTest(fake)` swaps the collection; `test/fakePlayers.ts fakePlayers(seed)` implements just `findOne({ _id })` and `updateOne(filter, { $set, $setOnInsert }, { upsert })` over a `Map` exposed as `.docs`.

## 8. Reporters

All best-effort; failures are logged or swallowed, never thrown into the room.

- `installRoomReporter()` (needs `BLOXITY_REPORT_TOKEN`, `BLOXITY_GAME_ID`, `MATCHMAKER_REPORT_URL`): every 2 s `POST {MATCHMAKER_REPORT_URL}/{gameId}/rooms` with `{ podName, players, rooms: [{ colyseusRoomId, name, clients, maxClients, locked, private, started, metadata }] }` built from `matchMaker.query({})`. `started` is always `false`: Bloxity's Open Rooms list renders a room that reports `started` as "Locked", and this room is joinable at any time (mid-round joiners are seated or queued), so reporting `started: true` made every room in a round look locked.
- `queueScores(userId, entries)`: appends `{ board, userId, score }` for each finite value above 0 (rounded). `queueStats(userId, values)`: keeps the latest values per user, limited to keys in `STAT_DEFINITIONS`, clamped to `0..1e9` (`number`) or `0..1e12` (`currency`). Both ignore a null `userId`.
- `flushReports()` (needs token and game id; without them the queues are just cleared): scores in batches of `REPORT_BATCH` to `POST {apiUrl()}/v1/leaderboards/hosted/{gameId}/report` with `{ boards: BOARDS, scores }`; stats to `POST {apiUrl()}/v1/games/{gameId}/stats` with `{ definitions: STAT_DEFINITIONS, players: [{ userId, values }] }`. A failed batch is logged and dropped. Re-entrant calls return immediately.
- `installReporters()`: `installRoomReporter()` plus a flush every `REPORT_EVERY_MS`. Flushes also happen in `finishRound` and `onDispose`.
- `BOARDS`: `eliminations` (sum), `wins` (sum), `best_match` (best), `weekly_elims` (sum, weekly reset). `STAT_DEFINITIONS`: `eliminations`, `wins`, `matches`, `deaths`, `damage`, `best`, `coins` (currency).
- Only verified identities are reported (`grant` checks `identity.verified`); dev and guest sessions never are.

## 9. Tests

`test/server.ts` exports `testServer()`: one `@colyseus/testing` server booted from `app.config` and shared by every test file (booting twice in one mocha run fails). `test/fakePlayers.ts` exports `sleep`, `until(fn, ms, what)` and `fakePlayers`. `test/Match.test.ts` shortens `PHASES` and `TIMING` with `Object.assign` at module load and defines `startRound(colyseus, n, opts)` (creates a room, connects `n` clients, sends `play`, waits for `playing`).

| Test | Covers |
|---|---|
| waits for a second player... | `waiting` with one player, round start with two, one per team, mode vote, name |
| checks hits... | damage number (striker 34 at 10 m), fire-rate refusal, weapon not carried, teleporting pose ignored |
| eliminates, scores, ends the round and pays rewards | elimination without teammates, kill count, `scoreToWin`, `rewards` payload, the `reward` message (headshot elimination: 7 Gems, 12 coins, 3 rp) and `rewards.gems` |
| Gems from a kill are saved to the account... | Gems added to a saved balance, written to the fake collection on leave, sent back in `profile` on the next join |
| knocks when a teammate is standing... | knock, revive refused without the hold, revive after `reviving` + 2.6 s |
| a frag's blast is the server's... | `boom` refused without `throw`, blast damage at close range |
| a second session of the same account... | close code 4100 for the older session (dev ids) |
| shop: skins with coins, weapons with Gems... | `profile`, a skin bought with coins, a weapon refused with `gems` (coins never buy it), the skin `equip` reflected in state, save in the fake collection |
| Gem shop: weapons, grenades and the pass cost Gems... | a weapon bought with Gems, the pass and a grenade refused when short, coins untouched, the pass unlocking its set, an unowned grenade refused by `equip` |
| a medic weapon heals a teammate... | the Mender stings an enemy, heals a teammate, and a normal gun still does no friendly damage |
| spectating: the eliminated player watches someone... | `spectate` refused while alive; after the elimination: a heart before watching is ignored, `spectate` sets `watch`, a second heart within 400 ms is dropped, `heart` / `react` broadcasts, an unknown reaction is ignored, `playerProfile` answers, and a respawn clears `watch` |
| `Progress.test.ts` | missions and rank rewards: unit tests of `progress.ts`, and a round that finishes missions and a rank, then a claim and `tutorialDone` |
| verifies the token... | faked verifier, spoofed name/id ignored, verified `outfitKey`, `avatar` updates and validation, guest carry-over, refused token = guest |

Adding a test: create `test/<name>.test.ts` (matched by the glob), get the server with `await testServer()`, call `__setPlayersForTest(null)`, `__setVerifierForTest(null)` and `await colyseus.cleanup()` in `beforeEach`, use `colyseus.createRoom("match", {})` and `colyseus.connectTo(room, options)`. Poll with `until` instead of fixed sleeps where possible. Mutable rule objects (`PHASES`, `TIMING`, and the objects in `rules.ts`) can be changed with `Object.assign`; such changes are process-wide and stay for later test files. Plain constants (`RECONNECT_SECONDS`, `ULT_MIN_GAP_S`, `RESPAWN_MIN_S`, `FIRE_RATE_SLACK`) cannot be shortened; fire-rate and revive checks use real time. `room.state` can be edited directly (the tests set `scoreToWin = 1`). The `@colyseus/sdk: onMessage() not registered` lines in the test output are harmless (test clients do not register every server message).

## 10. Recipes

**Add a client -> server message**
1. Add a handler to `messages` in `MatchRoom`. Resolve `this.player(client)` and the session, validate every field (`num`, `str`), gate on `p.life` / `this.fighting()` as needed, and rate-limit with a new `last...At` field (add it to `Session` and to the literal in `onJoin`).
2. Answer with `client.send(type, payload)` or `this.broadcast(type, payload, { except: client })`, or change the schema state.
3. Client: `send('type', payload)` from the owning module. For a new server -> client type, add it to `MESSAGES` in the client's `src/net.js` and register `onNet('type', fn)`.
4. Add a test and update `docs/protocol.md`.

**Add a weapon or change its damage**
- Server `rules.ts WEAPONS` (rule) and `catalog.ts WEAPON_PRICES` (slot, price). Client `src/config.js WEAPONS` (same `slot`, `damage`, `interval`, `range`, `headMul`, `pellets`, `price`, plus model/icon fields). A damage change is `damage` in both files. `normalizeProfile` drops ids missing from `WEAPON_PRICES`, so deploy the server first.

**Add a shop item or change a price**
- Skin: `SKIN_PRICES` + client `SKINS`. Operative: `OPERATIVE_PRICES`, `rules.ts OPERATIVES` + client `OPERATIVES`. Store upgrade/emote: `STORE` + client `STORE`; a new emote id also goes in `EMOTES`, `EMOTE_RE` (in `MatchRoom.ts`) and the client's `ANIM.emotes`. An upgrade needs its effect implemented (`armor` is the only one the server applies, in `spawn`; `medkits`/`walls`/`frags` are applied by the client's `match.js kit`). Coins only; never add a premium-currency price.

**Add a map to the vote**
- Append to `rules.ts MAP_FOCUS` and to the client's `MAPS` at the same index (`id`, `name`, `mood`, `tint`, `focus`, `shot`). `MAP_COUNT` follows. The `focus` must be identical on both sides or the zones diverge.

**Change round length, phase lengths or team size**
- Round length/score: `rules.ts MODES` + client `MATCH_MODES`. Check `ZONE.phases` and `LOOT.airdropAt` against the new duration.
- Phase lengths: `rules.ts PHASES` + client `MATCH` (`voteTime`, `introFlyover`, `countdown`, `endSlowmo`).
- Team size: `TEAM_MAX` and `ROOM_MAX_CLIENTS` (the lobby size, independent of `TEAM_MAX`, literal integer, 2..100: the deploy sends it as `roomSize`; a round seats 2 x `TEAM_MAX`), client `NET.roomSize`, `NET.teamMax` (also the party size) and `MATCH_MODES[].teamSize` / `desc`. `MIN_PLAYERS` pairs with client `NET.minPlayers`.

**Add a persisted profile field**
1. `catalog.ts`: `Profile`, `START_PROFILE`, and `normalizeProfile` (validate and copy it; uncopied fields are dropped on load). New `stats` keys are picked up automatically from `START_PROFILE.stats`.
2. Mutate it in a handler or in `grant`, then `sendProfile` and `persist`.
3. Client `config.js START_PROFILE` (the client merges it under the server's copy in `save.js`).

**Add a reported stat or leaderboard**
- Stat: add to `STAT_DEFINITIONS`; make sure the value is in the object passed to `queueStats` in `grant` (`{ ...profile.stats, coins }`).
- Leaderboard: add to `BOARDS` and to the client's `LEADERBOARDS` (ids are permanent once created), and add the entry to the `queueScores` call in `grant` (`sum` boards receive per-round amounts, `best` boards the round's value; zero is not sent).

## 11. Gotchas and invariants

- Two clocks: `state.clock` (round seconds, advances only in `playing`) and `Date.now()` ms. `protectedUntil`, `deadAt`, `ultUntil`, crate refill, drop `at`, `lastDamageAt`, streak and assist windows use the round clock; rate limits, grace windows and the revive hold use wall time.
- `fighting()` covers `ending`: damage, heals, revives and relays still work for the 2.4 s after the round is decided; score, zone damage, airdrops, `respawn` and `fell` do not.
- `PlayerState` loadout fields are only ever written by `applyLoadout` from the server profile.
- `PHASES` and `TIMING` must stay mutable objects (tests assign into them).
- `rules.MODES` (record with rules) and `catalog.MODES` (id list) are separate; a new mode goes in both.
- `state.crates` keys are strings; drop ids are never reused within a room.
- The zone planner, `ZONE`, `ISLAND_RADIUS` and `MAP_FOCUS` are a wire contract with the client (`protocol.md` section 7).
- The server cannot see crate positions, ammo, item counts or ability charge; do not write logic that assumes it can.
- A guest's profile lives in memory for the session only (600 starting coins each time).
- `onAuth` never rejects, so a room never refuses a join for identity reasons.
- `equip` during a running round changes the profile at once but the visible loadout (and what `carries` accepts) only at the next spawn.

## 12. Observations

Items marked (reproduced) were confirmed by running a throwaway test against the current code outside the repo; the rest come from reading the source.

**Repository**
- `build/` was rebuilt from this `src/` on 2026-11-14 (it used to hold another project's output). It is git-ignored and recreated by `npm run build`.
- `deploy.yml` still describes `roomSize` as "WorldRoom's maxClients". Comments in `constants.ts` ("client net.js NET_REPLACED") and `MatchState.ts` ("client net.js FLAGS") name client symbols that are actually `REPLACED_CODE` in `net.js` and `FLAG` in `online.js`. The `catalog.ts` header mentions `RANKS`, which exists only on the client.
- Unused: `ID_PATTERN`, the server-side `FLAG` export, `OPERATIVES[].charge`, `loadProfile().found`, the boolean returned by `saveProfile`, `PlayerDoc.version` beyond insert.
- `CLAUDE.md` lists the events sent without `openFail` and `serverError`, and says "one live session per account"; see the next block for what the code does.

**Sessions and saves**
- Single-session enforcement is per room. Two connections of one account in different rooms (or pods) are not detected and both write the save.
- (reproduced) A replaced session is not removed at once. `client.leave(4100)` reaches `onLeave` with a non-consented code, so it goes through `allowReconnection` and stays in `state.players` and `sessions` for `RECONNECT_SECONDS`. When the window ends, its `persist` writes its in-memory profile: in the test, the newer session bought a weapon (saved: 200 coins), and about 20 s later the document was back to 600 coins without the weapon. The newer session's next save restores its own copy, so the visible effect depends on write order. By the same code path (not separately tested), a dropped connection that rejoins as a new session within 20 s leaves its old session to write once more when the window ends.
- Guest carry-over reads documents by the ids in `carriedFrom`, but this server never writes a document for an unverified session. It can only find something if those ids were themselves verified identities earlier.
- The `auth` switch keeps the old profile object in the session until the new one loads; rewards granted in that gap are applied to the old object and discarded.

**Hit and action validation**
- (reproduced) Repeating a shot number bypasses the fire-rate check: four `hit` messages with the same `s` in one frame dealt 4 x 34 damage. There is no per-shot, per-target dedupe and no cap on total pellets per shot number. A missing `s` (-1) behaves the same way.
- `h`, `n` and `d` are the client's word within their clamps: every hit can be claimed as a headshot, and `d = 0` removes falloff. No line-of-sight check. Fire-rate clocks are per weapon and the held slot is not checked, so primary, secondary, knife and fists can be interleaved; `FIRE_RATE_SLACK` alone allows about 1.67x the nominal rate.
- `heal` has no medkit count: +80 HP every 1.76 s. `ult` needs only the 18 s gap, not charge. `throw`/`boom` have no frag count. `wall` has no count.
- `open` has no proximity check and accepts indexes up to 200 regardless of how many crates exist; an airdrop can be opened from anywhere for level 3 armour.
- `reviving` is unvalidated (no range or life check at the start of the hold); only the final `revive` is checked, at 6.5 m.
- Poses: `MAX_SPEED` 32 m/s is about three times the client's fastest legitimate sustained speed (8.6 x 1.3); height is only bounded to -60..300; dead players are not speed-checked; every spawn opens a 4 s window in which the client may place itself anywhere. `fell` is purely client-reported.
- No message rate limit: Colyseus `maxMessagesPerSecond` defaults to `Infinity` (checked in the installed `@colyseus/core` 0.18.23) and the room does not set it. `shot`, `pose`, `avatar`, `emote`, `getProfile` have no per-message throttle.

**Rounds and rewards**
- (reproduced) A side left without players forfeits at any time, including `intro`: the remaining player received `won: true`, 70 coins, +40 rp with the clock at 0. A guest in a second tab can be the opponent, so wins (coins, rp, the `wins` leaderboard) can be farmed roughly every half minute.
- `play` during `ending` seats the player and `finishRound` pays them a full win or loss.
- Eliminations with no enemy killer (zone, fall, own frag) give the other team a point. Eliminations during `ending` count for coins, rp and MVP but not the team score.
- Attacker `damage` (which pays coins) counts overkill and damage to knocked players.
- Leaving during `ending` on the winning side computes the penalty from a total that included the win bonus.
- Armour: a respawn keeps the armour level and restores full durability; the Rook cut also reduces zone damage.
- `squad` rounds (180 s) end before the last zone phase finishes shrinking (160 + 30 s).
- Fixed 2026-11-14: `ult` is no longer broadcast to its sender.
- `equip` before the profile has loaded is silently ignored, while `buy` answers `error: "loading"`.
