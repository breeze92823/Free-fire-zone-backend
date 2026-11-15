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
| `inv` | `/^[A-Za-z0-9_-]{1,64}$/` | the page was opened through a friend's invite link (`?inv=`, or `?ref=` of 8+ chars; remembered in `localStorage` `ffz.inv`) | `Session.inviter`: credited as the inviter when this is a brand-new account (section 5.14 of server.md); anything else is ignored |
| `private` | `true` | only on `create` for `?instantMultiplayer=true` | `onCreate`: `setPrivate(true)` |

Not join options: `roomId` and `instantMultiplayer` are page URL parameters that pick the join path; `carriedFrom` (guest ids to carry progress from) comes only from Bloxity's verify response, never from the client; any client-sent `userId` is ignored.

### 2.4 Close codes and reconnection

| Code | Meaning | Client behaviour |
|---|---|---|
| 4000 `CONSENTED` | Client left on purpose (`disconnect()` -> `room.leave(true)`, on `beforeunload`) | none; the server frees the seat at once |
| 4100 `REPLACED_CODE` | The same account joined this room again | `status = 'offline'`, `net.error = 'You are playing in another tab'`, no reconnect |
| 1001, 1005, 1006, 4010 | Dropped connection | The SDK reconnects by itself with the same session: `room.onDrop` -> `status = 'connecting'` (in a round the HUD shows "Connection lost — reconnecting…", `hud.setNet`), `room.onReconnect` -> `'online'`. The server holds the seat for `RECONNECT_SECONDS` (20; the player stays in the round, standing where they were), then re-sends `profile` and allows pose jumps for 3 s. Past the window the server runs `leaveMatch` as for `leave`. Checked live: `room.connection.close(4010)` mid-round reconnects into the same seat |
| any other / SDK gave up | Room lost | `room.onLeave`: `net.room/state/sessionId` cleared, local event `left` (`main.js` returns to the lobby), `status = 'offline'` (`'Disconnected'`), then `connect()` after 1.5 s (a new session and possibly another room) |

`connect()`: one attempt chain at a time. Sets `status = 'connecting'`, retries `joinOnce` with a wait of 1 s growing x1.6 up to 8 s, for at most `NET.connectTimeout` (60 s); then `status = 'offline'` with `'Could not reach the game server'` and resolves `false`. Local events for `onNet`: `status` (the new status), `joined` (the room), `left` (the close code).

## 3. Client -> server messages

Every handler ignores the message when the sender has no player/session. "Fighting" = phase `playing` or `ending`.

| Type | Payload | Sent by (client) | Server action | Reply / broadcast |
|---|---|---|---|---|
| `play` | `{ mode }` (`'clash'` or `'squad'`) | `main.js startMatchFlow` (PLAY), with `profile.mode` | Ignored if already `inMatch` (unless the sender leads a squad). In a squad only the leader may press it (a member gets `squadNote { kind: 'notLeader' }`) and it queues every member of the squad that is not `inMatch` yet. Sets `inMatch`, `voteMode`, `vote = -1`; in a running phase seats the player at once (`joinRound`) if a side has room (`TEAM_MAX` = 3 each), otherwise they stay queued with an empty `team` | State; `spawn { id, first: true }` to all when seated mid-round |
| `getProfile` | none | `save.js` on the local `joined` event and after a refused `shop` | Re-sends the profile if loaded | `profile` to the sender |
| `leave` | none | `main.js leaveMatch`: the HUD exit button and the spectate panel's Lobby (both after the "Leave the match?" dialog, `askLeave`), the results' Lobby, the queue's "Leave the team" when not in a squad | `leaveMatch` (server.md 5.4): in `playing` a knocked player, or one an enemy hit in the last `ASSIST_WINDOW` s, is first eliminated and credited to that enemy; then the leave penalty (`rewards` with `left: true`); in `ending` the normal rewards; in `vote` / `intro` / `countdown` nothing. Back to the menus, pending throws dropped, knocked teammates wiped if nobody on the team is standing, team check (a side left empty forfeits). A squad that is only queued (`inMatch`, no `team` yet) leaves the queue together; in a seated round only the sender leaves | `rewards` + `profile` to the sender when the round was in play; possibly `elim` and `matchEnd` to all |
| `vote` | `{ map }` int `0..MAP_COUNT-1` (server also accepts `mode`) | `main.js` `onVote` (map card click in `lobby.js`) | Only in phase `vote` with `inMatch`: sets `vote` (and `voteMode`) | State |
| `invite` | `{ to }` sessionId | `party.js` (the + in the lobby's "Players online" dock / list) | `onInvite`: 500 ms gap per sender, sender not `inMatch`, target exists, not `inMatch` (`busy`), not in a squad (`inTeam` / `sameTeam`), sender's squad below `SQUAD_MAX` (`full`), no duplicate (`dup`), at most `INVITE_MAX_PENDING` open. Creates an invite that expires after `INVITE_TTL_S` (20 s) | `invite` to the target and `squadNote { kind: 'sent' }` to the sender, or a refusing `squadNote` to the sender |
| `inviteReply` | `{ id, accept }` | `party.js` (Accept / Decline on the invite card) | Only the invited player. Decline: `squadNote { kind: 'declined' }` to the inviter. Accept: re-checks both sides (not `inMatch`, target not in a squad, room in the inviter's squad); creates the squad (id `s<n>`, the inviter is `squadLead`) when the inviter had none; sets the target's `squad` | `squadNote` `joined` to the existing members, `welcome` to the new one; `gone` / `youInTeam` / `teamFull` on a stale accept |
| `leaveSquad` | none | `main.js onLeaveTeam` ("Leave the team" in a squad) | Leaves the queue first when the squad was only queued, then `removeFromSquad`: the lead passes to the next member, a squad of one dissolves | `squadNote` `left` / `leader` / `disbanded` to the rest |
| `kick` | `{ t }` sessionId | `party.js` (the x on a teammate) | Only the squad leader, only while neither is `inMatch` | `squadNote` `youKicked` to the target, `kicked` to the rest |
| `pose` | `{ x, y, z, yaw, pitch, speed, flags, slot }` | `online.js sendPose`, up to `NET.poseHz` (20) per second while in a match | Bounds and speed checks, then writes the pose (section 6) | State |
| `enter` | `{ v, s }` vehicle id, seat index | `vehicles.js requestEnter` (E or the HUD prompt beside a vehicle, online) | Phase `playing`; alive, in the round, not already seated; the vehicle exists, the seat is free and within its seat count; the player's server position within `VEHICLE_ENTER_RANGE` (6 m, horizontal) of the vehicle's. Seat 0 also makes the player the vehicle's `owner` | State (`veh`, `seat`, the vehicle's `seats`, `owner`); nothing on a refusal |
| `exit` | none | `vehicles.js requestExit` (after the local exit found a spot) | Clears the seat (the last driver stays `owner` until the vehicle is at rest) | State |
| `vpose` | `{ v, x, y, z, qx, qy, qz, qw, vx, vy, vz, st, r }` | `vehicleNet.js sendVehicles` (`vehicles.js sendVehiclePose`), up to `NET.poseHz` while the owner drives or the vehicle moves, then once with `r: 1` at rest; also once at `exit` | Phase `playing` / `ending`; only from the vehicle's `owner`; finite, `abs(x)`, `abs(z)` <= `WORLD_BOUND`, `-60 <= y <= 300`, quaternion length 0.5..1.5 (normalised); horizontal move <= `VEHICLE_MAX_SPEED (45) * dt + VEHICLE_SLACK (8)` unless the new position is within 4 m of the vehicle's spawn (it fell off the world). Velocity clamped to +-80, `st` to +-1, `n` bumped. `r: 1` with nobody in seat 0: `owner = ""` | State |
| `avatar` | `{ avatar, outfitKey }` (JSON string max 4000; key pattern or `""`) | `main.js sendAvatar` (auth change, avatar change, proportions change) | Sets `avatar` / `outfitKey` when valid | State |
| `emote` | `{ emote }`: `wave`, `dance`, `salute`, `flex`, `cheer`, `portal:<id>` or `""` | `controller.js playEmote` (Z key, portal emote button); `updateController` sends `""` when moving or firing cancels it | Alive only. `""` clears. Must match `EMOTE_RE`; non-portal emotes must be owned. Cleared by the server after 6 s, when `speed > 1.2`, on damage | State (`emote`) |
| `auth` | `{ token, name, pfp }` | `main.js` (`bloxity.subscribeAuth`) when the Bloxity user changes after the first connect | Re-verifies; on a different id saves the old profile, switches identity, loads the new profile | `profile` (or `serverError`) to the sender; possibly closes other sessions with 4100 |
| `buy` | `{ kind, id }`, `kind`: `weapon`, `grenade`, `pass` (Gems), `skin`, `operative`, `store` (coins) | `save.js purchase` (`buyWeapon`, `buyGrenade`, `buyPass`, `buySkin`, `buyOperative`, `buyStoreItem`), applied optimistically | `catalog.buy`; saves | `shop` to the sender always; `profile` on success |
| `equip` | `{ kind, id, weapon? }`, `kind`: `weapon` (its `slot` picks primary / secondary / melee), `skin` (with `weapon`), `operative`, `emote`, `grenade`, `mode` | `save.js equip` (`equipWeapon`, `equipSkin`, `equipOperative`, `equipEmote`, `equipGrenade`, `setMode`), optimistic | `catalog.equip`; visible loadout updated now (menus) or at the next spawn (in a round); saves. Ignored while the profile is loading | `profile` on success; `shop { ok: false }` on refusal |
| `shot` | `{ w, o: [x,y,z], e: [[x,y,z], ...], v? }` (max 12 end points, 2 decimals; `v`: a launched round's velocity m/s, crossbow / launchers only) | `combat.js fire` / `fireProjectile`, every gun shot (not melee) | Alive, fighting, weapon carried, valid `o`; `v` kept only for a `blast` weapon or the crossbow and under 150 m/s | `shot` to all but the sender |
| `hit` | `{ t, w, s, n, h, d }`: target sid, weapon id, shot number, pellets that hit, of them headshots, distance (m, 1 decimal) | `combat.js shootBullets` (one per target hit by the shot; the mounted gun's shots too, `w: 'mg'`) and `resolveMelee` (`n: 1, h: 0`) | `onHit`: team, life, loadout (`carries`: the loadout, or a `MOUNTS` gun when the player sits in its vehicle's gunner seat), fire rate (`shotOk`), range; computes and applies damage (armour-piercing weapons ignore part of the armour cut); a medic weapon (`heal`) on a teammate heals instead (HP, or the bleed-out pool when knocked) | `dmg`, then possibly `knock`, `elim`, `matchEnd`, to all; a heal: `healed` to all |
| `vhit` | `{ v, w, s, n, d }`: vehicle id, weapon (or mount) id, shot number (the same as the shot's `hit`s), bullets that hit its hull, distance | `combat.js shootBullets` (one per vehicle hit by the shot), `projectiles.js` (a crossbow bolt) | `onVehicleHit`: fighting, alive, carries `w` (no melee), `canHurt` (not a wreck, not one the shooter sits in, nobody of its team inside), fire rate (`shotOk`), within range + `RANGE_SLACK` + `VEHICLE_DAMAGE.size` (horizontal for a never-moved vehicle); `damage * falloff * n * VEHICLE_DAMAGE.bullet` (0.6) off its `hp` | State `hp`; at 0 a wreck (`vboom`, below) |
| `ram` | `{ v, t, sp }`: the vehicle, the player it ran over, its speed (m/s) | `vehicles.js checkRams` (the driver's client: an enemy on foot inside its hull at 8 m/s or more, once per 0.9 s per player) | `onRam`: fighting, alive, the sender drives `v` (seat 0), not a wreck; the target an enemy on foot (not seated), not dead; speed = min(`sp`, the vehicle's synced velocity + 3, `VEHICLE_MAX_SPEED`) >= `ram.minSpeed` (8); the target within `ram.reach (4.5) + speed * 0.3 + 2` m of the vehicle; once per `ram.gapMs` (900) per target; damage `min(200, 30 + 7 * (speed - 8))`, weapon = the vehicle type | `ram` + `dmg` etc. to all |
| `throw` | `{ p: [x,y,z], v: [x,y,z] }` (start, velocity m/s) | `items.js release` (the grenade leaves the hand) | Alive, fighting, 400 ms rate limit; counts a pending throw (max 3); the kind is the profile's `loadout.grenade` | `throw` (with `k`) to all but the sender |
| `boom` | `{ x, y, z, t: [sid, ...], vt?: [vehicle id, ...] }` (blast point, targets in the blast with line of sight; `[]` for fire, smoke and stun grenades; `vt`: vehicles within the radius + 2.2 m with line of sight to their centre) | `combat.js explode` (a blast or sticky grenade went off), `items.js detonate` (fire / smoke / flash) | `onBoom`: needs a pending throw not older than its fuse + 3 s, within 60 m of the thrower; by `GRENADES[kind].effect`: a blast hurts the listed targets by server distance, and the listed vehicles (`blastVehicles`: `canHurt`, distance to the vehicle's centre minus `VEHICLE_DAMAGE.size`, `damage * k * blast (1.4)`, or `sticky (2.0)` for a sticky charge within `stickyReach` 2.6 m of its centre); `fire` starts a burning patch (server ticks, server.md 5.9); `smoke` / `flash` do no damage | `boom` (with `k`) to all but the sender; `dmg` etc. to all |
| `blast` | `{ w, s, x, y, z, t: [sid, ...], vt?: [vehicle id, ...] }` (launcher, shot number, where the round went off, players caught with line of sight, vehicles as for `boom`) | `combat.js weaponBlast` (a Thumper / Rhino round landed) | `onBlast`: alive, fighting, carries `w` (a weapon with `blast`), the point within its range + `RANGE_SLACK` of the shooter, at most one per `interval * FIRE_RATE_SLACK`; damage `WEAPONS[w].damage * (1 - min(dist, R) / R) ^ 0.7` (halved for the shooter), explosive; listed vehicles as for `boom` (x1.4) | `blast` to all but the sender; `dmg` etc. to all |
| `wall` | `{ x, y, z, yaw }` | `items.js deployWall` | Alive, fighting, 300 ms rate limit, within 8 m of the sender | `wall` to all but the sender |
| `heal` | none | `items.js updateActorItems` when the medkit timer (2.2 s) completes | Alive, fighting, 1.76 s rate limit; +80 HP up to 200 | State (`hp`) |
| `ult` | none | `items.js useUltimate` (Q) | Alive, fighting, 18 s gap; Jin heals, others set `ultUntil` | `ult` to the others (not the sender) |
| `claim` | `{ m: "daily" \| "weekly", i }` | `save.js claimMission` (lobby Missions window) | `progress.ts claimMission`: the slot exists, is finished and not claimed; pays its coins and Gems; saves | `claimed` to the sender, then `profile` |
| `tutorialDone` | none | `save.js finishTutorial` (last tip or Skip) | Sets `profile.tutorial`; saves. Ignored before the profile loads | none |
| `newsSeen` | `{ id }` (an integer: the client's `NEWS.id`) | `save.js markNewsSeen` (the lobby's new-arrivals window closed in any way; or a newer copy found in this browser's storage) | Sets `profile.newsSeen` when `id` is larger than the stored one and at most `NEWS_MAX`; saves. Ignored before the profile loads | none |
| `offerSeen` | none | `save.js markOfferSeen` (the friend invite offer window was closed in any way) | Sets `profile.offer.seen`; saves. Ignored before the profile loads | none |
| `offerPoll` | none | `lobby.js` every 20 s while the lobby is up (`save.js pollOffer`) | `syncOffer`: counts the friends brought in, grants the weapon once enough joined; answered with `inviteOffer`. At most one answer per `OFFER_POLL_MS` (4 s) | `inviteOffer` |
| `reviving` | `{ t }` knocked teammate sid | `controller.js updateController` when a revive hold starts | Records the hold start (no checks) | none |
| `revive` | `{ t }` | `controller.js updateController` when the hold reaches `HEALTH.reviveTime` (3 s) | Hold at least 2.4 s old, same team, target knocked, within 6.5 m | `revive` to all |
| `fell` | none | `main.js` `body.onFellOut` (below `PHYSICS.killY`, at most once a second) | In `playing`, not dead: eliminated as a zone death | `elim` to all |
| `respawn` | none | `main.js requestRespawn` (the spectate panel's Revive button or G: after the portal death screen's countdown, or `NET.respawnFallback` 5 s without the portal; without the portal also automatically after `NET.autoRespawn` 20 s) | Dead, has a team, `playing`, at least 3.5 s of round clock since death | `spawn { id, first: false }` to all |
| `spectate` | `{ t }` sid of the player watched, `""` = nobody | `main.js spectateActor` (elimination: the killer first; the arrows / Left-Right keys; the watched player went down; respawn sends `""`) | Sets `watch = t` when the sender is dead, has a team, it is `fighting()` and `t` is another player with a team; else `watch = ""` | none (state `watch`) |
| `heart` | `{ t }` | `main.js giveHeart` (the spectate panel's hearts card, H) at most every `SPECTATE.heartGap` 0.4 s | Sender dead and watching `t`, `HEART_GAP_MS` 400 ms, at most `HEARTS_PER_TARGET` 20 per target per round; `t.hearts++` | `heart { f, t }` to all |
| `react` | `{ t, e }`, `e` in `REACTIONS` (`laugh`, `fire`, `clap`, `wow`, `gg`) | `main.js sendReaction` (the spectate panel's reaction picker) | Sender dead and watching `t`, known `e`, `REACT_GAP_MS` 1.2 s | `react { f, t, e }` to all |
| `profileOf` | `{ t }` | `main.js` `onProfile` (spectate "View profile") | Any two players in the room, `PROFILE_GAP_MS` 400 ms | `playerProfile` to the sender |
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
| `inviteOffer` | `{ me, joined, need, weapon, start, end, now, seen, claimed, granted }` (`me`: this account's id for the invite link, `""` for guests; `joined` capped at `need`; `start` / `end` / `now` in ms, `now` = the server clock so the client can correct its countdown; `granted`: the weapon was added by this very answer) | After the profile loads (join, sign-in) and for each `offerPoll` | to the sender | `save.js` fills `offer`; `lobby.js` paints the chip, toasts a new friend and opens the reward window on `granted` |
| `shop` | `{ ok, kind, id, error }`, `error`: `null`, `loading`, `unknown`, `owned`, `coins`, `locked`, `slot` | Every `buy`; a refused `equip` | one | `save.js`: on `ok: false` sends `getProfile` to resync |
| `rewards` | `{ won, mvp, left, forfeit, noContest, coins, gems, gemsRound, rp, eliminations, knocks, assists, damage, deaths, headshots, score: { blue, orange }, missions, rankUp }` (`missions`: ids this round finished; `rankUp`: `[{ rank, name, coins, gems }]` paid now; both already in the profile that follows) (`gemsRound`: the round's Gems, granted now; `gems`: everything the round earned, kills included) (`left`: this is the leave penalty; `forfeit`: the round ended because a side left; `noContest`: it did so before `REWARDS.forfeitMinShare` of the round, so `won` is false for everyone, no MVP, no rank change from the result) | End of the round (`finishRound`), on leaving a round in `playing` (`left: true`) or `ending` | one | `main.js`: `left` -> lobby toast "You left the match: +N coins, +N Gems kept, -12 rank points" (`leaveSummary`); otherwise stored, `showRoundResults` -> `results.js showResults` (banner `NO CONTEST` / `VICTORY` / `DEFEAT`, a note for forfeits) |
| `reward` | `{ k, t, gems, coins, rp, h, s, b, total }`: `elim` / `knock`, target sid, Gems granted now, coins and rank points this kill adds to the round's `rewards`, headshot, streak, streak bonus Gems, the new Gems balance | The player knocks or eliminates an enemy during `playing` | one (the shooter) | `save.js`: `profile.gems = total`; `online.js`: bus `reward { kind, target, gems, coins, rp, head, streak, bonus }` -> HUD kill popup and multi-kill banner |
| `serverError` | `{ reason: 'load' }` | The profile could not be read from the database | one | no listener |
| `round` | `{ round }` | `startRound` | all | no listener (the client follows `state.phase`) |
| `spawn` | `{ id, first }` | Round start, mid-round join, respawn | all | `online.js`: own id -> `match.spawnActor(G.player, first)` (picks the position; bus `spawn`), skipped for a first spawn when already alive; others -> pose buffer cleared, `life = 'alive'` |
| `dmg` | `{ t, a, n, h, z, e, b? }`: target sid, attacker sid or `""`, amount (1 decimal, after armour), head, zone, explosive, `b`: the frying pan on the target's back stopped part of it | Every applied damage | all | bus `damage { target, attacker, amount, head, point, dir, zone, explosive }`; hit flash; charges the local ability when the local player is the attacker; `b`: pan sparks + clang; a remote attacker holding a melee weapon: its hit sound |
| `knock` | `{ t, a, w, h }` | A player is knocked | all | sets `life = 'knocked'`; bus `knock { target, attacker, weapon, head }` |
| `elim` | `{ t, k, w, h, s }`: victim, killer sid or `""`, weapon id / mount id (`mg`) / `zone` / `frag` / a vehicle type (run over) / `vboom` (caught in a destroyed vehicle) / `""`, head, killer's streak | A player is eliminated | all | sets `life = 'dead'`; for the local player `respawnAt = G.time + NET.respawnFallback`; bus `elimination { target, killer, weapon, head, streak }` |
| `revive` | `{ t, b }` revived sid, reviver sid | A revive succeeds | all | sets `life = 'alive'`; effects; bus `revive { target, by }` |
| `shot` | `{ id, w, o, e, v? }` | Relay of `shot` | all but the sender | `online.js`: muzzle flash (by style), tracers (none for silenced weapons), sound, near-miss whiz, switches the remote actor's held weapon, flies a visual copy of a launched round (`v`); bus `shot { actor, pos, recoil, silent }` |
| `throw` | `{ id, p, v, k }` (`k`: the grenade kind) | Relay of `throw` | all but the sender | `items.js remoteThrow`: a visual grenade of that kind that vanishes at its fuse |
| `healed` | `{ t, a, n }`: healed sid, healer sid, HP | A medic weapon healed a teammate | all | bus `heal { target, by, amount }` (green numbers for the healer) |
| `boom` | `{ id, x, y, z, k }` (`k`: the grenade kind) | A grenade went off | all but the sender | `items.js remoteBoom` (fire pool / smoke cloud / stun flash, and drops the thrower's flying copy) or `combat.js explodeVisual` (bus `explosion`) |
| `blast` | `{ id, w, x, y, z }` | A launcher round went off | all but the sender | `projectiles.js endRemote` (drops the flying copy) + `combat.js explodeVisual` |
| `vboom` | `{ v, x, y, z, a }`: vehicle, where (`y` -100 for a never-moved one), the player credited (`""`: it burnt down with nobody to credit) | A vehicle was destroyed (`wreckVehicle`) | all | `vehicleNet.js`: a rocket-size `explodeVisual` on the drawn vehicle, `setWreck`, bus `vehicleDestroyed` (the kill feed's "<who> Destroyed <vehicle>") |
| `ram` | `{ t, v, x, z }`: the player run over, the vehicle, its velocity (x, z) | An accepted `ram` | all | `vehicleNet.js`: the victim's client (not while seated) gets an impulse along the vehicle's way and a camera shake |
| `wall` | `{ id, x, y, z, yaw }` | Relay of `wall` | all but the sender | `items.js remoteWall`: a real collider locally (bus `wall`) |
| `ult` | `{ id, op }` | An ability was accepted | all but the sender | `items.js ultVisual(actor, op)` (the client also skips its own id) |
| `claimed` | `{ m, i, id, coins, gems }` or `{ m, i, error }` (`error`: `loading`, `unknown`, `claimed`, `unfinished`) | Every `claim` | one | `save.js onClaimed` -> `lobby.js` (sound + toast) |
| `opened` | `{ c, by }` or `{ d, by }` | A crate or airdrop was opened | all | `loot.js markOpened(c, d)` unless `by` is the local player |
| `openFail` | `{ c }` or `{ d }` | `open` refused (already open, unknown drop, drop still falling) | sender | no listener |
| `matchEnd` | `{ winner, forfeit, noContest }` (`blue` / `orange`; `forfeit`: a side left; `noContest`: early, nobody wins) | The round is decided (`end`) | all | bus `matchEnd { winner, forfeit, noContest }` (slow motion, closes the leave dialog, announcement: "NO CONTEST", "VICTORY!" + "The other team left the match", or the usual) |
| `invite` | `{ id, from, name, pfp, size, ttl }` (`size` = members of the inviter's squad, 1 = solo; `ttl` s) | Another player invited this one | one | `party.js`: an Accept / Decline card with a countdown bar (up to 3 shown) |
| `inviteEnd` | `{ id }` | The invite expired, or the inviter queued / left | one | `party.js`: removes the card |
| `heart` | `{ f, t }`: the spectator's and the watched player's sids | A spectator's `heart` was accepted | all | bus `heart { from, target }`: hearts float up on the spectate panel of whoever watches `t`; `t` gets a toast (at most one per 2 s) |
| `react` | `{ f, t, e }` | A spectator's `react` was accepted | all | bus `react { from, target, reaction }`: the reaction glyph (`REACTIONS` in `config.js`) and the sender's name float over `t`'s head; `t` gets a toast |
| `playerProfile` | `{ t, name, level, rp, signedIn, operative, primary, secondary, stats: { matches, wins, eliminations, deaths, best }, round: { kills, deaths, assists, knocks, damage, hearts } }` | Answer to `profileOf` | one | bus `playerProfile` (+ `actor`): fills the spectate panel's profile window |
| `squadNote` | `{ kind, name? }`; `kind`: `sent`, `busy`, `youBusy`, `inTeam`, `sameTeam`, `full`, `dup`, `declined`, `expired`, `joined`, `welcome`, `left`, `kicked`, `youKicked`, `disbanded`, `leader`, `notLeader`, `gone`, `youInTeam`, `teamFull` | Every squad event that needs a message | one | `party.js`: a toast (`NOTES` maps a kind to its text, e.g. `busy` = "<name> is currently in a game and cannot view invitations at this time.") and clears that player's "Sent" mark |

## 5. Schema state the client reads

Field definitions are in `server.md` section 4. `net.state` is read directly each frame; nothing subscribes to change callbacks.

| State | Consumed in |
|---|---|
| `phase`, `phaseLeft` | `main.js syncFlow` (phase transitions, countdown), `queueInfo` (vote timer), `enterRound` (late-join intro/countdown progress) |
| `clock` | `online.js syncClock` -> `G.time` (hard snap when off by more than 0.4 s, else eased); `match.js createMatch` |
| `duration`, `mode`, `scoreToWin`, `round` | `match.js createMatch`; `duration` also in `online.js applyState` |
| `map` | `main.js enterRound` -> `MAPS[map]` (its world: built and activated first, mood, zone focus, flyover) |
| `zoneSeed` | `match.js createMatch` -> `zone.reset(seed, map.focus, map.world)` |
| `blue`, `orange` | `online.js applyState` -> `G.match.score` |
| `winner` | `main.js showRoundResults` |
| `crates` | `online.js syncLoot` -> `loot.js syncCrates`, once on entering a round (later changes arrive as `opened`; refills run on the local clock) |
| `drops` | `online.js applyState` -> `loot.js syncDrops` every frame (spawns unseen drops, marks opened ones) |
| `vehicles` (map id -> `VehicleState`: `type`, `x y z`, `qx qy qz qw`, `vx vy vz`, `steer`, `owner`, `seats[]`, `n`, `hp`, `wreck`, `life`) | `vehicleNet.js syncVehicles` every frame of a round: creates / removes the local vehicles; authority from `owner` (this player or `""`: simulated locally, a dynamic body; another player: a kinematic body drawn `NET.interpDelay` behind its samples, a new sample per change of `n`); `y = -100` = never moved this round (each client parks it on the ground at `x, z` with the yaw of `qy, qw`); a parked vehicle's new pose (someone's last, `n` changed) snaps it there; `seats` -> who sits where (`actor.seat`); `hp` -> its health (the seated HUD's bar, smoke and fire); `wreck` -> the charred look, nobody can get in; `life` changed -> a new one parked at its spawn (the client rebuilds it) |
| players' `veh`, `seat` | `vehicleNet.js syncVehicles`: this player enters its local seat once the server has seated it, leaves it when the server says it is out (knocked, eliminated, respawned); other players sit on their vehicle's drawn seat (`placeSeated`) |
| `players` (roster) | `online.js reconcile` (remote actors for players with `inMatch` and a team), `roster()` (lobby list, `main.js showMates`), `trackRoster` (friend-join notices), `main.js queueInfo` (ready count, votes) |
| player `name`, `pfp`, `uid` | remote actor name/portrait/chat bubbles (`makeRemote`, `applyRemote`), lobby roster, vote cards |
| player `avatar`, `outfitKey` | `online.js loadRemoteAvatar` (remote actors), `main.js showMates` (lobby platform, prewarm) |
| player `inMatch`, `team`, `vote` | `syncFlow`, `queueInfo`, `reconcile`; the local team in `applyState`; the status text in `party.js` (`Playing` = `inMatch` + `team`, `In queue` = `inMatch`, else `In the lobby`) |
| player `squad`, `squadLead` | `online.js roster()` -> `party.js` (dock, banner, name plates, PLAY / Leave the team states) and `main.js showMates` (only the squad's members stand on the lobby platform); `syncFlow` (a member whose leader pressed PLAY goes to `queue`) |
| player `life`, `hp`, `downHp`, `vest`, `helmet`, `protectedUntil` | `applyState` (local player mirror) and `applyRemote` |
| player `x`, `y`, `z`, `yaw`, `pitch`, `flags`, `slot` | `applyRemote` (remote players only) |
| player `primary`, `secondary`, `melee`, `skinPrimary`, `skinSecondary`, `operative` | `match.js createMatch` (local loadout for the round), `makeRemote` / `applyRemote` (`melee`: slot 2, the pan on the back), lobby roster |
| player `emote`, `ultUntil` | `applyRemote` (remote players; `shade` -> cloak, others -> ability aura) |
| player `kills`, `deaths`, `assists`, `knocks`, `headshots`, `damage` | `online.js copyStats` (scoreboard, MVP, results) |
| player `level`, `rp`, `hearts` | `online.js copyPublic` -> actor `level`, `rp`, `hearts` (the spectate card: level, rank badge, hearts count; the profile window) |
| player `watch` | `online.js applyState`: counts spectators per player -> actor `watchers` (the spectate panel's eye counter) |

Synced but not read by the client: `signedIn`, `party` (the Bloxity party key; `squad` is the in-game lobby team), `voteMode`, `deadAt`, `killer`, `speed`.

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

Seated in a vehicle (`veh` set): the limit is `VEHICLE_MAX_SPEED (45) * dt + VEHICLE_SLACK (8)` instead. Speed check: with a previous accepted pose, outside the grace window and when not dead, the horizontal move must be `<= MAX_SPEED (32) * dt + MOVE_SLACK (6)` where `dt = max(0.05, seconds since the last accepted pose)`. A rejected pose is ignored without a reply; the next acceptable one is measured from the last accepted position. Grace windows (jumps allowed): `TIMING.joinGraceMs` 5 s after joining, `TIMING.spawnGraceMs` 4 s after any spawn, 3 s after a reconnect.

Receiving (`online.js applyRemote`): a snapshot `{ t, x, y, z, yaw, pitch }` is stored when the state's position or yaw differs from the last one (max 12 kept; a horizontal jump over 15 m, or a `spawn` message, clears the buffer). The actor is drawn at `now - NET.interpDelay` (0.1 s) by linear interpolation between the two surrounding snapshots (shortest-arc for yaw). Velocity is derived from the drawn positions (zeroed above 30 m/s). `grounded` is the flag or `flags === 0`; reload/heal/throw timers run locally while their flag is set; `swing` starts a swing.

## 7. The deterministic zone

The server never streams the circle. Both sides compute it from `state.zoneSeed`, the voted map's focus and the round clock.

- Generator: `mulberry32(seed)` (identical code in `zone.ts` and the client's `game/zone.js`): 32-bit state, returns a float in `[0, 1)`.
- Inputs: `seed = state.zoneSeed` (uint32, new each round); `focus = MAPS[state.map].focus` on both sides; the plan (`start`, `phases`, `damage`) and the land radius of the map's world, `WORLDS[MAPS[state.map].world]` on both sides (Coral Key: `ZONE`, 125; Dustline Ridge: start 330, radius 250).
- Start: centre `(0, 0)`, radius `plan.start`, `phase = -1`. Server: `new Zone(seed, focus, world)`. Client: `zone.reset(seed, focus, world)` in `match.js createMatch`. Both immediately call `planNext(0)`.
- `planNext(i)` is the only consumer of random numbers, exactly two per call, in this order:
  1. `a = rand() * 2 * PI` (angle);
  2. `j = sqrt(rand()) * phases[i].radius * 0.45` (jitter distance around the focus).
  Then: target = focus + `(cos a, sin a) * j`; move from the current centre toward it by at most `0.85 * max(0, currentRadius - phases[i].radius)`; clamp the result to within `max(0, landRadius - phases[i].radius * 0.6)` of the origin; the next radius is `phases[i].radius`.
- `update(t)`: when not shrinking and `t >= phases[next].at`, the phase starts (from = current, `damage = ZONE.damage[min(phase, last)]`). While shrinking, centre and radius are linear in `k = min(1, (t - at) / shrink)`; at `k >= 1` the shrink ends and `planNext(phase + 1)` runs if there is another phase.
- Total draws per round: 2 per phase (6 with the current 3 phases), always in phase order. A late joiner converges in at most one `update` per elapsed phase, because each finished phase ends exactly on its planned circle.
- Server use: `zone.outside(x, z)` for zone damage (the plan's `damage` per second outside). Client use: drawing, HUD timer, spawn-point choice; the client applies no zone damage itself.

Lockstep rule: any change to `mulberry32`, the order or number of `rand()` calls, the arithmetic in `planNext` / `update`, a world's plan or radius, or a map's world or focus must be made in both `zone.ts` + `rules.ts` (`WORLDS`, `MAPS`) and the client's `game/zone.js` + `config.js` (`WORLDS`, `ZONE`, `MAPS`). Airdrop positions are not part of this: they use `Math.random` on the server and travel in `state.drops`.

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
| Vehicle seats per type | `VEHICLES[type].seats.length` (jeep 4, buggy 2) | `VEHICLE_TYPES[type].seats` | agree |
| Vehicle health, gunner seat | `VEHICLES[type].hp` (1200 / 750), `seats[3].gun` = `'mg'` on the Jeep | `VEHICLE_TYPES[type].hp`, `gunSeat` 3, `mount` `'mg'` | agree |
| Mounted gun (`damage` 26, `interval` 0.085, `range` 170, `headMul` 1.6) | `MOUNTS.mg` (plus heat, spread, recoil: client only) | `MOUNTS.mg` | agree |
| Vehicle damage (`burnBelow` 0.2, `wreckRadius` 7, `ram.minSpeed` 8, `ram.gapMs` 900, `size` 2.2) | `VEHICLE_DAMAGE` (the client's share) | `VEHICLE_DAMAGE` (also `bullet`, `blast`, `sticky`, `stickyReach`, `fire`, `burnRate`, `wreckDamage`, `seatedDamage`, `respawn`, `ram.base` / `perMs` / `max` / `reach`) | agree |
| Where wrecks' replacements park | from the state (`x`, `z`, yaw; `life` changed) | `VEHICLE_PARKING` (+ each vehicle's camp spot) | n/a |
| Missions incl. vehicles (`d_wreck`, `w_wrecks`, `w_rams`; stats `wrecks`, `rams`) | `MISSIONS` (+ `MISSIONS.text`) | `progress.ts MISSIONS` | agree |
| Vehicle spawns (Dustline Ridge) | parked from the state (no client copy); the Test Drive uses its own `DRIVE.test` | `VEHICLE_SPAWNS.ridge` (`wj`, `wb` West Camp bay; `ej`, `eb` East Camp bay) | n/a |
| Vehicle speed | top speeds 24 / 29 m/s (`VEHICLES`) | `VEHICLE_MAX_SPEED` 45 (+ `VEHICLE_SLACK` 8) for vehicle poses and seated players' poses | server looser on purpose |
| Maps: world and focus, order | `MAPS[i].world`, `MAPS[i].focus` | `MAPS[i]` | agree |
| Zone per world (`start`, `phases`, `damage`) | `WORLDS[id].zone` (`ZONE` for Coral Key) | `WORLDS[id].zone` (`ZONE`) | agree |
| Land radius per world | `WORLDS[id].radius` (Coral Key 125 = `world/index.js radius`; Dustline Ridge 250 = `world/ridge/layout.js RADIUS`) | `WORLDS[id].radius` (`ISLAND_RADIUS`) | agree |
| Zone generator and planner | `game/zone.js` | `zone.ts` | agree |
| Loot (`respawn`, `airdropAt`, `airdropFall`) | `LOOT` | `LOOT` | agree |
| Rewards | `REWARDS` (not read; the HUD shows the amounts in `reward`) | `REWARDS` | agree |
| Gems | `GEMS` (not read) | `rules.ts GEMS` | agree |
| Weapon rules and Gem prices | `WEAPONS` (incl. `melee`, `pierce`, `heal`, `price`) | `rules.ts WEAPONS`, `catalog.ts WEAPON_PRICES` | agree |
| Grenades | `GRENADES` | `rules.ts GRENADES`, `catalog.ts GRENADE_PRICES` | agree |
| Weapon pass | `PASSES` + the `tier: 'basic'` weapons | `catalog.ts PASSES` | agree |
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
| Respawn wait | `NET.respawnFallback` 5 s (Revive enabled; automatic at `NET.autoRespawn` 20 s), or the portal's death screen | `RESPAWN_MIN_S` 3.5 s |
| Spectator rate limits | `SPECTATE.heartGap` 0.4 s, `SPECTATE.reactGap` 1.2 s | `HEART_GAP_MS` 400, `REACT_GAP_MS` 1200, `HEARTS_PER_TARGET` 20 |
| Reactions | `REACTIONS` ids + glyphs | `REACTIONS` ids |
| Level | reads `level` | `LEVEL`, `levelOf` (career stats) |
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
- A refused `ult` (under 18 s since the last) is silent: the client has already spent its charge and drawn the effect. This can happen legitimately after an airdrop refills the charge.
- Accepted by the server, never sent by the client: `vote.mode` (the mode preference travels in `play`), `FLAG.sprint`.
- Armour durability is server-only. The client HUD reads `vestDur` / `helmetDur` on the local actor, which nothing updates, so its durability bars cannot reflect the server.
- `emote` ids from the portal are sent as `portal:<id>`; the server accepts only `[a-z0-9]{1,40}` after the prefix and drops anything else without a reply.
- The client's `shot` handler has a knife/fists branch, but the client never sends `shot` for melee; remote swings are shown through `FLAG.swing`.
- The client declares the leaderboards (`leaderboard.define`) and submits nothing; scores and stats are reported only by the server (`reporters.ts`).
- Private rooms: `net.js` marks the private attempt as tried before `create` resolves, so if that one attempt fails the retry joins a public room through matchmaking.
- Several client constants mirror server values without being read (`REWARDS`, `MATCH.voteTime`, `MATCH.countdown`, `MATCH.endSlowmo`, `MATCH.streakWindow`, `NET.roomSize`): changing them has no effect on behaviour, but they should still be kept in step as documentation.
