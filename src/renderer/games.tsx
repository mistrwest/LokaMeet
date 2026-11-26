import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import {
  FLEET,
  applyCheckers,
  applyChess,
  applySeaReady,
  applySeaResult,
  canPlace,
  checkersMoves,
  checkersStart,
  chessStart,
  cpuCheckers,
  cpuChess,
  cpuSeaShot,
  type Skill,
  legalChess,
  randomFleet,
  seaStart,
  shipCells,
  shootResult,
  type CheckersMove,
  type CheckersState,
  type ChessMove,
  type ChessState,
  type SeaPublic,
  type Ship,
  type Side,
} from "./game-logic";
import { playCue } from "./sound";
import type { Key } from "./i18n";
import type { GameId, GameWire, PeerInfo, RoomInfo, Settings, Snapshot } from "../shared/types";

type Mode = "cpu" | "p2p" | "group";
type Seat = Side | "s";

interface Invite {
  matchId: string;
  game: GameId;
  mode: "p2p" | "group";
  from: string;
  fromName: string;
}

interface Match {
  id: string;
  game: GameId;
  mode: Mode;
  role: "host" | "guest";
  white: string;
  black: string;
  whiteName: string;
  blackName: string;
  me: Seat;
  roster: string[];
  seq: number;
  chess: ChessState | null;
  checkers: CheckersState | null;
  sea: SeaPublic | null;
  ships: Ship[] | null;
  cpuShips: Ship[] | null;
  thinking: boolean;
  left: boolean;
  banner: "" | "left" | "sunk" | "hit" | "miss" | "joined";
  drawFrom: string;
  resignFrom: string;
  horizontal: boolean;
}

interface Snap {
  match: Match | null;
  invite: Invite | null;
}

type T = (key: Key) => string;

class Table {
  private snap: Snap = { match: null, invite: null };
  private listeners = new Set<() => void>();
  private selfId = "";
  private selfName = "";
  private bound = false;
  private skill: Skill = "normal";
  private inviteOn = true;
  private inviteTone = "default";
  private inviteVolume = 0.7;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): Snap => this.snap;

  setSkill(skill: Skill): void {
    this.skill = skill;
  }

  setInvite(settings: Settings): void {
    this.inviteOn = settings.gameInviteSound !== false;
    this.inviteTone = settings.toneJoin || "default";
    this.inviteVolume = settings.gameInviteVolume ?? settings.volumeJoin ?? 0.7;
  }

  setSelf(id: string, name: string): void {
    this.selfId = id;
    this.selfName = name;
    const match = this.snap.match;
    if (!match) return;
    const whiteName = match.white === id ? name : match.whiteName;
    const blackName = match.black === id ? name : match.blackName;
    if (whiteName !== match.whiteName || blackName !== match.blackName) this.commit({ ...match, whiteName, blackName });
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;
    api.on((event) => {
      if (event?.t !== "signal" || event.payload?.t !== "game") return;
      this.onWire(String(event.peerId || ""), event.payload.game as GameWire);
    });
  }

  startCpu(game: GameId, cpuName: string): void {
    const match = this.fresh(game, "cpu", "host");
    match.black = "cpu";
    match.blackName = cpuName;
    if (game === "sea") match.cpuShips = randomFleet();
    this.commit(match, null);
  }

  startPeople(game: GameId, mode: "p2p" | "group", peerIds: string[]): void {
    const roster = [...new Set(peerIds.filter((id) => id && id !== this.selfId))];
    if (!roster.length) return;
    const match = this.fresh(game, mode, "host");
    match.roster = roster;
    this.commit(match, null);
    const invite: GameWire = { t: "invite", matchId: match.id, game, mode, fromName: this.selfName || "LokaMeet" };
    for (const peerId of roster) void this.send(peerId, invite);
  }

  accept(): void {
    const invite = this.snap.invite;
    if (!invite) return;
    const match = this.fresh(invite.game, invite.mode, "guest");
    match.id = invite.matchId;
    match.white = invite.from;
    match.whiteName = invite.fromName;
    match.black = this.selfId;
    match.blackName = this.selfName || "LokaMeet";
    match.me = "b";
    match.roster = [invite.from];
    this.commit(match, null);
    void this.send(invite.from, { t: "accept", matchId: invite.matchId, name: this.selfName || "LokaMeet" });
  }

  decline(): void {
    const invite = this.snap.invite;
    if (!invite) return;
    void this.send(invite.from, { t: "decline", matchId: invite.matchId });
    this.commit(this.snap.match, null);
  }

  leave(): void {
    const match = this.snap.match;
    if (match && match.mode !== "cpu") void this.tell(match, { t: "leave", matchId: match.id });
    this.commit(null);
  }

  resign(): void {
    const match = this.snap.match;
    if (!match || match.me === "s" || this.finished(match)) return;
    if (match.mode === "cpu") {
      const winner: "w" | "b" = match.me === "b" ? "w" : "b";
      this.commit(this.withWinner(match, winner));
      return;
    }
    if (match.resignFrom || match.drawFrom) return;
    const next = { ...match, resignFrom: this.selfId };
    this.commit(next);
    void this.tell(next, { t: "resign-offer", matchId: next.id });
  }

  answerResign(accept: boolean): void {
    const match = this.snap.match;
    if (!match || !match.resignFrom || match.resignFrom === this.selfId) return;
    const winner: "w" | "b" = match.resignFrom === match.white ? "b" : "w";
    const next = accept ? this.withWinner(match, winner) : { ...match, resignFrom: "" };
    this.commit(next);
    void this.tell(next, { t: "resign-answer", matchId: next.id, accept });
  }

  offerDraw(): void {
    const match = this.snap.match;
    if (!match || match.mode === "cpu" || match.me === "s" || this.finished(match) || match.drawFrom) return;
    const next = { ...match, drawFrom: this.selfId };
    this.commit(next);
    void this.tell(next, { t: "draw-offer", matchId: next.id });
  }

  answerDraw(accept: boolean): void {
    const match = this.snap.match;
    if (!match || !match.drawFrom || match.drawFrom === this.selfId) return;
    const next = accept ? this.withWinner(match, "draw") : { ...match, drawFrom: "" };
    this.commit(next);
    void this.tell(next, { t: "draw-answer", matchId: next.id, accept });
  }

  private finished(match: Match): boolean {
    return Boolean(match.chess?.winner || match.checkers?.winner || match.sea?.winner);
  }

  private withWinner(match: Match, winner: "w" | "b" | "draw"): Match {
    return {
      ...match,
      drawFrom: "",
      resignFrom: "",
      banner: "",
      chess: match.chess ? { ...match.chess, winner: winner === "draw" ? "draw" : winner } : match.chess,
      checkers: match.checkers ? { ...match.checkers, winner: winner === "draw" ? "draw" : winner } : match.checkers,
      sea: match.sea && winner !== "draw" ? { ...match.sea, phase: "done", winner } : match.sea,
    };
  }

  playChess(move: ChessMove): void {
    const match = this.snap.match;
    if (!match?.chess || !this.myTurn(match)) return;
    if (!legalChess(match.chess).some((item) => item.from === move.from && item.to === move.to)) return;
    const chess = applyChess(match.chess, move);
    const next = { ...match, chess, seq: match.seq + 1, banner: "" as const };
    this.commit(next);
    if (next.mode === "cpu") this.think(next);
    else void this.tell(next, { t: "move", matchId: next.id, seq: next.seq, by: this.selfId, chess: move });
  }

  playCheckers(move: CheckersMove): void {
    const match = this.snap.match;
    if (!match?.checkers || !this.myTurn(match)) return;
    const legal = checkersMoves(match.checkers).some((item) => item.from === move.from && item.path.join() === move.path.join());
    if (!legal) return;
    const checkers = applyCheckers(match.checkers, move);
    const next = { ...match, checkers, seq: match.seq + 1, banner: "" as const };
    this.commit(next);
    if (next.mode === "cpu") this.think(next);
    else void this.tell(next, { t: "move", matchId: next.id, seq: next.seq, by: this.selfId, checkers: move });
  }

  setHorizontal(horizontal: boolean): void {
    const match = this.snap.match;
    if (match) this.commit({ ...match, horizontal });
  }

  placeShip(x: number, y: number): void {
    const match = this.snap.match;
    if (!match?.sea || !match.ships || !this.placing(match)) return;
    const len = FLEET[match.ships.length];
    if (!len) return;
    const cells = shipCells(x, y, len, match.horizontal);
    if (!cells || !canPlace(match.ships, cells)) return;
    this.commit({ ...match, ships: [...match.ships, { cells }] });
  }

  undoShip(): void {
    const match = this.snap.match;
    if (!match?.ships?.length || !this.placing(match)) return;
    this.commit({ ...match, ships: match.ships.slice(0, -1) });
  }

  autoShips(): void {
    const match = this.snap.match;
    if (!match || !this.placing(match)) return;
    this.commit({ ...match, ships: randomFleet() });
  }

  ready(): void {
    const match = this.snap.match;
    if (!match?.sea || match.me === "s" || !match.ships || match.ships.length !== FLEET.length) return;
    const seat: Side = match.me === "b" ? "b" : "w";
    if (match.sea.ready[seat]) return;
    if (match.mode === "cpu") {
      const sea = applySeaReady(applySeaReady(match.sea, "w"), "b");
      this.commit({ ...match, sea: { ...sea, phase: "battle" } });
      return;
    }
    const sea = applySeaReady(match.sea, seat);
    const next = { ...match, sea };
    this.commit(next);
    void this.tell(next, { t: "sea", matchId: next.id, seq: next.seq, kind: "ready", seat });
  }

  shoot(index: number): void {
    const match = this.snap.match;
    if (!match?.sea || !this.myTurn(match)) return;
    const seat: Side = match.me === "b" ? "b" : "w";
    if (match.sea.shots[seat][index]) return;
    if (match.mode === "cpu") {
      this.shootCpu(match, index);
      return;
    }
    void this.tell(match, { t: "sea", matchId: match.id, seq: match.seq, kind: "shot", seat, index });
  }

  myTurn(match: Match | null): boolean {
    if (!match || match.left || match.thinking) return false;
    if (match.mode !== "cpu" && !match.black) return false;
    if (match.me !== "w" && match.me !== "b") return false;
    if (match.chess) return !match.chess.winner && match.chess.turn === match.me;
    if (match.checkers) return !match.checkers.winner && match.checkers.turn === match.me;
    if (match.sea) return match.sea.phase === "battle" && !match.sea.winner && match.sea.turn === match.me;
    return false;
  }

  private placing(match: Match): boolean {
    if (!match.sea || match.me === "s" || match.sea.phase !== "place") return false;
    const seat: Side = match.me === "b" ? "b" : "w";
    return !match.sea.ready[seat];
  }

  private fresh(game: GameId, mode: Mode, role: "host" | "guest"): Match {
    return {
      id: crypto.randomUUID(),
      game,
      mode,
      role,
      white: this.selfId,
      black: "",
      whiteName: this.selfName || "LokaMeet",
      blackName: "",
      me: "w",
      roster: [],
      seq: 0,
      chess: game === "chess" ? chessStart() : null,
      checkers: game === "checkers" ? checkersStart() : null,
      sea: game === "sea" ? seaStart() : null,
      ships: game === "sea" ? [] : null,
      cpuShips: null,
      thinking: false,
      left: false,
      banner: "",
      drawFrom: "",
      resignFrom: "",
      horizontal: true,
    };
  }

  private commit(match: Match | null, invite: Invite | null = this.snap.invite): void {
    this.snap = { match, invite };
    this.listeners.forEach((listener) => listener());
  }

  private async send(peerId: string, game: GameWire): Promise<void> {
    if (!peerId || peerId === this.selfId || peerId === "cpu") return;
    await api.invoke("signal", { peerId, payload: { t: "game", game } });
  }

  private async fan(match: Match, game: GameWire): Promise<void> {
    for (const peerId of match.roster) await this.send(peerId, game);
  }

  private async tell(match: Match, game: GameWire): Promise<void> {
    if (match.role === "guest") {
      await this.send(match.white, game);
      return;
    }
    await this.fan(match, game);
  }

  private think(match: Match): void {
    const id = match.id;
    const seq = match.seq;
    this.commit({ ...match, thinking: true });
    const pause = this.skill === "easy" ? 720 : this.skill === "hard" ? 260 : 460;
    window.setTimeout(() => {
      const current = this.snap.match;
      if (!current || current.id !== id || current.seq !== seq) return;
      if (current.chess && current.chess.turn === "b" && !current.chess.winner) {
        const move = cpuChess(current.chess, this.skill);
        this.commit({ ...current, thinking: false, seq: current.seq + 1, chess: move ? applyChess(current.chess, move) : current.chess });
        return;
      }
      if (current.checkers && current.checkers.turn === "b" && !current.checkers.winner) {
        const move = cpuCheckers(current.checkers, this.skill);
        this.commit({ ...current, thinking: false, seq: current.seq + 1, checkers: move ? applyCheckers(current.checkers, move) : current.checkers });
        return;
      }
      this.commit({ ...current, thinking: false });
    }, pause);
  }

  private shootCpu(match: Match, index: number): void {
    if (!match.sea || !match.cpuShips || !match.ships) return;
    const prior = new Set<number>();
    match.sea.shots.w.forEach((value, cell) => { if (value) prior.add(cell); });
    const result = shootResult(match.cpuShips, prior, index);
    let sea = applySeaResult(match.sea, "w", index, result.hit, result.win);
    let banner: Match["banner"] = result.sunk ? "sunk" : result.hit ? "hit" : "miss";
    if (!result.win) {
      const reply = cpuSeaShot(sea.shots.b, this.skill);
      const theirs = new Set<number>();
      sea.shots.b.forEach((value, cell) => { if (value) theirs.add(cell); });
      const back = shootResult(match.ships, theirs, reply);
      sea = applySeaResult(sea, "b", reply, back.hit, back.win);
      banner = back.sunk ? "sunk" : back.hit ? "hit" : "miss";
    }
    this.commit({ ...match, sea, banner, seq: match.seq + 1 });
  }

  private onWire(peerId: string, game: GameWire): void {
    if (game.t === "invite") {
      if (this.snap.match) {
        void this.send(peerId, { t: "decline", matchId: game.matchId });
        return;
      }
      this.commit(null, { matchId: game.matchId, game: game.game, mode: game.mode, from: peerId, fromName: game.fromName });
      if (this.inviteOn) playCue("join", { toneJoin: this.inviteTone, volumeJoin: this.inviteVolume } as Settings);
      return;
    }
    if (game.t === "decline") return;
    if (game.t === "accept") {
      const match = this.snap.match;
      if (!match || match.role !== "host" || match.id !== game.matchId) return;
      if (match.mode === "p2p" && match.black && match.black !== peerId) {
        void this.send(peerId, { t: "decline", matchId: match.id });
        return;
      }
      const roster = match.roster.includes(peerId) ? match.roster : [...match.roster, peerId];
      const next: Match = match.black ? { ...match, roster } : { ...match, roster, black: peerId, blackName: game.name || peerId.slice(0, 4) };
      this.commit({ ...next, banner: "joined" });
      if (this.inviteOn) playCue("join", { toneJoin: this.inviteTone, volumeJoin: this.inviteVolume } as Settings);
      void this.send(peerId, this.syncOf({ ...next, banner: "joined" }, peerId));
      return;
    }
    if (game.t === "sync") {
      if (game.white === this.selfId) return;
      const me: Seat = game.black === this.selfId ? "b" : "s";
      this.commit({
        id: game.matchId,
        game: game.game,
        mode: game.mode,
        role: "guest",
        white: game.white,
        black: game.black,
        whiteName: game.whiteName,
        blackName: game.blackName,
        me,
        roster: game.peers.filter((id) => id !== this.selfId),
        seq: game.seq,
        chess: game.chess ?? (game.game === "chess" ? chessStart() : null),
        checkers: game.checkers ?? (game.game === "checkers" ? checkersStart() : null),
        sea: game.sea ?? (game.game === "sea" ? seaStart() : null),
        ships: game.game === "sea" && me !== "s" ? [] : null,
        cpuShips: null,
        thinking: false,
        left: false,
        banner: "",
        drawFrom: "",
        resignFrom: "",
        horizontal: true,
      }, null);
      if (this.inviteOn) playCue("join", { toneJoin: this.inviteTone, volumeJoin: this.inviteVolume } as Settings);
      return;
    }
    const match = this.snap.match;
    if (!match || game.matchId !== match.id) return;
    if (game.t === "leave") {
      if (match.role === "host") void this.fan(match, game);
      this.commit(null);
      return;
    }
    if (game.t === "resign") {
      this.commit(this.withWinner(match, match.white === peerId ? "b" : "w"));
      if (match.role === "host") void this.fan(match, game);
      return;
    }
    if (game.t === "resign-offer") {
      this.commit({ ...match, resignFrom: peerId, banner: "" });
      if (match.role === "host") void this.fan(match, game);
      return;
    }
    if (game.t === "resign-answer") {
      const winner: "w" | "b" = match.resignFrom === match.white ? "b" : "w";
      const next = game.accept && match.resignFrom ? this.withWinner(match, winner) : { ...match, resignFrom: "" };
      this.commit(next);
      if (match.role === "host") void this.fan(match, game);
      return;
    }
    if (game.t === "draw-offer") {
      this.commit({ ...match, drawFrom: peerId, banner: "" });
      if (match.role === "host") void this.fan(match, game);
      return;
    }
    if (game.t === "draw-answer") {
      const next = game.accept ? this.withWinner(match, "draw") : { ...match, drawFrom: "" };
      this.commit(next);
      if (match.role === "host") void this.fan(match, game);
      return;
    }
    if (game.t === "move") this.onMove(match, peerId, game);
    if (game.t === "sea") this.onSea(match, game);
  }

  private syncOf(match: Match, peerId: string): GameWire {
    return {
      t: "sync",
      matchId: match.id,
      game: match.game,
      mode: match.mode === "cpu" ? "p2p" : match.mode,
      white: match.white,
      black: match.black,
      whiteName: match.whiteName,
      blackName: match.blackName,
      seq: match.seq,
      peers: [this.selfId, ...match.roster.filter((id) => id !== peerId)],
      chess: match.chess ?? undefined,
      checkers: match.checkers ?? undefined,
      sea: match.sea ?? undefined,
    };
  }

  private onMove(match: Match, peerId: string, game: Extract<GameWire, { t: "move" }>): void {
    if (game.seq !== match.seq + 1 || peerId === this.selfId) return;
    if (match.chess && game.chess) {
      const owner = match.chess.turn === "w" ? match.white : match.black;
      if (peerId !== owner) return;
      const legal = legalChess(match.chess).find((move) => move.from === game.chess!.from && move.to === game.chess!.to);
      if (!legal) return;
      const next = { ...match, seq: game.seq, chess: applyChess(match.chess, legal), banner: "" as const };
      this.commit(next);
      if (match.role === "host") void this.fan(next, game);
      return;
    }
    if (match.checkers && game.checkers) {
      const owner = match.checkers.turn === "w" ? match.white : match.black;
      if (peerId !== owner) return;
      const legal = checkersMoves(match.checkers).find((move) => move.from === game.checkers!.from && move.path.join() === game.checkers!.path.join());
      if (!legal) return;
      const next = { ...match, seq: game.seq, checkers: applyCheckers(match.checkers, legal), banner: "" as const };
      this.commit(next);
      if (match.role === "host") void this.fan(next, game);
    }
  }

  private onSea(match: Match, game: Extract<GameWire, { t: "sea" }>): void {
    if (!match.sea) return;
    if (game.kind === "ready") {
      const next = { ...match, sea: applySeaReady(match.sea, game.seat) };
      this.commit(next);
      if (match.role === "host") void this.fan(next, game);
      return;
    }
    if (game.kind === "shot") {
      const defender: Side = game.seat === "w" ? "b" : "w";
      if (match.me !== defender || !match.ships || match.sea.phase !== "battle" || match.sea.turn !== game.seat) return;
      const index = game.index ?? -1;
      if (index < 0 || index > 99 || match.sea.shots[game.seat][index]) return;
      const prior = new Set<number>();
      match.sea.shots[game.seat].forEach((value, cell) => { if (value) prior.add(cell); });
      const result = shootResult(match.ships, prior, index);
      const seq = match.seq + 1;
      const sea = applySeaResult(match.sea, game.seat, index, result.hit, result.win);
      const next = { ...match, seq, sea, banner: result.sunk ? "sunk" as const : result.hit ? "hit" as const : "miss" as const };
      this.commit(next);
      void this.tell(next, { t: "sea", matchId: next.id, seq, kind: "result", seat: game.seat, index, hit: result.hit, sunk: result.sunk, win: result.win });
      return;
    }
    if (game.kind === "result" && game.seq === match.seq + 1 && game.index !== undefined) {
      const sea = applySeaResult(match.sea, game.seat, game.index, Boolean(game.hit), Boolean(game.win));
      const next = { ...match, seq: game.seq, sea, banner: game.sunk ? "sunk" as const : game.hit ? "hit" as const : "miss" as const };
      this.commit(next);
      if (match.role === "host") void this.fan(next, game);
    }
  }
}

export const games = new Table();

export function startGames(): void {
  games.bind();
}

export function setGameInvite(settings: Settings): void {
  games.setInvite(settings);
}

const GAME_KEYS: Record<GameId, Key> = { chess: "games.chess", checkers: "games.checkers", sea: "games.sea" };

export function GameInvite({ t }: { t: T }) {
  const snap = useSyncExternalStore(games.subscribe, games.get);
  const invite = snap.invite;
  if (!invite) return null;
  return (
    <div className="modal-back game-invite">
      <div className="modal lamp-card">
        <h2>{t("games.inviteTitle")}</h2>
        <p>{t("games.inviteFrom").replaceAll("{name}", invite.fromName).replaceAll("{game}", t(GAME_KEYS[invite.game]))}</p>
        <div className="row">
          <button className="btn ghost" type="button" onClick={() => games.decline()}>{t("call.decline")}</button>
          <button className="btn" type="button" onClick={() => games.accept()}>{t("call.accept")}</button>
        </div>
      </div>
    </div>
  );
}

export function Games({ snap, t, hintPeer = "", hintRoom = "" }: { snap: Snapshot; t: T; hintPeer?: string; hintRoom?: string }) {
  const live = useSyncExternalStore(games.subscribe, games.get);
  const skill = snap.settings.gameDifficulty || "normal";
  useEffect(() => { games.setSelf(snap.profile.id, snap.profile.name); }, [snap.profile.id, snap.profile.name]);
  useEffect(() => { games.setSkill(skill); }, [skill]);
  useEffect(() => { games.setInvite(snap.settings); }, [snap.settings]);
  if (live.match) return <MatchView match={live.match} snap={snap} t={t} hints={snap.settings.gameHints !== false} />;
  return <Lobby snap={snap} t={t} hintPeer={hintPeer} hintRoom={hintRoom} />;
}

function Lobby({ snap, t, hintPeer, hintRoom }: { snap: Snapshot; t: T; hintPeer: string; hintRoom: string }) {
  const [game, setGame] = useState<GameId>("chess");
  const [mode, setMode] = useState<Mode>(hintPeer || hintRoom ? "p2p" : "cpu");
  const [picked, setPicked] = useState<string[]>(hintPeer ? [hintPeer] : []);
  const [roomId, setRoomId] = useState(hintRoom);
  const online = snap.peers.filter((peer) => peer.online);
  const rooms = snap.rooms.filter((room) => room.joined);
  const skill = snap.settings.gameDifficulty || "normal";
  const setSkill = (gameDifficulty: Skill) => { void api.invoke("setSettings", { gameDifficulty }); };
  const chooseRoom = (room: RoomInfo) => {
    setRoomId(room.id);
    const ids = online.filter((peer) => room.members.includes(peer.id)).map((peer) => peer.id);
    setPicked(ids);
    setMode("group");
  };
  const start = () => {
    if (mode === "cpu") {
      games.startCpu(game, t("games.cpuName"));
      return;
    }
    const ids = mode === "p2p" ? picked.slice(0, 1) : picked;
    games.startPeople(game, mode === "group" ? "group" : "p2p", ids);
  };
  return (
    <section className="lamp">
      <header className="lamp-head">
        <div>
          <h2>{t("games.title")}</h2>
          <p>{t("games.text")}</p>
        </div>
      </header>
      <div className="game-cards">
        <GameCard id="chess" active={game === "chess"} title={t("games.chess")} text={t("games.chessBlurb")} onClick={() => setGame("chess")} />
        <GameCard id="checkers" active={game === "checkers"} title={t("games.checkers")} text={t("games.checkersBlurb")} onClick={() => setGame("checkers")} />
        <GameCard id="sea" active={game === "sea"} title={t("games.sea")} text={t("games.seaBlurb")} onClick={() => setGame("sea")} />
      </div>
      {mode === "cpu" && (
        <div className="skill-row">
          {(["easy", "normal", "hard"] as const).map((item) => (
            <button key={item} type="button" className={skill === item ? `skill-card ${item} on` : `skill-card ${item}`} onClick={() => setSkill(item)}>
              <SkillMark id={item} />
              <strong>{t(item === "easy" ? "games.easy" : item === "hard" ? "games.hard" : "games.normal")}</strong>
              <small>{t(item === "easy" ? "games.easyBlurb" : item === "hard" ? "games.hardBlurb" : "games.normalBlurb")}</small>
            </button>
          ))}
        </div>
      )}
      <div className="choice-row">
        {(["cpu", "p2p", "group"] as const).map((item) => (
          <button key={item} type="button" className={mode === item ? "btn" : "btn ghost"} onClick={() => setMode(item)}>{t(item === "cpu" ? "games.cpu" : item === "p2p" ? "games.p2p" : "games.group")}</button>
        ))}
      </div>
      {mode !== "cpu" && (
        <div className="lamp-people">
          <div className="sub">{mode === "group" ? t("games.pickRoom") : t("games.pickPeer")}</div>
          {mode === "group" && rooms.length > 0 && (
            <div className="choice-row">
              {rooms.map((room) => (
                <button key={room.id} type="button" className={roomId === room.id ? "btn" : "btn ghost"} onClick={() => chooseRoom(room)}>{room.name}</button>
              ))}
            </div>
          )}
          {online.length === 0 && <p>{t("games.noPeers")}</p>}
          <div className="peer-picks">
            {online.map((peer) => (
              <PeerPick key={peer.id} peer={peer} on={picked.includes(peer.id)} onClick={() => {
                setPicked((list) => mode === "p2p" ? [peer.id] : list.includes(peer.id) ? list.filter((id) => id !== peer.id) : [...list, peer.id]);
              }} />
            ))}
          </div>
        </div>
      )}
      <button className="btn lamp-go" type="button" disabled={mode !== "cpu" && picked.length === 0} onClick={start}>{mode === "cpu" ? t("games.cpu") : t("games.start")}</button>
    </section>
  );
}

function GameCard({ id, active, title, text, onClick }: { id: GameId; active: boolean; title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" className={active ? `game-card ${id} active` : `game-card ${id}`} onClick={onClick}>
      <span className={`game-art ${id}`}><GameArt id={id} /></span>
      <strong>{title}</strong>
      <small>{text}</small>
    </button>
  );
}

function GameArt({ id }: { id: GameId }) {
  if (id === "sea") {
    return (
      <svg viewBox="0 0 160 90" aria-hidden>
        <rect width="160" height="90" rx="12" fill="#163e52" />
        {Array.from({ length: 8 }, (_, row) => Array.from({ length: 14 }, (_, col) => (
          <rect key={`${row}-${col}`} x={8 + col * 10.4} y={10 + row * 9} width="8.4" height="7" rx="1.4" fill={((row + col) % 5 === 0) ? "#d7b07a" : "#1d5c74"} opacity={((row + col) % 5 === 0) ? 1 : 0.9} />
        )))}
        <circle cx="128" cy="22" r="8" fill="#f4e2b0" opacity="0.85" />
      </svg>
    );
  }
  const discs = id === "checkers";
  return (
    <svg viewBox="0 0 160 90" aria-hidden>
      <rect width="160" height="90" rx="12" fill="#6b3a22" />
      {Array.from({ length: 4 }, (_, row) => Array.from({ length: 8 }, (_, col) => {
        const dark = (row + col) % 2 === 1;
        return <rect key={`${row}-${col}`} x={10 + col * 17.5} y={8 + row * 18.5} width="16" height="16.5" fill={dark ? "#8d4e2c" : "#f3d7a4"} />;
      }))}
      {discs ? (
        <>
          <circle cx="36.5" cy="16" r="6" fill="#2a1a12" />
          <circle cx="71.5" cy="16" r="6" fill="#2a1a12" />
          <circle cx="54" cy="62" r="6" fill="#fff6e4" />
          <circle cx="89" cy="62" r="6" fill="#fff6e4" />
        </>
      ) : (
        <>
          <text x="28" y="22" fontSize="13">♞</text>
          <text x="63" y="22" fontSize="13">♚</text>
          <text x="80" y="74" fontSize="13" fill="#fffaf2">♛</text>
          <text x="115" y="74" fontSize="13" fill="#fffaf2">♝</text>
        </>
      )}
    </svg>
  );
}

function SkillMark({ id }: { id: Skill }) {
  const bars = id === "easy" ? 1 : id === "normal" ? 2 : 3;
  return (
    <span className="skill-mark" aria-hidden>
      {[1, 2, 3].map((step) => <i key={step} className={step <= bars ? "on" : ""} style={{ height: 6 + step * 5 }} />)}
    </span>
  );
}

function PeerPick({ peer, on, onClick }: { peer: PeerInfo; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={on ? "peer-pick on" : "peer-pick"} onClick={onClick}>
      <i style={{ background: peer.color }} />
      <span>{peer.name}</span>
    </button>
  );
}

function playerName(id: string, stored: string, snap: Snapshot, t: T): string {
  if (!id) return stored;
  if (id === "cpu") return t("games.cpuName");
  if (id === snap.profile.id) return snap.profile.name || stored;
  return snap.peers.find((peer) => peer.id === id)?.name || stored || t("chats.member");
}

function MatchView({ match, snap, t, hints }: { match: Match; snap: Snapshot; t: T; hints: boolean }) {
  const white = playerName(match.white, match.whiteName, snap, t);
  const black = match.black ? playerName(match.black, match.blackName, snap, t) : "";
  const over = Boolean(match.chess?.winner || match.checkers?.winner || match.sea?.winner);
  const drawAsk = match.drawFrom && match.drawFrom !== snap.profile.id;
  const drawName = drawAsk ? playerName(match.drawFrom, "", snap, t) : "";
  const resignAsk = match.resignFrom && match.resignFrom !== snap.profile.id;
  const resignName = resignAsk ? playerName(match.resignFrom, "", snap, t) : "";
  return (
    <section className="lamp">
      <header className="lamp-head">
        <div>
          <h2>{t(GAME_KEYS[match.game])}</h2>
          <p>{statusLine(match, t, white, black)}</p>
        </div>
        <div className="game-acts">
          {match.me !== "s" && !over && match.mode !== "cpu" && (
            <>
              <button className={match.drawFrom === snap.profile.id ? "btn ghost wait-blink" : "btn ghost"} type="button" onClick={() => games.offerDraw()}>{t("games.drawOffer")}</button>
              <button className={match.resignFrom === snap.profile.id ? "btn ghost wait-blink" : "btn ghost"} type="button" onClick={() => games.resign()}>{t("games.resign")}</button>
            </>
          )}
          {match.me !== "s" && !over && match.mode === "cpu" && (
            <button className="btn ghost" type="button" onClick={() => games.resign()}>{t("games.resign")}</button>
          )}
          <button className="btn ghost" type="button" onClick={() => games.leave()}>{match.mode === "cpu" && !over ? t("games.back") : t("games.leave")}</button>
        </div>
      </header>
      <div className="seat-line">
        <span>{t("games.white")}: {white}</span>
        <span className={match.banner === "joined" ? "seat-in" : ""}>{t("games.black")}: {black || t("games.waiting")}</span>
      </div>
      {match.banner === "joined" && <div className="lamp-banner on">{t("games.accepted").replaceAll("{name}", black)}</div>}
      {drawAsk && (
        <div className="lamp-banner on">
          {t("games.drawAsked").replaceAll("{name}", drawName)}
          <button className="btn" type="button" onClick={() => games.answerDraw(true)}>{t("games.drawYes")}</button>
          <button className="btn ghost" type="button" onClick={() => games.answerDraw(false)}>{t("games.drawNo")}</button>
        </div>
      )}
      {resignAsk && (
        <div className="lamp-banner on">
          {t("games.resignAsked").replaceAll("{name}", resignName)}
          <button className="btn" type="button" onClick={() => games.answerResign(true)}>{t("games.drawYes")}</button>
          <button className="btn ghost" type="button" onClick={() => games.answerResign(false)}>{t("games.drawNo")}</button>
        </div>
      )}
      {match.banner === "sunk" && <div className="lamp-banner">{t("games.sunk")}</div>}
      {match.banner === "hit" && <div className="lamp-banner">{t("games.hit")}</div>}
      {match.banner === "miss" && <div className="lamp-banner">{t("games.miss")}</div>}
      {match.game === "chess" && match.chess && <ChessTable match={match} hints={hints} />}
      {match.game === "checkers" && match.checkers && <CheckersTable match={match} hints={hints} />}
      {match.game === "sea" && match.sea && <SeaTable match={match} t={t} white={white} black={black} />}
    </section>
  );
}

function statusLine(match: Match, t: T, white = "", black = ""): string {
  if (match.left) return t("games.left");
  if (match.banner === "joined" && black) return t("games.accepted").replaceAll("{name}", black);
  if (match.me === "s") return t("games.spectate");
  if (!match.black && match.mode !== "cpu") return t("games.waiting");
  if (match.thinking) return t("games.thinking");
  const winner = match.chess?.winner || match.checkers?.winner || (match.sea?.winner ?? "");
  if (winner === "draw") return t("games.draw");
  if (winner) return winner === match.me ? t("games.youWin") : t("games.youLose");
  if (match.chess?.note === "mate") return t("games.mate");
  if (match.chess?.note === "check") return t("games.check");
  if (match.sea?.phase === "place") return match.sea.ready[match.me === "b" ? "b" : "w"] ? t("games.waitingReady") : t("games.place");
  return games.myTurn(match) ? t("games.yourTurn") : t("games.oppTurn");
}

function ChessTable({ match, hints }: { match: Match; hints: boolean }) {
  const state = match.chess!;
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => { setFrom(null); }, [match.seq, state.note]);
  const turn = games.myTurn(match);
  const legal = turn ? legalChess(state) : [];
  const targets = new Set(legal.filter((move) => move.from === from).map((move) => move.to));
  const flip = match.me === "b";
  const ranks = flip ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="board-frame">
      <div className="board chess">
        {ranks.map((rank) => files.map((file) => {
          const index = rank * 8 + file;
          const piece = state.board[index];
          const dark = (file + rank) % 2 === 1;
          const mine = piece !== "." && (piece === piece.toUpperCase() ? "w" : "b") === state.turn && turn;
          return (
            <button key={index} type="button" className={`sq${dark ? " dark" : ""}${from === index ? " from" : ""}${hints && targets.has(index) ? " hint" : ""}${state.note === "check" && piece.toLowerCase() === "k" && (piece === "K" ? state.turn === "w" : state.turn === "b") ? " check" : ""}`} onClick={() => {
              if (!turn) return;
              if (from !== null && targets.has(index)) {
                const move = legal.find((item) => item.from === from && item.to === index);
                if (move) games.playChess(move);
                setFrom(null);
                return;
              }
              setFrom(legal.some((item) => item.from === index) && mine ? index : null);
            }}>
              {piece !== "." && <span className={piece === piece.toUpperCase() ? "piece w" : "piece b"}>{PIECE[piece.toLowerCase()]}</span>}
            </button>
          );
        }))}
      </div>
    </div>
  );
}

const PIECE: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

function CheckersTable({ match, hints }: { match: Match; hints: boolean }) {
  const state = match.checkers!;
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => { setFrom(null); }, [match.seq]);
  const turn = games.myTurn(match);
  const legal = turn ? checkersMoves(state) : [];
  const targets = legal.filter((move) => move.from === from);
  const lands = new Set(targets.map((move) => move.path[move.path.length - 1]));
  const flip = match.me === "b";
  const ranks = flip ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="board-frame">
      <div className="board checkers">
        {ranks.map((rank) => files.map((file) => {
          const index = rank * 8 + file;
          const play = (file + rank) % 2 === 0;
          const piece = state.board[index];
          return (
            <button key={index} type="button" className={`sq${play ? " dark" : ""}${from === index ? " from" : ""}${hints && lands.has(index) ? " hint" : ""}`} onClick={() => {
              if (!turn || !play) return;
              if (from !== null && lands.has(index)) {
                const move = targets.find((item) => item.path[item.path.length - 1] === index);
                if (move) games.playCheckers(move);
                setFrom(null);
                return;
              }
              setFrom(legal.some((item) => item.from === index) ? index : null);
            }}>
              {piece !== "." && <i className={`disc ${piece === "w" || piece === "W" ? "w" : "b"}${piece === "W" || piece === "B" ? " king" : ""}`} />}
            </button>
          );
        }))}
      </div>
    </div>
  );
}

function SeaTable({ match, t, white, black }: { match: Match; t: T; white: string; black: string }) {
  const sea = match.sea!;
  const me: Side = match.me === "b" ? "b" : "w";
  const placing = sea.phase === "place" && match.me !== "s" && !sea.ready[me];
  const len = match.ships ? FLEET[match.ships.length] : 0;
  return (
    <div className="sea-layout">
      {placing && (
        <div className="sea-tools">
          <span>{t("games.place")}</span>
          <button className="btn ghost" type="button" onClick={() => games.setHorizontal(!match.horizontal)}>{t("games.rotate")}</button>
          <button className="btn ghost" type="button" onClick={() => games.undoShip()}>{t("games.undo")}</button>
          <button className="btn ghost" type="button" onClick={() => games.autoShips()}>{t("games.auto")}</button>
          <button className="btn" type="button" disabled={!match.ships || match.ships.length !== FLEET.length || (!match.black && match.mode !== "cpu")} onClick={() => games.ready()}>{t("games.ready")}</button>
        </div>
      )}
      {sea.phase === "place" && match.me !== "s" && sea.ready[me] && <p>{t("games.waitingReady")}</p>}
      <div className="sea-grids">
        {match.me !== "s" && <SeaGrid title={t("games.yourFleet")} cells={ownCells(match, me)} hover={placing ? len : 0} horizontal={match.horizontal} ships={match.ships ?? []} onCell={(index) => { if (placing) games.placeShip(index % 10, Math.floor(index / 10)); }} />}
        {(sea.phase !== "place" || match.me === "s") && (
          match.me === "s"
            ? <>
              <SeaGrid title={black || t("games.black")} cells={shotCells(sea.shots.w)} onCell={() => undefined} />
              <SeaGrid title={white || t("games.white")} cells={shotCells(sea.shots.b)} onCell={() => undefined} />
            </>
            : <SeaGrid title={t("games.enemy")} cells={shotCells(sea.shots[me])} onCell={(index) => games.shoot(index)} />
        )}
      </div>
    </div>
  );
}

function ownCells(match: Match, seat: Side): Array<"ship" | "hit" | "miss" | ""> {
  const cells: Array<"ship" | "hit" | "miss" | ""> = Array(100).fill("");
  for (const ship of match.ships ?? []) for (const cell of ship.cells) cells[cell] = "ship";
  const incoming = seat === "w" ? match.sea?.shots.b : match.sea?.shots.w;
  incoming?.forEach((value, index) => {
    if (value === 2) cells[index] = "hit";
    if (value === 1) cells[index] = "miss";
  });
  return cells;
}

function shotCells(shots: number[]): Array<"hit" | "miss" | ""> {
  return shots.map((value) => value === 2 ? "hit" : value === 1 ? "miss" : "");
}

function SeaGrid({ title, cells, onCell, hover = 0, horizontal = true, ships = [] }: { title: string; cells: Array<"ship" | "hit" | "miss" | "">; onCell: (index: number) => void; hover?: number; horizontal?: boolean; ships?: Ship[] }) {
  const [over, setOver] = useState(-1);
  const preview = new Set<number>();
  let ok = false;
  if (hover && over >= 0) {
    const cellsAt = shipCells(over % 10, Math.floor(over / 10), hover, horizontal);
    if (cellsAt) {
      ok = canPlace(ships, cellsAt);
      cellsAt.forEach((cell) => preview.add(cell));
    }
  }
  return (
    <div className="sea-grid">
      <div className="sea-title">{title}</div>
      <div className="sea-board" onMouseLeave={() => setOver(-1)}>
        {cells.map((kind, index) => (
          <button key={index} type="button" className={`sea-cell ${kind}${preview.has(index) ? (ok ? " preview" : " bad") : ""}`} onMouseEnter={() => setOver(index)} onClick={() => onCell(index)} />
        ))}
      </div>
    </div>
  );
}
