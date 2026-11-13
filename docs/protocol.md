# Free Fire Zone wire protocol

The complete contract between the client (`../Free-fire-zone`, `@colyseus/sdk` 0.18) and this server (Colyseus 0.18 room `match`). Server internals are in [`server.md`](server.md).

Paths: server files are relative to this repo's `src/`; client files are relative to the client repo's `src/`. `sid` means a Colyseus `sessionId`. Positions are metres (+X east, +Z south, +Y up), angles radians, the "round clock" is `state.clock` (seconds of `playing`).

## 1. Transport

- WebSocket through Colyseus. Messages are `room.send(type, payload)` / `client.send(type, payload)` with string types and plain-object payloads. Max message size `MAX_PAYLOAD_BYTES` (64 KB).
- Room state (`MatchState`) is synced by schema patches every `PATCH_MS` (50 ms). The client joins without a schema class and reads the reflected state as `net.state`.
- Client entry points (`net.js`): `connect()`, `disconnect()`, `send(type, msg)` (returns `false` when not online), `onNet(type, fn)`, `me()` (own `PlayerState`), `reportRoom(team)`, `setJoinOptions(fn)`. `net` holds `room`, `state`, `sessionId`, `status`, `error`, `relayRoomId`.

## 2. Connection

### 2.1 When the client connects
`main.js` calls `connect()` once Bloxity auth has settled (`bloxity.subscribeAuth`, `s.ready`). `startMatchFlow()` (PLAY) also calls it when offline. Everything in the lobby that needs the profile (shops, loadout) depends on being in a room.

### 2.2 Endpoint resolution and join path (`net.js joinOnce`)
Each attempt, in order:

1. Launch room, first attempt only: URL `?roomId=<id>` (Open Rooms "Join" = bare Colyseus room id; friend invite = `<relayRoomId>~<roomId>`). `bloxity.locateRoom(id)`:
   - `relay~room`: endpoint `{playUrl as ws}/v1/ws/<relay>`, then `new Client(endpoint).joinById(roomId, options)`.
   - bare id: `GET {playUrl}/v1/dir/free-fire-zone/list`, pick the entry with that `colyseusRoomId` that is not locked and not full, join by id at its `joinUrl`.
   - Not found, full or failing: fall through to matchmaking.
2. Endpoint (`resolve()`): with the Bloxity SDK and no `VITE_SERVER_URL`, `Legion.SDK.net.resolveEndpoint('free-fire-zone', { userId })` returns `{ endpoint, roomId }` (`roomId` here is the matchmaker relay id, kept as `net.relayRoomId`). Otherwise `NET.devServer` (`VITE_SERVER_URL`) or `ws(s)://<page host>:2567`. A new `Client` is built per attempt.
3. Private room, first attempt only: URL `?instantMultiplayer=true` -> `client.create('match', { ...options, private: true })`.
4. Otherwise `client.joinOrCreate('match', options)`. With a party, an error matching `/full|locked/` also calls `bloxity.partyFailed('room-full')`.

After a successful join (`attach`): message listeners registered, `status = 'online'`, `reportRoom()` (`Legion.SDK.game.updateRoom("<relay>~<roomId>" or "<roomId>", team)`), local event `joined` (which makes `save.js` send `getProfile`), `registerFeature('play_with_friends')`, and `bloxity.partyJoined(room.roomId)` for a party launch.

### 2.3 Join options

Built by `net.js joinOptions` plus `main.js setJoinOptions`. Read by `MatchRoom.onAuth` / `onJoin` / `onCreate`.

| Option | Type / limit | Sent when | Server use |
|---|---|---|---|
| `token` | string, 8..4096 chars | Bloxity SDK has a game token | Verified with Bloxity; the only source of an account id |
| `devUser` | `/^dev-[a-z0-9-]{4,40}$/` | dev builds or `VITE_DEV_MODE` only; from `?devUser=` or `localStorage['ffz.devUser']` | Used as the account id only when the token is not verified and `NODE_ENV !== "production"` |
| `party` | string, max 128 | party launch (`Legion.SDK.party.getLaunch().roomKey`) | `PlayerState.party`; same key = same team when there is room |
| `name` | string, max 32 | always (`"Guest"` when offline from Bloxity) | Guest display name; ignored for verified identities |
| `pfp` | `http(s)://` URL, max 512 | always | Used when the verified identity has no picture, and for guests |
| `avatar` | JSON string, max 4000 | always (`""` without a look) | `PlayerState.avatar` |
| `outfitKey` | `/^[A-Za-z0-9_.~-]{1,256}$/` | when the SDK has one | `PlayerState.outfitKey` unless Bloxity's verify response supplies one |
| `private` | `true` | only on `create` for `?instantMultiplayer=true` | `onCreate`: `setPrivate(true)` |

Not join options: `roomId` and `instantMultiplayer` are page URL parameters that pick the join path; `carriedFrom` (guest ids to carry progress from) comes only from Bloxity's verify response, never from the client; any client-sent `userId` is ignored.

### 2.4 Close codes and reconnection

| Code | Meaning | Client behaviour |
|---|---|---|
| 4000 `CONSENTED` | Client left on purpose (`disconnect()` -> `room.leave(true)`, on `beforeunload`) | none; the server frees the seat at once |
| 4100 `REPLACED_CODE` | The same account joined this room again | `status = 'offline'`, `net.error = 'You are playing in another tab'`, no reconnect |
| 1001, 1005, 1006, 4010 | Dropped connection | The SDK reconnects by itself with the same session: `room.onDrop` -> `status = 'connecting'`, `room.onReconnect` -> `'online'`. The server holds the seat for `RECONNECT_SECONDS` (20), then re-sends `profile` and allows pose jumps for 3 s |
| any other / SDK gave up | Room lost | `room.onLeave`: `net.room/state/sessionId` cleared, local event `left` (`main.js` returns to the lobby), `status = 'offline'` (`'Disconnected'`), then `connect()` after 1.5 s (a new session and possibly another room) |

`connect()`: one attempt chain at a time. Sets `status = 'connecting'`, retries `joinOnce` with a wait of 1 s growing x1.6 up to 8 s, for at most `NET.connectTimeout` (60 s); then `status = 'offline'` with `'Could not reach the game server'` and resolves `false`. Local events for `onNet`: `status` (the new status), `joined` (the room), `left` (the close code).

## 3. Client -> server messages

Every handler ignores the message when the sender has no player/session. "Fighting" = phase `playing` or `ending`.

| Type | Payload | Sent by (client) | Server action | Reply / broadcast |
|---|---|---|---|---|
| `play` | `{ mode }` (`'clash'` or `'squad'`) | `main.js startMatchFlow` (PLAY), with `profile.mode` | Ignored if already `inMatch`. Sets `inMatch`, `voteMode`, `vote = -1`; in a running phase seats the player at once (`joinRound`) | State; `spawn { id, first: true }` to all when seated mid-round |
| `getProfile` | none | `save.js` on the local `joined` event and after a refused `shop` | Re-sends the profile if loaded | `profile` to the sender |
| `leave` | none | `main.js leaveMatch` (HUD and results "Lobby", queue "Leave the team") | `leaveMatch`: leave penalty in a running round, back to the menus, team check | `rewards` + `profile` to the sender when penalised; possibly `matchEnd` to all |
| `vote` | `{ map }` int `0..MAP_COUNT-1` (server also accepts `mode`) | `main.js` `onVote` (map card click in `lobby.js`) | Only in phase `vote` with `inMatch`: sets `vote` (and `voteMode`) | State |
| `pose` | `{ x, y, z, yaw, pitch, speed, flags, slot }` | `online.js sendPose`, up to `NET.poseHz` (20) per second while in a match | Bounds and speed checks, then writes the pose (section 6) | State |
| `avatar` | `{ avatar, outfitKey }` (JSON string max 4000; key pattern or `""`) | `main.js sendAvatar` (auth change, avatar change, proportions change) | Sets `avatar` / `outfitKey` when valid | State |
| `emote` | `{ emote }`: `wave`, `dance`, `salute`, `flex`, `cheer`, `portal:<id>` or `""` | `controller.js playEmote` (Z key, portal emote button); `updateController` sends `""` when moving or firing cancels it | Alive only. `""` clears. Must match `EMOTE_RE`; non-portal emotes must be owned. Cleared by the server after 6 s, when `speed > 1.2`, on damage | State (`emote`) |
| `auth` | `{ token, name, pfp }` | `main.js` (`bloxity.subscribeAuth`) when the Bloxity user changes after the first connect | Re-verifies; on a different id saves the old profile, switches identity, loads the new profile | `profile` (or `serverError`) to the sender; possibly closes other sessions with 4100 |
| `buy` | `{ kind, id }`, `kind`: `weapon`, `skin`, `operative`, `store` | `save.js purchase` (`buyWeapon`, `buySkin`, `buyOperative`, `buyStoreItem`), applied optimistically | `catalog.buy`; saves | `shop` to the sender always; `profile` on success |
| `equip` | `{ kind, id, weapon? }`, `kind`: `weapon`, `skin` (with `weapon`), `operative`, `emote`, `mode` | `save.js equip` (`equipWeapon`, `equipSkin`, `equipOperative`, `equipEmote`, `setMode`), optimistic | `catalog.equip`; visible loadout updated now (menus) or at the next spawn (in a round); saves. Ignored while the profile is loading | `profile` on success; `shop { ok: false }` on refusal |
| `shot` | `{ w, o: [x,y,z], e: [[x,y,z], ...] }` (max 12 end points, 2 decimals) | `combat.js fire`, every gun shot (not melee) | Alive, fighting, weapon carried, valid `o` | `shot` to all but the sender |
| `hit` | `{ t, w, s, n, h, d }`: target sid, weapon id, shot number, pellets that hit, of them headshots, distance (m, 1 decimal) | `combat.js fire` (one per target hit by the shot) and `resolveMelee` (`n: 1, h: 0`) | `onHit`: team, life, loadout, fire rate, range; computes and applies damage | `dmg`, then possibly `knock`, `elim`, `matchEnd`, to all |
| `throw` | `{ p: [x,y,z], v: [x,y,z] }` (start, velocity m/s) | `items.js release` (frag leaves the hand) | Alive, fighting, 400 ms rate limit; counts a pending frag (max 3) | `throw` to all but the sender |
| `boom` | `{ x, y, z, t: [sid, ...] }` (blast point, targets in the blast with line of sight) | `combat.js explode` (the local player's frag fuse ran out) | `onBoom`: needs a pending throw not older than fuse + 3 s, within 60 m of the thrower; damage by server distance | `boom` to all but the sender; `dmg` etc. to all |
| `wall` | `{ x, y, z, yaw }` | `items.js deployWall` | Alive, fighting, 300 ms rate limit, within 8 m of the sender | `wall` to all but the sender |
| `heal` | none | `items.js updateActorItems` when the medkit timer (2.2 s) completes | Alive, fighting, 1.76 s rate limit; +80 HP up to 200 | State (`hp`) |
| `ult` | none | `items.js useUltimate` (Q) | Alive, fighting, 18 s gap; Jin heals, others set `ultUntil` | `ult` to all, sender included |
| `reviving` | `{ t }` knocked teammate sid | `controller.js updateController` when a revive hold starts | Records the hold start (no checks) | none |
| `revive` | `{ t }` | `controller.js updateController` when the hold reaches `HEALTH.reviveTime` (3 s) | Hold at least 2.4 s old, same team, target knocked, within 6.5 m | `revive` to all |
| `fell` | none | `main.js` `body.onFellOut` (below `PHYSICS.killY`, at most once a second) | In `playing`, not dead: eliminated as a zone death | `elim` to all |
| `respawn` | none | `main.js requestRespawn` (Respawn button via the portal death screen, or the `NET.respawnFallback` 5 s timer) | Dead, has a team, `playing`, at least 3.5 s of round clock since death | `spawn { id, first: false }` to all |
| `open` | `{ c }` crate index, or `{ d }` airdrop id | `loot.js openCrate` (E on a crate or landed drop) | Alive, fighting, 250 ms rate limit; marks it open; rolls or grants armour | `opened` to all, or `openFail` to the sender |

Notes:
- `hit.s` comes from one counter in `combat.js` (`shotSeq`) shared by all weapons; all hits of one shot (several pellets, several targets) carry the same number.
- `hit.d` is measured from the camera (the aim ray origin), not from the character.
- `shop`-style requests are optimistic on the client: the local `profile` is changed before the answer and replaced by the next `profile` message.

## 4. Server -> client messages

All listed types are registered in `net.js MESSAGES` and forwarded to `onNet(type, fn)` listeners. "Bus" = the game event bus in `game/state.js` (`emit`).

| Type | Payload | Sent when | To | Client handling |
|---|---|---|---|---|
| `profile` | `{ profile, saved, userId }` (`Profile`; `saved`: stored for this identity; `userId`: verified id or `""`) | After the profile loads, on `getProfile`, after a successful `buy`/`equip`, with every reward, after a reconnect | one | `save.js`: replaces the mirrored `profile`, sets `account.loaded` / `account.saved`, notifies `onProfile` listeners. `userId` is not read |
| `shop` | `{ ok, kind, id, error }`, `error`: `null`, `loading`, `unknown`, `owned`, `coins`, `locked`, `slot` | Every `buy`; a refused `equip` | one | `save.js`: on `ok: false` sends `getProfile` to resync |
| `rewards` | `{ won, mvp, coins, rp, eliminations, knocks, assists, damage, deaths, headshots, score: { blue, orange } }` | End of the round (`finishRound`), or on leaving a running round | one | `main.js`: stored; `showRoundResults` -> `results.js showResults` |
| `serverError` | `{ reason: 'load' }` | The profile could not be read from the database | one | no listener |
| `round` | `{ round }` | `startRound` | all | no listener (the client follows `state.phase`) |
| `spawn` | `{ id, first }` | Round start, mid-round join, respawn | all | `online.js`: own id -> `match.spawnActor(G.player, first)` (picks the position; bus `spawn`), skipped for a first spawn when already alive; others -> pose buffer cleared, `life = 'alive'` |
| `dmg` | `{ t, a, n, h, z, e }`: target sid, attacker sid or `""`, amount (1 decimal, after armour), head, zone, explosive | Every applied damage | all | bus `damage { target, attacker, amount, head, point, dir, zone, explosive }`; hit flash; charges the local ability when the local player is the attacker |
| `knock` | `{ t, a, w, h }` | A player is knocked | all | sets `life = 'knocked'`; bus `knock { target, attacker, weapon, head }` |
| `elim` | `{ t, k, w, h, s }`: victim, killer sid or `""`, weapon id / `zone` / `frag` / `""`, head, killer's streak | A player is eliminated | all | sets `life = 'dead'`; for the local player `respawnAt = G.time + NET.respawnFallback`; bus `elimination { target, killer, weapon, head, streak }` |
| `revive` | `{ t, b }` revived sid, reviver sid | A revive succeeds | all | sets `life = 'alive'`; effects; bus `revive { target, by }` |
| `shot` | `{ id, w, o, e }` | Relay of `shot` | all but the sender | `online.js`: muzzle flash, tracers, sound, near-miss whiz, switches the remote actor's held weapon; bus `shot { actor, pos, recoil }` |
| `throw` | `{ id, p, v }` | Relay of `throw` | all but the sender | `items.js remoteThrow`: a visual grenade that vanishes at the fuse |
| `boom` | `{ id, x, y, z }` | A frag exploded | all but the sender | `combat.js explodeVisual` (bus `explosion`); `id` is not read |
| `wall` | `{ id, x, y, z, yaw }` | Relay of `wall` | all but the sender | `items.js remoteWall`: a real collider locally (bus `wall`) |
| `ult` | `{ id, op }` | An ability was accepted | all | `items.js ultVisual(actor, op)` (bus `ultimate`) |
| `opened` | `{ c, by }` or `{ d, by }` | A crate or airdrop was opened | all | `loot.js markOpened(c, d)` unless `by` is the local player |
| `openFail` | `{ c }` or `{ d }` | `open` refused (already open, unknown drop, drop still falling) | sender | no listener |
| `matchEnd` | `{ winner }` (`blue` / `orange`) | The round is decided (`end`) | all | bus `matchEnd { winner }` (slow motion, banner) |

## 5. Schema state the client reads

Field definitions are in `server.md` section 4. `net.state` is read directly each frame; nothing subscribes to change callbacks.

| State | Consumed in |
|---|---|
| `phase`, `phaseLeft` | `main.js syncFlow` (phase transitions, countdown), `queueInfo` (vote timer), `enterRound` (late-join intro/countdown progress) |
| `clock` | `online.js syncClock` -> `G.time` (hard snap when off by more than 0.4 s, else eased); `match.js createMatch` |
| `duration`, `mode`, `scoreToWin`, `round` | `match.js createMatch`; `duration` also in `online.js applyState` |
| `map` | `main.js enterRound` -> `MAPS[map]` (mood, zone focus, flyover) |
| `zoneSeed` | `match.js createMatch` -> `zone.reset(seed, map.focus)` |
| `blue`, `orange` | `online.js applyState` -> `G.match.score` |
| `winner` | `main.js showRoundResults` |
| `crates` | `online.js syncLoot` -> `loot.js syncCrates`, once on entering a round (later changes arrive as `opened`; refills run on the local clock) |
| `drops` | `online.js applyState` -> `loot.js syncDrops` every frame (spawns unseen drops, marks opened ones) |
| `players` (roster) | `online.js reconcile` (remote actors for players with `inMatch` and a team), `roster()` (lobby list, `main.js showMates`), `trackRoster` (friend-join notices), `main.js queueInfo` (ready count, votes) |
| player `name`, `pfp`, `uid` | remote actor name/portrait/chat bubbles (`makeRemote`, `applyRemote`), lobby roster, vote cards |
| player `avatar`, `outfitKey` | `online.js loadRemoteAvatar` (remote actors), `main.js showMates` (lobby platform, prewarm) |
| player `inMatch`, `team`, `vote` | `syncFlow`, `queueInfo`, `reconcile`; the local team in `applyState` |
| player `life`, `hp`, `downHp`, `vest`, `helmet`, `protectedUntil` | `applyState` (local player mirror) and `applyRemote` |
| player `x`, `y`, `z`, `yaw`, `pitch`, `flags`, `slot` | `applyRemote` (remote players only) |
| player `primary`, `secondary`, `skinPrimary`, `skinSecondary`, `operative` | `match.js createMatch` (local loadout for the round), `makeRemote` / `applyRemote`, lobby roster |
| player `emote`, `ultUntil` | `applyRemote` (remote players; `shade` -> cloak, others -> ability aura) |
| player `kills`, `deaths`, `assists`, `knocks`, `headshots`, `damage` | `online.js copyStats` (scoreboard, MVP, results) |

Synced but not read by the client: `signedIn`, `party`, `voteMode`, `deadAt`, `killer`, `speed`.

The `avatar` string is `JSON.stringify({ equipped, proportions, outfitKey })` (`avatar/look.js lookToJson`): Bloxity ids only. `lookFromJson` drops any `equipped` value containing `/` or `:` and prefers the state's `outfitKey` over the one inside the JSON.

## 6. Pose replication

Sending (`online.js sendPose`, called from `main.js gameFrame` in every match phase except `results`): accumulates frame time and sends when at least `1 / NET.poseHz` s (50 ms) have passed, so at most 20 per second.

| Field | Value | Server handling |
|---|---|---|
| `x`, `y`, `z` | position, 2 decimals | must be finite; `abs(x)`, `abs(z)` <= `WORLD_BOUND` (400); `-60 <= y <= 300`; else the whole pose is dropped |
| `yaw` | facing, 3 decimals | any finite value |
| `pitch` | 3 decimals, + = down | clamped to +-1.6 |
| `speed` | horizontal speed m/s, 2 decimals | clamped to 0..60; above 1.2 clears a running emote |
| `flags` | `FLAG` bitmask | clamped to 0..65535, stored as is |
| `slot` | held weapon slot | clamped to 0..3 |

`FLAG` bits (identical in `online.js` and `rooms/schema/MatchState.ts`): `crouch` 1, `aim` 2, `grounded` 4, `reload` 8, `heal` 16, `throw` 32, `swing` 64, `sprint` 128. The client sets all but `sprint`.

Speed check: with a previous accepted pose, outside the grace window and when not dead, the horizontal move must be `<= MAX_SPEED (32) * dt + MOVE_SLACK (6)` where `dt = max(0.05, seconds since the last accepted pose)`. A rejected pose is ignored without a reply; the next acceptable one is measured from the last accepted position. Grace windows (jumps allowed): `TIMING.joinGraceMs` 5 s after joining, `TIMING.spawnGraceMs` 4 s after any spawn, 3 s after a reconnect.

Receiving (`online.js applyRemote`): a snapshot `{ t, x, y, z, yaw, pitch }` is stored when the state's position or yaw differs from the last one (max 12 kept; a horizontal jump over 15 m, or a `spawn` message, clears the buffer). The actor is drawn at `now - NET.interpDelay` (0.1 s) by linear interpolation between the two surrounding snapshots (shortest-arc for yaw). Velocity is derived from the drawn positions (zeroed above 30 m/s). `grounded` is the flag or `flags === 0`; reload/heal/throw timers run locally while their flag is set; `swing` starts a swing.

## 7. The deterministic zone

The server never streams the circle. Both sides compute it from `state.zoneSeed`, the voted map's focus and the round clock.

- Generator: `mulberry32(seed)` (identical code in `zone.ts` and the client's `game/zone.js`): 32-bit state, returns a float in `[0, 1)`.
- Inputs: `seed = state.zoneSeed` (uint32, new each round); `focus = MAP_FOCUS[state.map]` on the server = `MAPS[state.map].focus` on the client; `ZONE` (`start`, `phases`, `damage`); island radius 125 (`ISLAND_RADIUS` / the client's `G.island.radius`).
- Start: centre `(0, 0)`, radius `ZONE.start` (150), `phase = -1`. Server: `new Zone(seed, focus)`. Client: `zone.reset(seed, focus)` in `match.js createMatch`. Both immediately call `planNext(0)`.
- `planNext(i)` is the only consumer of random numbers, exactly two per call, in this order:
  1. `a = rand() * 2 * PI` (angle);
  2. `j = sqrt(rand()) * phases[i].radius * 0.45` (jitter distance around the focus).
  Then: target = focus + `(cos a, sin a) * j`; move from the current centre toward it by at most `0.85 * max(0, currentRadius - phases[i].radius)`; clamp the result to within `max(0, 125 - phases[i].radius * 0.6)` of the origin; the next radius is `phases[i].radius`.
- `update(t)`: when not shrinking and `t >= phases[next].at`, the phase starts (from = current, `damage = ZONE.damage[min(phase, last)]`). While shrinking, centre and radius are linear in `k = min(1, (t - at) / shrink)`; at `k >= 1` the shrink ends and `planNext(phase + 1)` runs if there is another phase.
- Total draws per round: 2 per phase (6 with the current 3 phases), always in phase order. A late joiner converges in at most one `update` per elapsed phase, because each finished phase ends exactly on its planned circle.
- Server use: `zone.outside(x, z)` for zone damage (`ZONE.damage` per second outside). Client use: drawing, HUD timer, spawn-point choice; the client applies no zone damage itself.

Lockstep rule: any change to `mulberry32`, the order or number of `rand()` calls, the arithmetic in `planNext` / `update`, `ZONE`, the island radius or a map focus must be made in both `zone.ts` + `rules.ts` and the client's `game/zone.js` + `config.js` (`ZONE`, `MAPS`) + `world/index.js` (`radius`). Airdrop positions are not part of this: they use `Math.random` on the server and travel in `state.drops`.

## 8. Mirrored values

Values that exist on both sides and must be changed together. Status is from comparing the current files.

| Value | Client | Server | Status |
|---|---|---|---|
| Weapon rules (`slot`, `damage`, `interval`, `range`, `headMul`, `pellets`; 9 weapons) | `config.js WEAPONS` | `rules.ts WEAPONS` | agree (client melee entries have no `headMul`; server uses 1) |
| Weapon prices | `WEAPONS[].price` | `catalog.ts WEAPON_PRICES` | agree |
| Damage falloff (start 0.6 of range, down to 60%) | `BULLET.falloffStart`, `combat.js damageFalloff` (not called) | `FALLOFF_START`, `rules.ts damageFalloff` | agree |
| Skin prices (7) | `SKINS[].price` | `SKIN_PRICES` | agree |
| Operative prices, `duration`, `charge` | `OPERATIVES` | `OPERATIVE_PRICES`, `rules.ts OPERATIVES` | agree |
| Rook damage cut | text "45% less" in `OPERATIVES.rook.desc` | `ROOK_DAMAGE_TAKEN` 0.55 | agree |
| Jin heal 90 / 60 / 10 m | literals in `items.js ultVisual`, `OPERATIVES.jin.desc` | `JIN_HEAL` (range checked with +2 m) | agree |
| Store items (`id`, `type`, `max`, `price`, `emote`) | `STORE` | `catalog.ts STORE` | agree |
| Emote ids | `ANIM.emotes`, `STORE` | `EMOTES`, `EMOTE_RE` | agree |
| Starting profile | `START_PROFILE` | `START_PROFILE` | agree |
| Health and armour (`max`, `regenDelay`, `regen`, `regenCap`, `knockedHp`, `bleed`, `reviveTime`, `reviveHp`, `vest`, `helmet`, `armorDurability`) | `HEALTH` | `HEALTH` | agree |
| Frag (`damage`, `radius`, `fuse`), medkit (`heal`, `time`) | `ITEMS` | `ITEMS` | agree |
| Modes (`name`, `duration`, `scoreToWin`) | `MATCH_MODES` | `rules.ts MODES`, `catalog.ts MODES` | agree |
| Phase lengths | `MATCH.voteTime` 15, `introFlyover` 3.2, `countdown` 4, `endSlowmo` 2.4 | `PHASES` (plus `results` 12) | agree; only `introFlyover` is read by client code |
| Streak window | `MATCH.streakWindow` 6 (not read) | `STREAK_WINDOW` | agree |
| Map focus points, order | `MAPS[i].focus` | `MAP_FOCUS[i]` | agree |
| Zone (`start`, `phases`, `damage`) | `ZONE` | `ZONE` | agree |
| Island radius | `world/index.js` (`radius: 125`) | `ISLAND_RADIUS` | agree |
| Zone generator and planner | `game/zone.js` | `zone.ts` | agree |
| Loot (`respawn`, `airdropAt`, `airdropFall`) | `LOOT` | `LOOT` | agree |
| Rewards | `REWARDS` (not read), `coinsPerElim: 12` literal in `main.js` (HUD notice) | `REWARDS` | agree |
| Leaderboards | `LEADERBOARDS` | `reporters.ts BOARDS` | agree |
| Pose flags | `online.js FLAG` | `MatchState.ts FLAG` | agree |
| Replaced close code | `net.js REPLACED_CODE` | `constants.ts REPLACED_CODE` | agree (4100) |
| Room name, size, team size, min players | `NET.room`, `roomSize` (not read), `teamMax`, `minPlayers` | `app.config.ts`, `ROOM_MAX_CLIENTS`, `TEAM_MAX`, `MIN_PLAYERS` | agree |
| Shot end points per message | `ends.slice(0, 12)` in `combat.js` | `SHOT_POINTS_MAX` | agree |
| Look JSON length | `lookToJson` slice 4000 | `AVATAR_MAX_LEN` | agree |
| `devUser` pattern | `net.js devUser` | `MatchRoom.onAuth` | agree |
| Game slug | `GAME_SLUG` | `auth.ts GAME_SLUG` default, deploy `LEGION_GAME_ID` | agree |
| Dev port | `NET.devPort` 2567 | `listen` default | agree |

Related values that differ on purpose (the server is looser, or only one side has them):

| Value | Client | Server |
|---|---|---|
| Revive reach | 2.2 m literal in `controller.js` | `HEALTH.reviveRange` 3.5 m + 3 m slack |
| Revive hold | `HEALTH.reviveTime` 3 s | 2.4 s minimum |
| Respawn wait | `NET.respawnFallback` 5 s, or the portal's death screen | `RESPAWN_MIN_S` 3.5 s |
| Fire interval | interval, x0.77 during Nova's ability | interval x `FIRE_RATE_SLACK` 0.6 |
| Melee reach | range + 0.5 m horizontal | range + 2.5 m |
| Movement speed | at most 8.6 m/s sprint (x1.3 Nova), 20 m/s dash for 0.18 s | `MAX_SPEED` 32 m/s + `MOVE_SLACK` 6 m |
| Ability availability | charge 40..55 (1 per second, 0.045 per damage, crates and airdrops add charge) | `ULT_MIN_GAP_S` 18 s |
| Spawn protection | reads `protectedUntil` | `HEALTH.spawnProtection` 2.5 s |
| Upgrade effects | `medkits`, `walls`, `frags` applied in `match.js kit` | `armor` applied in `MatchRoom.spawn` |
| Ranks | `RANKS` | none (only `rp` is stored) |
| Crate count | `island.lootSpots` length | `LOOT.crates` 200 accepted indexes |

No mirrored value currently disagrees.

## 9. Known gaps between the two sides

- Sent by the server, not handled by the client: `round`, `serverError`, `openFail` (registered in `MESSAGES`, no `onNet` listener). A failed profile load or a refused `open` therefore shows nothing; the client has already taken the crate's ammo and items locally.
- Payload fields nobody reads: `profile.userId`, `boom.id`, a successful `shop`.
- `ult` reaches the sender too, and `online.js` resolves its own `sid` to the local actor (`byNet` finds `G.player` because `createMatch` sets its `netId`), so `ultVisual` runs a second time for the local player after the local call in `useUltimate`. The other relays exclude the sender.
- A refused `ult` (under 18 s since the last) is silent: the client has already spent its charge and drawn the effect. This can happen legitimately after an airdrop refills the charge.
- Accepted by the server, never sent by the client: `vote.mode` (the mode preference travels in `play`), `FLAG.sprint`.
- Armour durability is server-only. The client HUD reads `vestDur` / `helmetDur` on the local actor, which nothing updates, so its durability bars cannot reflect the server.
- `emote` ids from the portal are sent as `portal:<id>`; the server accepts only `[a-z0-9]{1,40}` after the prefix and drops anything else without a reply.
- The client's `shot` handler has a knife/fists branch, but the client never sends `shot` for melee; remote swings are shown through `FLAG.swing`.
- Client leaderboard code (`bloxity.js submitMatchScores`) is never called; scores and stats are reported only by the server (`reporters.ts`). The client still declares the boards (`leaderboard.define`).
- Private rooms: `net.js` marks the private attempt as tried before `create` resolves, so if that one attempt fails the retry joins a public room through matchmaking.
- Several client constants mirror server values without being read (`REWARDS`, `MATCH.voteTime`, `MATCH.countdown`, `MATCH.endSlowmo`, `MATCH.streakWindow`, `NET.roomSize`): changing them has no effect on behaviour, but they should still be kept in step as documentation.
