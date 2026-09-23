// 部屋（合言葉）・メンバー・ホスト・再接続・成績の管理（docs/RULES.md 2章・3章・13章）
import { randomBytes } from "node:crypto";
import { cardLabel, colorName, isWild } from "../shared/cards.js";
import * as E from "../shared/engine.js";
import {
  type ClientMsg,
  type EventView,
  type GameView,
  type LogLine,
  type MatchView,
  type MemberView,
  type RoomView,
  type ServerMsg,
  type StatRow,
  KEY_MAX,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  NAME_MAX,
  STAMPS,
} from "../shared/protocol.js";

export const MAX_ROOMS = 200;
export const HOST_OFFLINE_MS = 20_000;
export const ROOM_EMPTY_MS = 10 * 60_000;
const STAMP_INTERVAL_MS = 1_500;
const LOG_KEEP = 60;

/** 1本の接続 */
export interface Client {
  send(msg: ServerMsg): void;
  token: string | null;
  tokens: number;
  tokensAt: number;
}

interface Member {
  id: string;
  token: string;
  name: string;
  role: "player" | "spectator";
  queued: boolean;
  queuedAt: number;
  joinedAt: number;
  clients: Set<Client>;
  offlineSince: number | null;
  lastStamp: number;
  /** 最後に送った試合記録の版（room.histRev）。違えば次の送信で試合記録を付ける */
  histSent: number;
}

interface MatchRecord {
  no: number;
  at: number;
  /** 場札点 */
  pts: number;
  target: string | null;
  by: string[];
  ret: string | null;
  rows: { id: string; hand: number; score: number; mark: E.Mark; zero: boolean; drew: number; dobon: number; bedobon: number }[];
}

interface Room {
  key: string;
  display: string;
  hostId: string;
  members: Map<string, Member>;
  /** 席やこれまでの成績の表示用（退室した人の名前も残す） */
  names: Map<string, string>;
  /** 成績をまとめる単位。入り直した人の新しいid → 前のid（同じ端末・同じ名前のとき） */
  person: Map<string, string>;
  /** 端末ごとの、この部屋での最後の入室（入り直したときに成績をつなぐため） */
  back: Map<string, { person: string; name: string }>;
  phase: "LOBBY" | "PLAYING" | "RESULT";
  game: E.GameState | null;
  recorded: boolean;
  history: MatchRecord[];
  log: LogLine[];
  events: EventView[];
  dirty: boolean;
  emptySince: number | null;
  gameCount: number;
  /** 試合記録（と、そこに出る名前）が変わるたびに増やす */
  histRev: number;
}

export interface LobbyOptions {
  now?: () => number;
  rng?: () => number;
  build?: string;
}

function cryptoRng(): number {
  return randomBytes(4).readUInt32LE(0) / 4294967296;
}

export function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const k = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (k.length === 0 || [...k].length > KEY_MAX) return null;
  return k;
}

// 制御文字・ゼロ幅文字・書字方向の制御文字
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

export function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // 制御文字を除き、空白をまとめる
  const t = s.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = [...t].slice(0, NAME_MAX).join("");
  return chars || "名無し";
}

/** 同名よけに付けた「(2)」などを外した名前 */
function baseName(name: string): string {
  return name.replace(/\(\d+\)$/, "");
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

export class Lobby {
  readonly rooms = new Map<string, Room>();
  private tokenIndex = new Map<string, { key: string; memberId: string }>();
  private now: () => number;
  private rng: () => number;
  readonly build: string;

  constructor(opts: LobbyOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? cryptoRng;
    this.build = opts.build ?? "dev";
  }

  // ------------------------------------------------------------------ 接続

  disconnect(client: Client) {
    const found = this.findByClient(client);
    if (!found) return;
    const { room, member } = found;
    member.clients.delete(client);
    if (member.clients.size === 0) this.setOnline(room, member, false);
  }

  handle(client: Client, raw: string) {
    // 送りすぎ対策（1秒に10通まで、瞬間20通）
    const t = this.now();
    client.tokens = Math.min(20, client.tokens + ((t - client.tokensAt) / 1000) * 10);
    client.tokensAt = t;
    if (client.tokens < 1) return;
    client.tokens -= 1;

    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") return;

    if (msg.t === "ping") {
      client.send({ t: "pong", c: Number(msg.c) || 0, s: t });
      return;
    }
    if (msg.t === "hello") return this.hello(client, msg);
    if (!client.token) return this.err(client, "接続の準備ができていません。再読み込みしてください");
    if (msg.t === "join") return this.join(client, msg);

    const found = this.findByToken(client.token);
    if (!found) {
      client.send({ t: "out", why: "left" });
      return;
    }
    const { room, member } = found;
    switch (msg.t) {
      case "leave":
        return this.leave(client, room, member);
      case "name":
        return this.rename(room, member, msg.name);
      case "role":
        return this.setRole(client, room, member, !!msg.spectate);
      case "queue":
        return this.setQueue(client, room, member, !!msg.on);
      case "start":
        return this.start(client, room, member);
      case "end":
        return this.end(client, room, member);
      case "next":
        return this.next(client, room, member);
      case "kick":
        return this.kick(client, room, member, String(msg.id));
      case "play":
        return this.gameAction(client, room, member, {
          type: "play",
          cardIds: Array.isArray(msg.ids) ? msg.ids.map(String) : [],
          color: msg.color,
        });
      case "draw":
        return this.gameAction(client, room, member, { type: "draw" });
      case "pass":
        return this.gameAction(client, room, member, { type: "pass" });
      case "dobon":
        return this.gameAction(client, room, member, { type: "dobon" });
      case "ret":
        return this.gameAction(client, room, member, { type: "dobonReturn" });
      case "stamp":
        return this.stamp(room, member, Number(msg.s));
    }
  }

  private err(client: Client, m: string) {
    client.send({ t: "err", m });
  }

  private hello(client: Client, msg: Extract<ClientMsg, { t: "hello" }>) {
    if (typeof msg.token !== "string" || !TOKEN_RE.test(msg.token)) return this.err(client, "不正な接続です");
    // 同じ接続で別の鍵に切り替える場合は前の所属を外す
    if (client.token && client.token !== msg.token) this.disconnect(client);
    client.token = msg.token;
    const found = this.findByToken(msg.token);
    client.send({ t: "hello", you: found?.member.id ?? null, now: this.now(), build: this.build });
    if (found) this.attach(client, found.room, found.member);
  }

  private attach(client: Client, room: Room, member: Member) {
    member.clients.add(client);
    if (member.clients.size === 1) this.setOnline(room, member, true);
    // つないだ直後は試合記録も必ず付ける
    const s = this.view(room, member, this.stats(room));
    s.matches = this.matches(room);
    member.histSent = room.histRev;
    client.send({ t: "state", s, ev: [] });
  }

  private setOnline(room: Room, member: Member, online: boolean) {
    const t = this.now();
    member.offlineSince = online ? null : t;
    if (online) room.emptySince = null;
    else if (![...room.members.values()].some((m) => m.clients.size > 0)) room.emptySince ??= t;
    const g = room.game;
    if (g && room.phase === "PLAYING" && g.seats.includes(member.id)) {
      E.onConnectionChange(g, member.id, online, this.ctx(room));
    }
    room.dirty = true;
  }

  // ------------------------------------------------------------------ 入退室

  private join(client: Client, msg: Extract<ClientMsg, { t: "join" }>) {
    const token = client.token!;
    const key = normalizeKey(msg.key);
    if (!key) return this.err(client, `合言葉は1〜${KEY_MAX}文字で入力してください`);
    const current = this.findByToken(token);
    if (current) {
      if (current.room.key === key) return this.attach(client, current.room, current.member);
      if (!this.canLeave(current.room, current.member)) return this.err(client, "ゲーム中は別の部屋に移れません");
      this.removeMember(current.room, current.member, "left");
    }
    let room = this.rooms.get(key);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) return this.err(client, "部屋が多すぎます。しばらくしてから試してください");
      room = this.createRoom(key, String(msg.key).normalize("NFKC").trim());
    }
    const members = [...room.members.values()];
    const players = members.filter((m) => m.role === "player").length;
    const spectators = members.length - players;
    let role: Member["role"] = msg.spectate || room.phase !== "LOBBY" ? "spectator" : "player";
    let queued = false;
    if (role === "player" && players >= MAX_PLAYERS) {
      role = "spectator";
      queued = true;
    }
    if (role === "spectator" && spectators >= MAX_SPECTATORS) return this.err(client, "この部屋は満員です");
    const t = this.now();
    const name = cleanName(msg.name);
    const member: Member = {
      id: randomBytes(5).toString("hex"),
      token,
      name: this.uniqueName(room, name, null),
      role,
      queued,
      queuedAt: t,
      joinedAt: t,
      clients: new Set(),
      offlineSince: null,
      lastStamp: 0,
      histSent: -1,
    };
    room.members.set(member.id, member);
    room.names.set(member.id, member.name);
    // 退室・キックのあと同じ端末・同じ名前で入り直したら、成績を続きから数える
    const prev = room.back.get(token);
    const person = prev && baseName(prev.name) === baseName(name) ? prev.person : member.id;
    if (person !== member.id) room.person.set(member.id, person);
    room.back.set(token, { person, name: member.name });
    this.tokenIndex.set(token, { key: room.key, memberId: member.id });
    room.histRev++;
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = member.id;
    room.emptySince = null;
    this.addLog(room, `${member.name}が入室しました${role === "spectator" ? "（観戦）" : ""}`);
    room.dirty = true;
    client.send({ t: "hello", you: member.id, now: t, build: this.build });
    this.attach(client, room, member);
  }

  private createRoom(key: string, display: string): Room {
    const room: Room = {
      key,
      display: [...display].slice(0, KEY_MAX).join(""),
      hostId: "",
      members: new Map(),
      names: new Map(),
      person: new Map(),
      back: new Map(),
      phase: "LOBBY",
      game: null,
      recorded: false,
      history: [],
      log: [],
      events: [],
      dirty: true,
      emptySince: null,
      gameCount: 0,
      histRev: 0,
    };
    this.rooms.set(key, room);
    return room;
  }

  private uniqueName(room: Room, base: string, selfId: string | null): string {
    const taken = new Set([...room.members.values()].filter((m) => m.id !== selfId).map((m) => m.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const suffix = `(${i})`;
      const cand = [...base].slice(0, NAME_MAX - suffix.length).join("") + suffix;
      if (!taken.has(cand)) return cand;
    }
  }

  private canLeave(room: Room, member: Member): boolean {
    return !(room.phase === "PLAYING" && room.game?.seats.includes(member.id));
  }

  private leave(client: Client, room: Room, member: Member) {
    if (!this.canLeave(room, member)) return this.err(client, "ゲーム中は退室できません");
    this.removeMember(room, member, "left");
  }

  private removeMember(room: Room, member: Member, why: "left" | "kicked") {
    room.members.delete(member.id);
    room.histRev++;
    this.tokenIndex.delete(member.token);
    for (const c of member.clients) c.send({ t: "out", why });
    member.clients.clear();
    this.addLog(room, why === "kicked" ? `${member.name}がキックされました` : `${member.name}が退室しました`);
    const g = room.game;
    const seatedNow = !!g && g.seats.includes(member.id);
    if (g && room.phase === "PLAYING" && seatedNow) {
      // 席はゲーム終了まで残す（切断中と同じ扱い）。本人は入り直せるが、観戦として入る
      E.onConnectionChange(g, member.id, false, this.ctx(room));
    }
    if (!seatedNow) this.forget(room, member);
    if (room.hostId === member.id) this.transferHost(room, true);
    if (room.members.size === 0) this.deleteRoom(room);
    else room.dirty = true;
  }

  /** 成績にも席にも出てこない人の情報を消す（入退室をくり返しても部屋の中身が増え続けないように） */
  private forget(room: Room, member: Member) {
    const person = this.personOf(room, member.id);
    const rows = room.history.flatMap((rec) => rec.rows);
    if (!rows.some((r) => r.id === member.id)) {
      room.names.delete(member.id);
      room.person.delete(member.id);
    }
    const seated = room.game?.seats.some((id) => this.personOf(room, id) === person) ?? false;
    const recorded = rows.some((r) => this.personOf(room, r.id) === person);
    if (!seated && !recorded && room.back.get(member.token)?.person === person) room.back.delete(member.token);
  }

  private deleteRoom(room: Room) {
    for (const m of room.members.values()) this.tokenIndex.delete(m.token);
    this.rooms.delete(room.key);
  }

  private rename(room: Room, member: Member, raw: unknown) {
    const name = this.uniqueName(room, cleanName(raw), member.id);
    if (name === member.name) return;
    this.addLog(room, `${member.name}が名前を${name}に変えました`);
    member.name = name;
    room.names.set(member.id, name);
    room.histRev++;
    const b = room.back.get(member.token);
    if (b) b.name = name;
    room.dirty = true;
  }

  private setRole(client: Client, room: Room, member: Member, spectate: boolean) {
    if (room.phase !== "LOBBY") return this.err(client, "ロビーでだけ変更できます");
    if (spectate) {
      member.role = "spectator";
      member.queued = false;
    } else {
      const players = [...room.members.values()].filter((m) => m.role === "player").length;
      if (member.role !== "player" && players >= MAX_PLAYERS) return this.err(client, "参加者は10人までです");
      member.role = "player";
      member.queued = false;
    }
    room.dirty = true;
  }

  private setQueue(client: Client, room: Room, member: Member, on: boolean) {
    if (member.role !== "spectator") return this.err(client, "観戦者だけが予約できます");
    member.queued = on;
    member.queuedAt = this.now();
    room.dirty = true;
  }

  private isHost(room: Room, member: Member) {
    return room.hostId === member.id;
  }

  /**
   * ホストの移譲。force はホストが部屋からいなくなったとき。
   * 切断が20秒続いたときは、接続中の人がいる場合だけ移す（全員切断中なら今のまま）
   */
  private transferHost(room: Room, force: boolean) {
    const cur = room.members.get(room.hostId);
    if (!force && cur && (cur.clients.size > 0 || this.now() - (cur.offlineSince ?? 0) < HOST_OFFLINE_MS)) return;
    const others = [...room.members.values()].filter((m) => m.id !== room.hostId);
    const online = others.filter((m) => m.clients.size > 0);
    const pool = online.length ? online : force ? others : [];
    pool.sort((a, b) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === "player" ? -1 : 1));
    const next = pool[0];
    if (!next) return;
    room.hostId = next.id;
    this.addLog(room, `ホストが${next.name}に移りました`);
    room.dirty = true;
  }

  private kick(client: Client, room: Room, member: Member, targetId: string) {
    if (!this.isHost(room, member)) return this.err(client, "キックはホストだけができます");
    const target = room.members.get(targetId);
    if (!target) return;
    if (target.id === member.id) return this.err(client, "自分はキックできません");
    // 入室禁止にはしない。合言葉を入れ直せば戻れる（ゲーム中なら観戦として）
    this.removeMember(room, target, "kicked");
  }

  // ------------------------------------------------------------------ ゲームの開始・終了

  private ctx(room: Room): E.Ctx {
    return {
      now: this.now(),
      rng: this.rng,
      timeoutFor: (id) => {
        const m = room.members.get(id);
        return m && m.clients.size > 0 ? E.TURN_MS : E.OFFLINE_TURN_MS;
      },
    };
  }

  private start(client: Client, room: Room, member: Member) {
    if (!this.isHost(room, member)) return this.err(client, "STARTはホストだけができます");
    if (room.phase !== "LOBBY") return;
    const members = [...room.members.values()];
    // 切断中の参加者は観戦（次ゲーム予約つき）に回す
    for (const m of members) {
      if (m.role === "player" && m.clients.size === 0) {
        m.role = "spectator";
        m.queued = true;
        m.queuedAt = this.now();
      }
    }
    // 予約した観戦者を予約順に参加者へ
    let players = members.filter((m) => m.role === "player").length;
    const queued = members.filter((m) => m.role === "spectator" && m.queued && m.clients.size > 0).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const m of queued) {
      if (players >= MAX_PLAYERS) break;
      m.role = "player";
      m.queued = false;
      players++;
    }
    const ids = members.filter((m) => m.role === "player").sort((a, b) => a.joinedAt - b.joinedAt).map((m) => m.id);
    if (ids.length < 2) {
      room.dirty = true;
      return this.err(client, "参加者が2人以上必要です");
    }
    for (const id of ids) room.names.set(id, room.members.get(id)!.name);
    const { game, events } = E.createGame(ids, room.gameCount + 1, this.ctx(room));
    room.gameCount += 1;
    room.game = game;
    room.phase = "PLAYING";
    room.recorded = false;
    this.pushEvents(room, events);
  }

  private end(client: Client, room: Room, member: Member) {
    if (!this.isHost(room, member)) return this.err(client, "END GAMEはホストだけができます");
    if (room.phase !== "PLAYING") return;
    this.toLobby(room);
    this.addLog(room, "ホストがゲームを中断しました（記録なし）");
  }

  private next(client: Client, room: Room, member: Member) {
    const g = room.game;
    if (room.phase !== "RESULT" || !g?.result) return;
    if (!g.result.final) return this.err(client, "結果の確定を待ってください");
    if (!g.seats.includes(member.id) && !this.isHost(room, member)) return this.err(client, "参加者だけが次へ進めます");
    this.toLobby(room);
  }

  private toLobby(room: Room) {
    room.phase = "LOBBY";
    room.game = null;
    room.dirty = true;
  }

  // ------------------------------------------------------------------ ゲーム中の操作

  private gameAction(client: Client, room: Room, member: Member, action: E.Action) {
    const g = room.game;
    if (!g || room.phase === "LOBBY") return this.err(client, "ゲーム中ではありません");
    if (!g.seats.includes(member.id)) return this.err(client, "観戦中は操作できません");
    const r = E.act(g, member.id, action, this.ctx(room));
    if (!r.ok) return this.err(client, r.error);
    this.pushEvents(room, r.events);
  }

  private stamp(room: Room, member: Member, s: number) {
    if (!Number.isInteger(s) || s < 0 || s >= STAMPS.length) return;
    const t = this.now();
    if (t - member.lastStamp < STAMP_INTERVAL_MS) return;
    member.lastStamp = t;
    room.events.push({ e: "stamp", by: member.id, s });
    room.dirty = true;
  }

  private pushEvents(room: Room, events: EventView[]) {
    for (const ev of events) {
      room.events.push(ev);
      const line = this.describe(room, ev);
      if (line) this.addLog(room, line);
    }
    const g = room.game;
    if (g?.result && room.phase === "PLAYING") room.phase = "RESULT";
    if (g?.result?.final && !room.recorded) this.record(room);
    room.dirty = true;
  }

  private record(room: Room) {
    const g = room.game!;
    const r = g.result!;
    room.recorded = true;
    room.history.push({
      no: g.gameNo,
      at: this.now(),
      pts: r.tablePoints,
      target: r.targetId,
      by: r.dobonBy.slice(),
      ret: r.returnBy,
      rows: r.scores.map((s) => ({
        id: s.id,
        hand: s.handPoints,
        score: s.finalScore,
        mark: s.mark,
        zero: s.zero,
        drew: r.drew?.id === s.id ? r.drew.n : 0,
        dobon: s.dobonCount,
        bedobon: s.bedobonCount,
      })),
    });
    room.histRev++;
  }

  // ------------------------------------------------------------------ 時間の処理

  tick() {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      const g = room.game;
      if (g && room.phase !== "LOBBY") {
        const events = E.tick(g, this.ctx(room));
        if (events.length) this.pushEvents(room, events);
      }
      this.transferHost(room, !room.members.has(room.hostId));
      const anyOnline = [...room.members.values()].some((m) => m.clients.size > 0);
      if (anyOnline) room.emptySince = null;
      else {
        room.emptySince ??= t;
        if (t - room.emptySince > ROOM_EMPTY_MS) {
          this.deleteRoom(room);
          continue;
        }
      }
      if (room.dirty) this.flush(room);
    }
  }

  /** 状態が変わった部屋に、各メンバー向けの表示データを送る */
  flushAll() {
    for (const room of this.rooms.values()) if (room.dirty) this.flush(room);
  }

  private flush(room: Room) {
    const stats = this.stats(room);
    const ev = room.events;
    room.events = [];
    room.dirty = false;
    let matches: MatchView[] | null = null;
    for (const m of room.members.values()) {
      if (m.clients.size === 0) continue;
      const s = this.view(room, m, stats);
      if (m.histSent !== room.histRev) {
        // 試合記録は変わったときだけ送る（毎回送ると重いので）
        matches ??= this.matches(room);
        s.matches = matches;
        m.histSent = room.histRev;
      }
      const msg: ServerMsg = { t: "state", s, ev };
      for (const c of m.clients) c.send(msg);
    }
  }

  // ------------------------------------------------------------------ 表示データ

  private nameOf(room: Room, id: string | null): string {
    if (!id) return "";
    return room.members.get(id)?.name ?? room.names.get(id) ?? "?";
  }

  private view(room: Room, m: Member, stats: StatRow[]): RoomView {
    const members: MemberView[] = [...room.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((x) => ({ id: x.id, name: x.name, role: x.role, online: x.clients.size > 0, queued: x.queued }));
    return {
      key: room.display,
      phase: room.phase,
      host: room.hostId,
      you: m.id,
      role: m.role,
      members,
      game: room.game ? this.gameView(room, room.game, m) : null,
      stats,
      games: room.history.length,
      log: room.log.slice(-30),
    };
  }

  private gameView(room: Room, g: E.GameState, m: Member): GameView {
    const top = E.topCard(g);
    const seated = g.seats.includes(m.id);
    const r = g.result;
    return {
      no: g.gameNo,
      seats: g.seats.map((id) => {
        const mem = room.members.get(id);
        return { id, name: this.nameOf(room, id), count: g.hands[id].length, online: !!mem && mem.clients.size > 0, gone: !mem };
      }),
      turn: g.turn,
      dir: g.direction,
      stack: g.lastPlay.cards,
      lastBy: g.lastPlay.by,
      cutin: g.lastPlay.cutin,
      tablePts: g.lastPlay.points,
      color: isWild(top) ? g.activeColor : top.color,
      pending: g.pendingDraw,
      drew: g.drewThisTurn,
      started: g.turnStartedAt,
      deadline: g.turnDeadline,
      window: g.windowOpen,
      canDobon: seated && E.dobonButtonOpen(g, m.id, this.now()),
      deck: g.deck.length,
      hand: seated ? g.hands[m.id] : null,
      result: r
        ? {
            target: r.targetId,
            by: r.dobonBy,
            ret: r.returnBy,
            pts: r.tablePoints,
            deadline: r.deadline,
            final: r.final,
            rows: r.scores.map((s) => ({
              id: s.id,
              name: this.nameOf(room, s.id),
              hand: s.handPoints,
              score: s.finalScore,
              mark: s.mark,
              zero: s.zero,
              drew: r.drew?.id === s.id ? r.drew.n : 0,
            })),
          }
        : null,
    };
  }

  private personOf(room: Room, id: string): string {
    return room.person.get(id) ?? id;
  }

  /** 人（入り直しても同じ）→ 今いるメンバーの id */
  private currentIds(room: Room): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of room.members.values()) out.set(this.personOf(room, m.id), m.id);
    return out;
  }

  /** 試合別の成績（新しい順）。今いる人は今の id と名前で出す */
  private matches(room: Room): MatchView[] {
    const cur = this.currentIds(room);
    const idOf = (id: string) => cur.get(this.personOf(room, id)) ?? id;
    const opt = (id: string | null) => (id ? idOf(id) : null);
    return room.history
      .map((rec) => ({
        no: rec.no,
        at: rec.at,
        pts: rec.pts,
        target: opt(rec.target),
        by: rec.by.map(idOf),
        ret: opt(rec.ret),
        rows: rec.rows.map((x) => {
          const id = idOf(x.id);
          return { id, name: this.nameOf(room, id), hand: x.hand, score: x.score, mark: x.mark, zero: x.zero, drew: x.drew };
        }),
      }))
      .reverse();
  }

  /** 成績。入り直した人（同じ端末・同じ名前）は1行にまとめ、いまの名前で出す */
  private stats(room: Room): StatRow[] {
    const acc = new Map<string, StatRow>();
    for (const rec of room.history) {
      for (const r of rec.rows) {
        const p = this.personOf(room, r.id);
        let s = acc.get(p);
        if (!s) {
          s = { id: r.id, name: "", games: 0, total: 0, max: 0, dobon: 0, bedobon: 0 };
          acc.set(p, s);
        }
        s.id = r.id;
        s.games += 1;
        s.total += r.score;
        s.max = Math.max(s.max, r.score);
        s.dobon += r.dobon;
        s.bedobon += r.bedobon;
      }
    }
    for (const m of room.members.values()) {
      const s = acc.get(this.personOf(room, m.id));
      if (s) s.id = m.id;
    }
    for (const s of acc.values()) s.name = this.nameOf(room, s.id);
    return [...acc.values()].sort((a, b) => a.total / a.games - b.total / b.games);
  }

  private addLog(room: Room, m: string) {
    room.log.push({ t: this.now(), m });
    if (room.log.length > LOG_KEEP) room.log.splice(0, room.log.length - LOG_KEEP);
  }

  private describe(room: Room, ev: EventView): string | null {
    const n = (id: string | null) => this.nameOf(room, id);
    switch (ev.e) {
      case "start":
        return `ゲーム${room.game?.gameNo ?? ""}開始。初期場札は${cardLabel(ev.card)}（最初は${n(ev.first)}）`;
      case "play":
        return `${ev.cutin ? "【カットイン】" : ""}${n(ev.by)}が${ev.cards.map(cardLabel).join("・")}を出した${ev.color ? `（${colorName(ev.color)}）` : ""}`;
      case "draw":
        switch (ev.why) {
          case "normal":
            return `${n(ev.by)}が1枚引いた`;
          case "pending":
            return `${n(ev.by)}が累積${ev.n}枚を引いた`;
          case "timeout":
            return `${n(ev.by)}が時間切れで${ev.n}枚引いた`;
          case "refill":
            return `${n(ev.by)}は手札0枚になり${ev.n}枚補充`;
          case "dobon":
            return `${n(ev.by)}が累積${ev.n}枚を引いた（ドボン成立のため）`;
        }
        return null;
      case "pass":
        return ev.timeout ? `${n(ev.by)}が時間切れでパス` : `${n(ev.by)}がパス`;
      case "uno":
        return `${n(ev.by)}：UNO!`;
      case "reshuffle":
        return ev.added ? "山札が尽きたので新しい108枚を追加" : "捨て札を切り直して山札に戻した";
      case "dobon":
        if (ev.n === 1) return `${n(ev.by)}がドボン！${ev.target ? `（${n(ev.target)}へ）` : "（初期場札）"}`;
        return `${n(ev.by)}も追加ドボン！（${ev.n}人）`;
      case "ret":
        return `${n(ev.by)}がドボン返し！`;
      case "final":
        return "結果確定";
      case "sys":
        return ev.m;
      case "stamp":
        return null;
    }
  }

  // ------------------------------------------------------------------ 検索

  private findByToken(token: string): { room: Room; member: Member } | null {
    const idx = this.tokenIndex.get(token);
    if (!idx) return null;
    const room = this.rooms.get(idx.key);
    const member = room?.members.get(idx.memberId);
    if (!room || !member) {
      this.tokenIndex.delete(token);
      return null;
    }
    return { room, member };
  }

  private findByClient(client: Client) {
    if (!client.token) return null;
    const f = this.findByToken(client.token);
    if (!f || !f.member.clients.has(client)) return null;
    return f;
  }
}
