import { Room, Client, CloseCode } from "colyseus";

import { DropState, MatchState, PlayerState } from "./schema/MatchState.js";
import {
  AVATAR_MAX_LEN, FIRE_RATE_SLACK, GUEST_ID_PREFIX, HEART_GAP_MS, HEARTS_PER_TARGET, INVITE_GAP_MS, INVITE_MAX_PENDING, INVITE_TTL_S, MIN_PLAYERS, MOVE_SLACK, MAX_SPEED, NAME_MAX, PARTY_MAX_LEN, PATCH_MS,
  PFP_MAX_LEN, PROFILE_GAP_MS, RANGE_SLACK, REACT_GAP_MS, RECONNECT_SECONDS, RESPAWN_MIN_S, REPLACED_CODE, ROOM_MAX_CLIENTS, SHOT_POINTS_MAX, SQUAD_MAX, TEAM_MAX, TICK_MS, TIMING, WORLD_BOUND,
} from "../constants.js";
import {
  ASSIST_WINDOW, GEMS, GRENADES, HEALTH, ITEMS, JIN_HEAL, LOOT, MAP_COUNT, MAP_FOCUS, MODES, OPERATIVES, PHASES, REACTIONS, REWARDS, ROOK_DAMAGE_TAKEN, STREAK_WINDOW,
  ULT_MIN_GAP_S, WEAPONS, GEMS_MAX, damageFalloff, levelOf,
} from "../rules.js";
import { Zone } from "../zone.js";
import { buy, equip, normalizeProfile, skinFor, type Profile } from "../catalog.js";
import { loadProfile, saveProfile } from "../db.js";
import { claimMission, countRound, payRankUps, refreshMissions } from "../progress.js";
import { OUTFIT_KEY, reportId, verifyToken, type Identity } from "../auth.js";
import { flushReports, queueScores, queueStats } from "../reporters.js";

type Team = "blue" | "orange";
const TEAMS: Team[] = ["blue", "orange"];
const RUNNING = new Set(["intro", "countdown", "playing", "ending"]);

// Per-connection bookkeeping the clients never see.
interface Session {
  identity: Identity;
  dev: boolean; // a local-dev id (non-production server only): saved, never reported
  profile: Profile;
  loaded: boolean; // the profile read has answered: only then may it be written
  vestDur: number;
  helmetDur: number;
  lastDamageAt: number; // round clock
  damagers: Map<string, number>; // attacker sessionId -> round clock
  lastHitBy: string;
  streak: number;
  lastElimAt: number;
  roundGems: number; // Gems granted this round (already in the profile; shown in `rewards`)
  zoneTick: number;
  shotSeq: Map<string, number>; // weapon -> last shot sequence number
  shotAt: Map<string, number>; // weapon -> ms of that shot
  throws: number; // frags thrown and not yet exploded
  throwKind: string; // the grenade type of the last throw (GRENADES)
  lastThrowAt: number; // ms
  lastHealAt: number; // ms
  lastUltAt: number; // ms
  lastWallAt: number; // ms
  lastOpenAt: number; // ms
  reviving: { target: string; at: number } | null;
  pose: { x: number; y: number; z: number; at: number } | null;
  graceUntil: number; // ms: poses may jump (spawn / respawn teleports)
  emoteAt: number; // ms
  playedRound: number; // round index this player fought in (rewards, leave penalty)
  lastSeat: number; // the last round that seated this player (not reset at the end): sat-out players get seats first
  lastInviteAt: number; // ms of the last squad invite sent
  heartAt: number; // ms of the last heart given (spectating)
  heartsGiven: Map<string, number>; // target sessionId -> hearts given this round
  reactAt: number; // ms of the last spectator reaction
  roundRevives: number; // teammates this player revived this round (missions)
  profileAt: number; // ms of the last public profile request
}

// A pending squad invite (from the lobby's "Players online" list), answered by `inviteReply`.
interface Invite {
  id: number;
  from: string; // sessionId
  to: string; // sessionId
  expires: number; // ms
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pfpOk = (v: unknown) => (typeof v === "string" && v.length <= PFP_MAX_LEN && /^https?:\/\//i.test(v) ? v : "");
const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const EMOTE_RE = /^(wave|dance|salute|flex|cheer|portal:[a-z0-9]{1,40})$/;

/**
 * One server = one room of up to ROOM_MAX_CLIENTS players. Everyone in the room is in the lobby
 * (menus, shops) until they press Play; a round starts once MIN_PLAYERS have, and runs vote ->
 * intro -> countdown -> playing -> ending -> results, then the next round in the same room.
 * Movement is the client's (poses are bounded); hits are reported by the shooter and checked here
 * (fire rate, range, team, alive, armour); the server alone decides damage, knocks, eliminations,
 * respawns, score, the zone, airdrops, rewards and the shop.
 */
export class MatchRoom extends Room<{ state: MatchState }> {
  state = new MatchState();
  maxClients = ROOM_MAX_CLIENTS;
  patchRate = PATCH_MS;

  private sessions = new Map<string, Session>();
  private zone = new Zone(1);
  private nextDrop = 0;
  private dropId = 1;
  private invites = new Map<number, Invite>();
  private inviteSeq = 1;
  private squadSeq = 1;

  messages = {
    // --- Lobby -----------------------------------------------------------------------------------
    // Pressed Play: { mode } is the player's preferred mode for the next vote. A squad (lobby team)
    // plays together: only its leader presses Play and every member is queued with them.
    play: (client: Client, msg: { mode?: unknown }) => {
      const p = this.player(client);
      if (!p) return;
      if (p.squad && !p.squadLead) return this.tell(client.sessionId, "squadNote", { kind: "notLeader" });
      if (p.inMatch && !p.squad) return;
      const mode = typeof msg?.mode === "string" && msg.mode in MODES ? msg.mode : "";
      for (const [sid, m] of p.squad ? this.squadOf(p.squad) : [[client.sessionId, p] as [string, PlayerState]]) {
        if (m.inMatch) continue;
        m.inMatch = true;
        m.voteMode = mode;
        m.vote = -1;
        this.dropInvitesOf(sid); // queued players can neither send nor answer invites
        if (RUNNING.has(this.state.phase)) this.joinRound(sid, m);
      }
    },
    // The client is ready for its profile (also sent unasked once loaded).
    getProfile: (client: Client) => {
      const s = this.sessions.get(client.sessionId);
      if (s?.loaded) this.sendProfile(client, s);
    },
    // Back to the menus. Leaving a running round costs half the coins and some rank.
    // A squad that is only queued (no seat yet) leaves the queue together: the leader decided to queue.
    leave: (client: Client) => {
      const p = this.player(client);
      const group = p?.squad && p.inMatch && !p.team ? this.squadOf(p.squad).map(([sid]) => sid) : [client.sessionId];
      for (const sid of group) this.leaveMatch(sid);
    },

    // --- Squad (the lobby team: up to SQUAD_MAX players who queue and play together) ---------------
    // Invite another player in the room: { to: sessionId }. They answer with `inviteReply`.
    invite: (client: Client, msg: { to?: unknown }) => this.onInvite(client.sessionId, typeof msg?.to === "string" ? msg.to : ""),
    inviteReply: (client: Client, msg: { id?: unknown; accept?: unknown }) => this.onInviteReply(client.sessionId, num(msg?.id), msg?.accept === true),
    // Leave the squad (and the queue, if the squad was queued).
    leaveSquad: (client: Client) => {
      const p = this.player(client);
      if (!p?.squad) return;
      if (p.inMatch && !p.team) this.leaveMatch(client.sessionId);
      this.removeFromSquad(client.sessionId, "left");
    },
    // The leader removes a member (not while queued or fighting): { t: sessionId }.
    kick: (client: Client, msg: { t?: unknown }) => {
      const p = this.player(client);
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const t = this.state.players.get(tid);
      if (!p?.squad || !p.squadLead || !t || tid === client.sessionId || t.squad !== p.squad || p.inMatch || t.inMatch) return;
      this.removeFromSquad(tid, "kicked");
    },
    vote: (client: Client, msg: { map?: unknown; mode?: unknown }) => {
      const p = this.player(client);
      if (!p || !p.inMatch || this.state.phase !== "vote") return;
      const m = num(msg?.map);
      if (m !== null && m >= 0 && m < MAP_COUNT) p.vote = Math.floor(m);
      if (typeof msg?.mode === "string" && msg.mode in MODES) p.voteMode = msg.mode;
    },

    // --- Presence --------------------------------------------------------------------------------
    pose: (client: Client, msg: any) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || !msg) return;
      const x = num(msg.x), y = num(msg.y), z = num(msg.z);
      if (x === null || y === null || z === null) return;
      if (Math.abs(x) > WORLD_BOUND || Math.abs(z) > WORLD_BOUND || y < -60 || y > 300) return;
      const now = Date.now();
      if (s.pose && now > s.graceUntil && p.life !== "dead") {
        const dt = Math.max(0.05, (now - s.pose.at) / 1000);
        const moved = Math.hypot(x - s.pose.x, z - s.pose.z);
        if (moved > MAX_SPEED * dt + MOVE_SLACK) return; // a teleport: not accepted
      }
      s.pose = { x, y, z, at: now };
      p.x = x;
      p.y = y;
      p.z = z;
      p.yaw = num(msg.yaw) ?? p.yaw;
      p.pitch = clampN(num(msg.pitch) ?? 0, -1.6, 1.6);
      p.speed = clampN(num(msg.speed) ?? 0, 0, 60);
      p.flags = clampN(Math.floor(num(msg.flags) ?? 0), 0, 0xffff);
      const slot = num(msg.slot);
      if (slot !== null) p.slot = clampN(Math.floor(slot), 0, 3);
      if (p.emote && p.speed > 1.2) p.emote = "";
    },
    // The player's Bloxity look for the others to draw: { avatar: JSON of ids (never URLs), outfitKey }.
    avatar: (client: Client, msg: { avatar?: unknown; outfitKey?: unknown }) => {
      const p = this.player(client);
      if (!p) return;
      if (typeof msg?.avatar === "string" && msg.avatar.length <= AVATAR_MAX_LEN) p.avatar = msg.avatar;
      if (typeof msg?.outfitKey === "string" && (msg.outfitKey === "" || OUTFIT_KEY.test(msg.outfitKey))) p.outfitKey = msg.outfitKey;
    },
    emote: (client: Client, msg: { emote?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive") return;
      const e = typeof msg?.emote === "string" ? msg.emote : "";
      if (e === "") {
        p.emote = "";
        return;
      }
      if (!EMOTE_RE.test(e)) return;
      if (!e.startsWith("portal:") && !s.profile.owned.emotes.includes(e)) return;
      p.emote = e;
      s.emoteAt = Date.now();
    },
    // Sign-in / sign-out mid-session: re-verify and switch the saved profile.
    auth: async (client: Client, msg: { token?: unknown; name?: unknown; pfp?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s) return;
      const v = await verifyToken(msg?.token);
      if (!this.sessions.has(client.sessionId)) return;
      const identity: Identity = v
        ? { ...v, verified: true }
        : { userId: GUEST_ID_PREFIX + client.sessionId, verified: false, username: str(msg?.name, NAME_MAX) || "Guest", pfp: pfpOk(msg?.pfp), carriedFrom: [] };
      if (identity.userId === s.identity.userId) return;
      await this.persist(client.sessionId);
      s.identity = identity;
      s.dev = false;
      p.name = identity.username.slice(0, NAME_MAX) || "Player";
      p.pfp = pfpOk(identity.pfp) || p.pfp;
      p.signedIn = identity.verified;
      p.uid = identity.verified ? identity.userId : "";
      if (identity.outfitKey) p.outfitKey = identity.outfitKey;
      this.evictOthers(client.sessionId, identity);
      void this.loadSession(client, s);
    },

    // --- Shop (coins only) ------------------------------------------------------------------------
    buy: async (client: Client, msg: { kind?: unknown; id?: unknown }) => {
      const s = this.sessions.get(client.sessionId);
      if (!s) return;
      if (!s.loaded) return client.send("shop", { ok: false, kind: msg?.kind, id: msg?.id, error: "loading" });
      const error = buy(s.profile, msg?.kind, msg?.id);
      client.send("shop", { ok: !error, kind: msg?.kind, id: msg?.id, error });
      if (!error) {
        this.sendProfile(client, s);
        await this.persist(client.sessionId);
      }
    },
    // A finished mission's reward: { m: "daily" | "weekly", i: slot index } -> `claimed`.
    claim: async (client: Client, msg: { m?: unknown; i?: unknown }) => {
      const s = this.sessions.get(client.sessionId);
      if (!s) return;
      if (!s.loaded) return client.send("claimed", { m: msg?.m, i: msg?.i, error: "loading" });
      refreshMissions(s.profile.missions);
      const r = claimMission(s.profile, msg?.m, msg?.i);
      client.send("claimed", { m: msg?.m, i: msg?.i, ...r });
      this.sendProfile(client, s);
      if (!("error" in r)) await this.persist(client.sessionId);
    },
    // The first-round tips were finished or skipped: never shown again on this account.
    tutorialDone: async (client: Client) => {
      const s = this.sessions.get(client.sessionId);
      if (!s?.loaded || s.profile.tutorial) return;
      s.profile.tutorial = true;
      await this.persist(client.sessionId);
    },
    equip: async (client: Client, msg: { kind?: unknown; id?: unknown; weapon?: unknown }) => {
      const s = this.sessions.get(client.sessionId);
      const p = this.player(client);
      if (!s || !p) return;
      if (!s.loaded) return;
      const error = equip(s.profile, msg?.kind, msg?.id, msg?.weapon);
      if (error) return client.send("shop", { ok: false, kind: msg?.kind, id: msg?.id, error });
      // A new loadout shows at once in the menus; in a round it arrives with the next spawn.
      if (!RUNNING.has(this.state.phase) || !p.team) this.applyLoadout(p, s);
      this.sendProfile(client, s);
      await this.persist(client.sessionId);
    },

    // --- Combat ------------------------------------------------------------------------------------
    // Visual relay of the sender's shot (tracers, muzzle flash, sound): { w, o: [x,y,z], e: [[x,y,z], ...] }.
    shot: (client: Client, msg: any) => {
      const p = this.player(client);
      if (!p || p.life !== "alive" || !this.fighting()) return;
      if (typeof msg?.w !== "string" || !this.carries(p, msg.w)) return;
      const pt = (v: any) => (Array.isArray(v) && v.length === 3 && v.every((n: unknown) => num(n) !== null) ? v.map((n: number) => Math.round(n * 100) / 100) : null);
      const o = pt(msg.o);
      const e = Array.isArray(msg.e) ? msg.e.slice(0, SHOT_POINTS_MAX).map(pt).filter(Boolean) : [];
      if (!o) return;
      this.broadcast("shot", { id: client.sessionId, w: msg.w, o, e }, { except: client });
    },
    // The shooter's hit report: { t: target sessionId, w: weapon, s: shot number, n: pellets that
    // hit, h: of them on the head, d: distance (m) }. Knife and fists use it too (melee).
    hit: (client: Client, msg: any) => this.onHit(client.sessionId, msg),
    // Frag thrown (visual relay; the explosion is reported by the thrower as `boom`).
    throw: (client: Client, msg: any) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive" || !this.fighting()) return;
      const now = Date.now();
      if (now - s.lastThrowAt < 400) return;
      s.lastThrowAt = now;
      s.throws = Math.min(s.throws + 1, 3);
      // The grenade type is the loadout's (an unowned or unknown kind throws a frag).
      s.throwKind = s.profile.loadout.grenade in GRENADES ? s.profile.loadout.grenade : "frag";
      const v = (a: any) => (Array.isArray(a) && a.length === 3 && a.every((n: unknown) => num(n) !== null) ? a : null);
      if (v(msg?.p) && v(msg?.v)) this.broadcast("throw", { id: client.sessionId, p: msg.p, v: msg.v, k: s.throwKind }, { except: client });
    },
    // The thrower's frag went off: { x, y, z, t: [sessionIds in the blast with line of sight] }.
    boom: (client: Client, msg: any) => this.onBoom(client.sessionId, msg),
    wall: (client: Client, msg: any) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive" || !this.fighting()) return;
      const x = num(msg?.x), y = num(msg?.y), z = num(msg?.z), yaw = num(msg?.yaw);
      if (x === null || y === null || z === null || yaw === null) return;
      const now = Date.now();
      if (now - s.lastWallAt < 300 || Math.hypot(x - p.x, z - p.z) > 8) return;
      s.lastWallAt = now;
      this.broadcast("wall", { id: client.sessionId, x, y, z, yaw }, { except: client });
    },
    heal: (client: Client) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive" || !this.fighting()) return;
      const now = Date.now();
      if (now - s.lastHealAt < ITEMS.medkit.time * 800) return;
      s.lastHealAt = now;
      p.hp = Math.min(HEALTH.max, p.hp + ITEMS.medkit.heal);
    },
    ult: (client: Client) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive" || !this.fighting()) return;
      const now = Date.now();
      if (now - s.lastUltAt < ULT_MIN_GAP_S * 1000) return;
      s.lastUltAt = now;
      const op = OPERATIVES[p.operative] ? p.operative : "rook";
      if (op === "jin") {
        p.hp = Math.min(HEALTH.max, p.hp + JIN_HEAL.self);
        for (const [, o] of this.state.players) {
          if (o !== p && o.team === p.team && o.life === "alive" && Math.hypot(o.x - p.x, o.z - p.z) < JIN_HEAL.range + 2) o.hp = Math.min(HEALTH.max, o.hp + JIN_HEAL.ally);
        }
      } else p.ultUntil = this.state.clock + OPERATIVES[op].duration;
      this.broadcast("ult", { id: client.sessionId, op }, { except: client });
    },
    // Hold-to-revive started (`reviving`) and finished (`revive`): { t: the knocked teammate }.
    reviving: (client: Client, msg: { t?: unknown }) => {
      const s = this.sessions.get(client.sessionId);
      if (s && typeof msg?.t === "string") s.reviving = { target: msg.t, at: Date.now() };
    },
    revive: (client: Client, msg: { t?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const t = this.state.players.get(tid);
      if (!p || !s || !t || p.life !== "alive" || t.life !== "knocked" || t.team !== p.team || !this.fighting()) return;
      if (!s.reviving || s.reviving.target !== tid || Date.now() - s.reviving.at < HEALTH.reviveTime * 800) return;
      if (Math.hypot(t.x - p.x, t.z - p.z) > HEALTH.reviveRange + RANGE_SLACK * 0.25) return;
      s.reviving = null;
      t.life = "alive";
      t.hp = HEALTH.reviveHp;
      t.downHp = 0;
      t.protectedUntil = this.state.clock + 1;
      s.roundRevives++;
      this.broadcast("revive", { t: tid, b: client.sessionId });
    },
    // Fell off the island (or into the sea): out.
    fell: (client: Client) => {
      const p = this.player(client);
      if (p && p.life !== "dead" && this.state.phase === "playing") this.eliminate(client.sessionId, null, { zone: true });
    },
    // The portal's death screen said go (or the fallback timer ran out): back in.
    respawn: (client: Client) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "dead" || !p.team || this.state.phase !== "playing") return;
      if (this.state.clock - p.deadAt < RESPAWN_MIN_S) return;
      this.spawn(client.sessionId, p, s, false);
    },

    // --- Spectating (eliminated players watch the others until they respawn) -------------------------
    // Who this eliminated player watches: { t: sessionId } (another player in the round), "" = nobody.
    spectate: (client: Client, msg: { t?: unknown }) => {
      const p = this.player(client);
      if (!p || !p.team) return;
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const t = tid && tid !== client.sessionId ? this.state.players.get(tid) : undefined;
      p.watch = p.life === "dead" && t?.team && this.fighting() ? tid : "";
    },
    // A spectator likes the play of the player they watch: { t: sessionId }. Counted on the target
    // (state `hearts`, this round) and broadcast as `heart` { f, t } for the floating hearts.
    heart: (client: Client, msg: { t?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const t = this.state.players.get(tid);
      if (!p || !s || !t || !t.team || p.watch !== tid || p.life !== "dead") return;
      const now = Date.now();
      const given = s.heartsGiven.get(tid) ?? 0;
      if (now - s.heartAt < HEART_GAP_MS || given >= HEARTS_PER_TARGET) return;
      s.heartAt = now;
      s.heartsGiven.set(tid, given + 1);
      t.hearts = Math.min(65535, t.hearts + 1);
      this.broadcast("heart", { f: client.sessionId, t: tid });
    },
    // A spectator's reaction to the player they watch: { t: sessionId, e: REACTIONS id }, relayed as
    // `react` { f, t, e } (drawn over the target's head; the target sees who sent it).
    react: (client: Client, msg: { t?: unknown; e?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const e = typeof msg?.e === "string" ? msg.e : "";
      const t = this.state.players.get(tid);
      if (!p || !s || !t || !t.team || p.watch !== tid || p.life !== "dead" || !(REACTIONS as readonly string[]).includes(e)) return;
      const now = Date.now();
      if (now - s.reactAt < REACT_GAP_MS) return;
      s.reactAt = now;
      this.broadcast("react", { f: client.sessionId, t: tid, e });
    },
    // Another player's public profile (spectate "View profile"): { t: sessionId } -> `playerProfile`.
    profileOf: (client: Client, msg: { t?: unknown }) => {
      const s = this.sessions.get(client.sessionId);
      const tid = typeof msg?.t === "string" ? msg.t : "";
      const t = this.state.players.get(tid);
      const ts = this.sessions.get(tid);
      if (!s || !t || !ts) return;
      const now = Date.now();
      if (now - s.profileAt < PROFILE_GAP_MS) return;
      s.profileAt = now;
      const st = ts.profile.stats;
      client.send("playerProfile", {
        t: tid,
        name: t.name,
        level: t.level,
        rp: t.rp,
        signedIn: t.signedIn,
        operative: t.operative,
        primary: t.primary,
        secondary: t.secondary,
        stats: { matches: st.matches, wins: st.wins, eliminations: st.eliminations, deaths: st.deaths, best: st.best },
        round: { kills: t.kills, deaths: t.deaths, assists: t.assists, knocks: t.knocks, damage: Math.round(t.damage), hearts: t.hearts },
      });
    },

    // Supplies: { c: crate index } or { d: airdrop id }. Ammo and items are the client's; armour is decided here.
    open: (client: Client, msg: { c?: unknown; d?: unknown }) => {
      const p = this.player(client);
      const s = this.sessions.get(client.sessionId);
      if (!p || !s || p.life !== "alive" || !this.fighting()) return;
      const now = Date.now();
      if (now - s.lastOpenAt < 250) return;
      s.lastOpenAt = now;
      const c = num(msg?.c);
      if (c !== null) {
        const i = Math.floor(c);
        if (i < 0 || i >= LOOT.crates) return;
        const key = String(i);
        if (this.state.crates.has(key)) return client.send("openFail", { c: i });
        this.state.crates.set(key, this.state.clock + LOOT.respawn);
        if (Math.random() < 0.45) {
          if (p.vest <= p.helmet && p.vest < 3) this.setArmor(p, s, "vest", p.vest + 1);
          else if (p.helmet < 3) this.setArmor(p, s, "helmet", p.helmet + 1);
        }
        this.broadcast("opened", { c: i, by: client.sessionId });
        return;
      }
      const d = num(msg?.d);
      const drop = d !== null ? this.state.drops.find((x) => x.id === d) : undefined;
      if (!drop || drop.opened || this.state.clock < drop.at + LOOT.airdropFall - 0.5) return client.send("openFail", { d });
      drop.opened = true;
      this.setArmor(p, s, "vest", 3);
      this.setArmor(p, s, "helmet", 3);
      this.broadcast("opened", { d: drop.id, by: client.sessionId });
    },
  };

  // --- Lifecycle ------------------------------------------------------------------------------------
  onCreate(options?: { private?: unknown }) {
    // ?instantMultiplayer=true (Play with friends): a private room, joined only by its id.
    if (options?.private === true) void this.setPrivate(true);
    void this.setMetadata({ mode: 1, modeName: "Team Battle", started: false } as any);
    this.setSimulationInterval((dt) => this.tick(dt / 1000), TICK_MS);
  }

  // The token from Legion.SDK.auth.getToken() (join options). A refused or missing token is a
  // guest with a server-made id. Never trusts a client-sent user id.
  async onAuth(client: Client, options: any, context: any) {
    const token = typeof options?.token === "string" ? options.token : context?.token;
    const v = await verifyToken(token);
    if (v) return { ...v, verified: true, dev: false };
    // Local development only: a stable id per browser so progress survives reloads.
    const dev = process.env.NODE_ENV !== "production" && typeof options?.devUser === "string" && /^dev-[a-z0-9-]{4,40}$/.test(options.devUser);
    return {
      userId: dev ? options.devUser : GUEST_ID_PREFIX + client.sessionId,
      verified: false,
      dev,
      username: str(options?.name, NAME_MAX) || "Guest",
      pfp: pfpOk(options?.pfp),
      carriedFrom: [] as string[],
    };
  }

  onJoin(client: Client, options: any, auth: Identity & { dev: boolean }) {
    const p = new PlayerState();
    p.name = (auth.username || "Player").slice(0, NAME_MAX);
    p.pfp = pfpOk(auth.pfp) || pfpOk(options?.pfp);
    p.signedIn = auth.verified;
    p.uid = auth.verified ? auth.userId : "";
    // The verified outfit key wins over the one in the join options.
    if (auth.outfitKey) p.outfitKey = auth.outfitKey;
    else if (typeof options?.outfitKey === "string" && OUTFIT_KEY.test(options.outfitKey)) p.outfitKey = options.outfitKey;
    if (typeof options?.avatar === "string" && options.avatar.length <= AVATAR_MAX_LEN) p.avatar = options.avatar;
    p.party = str(options?.party, PARTY_MAX_LEN);
    p.life = "dead";
    this.state.players.set(client.sessionId, p);
    const s: Session = {
      identity: { userId: auth.userId, verified: auth.verified, username: auth.username, pfp: auth.pfp, carriedFrom: auth.carriedFrom ?? [] },
      dev: !!auth.dev,
      profile: normalizeProfile(null),
      loaded: false,
      vestDur: 0,
      helmetDur: 0,
      lastDamageAt: -99,
      damagers: new Map(),
      lastHitBy: "",
      streak: 0,
      lastElimAt: -99,
      roundGems: 0,
      roundRevives: 0,
      zoneTick: 0,
      shotSeq: new Map(),
      shotAt: new Map(),
      throws: 0,
      throwKind: "frag",
      lastThrowAt: 0,
      lastHealAt: 0,
      lastUltAt: 0,
      lastWallAt: 0,
      lastOpenAt: 0,
      reviving: null,
      pose: null,
      graceUntil: Date.now() + TIMING.joinGraceMs,
      emoteAt: 0,
      playedRound: -1,
      lastSeat: -1,
      lastInviteAt: 0,
      heartAt: 0,
      heartsGiven: new Map(),
      reactAt: 0,
      profileAt: 0,
    };
    this.sessions.set(client.sessionId, s);
    this.evictOthers(client.sessionId, s.identity);
    void this.loadSession(client, s);
  }

  // A deliberate leave drops the player at once; anything else (WiFi blip, backgrounded tab) gets
  // RECONNECT_SECONDS to come back with the same session (still in the round, still on the team).
  async onLeave(client: Client, code?: number) {
    if (code !== CloseCode.CONSENTED) {
      try {
        await this.allowReconnection(client, RECONNECT_SECONDS);
        const s = this.sessions.get(client.sessionId);
        if (s) {
          s.graceUntil = Date.now() + 3000;
          this.sendProfile(client, s);
        }
        return;
      } catch {
        // Gone for good.
      }
    }
    this.leaveMatch(client.sessionId);
    this.removeFromSquad(client.sessionId, "left");
    this.dropInvitesOf(client.sessionId);
    await this.persist(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.sessions.delete(client.sessionId);
  }

  async onDispose() {
    await flushReports();
  }

  // --- Helpers --------------------------------------------------------------------------------------
  private player(client: Client) {
    return this.state.players.get(client.sessionId);
  }

  private fighting() {
    return this.state.phase === "playing" || this.state.phase === "ending";
  }

  private carries(p: PlayerState, w: string) {
    return w === p.primary || w === p.secondary || w === "knife" || w === "fists";
  }

  private inRound() {
    return [...this.state.players.entries()].filter(([, p]) => p.inMatch && p.team);
  }

  private ready() {
    return [...this.state.players.values()].filter((p) => p.inMatch).length;
  }

  // One live session per verified account: a second tab (or a crashed one lingering in
  // allowReconnection) is dropped so the save never has two writers.
  private evictOthers(sessionId: string, identity: Identity) {
    if (!identity.verified && !this.sessions.get(sessionId)?.dev) return;
    for (const [sid, s] of this.sessions) {
      if (sid === sessionId || s.identity.userId !== identity.userId) continue;
      const stale = this.clients.find((c) => c.sessionId === sid);
      try {
        // A dedicated close code: the replaced tab says so instead of rejoining (and kicking back).
        stale?.leave(REPLACED_CODE);
      } catch {
        // Already gone.
      }
    }
  }

  private saved(s: Session) {
    return s.identity.verified || s.dev;
  }

  private async loadSession(client: Client, s: Session) {
    const identity = s.identity;
    s.loaded = false;
    if (!this.saved(s)) {
      s.profile = normalizeProfile(null);
      s.loaded = true;
    } else {
      try {
        const r = await loadProfile(identity.userId, identity.carriedFrom);
        if (this.sessions.get(client.sessionId) !== s || s.identity !== identity) return;
        s.profile = r.profile;
        s.loaded = true;
        // Local testing only: DEV_GEMS gives a brand-new dev account (dev-...) a Gem balance so the
        // Weapons Store can be tried without playing rounds first. Never in production.
        const devGems = process.env.NODE_ENV !== "production" && s.dev ? Number(process.env.DEV_GEMS) : 0;
        if (!r.found && !r.carried && devGems > 0) s.profile.gems = Math.min(devGems, 1e6);
        if (r.carried) await saveProfile(identity.userId, identity.username, s.profile);
      } catch (err) {
        console.warn("[MatchRoom] loadProfile failed", err);
        if (this.sessions.get(client.sessionId) !== s) return;
        client.send("serverError", { reason: "load" });
        return; // saving stays off: a save that could not be read is never overwritten
      }
    }
    const p = this.state.players.get(client.sessionId);
    if (p && (!RUNNING.has(this.state.phase) || !p.team)) this.applyLoadout(p, s);
    if (p) this.applyPublic(p, s);
    this.sendProfile(client, s);
  }

  // The profile's public face in the room state: level (career stats) and rank points.
  private applyPublic(p: PlayerState, s: Session) {
    p.level = levelOf(s.profile.stats);
    p.rp = Math.min(0xffffffff, Math.max(0, Math.floor(s.profile.rp)));
  }

  private sendProfile(client: Client, s: Session) {
    refreshMissions(s.profile.missions); // a new day / week rolls new missions
    try {
      client.send("profile", { profile: s.profile, saved: this.saved(s), userId: s.identity.verified ? s.identity.userId : "" });
    } catch {
      // Gone meanwhile.
    }
  }

  private async persist(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.loaded || !this.saved(s)) return;
    await saveProfile(s.identity.userId, s.identity.username, s.profile);
  }

  private applyLoadout(p: PlayerState, s: Session) {
    const lo = s.profile.loadout;
    p.primary = lo.primary;
    p.secondary = lo.secondary;
    p.skinPrimary = skinFor(s.profile, lo.primary);
    p.skinSecondary = skinFor(s.profile, lo.secondary);
    p.operative = lo.operative;
  }

  private setArmor(p: PlayerState, s: Session, piece: "vest" | "helmet", level: number) {
    const lv = clampN(level, 0, 3);
    if (piece === "vest") {
      p.vest = lv;
      s.vestDur = HEALTH.armorDurability[lv];
    } else {
      p.helmet = lv;
      s.helmetDur = HEALTH.armorDurability[lv];
    }
  }

  // --- Squad (lobby team) ---------------------------------------------------------------------------
  private tell(sessionId: string, type: string, msg: unknown) {
    try {
      this.clients.find((c) => c.sessionId === sessionId)?.send(type, msg);
    } catch {
      // Gone meanwhile.
    }
  }

  // Members of a squad: [[sessionId, PlayerState], ...] in room order.
  private squadOf(id: string): [string, PlayerState][] {
    return id ? [...this.state.players.entries()].filter(([, p]) => p.squad === id) : [];
  }

  private onInvite(fromId: string, toId: string) {
    const p = this.state.players.get(fromId);
    const s = this.sessions.get(fromId);
    const t = this.state.players.get(toId);
    if (!p || !s || !t || fromId === toId) return;
    const now = Date.now();
    if (now - s.lastInviteAt < INVITE_GAP_MS) return;
    s.lastInviteAt = now;
    if (p.inMatch) return this.tell(fromId, "squadNote", { kind: "youBusy" });
    if (t.inMatch) return this.tell(fromId, "squadNote", { kind: "busy", name: t.name }); // in a round or the queue: cannot view invitations
    if (t.squad) return this.tell(fromId, "squadNote", { kind: t.squad === p.squad ? "sameTeam" : "inTeam", name: t.name });
    if (p.squad && this.squadOf(p.squad).length >= SQUAD_MAX) return this.tell(fromId, "squadNote", { kind: "full" });
    let pending = 0;
    for (const inv of this.invites.values()) {
      if (inv.from !== fromId) continue;
      if (inv.to === toId) return this.tell(fromId, "squadNote", { kind: "dup", name: t.name });
      pending++;
    }
    if (pending >= INVITE_MAX_PENDING) return;
    const inv: Invite = { id: this.inviteSeq++, from: fromId, to: toId, expires: now + INVITE_TTL_S * 1000 };
    this.invites.set(inv.id, inv);
    this.tell(toId, "invite", { id: inv.id, from: fromId, name: p.name, pfp: p.pfp, size: p.squad ? this.squadOf(p.squad).length : 1, ttl: INVITE_TTL_S });
    this.tell(fromId, "squadNote", { kind: "sent", name: t.name });
  }

  private onInviteReply(toId: string, id: number | null, accept: boolean) {
    const inv = id !== null ? this.invites.get(id) : undefined;
    if (!inv || inv.to !== toId) return;
    this.invites.delete(inv.id);
    const t = this.state.players.get(toId);
    const p = this.state.players.get(inv.from);
    if (!t) return;
    if (!accept) return this.tell(inv.from, "squadNote", { kind: "declined", name: t.name });
    if (!p || p.inMatch || t.inMatch) return this.tell(toId, "squadNote", { kind: "gone" });
    if (t.squad) return this.tell(toId, "squadNote", { kind: "youInTeam" });
    if (p.squad && this.squadOf(p.squad).length >= SQUAD_MAX) {
      this.tell(toId, "squadNote", { kind: "teamFull" });
      return this.tell(inv.from, "squadNote", { kind: "full" });
    }
    if (!p.squad) {
      p.squad = "s" + this.squadSeq++;
      p.squadLead = true;
    }
    t.squad = p.squad;
    t.squadLead = false;
    for (const [sid] of this.squadOf(p.squad)) {
      if (sid !== toId) this.tell(sid, "squadNote", { kind: "joined", name: t.name });
    }
    this.tell(toId, "squadNote", { kind: "welcome", name: p.name });
    for (const o of [...this.invites.values()]) if (o.to === toId) this.invites.delete(o.id); // answered by joining
  }

  // Drops this player out of their squad: a squad of one dissolves, a leaving leader hands over.
  private removeFromSquad(sessionId: string, why: "left" | "kicked") {
    const p = this.state.players.get(sessionId);
    if (!p?.squad) return;
    const id = p.squad;
    const wasLead = p.squadLead;
    p.squad = "";
    p.squadLead = false;
    const rest = this.squadOf(id);
    if (why === "kicked") this.tell(sessionId, "squadNote", { kind: "youKicked" });
    if (rest.length < 2) {
      for (const [sid, r] of rest) {
        r.squad = "";
        r.squadLead = false;
        this.tell(sid, "squadNote", { kind: "disbanded", name: p.name });
      }
      return;
    }
    if (wasLead) {
      rest[0][1].squadLead = true;
      this.tell(rest[0][0], "squadNote", { kind: "leader" });
    }
    for (const [sid] of rest) this.tell(sid, "squadNote", { kind: why, name: p.name });
  }

  // Invites this player sent or was sent end (they queued, or left the room).
  private dropInvitesOf(sessionId: string) {
    for (const inv of [...this.invites.values()]) {
      if (inv.from !== sessionId && inv.to !== sessionId) continue;
      this.invites.delete(inv.id);
      this.tell(inv.to, "inviteEnd", { id: inv.id });
    }
  }

  private expireInvites(now: number) {
    for (const inv of [...this.invites.values()]) {
      if (now < inv.expires) continue;
      this.invites.delete(inv.id);
      this.tell(inv.to, "inviteEnd", { id: inv.id });
      this.tell(inv.from, "squadNote", { kind: "expired", name: this.state.players.get(inv.to)?.name ?? "" });
    }
  }

  // --- Teams + rounds -------------------------------------------------------------------------------
  // The side for a player, or "" when both sides are full (TEAM_MAX each): they wait for the next round.
  private pickTeam(sessionId: string, p: PlayerState): Team | "" {
    const count = { blue: 0, orange: 0 };
    for (const [sid, o] of this.state.players) if (sid !== sessionId && o.inMatch && (o.team === "blue" || o.team === "orange")) count[o.team as Team]++;
    // Squad (lobby team) and Bloxity party members play together when their team has room.
    if (p.squad || p.party) {
      for (const [sid, o] of this.state.players) {
        const mate = (p.squad && o.squad === p.squad) || (p.party && o.party === p.party);
        if (sid !== sessionId && mate && (o.team === "blue" || o.team === "orange") && count[o.team as Team] < TEAM_MAX) return o.team as Team;
      }
    }
    let open = TEAMS.filter((t) => count[t] < TEAM_MAX);
    if (!open.length) return "";
    // The first of a squad to be seated takes a side with room for all of them still waiting.
    if (p.squad) {
      const need = this.squadOf(p.squad).filter(([sid, o]) => o.inMatch && (sid === sessionId || !o.team)).length;
      const roomy = open.filter((t) => TEAM_MAX - count[t] >= need);
      if (roomy.length) open = roomy;
    }
    if (open.length === 1) return open[0];
    if (count.blue === count.orange) return Math.random() < 0.5 ? "blue" : "orange";
    return count.blue < count.orange ? "blue" : "orange";
  }

  private resetForRound(sessionId: string, p: PlayerState, s: Session) {
    p.kills = p.deaths = p.assists = p.knocks = p.headshots = p.hearts = 0;
    p.damage = 0;
    s.heartsGiven.clear();
    s.streak = 0;
    s.lastElimAt = -99;
    s.roundGems = 0;
    s.roundRevives = 0;
    s.damagers.clear();
    s.playedRound = s.lastSeat = this.state.round;
    this.applyLoadout(p, s);
    this.spawn(sessionId, p, s, true);
  }

  // Back to full health with the starting armour. `first`: the round's opening spawn.
  private spawn(sessionId: string, p: PlayerState, s: Session, first: boolean) {
    const armorLv = s.profile.upgrades.armor ? 1 + s.profile.upgrades.armor : 0;
    p.life = "alive";
    p.hp = HEALTH.max;
    p.downHp = 0;
    p.emote = "";
    p.ultUntil = 0;
    p.killer = "";
    p.watch = "";
    if (first) {
      this.setArmor(p, s, "vest", armorLv);
      this.setArmor(p, s, "helmet", armorLv);
      p.protectedUntil = 0;
    } else {
      // Respawns keep at least one level of armour.
      this.setArmor(p, s, "vest", Math.max(p.vest, 1, armorLv));
      this.setArmor(p, s, "helmet", Math.max(p.helmet, 1, armorLv));
      p.protectedUntil = this.state.clock + HEALTH.spawnProtection;
    }
    s.lastDamageAt = -99;
    s.lastHitBy = "";
    s.zoneTick = 0;
    s.reviving = null;
    s.graceUntil = Date.now() + TIMING.spawnGraceMs;
    this.applyLoadout(p, s);
    this.broadcast("spawn", { id: sessionId, first });
  }

  // Pressed Play while a round runs: straight in.
  private joinRound(sessionId: string, p: PlayerState) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const team = this.pickTeam(sessionId, p);
    if (!team) return; // both sides full: stays in the queue (inMatch, no team) until the next round
    p.team = team;
    this.resetForRound(sessionId, p, s);
  }

  private leaveMatch(sessionId: string) {
    const p = this.state.players.get(sessionId);
    const s = this.sessions.get(sessionId);
    if (!p || !s || !p.inMatch) return;
    if (p.team && RUNNING.has(this.state.phase) && s.playedRound === this.state.round) {
      const r = this.rewardsFor(sessionId, p, null);
      // Half of what the player earned by fighting; no participation coins (join-and-leave farming).
      r.coins = Math.max(0, Math.round((r.coins - REWARDS.loss) * 0.5));
      r.rp = Math.min(r.rp, REWARDS.leavePenaltyRp);
      r.gems -= r.gemsRound; // no round Gems for leaving (the kills' Gems stay)
      r.gemsRound = 0;
      r.won = false;
      this.grant(sessionId, s, r, false);
      void this.persist(sessionId);
    }
    p.inMatch = false;
    p.team = "";
    p.life = "dead";
    p.watch = "";
    p.vote = -1;
    p.emote = "";
    s.playedRound = -1;
    this.checkTeams();
  }

  private setPhase(phase: string, seconds = 0) {
    this.state.phase = phase;
    this.state.phaseLeft = seconds;
    void this.setMetadata({ mode: 1, modeName: "Team Battle", started: phase === "playing" } as any);
  }

  private startVote() {
    for (const p of this.state.players.values()) {
      p.vote = -1;
      if (!p.inMatch) p.team = "";
    }
    this.setPhase("vote", PHASES.vote);
  }

  private tally<T>(values: T[], fallback: T): T {
    const counts = new Map<T, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = fallback;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN || (n === bestN && Math.random() < 0.5)) [best, bestN] = [v, n];
    return best;
  }

  private startRound() {
    const st = this.state;
    const ready = [...st.players.entries()].filter(([, p]) => p.inMatch);
    st.map = this.tally(ready.map(([, p]) => p.vote).filter((v) => v >= 0), Math.floor(Math.random() * MAP_COUNT));
    st.mode = this.tally(ready.map(([, p]) => p.voteMode).filter((m) => m in MODES), "clash");
    // Local testing only: ROUND_SECONDS shortens rounds (ignored in production).
    const devRound = process.env.NODE_ENV !== "production" ? Number(process.env.ROUND_SECONDS) : 0;
    st.duration = devRound > 0 ? devRound : MODES[st.mode].duration;
    st.scoreToWin = MODES[st.mode].scoreToWin;
    st.round++;
    st.clock = 0;
    st.blue = st.orange = 0;
    st.winner = "";
    st.zoneSeed = (Math.random() * 0xffffffff) >>> 0;
    this.zone = new Zone(st.zoneSeed, MAP_FOCUS[st.map]);
    st.crates.clear();
    st.drops.clear();
    this.nextDrop = 0;
    // Teams: shuffle, keep parties together, balance.
    for (const [, p] of ready) p.team = "";
    // Shuffle, then those who sat out the last round go first; whoever does not fit waits.
    const seat = (sid: string) => this.sessions.get(sid)?.lastSeat ?? -1;
    ready.sort(() => Math.random() - 0.5);
    ready.sort(([a], [b]) => seat(a) - seat(b)); // longest without a seat first
    // A squad is seated together: its members follow its first member in the order.
    const order: typeof ready = [];
    const placed = new Set<string>();
    for (const e of ready) {
      if (placed.has(e[0])) continue;
      placed.add(e[0]);
      order.push(e);
      if (!e[1].squad) continue;
      for (const o of ready) {
        if (placed.has(o[0]) || o[1].squad !== e[1].squad) continue;
        placed.add(o[0]);
        order.push(o);
      }
    }
    for (const [sid, p] of order) p.team = this.pickTeam(sid, p);
    this.setPhase("intro", PHASES.intro);
    for (const [sid, p] of ready) {
      if (!p.team) continue;
      const s = this.sessions.get(sid);
      if (s) this.resetForRound(sid, p, s);
    }
    this.broadcast("round", { round: st.round });
  }

  // A side with nobody left ends the round early; too few players at the vote cancels it.
  private checkTeams() {
    const st = this.state;
    if (st.phase === "vote" && this.ready() < MIN_PLAYERS) return this.setPhase("waiting");
    if (!RUNNING.has(st.phase) || st.phase === "ending") return;
    const live = { blue: 0, orange: 0 };
    for (const [, p] of this.inRound()) live[p.team as Team]++;
    if (live.blue && live.orange) return;
    this.end(live.blue ? "blue" : live.orange ? "orange" : st.blue >= st.orange ? "blue" : "orange");
  }

  private end(winner: Team) {
    const st = this.state;
    if (!RUNNING.has(st.phase) || st.phase === "ending") return;
    st.winner = winner;
    this.setPhase("ending", PHASES.ending);
    this.broadcast("matchEnd", { winner });
  }

  // --- Simulation -------------------------------------------------------------------------------------
  private tick(dt: number) {
    const st = this.state;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25);
    const now = Date.now();
    for (const [sid, p] of st.players) {
      const s = this.sessions.get(sid);
      if (p.emote && s && now - s.emoteAt > 6000) p.emote = "";
    }
    if (this.invites.size) this.expireInvites(now);
    switch (st.phase) {
      case "waiting":
        if (this.ready() >= MIN_PLAYERS) this.startVote();
        return;
      case "vote":
        st.phaseLeft -= dt;
        if (this.ready() < MIN_PLAYERS) return this.setPhase("waiting");
        if (st.phaseLeft <= 0) this.startRound();
        return;
      case "intro":
        st.phaseLeft -= dt;
        if (st.phaseLeft <= 0) this.setPhase("countdown", PHASES.countdown);
        return;
      case "countdown":
        st.phaseLeft -= dt;
        if (st.phaseLeft <= 0) this.setPhase("playing");
        return;
      case "playing":
        this.simulate(dt);
        if (st.clock >= st.duration) this.end(st.blue === st.orange ? (Math.random() < 0.5 ? "blue" : "orange") : st.blue > st.orange ? "blue" : "orange");
        return;
      case "ending":
        this.simulate(dt);
        st.phaseLeft -= dt;
        if (st.phaseLeft <= 0) this.finishRound();
        return;
      case "results":
        st.phaseLeft -= dt;
        if (st.phaseLeft <= 0) {
          for (const p of st.players.values()) {
            p.team = "";
            p.life = "dead";
          }
          if (this.ready() >= MIN_PLAYERS) this.startVote();
          else this.setPhase("waiting");
        }
        return;
    }
  }

  private simulate(dt: number) {
    const st = this.state;
    if (st.phase === "playing") st.clock += dt;
    const clock = st.clock;
    this.zone.update(clock);
    // Opened crates refill.
    for (const [k, at] of st.crates) if (clock >= at) st.crates.delete(k);
    // Supply drops over the zone.
    if (st.phase === "playing" && this.nextDrop < LOOT.airdropAt.length && clock >= LOOT.airdropAt[this.nextDrop]) {
      this.nextDrop++;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * Math.max(10, this.zone.radius * 0.6);
      const d = new DropState();
      d.id = this.dropId++;
      d.x = this.zone.cx + Math.cos(a) * r;
      d.z = this.zone.cz + Math.sin(a) * r;
      d.at = clock;
      st.drops.push(d);
    }
    for (const [sid, p] of this.inRound()) {
      const s = this.sessions.get(sid);
      if (!s) continue;
      if (p.life === "alive") {
        if (clock - s.lastDamageAt > HEALTH.regenDelay && p.hp < HEALTH.regenCap) p.hp = Math.min(HEALTH.regenCap, p.hp + HEALTH.regen * dt);
      } else if (p.life === "knocked") {
        p.downHp -= HEALTH.bleed * dt;
        if (p.downHp <= 0) {
          this.eliminate(sid, s.lastHitBy || null, {});
          continue;
        }
      }
      // Zone damage, once a second (ignores armour).
      if (p.life !== "dead" && st.phase === "playing" && this.zone.outside(p.x, p.z)) {
        s.zoneTick += dt;
        if (s.zoneTick >= 1) {
          s.zoneTick = 0;
          this.applyDamage(sid, this.zone.damage, null, { zone: true });
        }
      } else s.zoneTick = 0;
    }
  }

  // --- Damage -------------------------------------------------------------------------------------------
  private onHit(sessionId: string, msg: any) {
    const a = this.state.players.get(sessionId);
    const s = this.sessions.get(sessionId);
    const tid = typeof msg?.t === "string" ? msg.t : "";
    const t = this.state.players.get(tid);
    const w = typeof msg?.w === "string" ? msg.w : "";
    const rule = WEAPONS[w];
    if (!a || !s || !t || !rule || tid === sessionId || !this.fighting()) return;
    if (a.life !== "alive" || !a.team || t.life === "dead" || !t.team || !this.carries(a, w)) return;
    const ally = t.team === a.team;
    if (ally && !rule.heal) return;
    // Fire rate: a new shot number must wait the weapon's interval (one shot may hit several players).
    const seq = num(msg.s) ?? -1;
    const now = Date.now();
    if (s.shotSeq.get(w) !== seq) {
      const last = s.shotAt.get(w) ?? 0;
      if (now - last < rule.interval * 1000 * FIRE_RATE_SLACK) return;
      s.shotSeq.set(w, seq);
      s.shotAt.set(w, now);
    }
    // Range, against where the server last saw both players.
    const dist = Math.hypot(t.x - a.x, t.y - a.y, t.z - a.z);
    const melee = !!rule.melee;
    if (dist > rule.range + (melee ? 2.5 : RANGE_SLACK)) return;
    const pellets = rule.pellets ?? 1;
    const n = clampN(Math.floor(num(msg.n) ?? 1), 1, pellets);
    // A medic weapon's hit on a teammate heals: HP while standing, the bleed-out pool while knocked
    // (it does not revive). Spawn-protected or not, an ally can always be healed.
    if (ally) {
      const heal = rule.heal! * n;
      if (t.life === "alive") t.hp = Math.min(HEALTH.max, t.hp + heal);
      else if (t.life === "knocked") t.downHp = Math.min(HEALTH.knockedHp, t.downHp + heal);
      this.broadcast("healed", { t: tid, a: sessionId, n: heal });
      return;
    }
    const h = melee ? 0 : clampN(Math.floor(num(msg.h) ?? 0), 0, n);
    const d = clampN(num(msg.d) ?? dist, 0, rule.range);
    const fall = melee ? 1 : damageFalloff(rule, d);
    const amount = rule.damage * fall * ((n - h) + h * rule.headMul);
    this.applyDamage(tid, amount, sessionId, { head: h > 0, weapon: w, pierce: rule.pierce });
  }

  private onBoom(sessionId: string, msg: any) {
    const a = this.state.players.get(sessionId);
    const s = this.sessions.get(sessionId);
    const g = GRENADES[s?.throwKind ?? "frag"] ?? GRENADES.frag;
    if (!a || !s || !this.fighting() || s.throws <= 0 || Date.now() - s.lastThrowAt > (g.fuse + 3) * 1000) return;
    const x = num(msg?.x), y = num(msg?.y), z = num(msg?.z);
    if (x === null || y === null || z === null || Math.hypot(x - a.x, z - a.z) > 60) return;
    s.throws--;
    this.broadcast("boom", { id: sessionId, x, y, z }, { except: this.clients.find((c) => c.sessionId === sessionId) });
    const targets: string[] = Array.isArray(msg?.t) ? msg.t.filter((v: unknown) => typeof v === "string").slice(0, ROOM_MAX_CLIENTS) : [];
    const R = g.radius;
    for (const tid of new Set(targets)) {
      const t = this.state.players.get(tid);
      if (!t || t.life === "dead" || !t.team) continue;
      if (tid !== sessionId && t.team === a.team) continue;
      const dist = Math.hypot(t.x - x, t.y + 1 - y, t.z - z);
      if (dist > R + 2) continue;
      const k = Math.pow(1 - Math.min(dist, R) / R, 0.7);
      const dmg = g.damage * k * (tid === sessionId ? 0.5 : 1);
      if (dmg > 0.5) this.applyDamage(tid, dmg, sessionId, { explosive: true, weapon: "frag" });
    }
  }

  // Armour, knock-down and elimination, as the client's combat.js once did it locally.
  private applyDamage(targetId: string, amount: number, attackerId: string | null, opts: { head?: boolean; zone?: boolean; explosive?: boolean; weapon?: string; pierce?: number }) {
    const st = this.state;
    const t = st.players.get(targetId);
    const ts = this.sessions.get(targetId);
    if (!t || !ts || t.life === "dead" || !(amount > 0)) return 0;
    if (!this.fighting()) return 0;
    if (st.clock < t.protectedUntil && !opts.zone) return 0;
    let dmg = amount;
    if (t.operative === "rook" && st.clock < t.ultUntil) dmg *= ROOK_DAMAGE_TAKEN;
    if (t.life === "alive" && !opts.zone) {
      const keep = 1 - clampN(opts.pierce ?? 0, 0, 1); // armour-piercing rounds ignore part of the cut
      if (opts.head && t.helmet > 0) {
        const cut = dmg * HEALTH.helmet[t.helmet] * keep;
        dmg -= cut;
        ts.helmetDur -= cut;
        if (ts.helmetDur <= 0) this.setArmor(t, ts, "helmet", t.helmet - 1);
      } else if (!opts.head && t.vest > 0) {
        const cut = dmg * HEALTH.vest[t.vest] * keep;
        dmg -= cut;
        ts.vestDur -= cut;
        if (ts.vestDur <= 0) this.setArmor(t, ts, "vest", t.vest - 1);
      }
    }
    ts.lastDamageAt = st.clock;
    const a = attackerId ? st.players.get(attackerId) : undefined;
    if (a && attackerId !== targetId) {
      ts.lastHitBy = attackerId!;
      ts.damagers.set(attackerId!, st.clock);
      a.damage += dmg;
      if (opts.head) a.headshots++;
    }
    t.emote = "";
    this.broadcast("dmg", { t: targetId, a: attackerId ?? "", n: Math.round(dmg * 10) / 10, h: !!opts.head, z: !!opts.zone, e: !!opts.explosive });
    if (t.life === "alive") {
      t.hp -= dmg;
      if (t.hp <= 0) {
        t.hp = 0;
        const helpers = [...st.players.entries()].some(([sid, o]) => sid !== targetId && o.team === t.team && o.life === "alive");
        if (helpers && !opts.zone) this.knock(targetId, attackerId, opts);
        else this.eliminate(targetId, attackerId, opts);
      }
    } else if (t.life === "knocked") {
      t.downHp -= dmg;
      if (t.downHp <= 0) this.eliminate(targetId, attackerId, opts);
    }
    return dmg;
  }

  private knock(targetId: string, attackerId: string | null, opts: { head?: boolean; weapon?: string }) {
    const t = this.state.players.get(targetId);
    if (!t) return;
    t.life = "knocked";
    t.downHp = HEALTH.knockedHp;
    t.emote = "";
    const a = attackerId ? this.state.players.get(attackerId) : undefined;
    if (a && attackerId !== targetId) a.knocks++;
    this.broadcast("knock", { t: targetId, a: attackerId ?? "", w: opts.weapon ?? "", h: !!opts.head });
    if (a && attackerId !== targetId && a.team !== t.team && this.state.phase === "playing") {
      this.reward(attackerId!, { k: "knock", t: targetId, gems: GEMS.perKnock, coins: REWARDS.perKnock, rp: 0, h: !!opts.head, s: 0, b: 0 });
    }
    this.checkWipe(t.team);
  }

  private eliminate(targetId: string, attackerId: string | null, opts: { head?: boolean; zone?: boolean; explosive?: boolean; weapon?: string }) {
    const st = this.state;
    const t = st.players.get(targetId);
    const ts = this.sessions.get(targetId);
    if (!t || !ts || t.life === "dead") return;
    t.life = "dead";
    t.hp = 0;
    t.downHp = 0;
    t.deaths++;
    t.deadAt = st.clock;
    t.emote = "";
    ts.streak = 0;
    // The killer: the attacker if an enemy, else whoever last hurt them.
    let killerId = "";
    const a = attackerId ? st.players.get(attackerId) : undefined;
    if (a && attackerId !== targetId && a.team !== t.team) killerId = attackerId!;
    else if (ts.lastHitBy && st.players.get(ts.lastHitBy)?.team !== t.team && st.players.has(ts.lastHitBy)) killerId = ts.lastHitBy;
    let streak = 0;
    const k = killerId ? st.players.get(killerId) : undefined;
    const ks = killerId ? this.sessions.get(killerId) : undefined;
    if (k && ks) {
      k.kills++;
      ks.streak = st.clock - ks.lastElimAt < STREAK_WINDOW ? ks.streak + 1 : 1;
      ks.lastElimAt = st.clock;
      streak = ks.streak;
      for (const [id, at] of ts.damagers) {
        if (id === killerId || st.clock - at > ASSIST_WINDOW) continue;
        const helper = st.players.get(id);
        if (helper && helper.team === k.team) helper.assists++;
      }
    }
    ts.damagers.clear();
    t.killer = killerId;
    if (st.phase === "playing" && t.team) {
      const scorer: Team = k ? (k.team as Team) : t.team === "blue" ? "orange" : "blue";
      st[scorer]++;
      this.broadcast("elim", { t: targetId, k: killerId, w: opts.weapon ?? (opts.zone ? "zone" : opts.explosive ? "frag" : ""), h: !!opts.head, s: streak });
      if (k && ks) {
        const head = !!opts.head && !opts.zone;
        const bonus = GEMS.streak * (Math.min(streak, GEMS.streakCap) - 1);
        const gems = GEMS.perElimination + (head ? GEMS.headshot : 0) + bonus;
        this.reward(killerId, { k: "elim", t: targetId, gems, coins: REWARDS.perElimination, rp: REWARDS.rpPerElim, h: head, s: streak, b: bonus });
      }
      if (st[scorer] >= st.scoreToWin) this.end(scorer);
    } else {
      this.broadcast("elim", { t: targetId, k: killerId, w: opts.weapon ?? "", h: !!opts.head, s: streak });
    }
    this.checkWipe(t.team);
  }

  // A team with nobody standing loses its knocked players.
  private checkWipe(team: string) {
    if (!team) return;
    const members = [...this.state.players.entries()].filter(([, p]) => p.team === team);
    if (members.some(([, p]) => p.life === "alive")) return;
    for (const [sid, p] of members) if (p.life === "knocked") this.eliminate(sid, this.sessions.get(sid)?.lastHitBy || null, {});
  }

  // --- Rewards ------------------------------------------------------------------------------------------
  // A knock or elimination by `sessionId`: Gems go into the profile now (saved with the next
  // persist: round end, leave, disconnect); the coins and rank points shown are what this kill adds
  // to the round's `rewards` (rewardsFor counts kills / knocks). The shooter's popup shows these.
  private reward(sessionId: string, r: { k: "elim" | "knock"; t: string; gems: number; coins: number; rp: number; h: boolean; s: number; b: number }) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.profile.gems = Math.min(GEMS_MAX, s.profile.gems + r.gems);
    s.roundGems += r.gems;
    const client = this.clients.find((c) => c.sessionId === sessionId);
    try {
      client?.send("reward", { ...r, total: s.profile.gems });
    } catch {
      // Gone meanwhile.
    }
  }

  private rewardsFor(sessionId: string, p: PlayerState, mvpId: string | null) {
    const won = p.team === this.state.winner;
    const mvp = mvpId === sessionId;
    const coins = Math.round(p.kills * REWARDS.perElimination + p.knocks * REWARDS.perKnock + p.damage * REWARDS.perDamage + (won ? REWARDS.win : REWARDS.loss) + (mvp ? REWARDS.mvp : 0));
    const rp = (won ? REWARDS.rpWin : REWARDS.rpLoss) + p.kills * REWARDS.rpPerElim;
    // Gems: the kills' share was granted kill by kill (reward); the round's share is granted here.
    const gemsRound = (won ? GEMS.win : GEMS.loss) + (mvp ? GEMS.mvp : 0);
    return {
      won,
      mvp,
      coins,
      rp,
      gems: (this.sessions.get(sessionId)?.roundGems ?? 0) + gemsRound, // everything this round earned
      gemsRound,
      eliminations: p.kills,
      knocks: p.knocks,
      assists: p.assists,
      damage: Math.round(p.damage),
      deaths: p.deaths,
      headshots: p.headshots,
      score: { blue: this.state.blue, orange: this.state.orange },
    };
  }

  // `finished`: the round ran to its results (false = the player left it; play / win missions skip it).
  private grant(sessionId: string, s: Session, r: ReturnType<MatchRoom["rewardsFor"]>, finished: boolean) {
    const pr = s.profile;
    pr.coins += r.coins;
    pr.gems = Math.min(GEMS_MAX, pr.gems + r.gemsRound);
    pr.rp = Math.max(0, pr.rp + r.rp);
    pr.stats.matches++;
    if (r.won) pr.stats.wins++;
    pr.stats.eliminations += r.eliminations;
    pr.stats.deaths += r.deaths;
    pr.stats.damage += Math.round(r.damage);
    pr.stats.best = Math.max(pr.stats.best, r.eliminations);
    // Missions count this round; rank rewards pay any rank reached for the first time.
    refreshMissions(pr.missions);
    const missions = countRound(pr.missions, {
      play: finished ? 1 : 0,
      win: finished && r.won ? 1 : 0,
      elims: r.eliminations,
      knocks: r.knocks,
      damage: r.damage,
      headshots: r.headshots,
      assists: r.assists,
      revives: s.roundRevives,
    });
    const rankUp = payRankUps(pr);
    const pl = this.state.players.get(sessionId);
    if (pl) this.applyPublic(pl, s);
    const client = this.clients.find((c) => c.sessionId === sessionId);
    if (client) {
      client.send("rewards", { ...r, missions, rankUp });
      this.sendProfile(client, s);
    }
    // Leaderboards and stats: verified Bloxity accounts only (docs: report only legion_ identities).
    if (s.identity.verified) {
      const id = reportId(s.identity.userId);
      queueScores(id, { eliminations: r.eliminations, weekly_elims: r.eliminations, best_match: r.eliminations, wins: r.won ? 1 : 0 });
      queueStats(id, { ...pr.stats, coins: pr.coins });
    }
  }

  private finishRound() {
    const st = this.state;
    const round = this.inRound().filter(([sid]) => this.sessions.get(sid)?.playedRound === st.round);
    const sorted = [...round].sort(([, a], [, b]) => b.kills - a.kills || b.damage - a.damage);
    const mvpId = sorted.length && sorted[0][1].kills > 0 ? sorted[0][0] : null;
    for (const [sid, p] of round) {
      const s = this.sessions.get(sid);
      if (!s) continue;
      this.grant(sid, s, this.rewardsFor(sid, p, mvpId), true);
      s.playedRound = -1;
      void this.persist(sid);
    }
    this.setPhase("results", PHASES.results);
    void flushReports();
  }
}
