import type { CheckersSync, ChessSync, SeaSync } from "../shared/types";

export type Side = "w" | "b";
export type ChessState = ChessSync;
export type CheckersState = CheckersSync;
export type SeaPublic = SeaSync;

export interface ChessMove {
  from: number;
  to: number;
  promo: string;
}

export interface CheckersMove {
  from: number;
  path: number[];
}

export interface Ship {
  cells: number[];
}

export const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function opp(side: Side): Side {
  return side === "w" ? "b" : "w";
}

function sideOf(piece: string): Side | "" {
  if (!piece || piece === ".") return "";
  return piece === piece.toUpperCase() ? "w" : "b";
}

function put(board: string, index: number, piece: string): string {
  return board.slice(0, index) + piece + board.slice(index + 1);
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

export function chessStart(): ChessState {
  const cells = Array(64).fill(".");
  const back = "RNBQKBNR";
  for (let file = 0; file < 8; file += 1) {
    cells[file] = back[file];
    cells[8 + file] = "P";
    cells[48 + file] = "p";
    cells[56 + file] = back[file].toLowerCase();
  }
  return { board: cells.join(""), turn: "w", castle: "KQkq", ep: -1, half: 0, winner: "", note: "" };
}

function attacked(board: string, sq: number, by: Side): boolean {
  const file = sq & 7;
  const rank = sq >> 3;
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    const pf = file + df;
    if (!onBoard(pf, pawnRank)) continue;
    const piece = board[pawnRank * 8 + pf];
    if (by === "w" && piece === "P") return true;
    if (by === "b" && piece === "p") return true;
  }
  for (const [df, dr] of KNIGHT) {
    const f = file + df;
    const r = rank + dr;
    if (!onBoard(f, r)) continue;
    const piece = board[r * 8 + f];
    if ((by === "w" && piece === "N") || (by === "b" && piece === "n")) return true;
  }
  for (const [df, dr] of KING) {
    const f = file + df;
    const r = rank + dr;
    if (!onBoard(f, r)) continue;
    const piece = board[r * 8 + f];
    if ((by === "w" && piece === "K") || (by === "b" && piece === "k")) return true;
  }
  const look = (dirs: number[][], rook: boolean) => {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const piece = board[r * 8 + f];
        if (piece !== ".") {
          if (sideOf(piece) === by) {
            const kind = piece.toLowerCase();
            if (rook ? kind === "r" || kind === "q" : kind === "b" || kind === "q") return true;
          }
          break;
        }
        f += df;
        r += dr;
      }
    }
    return false;
  };
  return look(ROOK, true) || look(BISHOP, false);
}

function kingAt(board: string, side: Side): number {
  return board.indexOf(side === "w" ? "K" : "k");
}

function inCheck(board: string, side: Side): boolean {
  const king = kingAt(board, side);
  return king >= 0 && attacked(board, king, opp(side));
}

function pushMove(board: string, from: number, to: number, side: Side, out: ChessMove[]): void {
  const piece = board[from];
  const rank = to >> 3;
  if ((piece === "P" && rank === 7) || (piece === "p" && rank === 0)) {
    out.push({ from, to, promo: side === "w" ? "Q" : "q" });
    return;
  }
  out.push({ from, to, promo: "" });
}

function pseudo(state: ChessState): ChessMove[] {
  const out: ChessMove[] = [];
  const board = state.board;
  const side = state.turn;
  const enemy = opp(side);
  for (let from = 0; from < 64; from += 1) {
    const piece = board[from];
    if (sideOf(piece) !== side) continue;
    const file = from & 7;
    const rank = from >> 3;
    const kind = piece.toLowerCase();
    const add = (to: number) => pushMove(board, from, to, side, out);
    const ray = (dirs: number[][]) => {
      for (const [df, dr] of dirs) {
        let f = file + df;
        let r = rank + dr;
        while (onBoard(f, r)) {
          const to = r * 8 + f;
          const target = board[to];
          if (target === ".") add(to);
          else {
            if (sideOf(target) === enemy) add(to);
            break;
          }
          f += df;
          r += dr;
        }
      }
    };
    if (kind === "n") {
      for (const [df, dr] of KNIGHT) {
        const f = file + df;
        const r = rank + dr;
        if (!onBoard(f, r)) continue;
        if (sideOf(board[r * 8 + f]) !== side) add(r * 8 + f);
      }
    } else if (kind === "b") ray(BISHOP);
    else if (kind === "r") ray(ROOK);
    else if (kind === "q") ray([...BISHOP, ...ROOK]);
    else if (kind === "k") {
      for (const [df, dr] of KING) {
        const f = file + df;
        const r = rank + dr;
        if (!onBoard(f, r)) continue;
        if (sideOf(board[r * 8 + f]) !== side) add(r * 8 + f);
      }
      const home = side === "w" ? 4 : 60;
      if (from === home && !inCheck(board, side)) {
        const rights = side === "w" ? ["K", "Q"] : ["k", "q"];
        if (state.castle.includes(rights[0]) && board[home + 1] === "." && board[home + 2] === "." && board[home + 3] !== ".") {
          if (!attacked(board, home + 1, enemy) && !attacked(board, home + 2, enemy)) add(home + 2);
        }
        if (state.castle.includes(rights[1]) && board[home - 1] === "." && board[home - 2] === "." && board[home - 3] === "." && board[home - 4] !== ".") {
          if (!attacked(board, home - 1, enemy)) add(home - 2);
        }
      }
    } else if (kind === "p") {
      const dir = side === "w" ? 1 : -1;
      const start = side === "w" ? 1 : 6;
      const oneR = rank + dir;
      if (onBoard(file, oneR) && board[oneR * 8 + file] === ".") {
        add(oneR * 8 + file);
        const twoR = rank + dir * 2;
        if (rank === start && board[twoR * 8 + file] === ".") add(twoR * 8 + file);
      }
      for (const df of [-1, 1]) {
        const f = file + df;
        if (!onBoard(f, oneR)) continue;
        const to = oneR * 8 + f;
        if (sideOf(board[to]) === enemy || to === state.ep) add(to);
      }
    }
  }
  return out;
}

function applyChessRaw(state: ChessState, move: ChessMove): ChessState {
  let board = state.board;
  const piece = board[move.from];
  const captured = board[move.to] !== ".";
  const side = state.turn;
  board = put(board, move.from, ".");
  board = put(board, move.to, move.promo || piece);
  if ((piece === "P" || piece === "p") && move.to === state.ep) {
    const cap = side === "w" ? move.to - 8 : move.to + 8;
    board = put(board, cap, ".");
  }
  if (piece.toLowerCase() === "k" && Math.abs(move.to - move.from) === 2) {
    const rookFrom = move.to > move.from ? move.from + 3 : move.from - 4;
    const rookTo = move.to > move.from ? move.to - 1 : move.to + 1;
    const rook = board[rookFrom];
    board = put(board, rookFrom, ".");
    board = put(board, rookTo, rook);
  }
  let castle = state.castle;
  if (piece === "K") castle = castle.replace(/[KQ]/g, "");
  if (piece === "k") castle = castle.replace(/[kq]/g, "");
  if (move.from === 0 || move.to === 0) castle = castle.replace("Q", "");
  if (move.from === 7 || move.to === 7) castle = castle.replace("K", "");
  if (move.from === 56 || move.to === 56) castle = castle.replace("q", "");
  if (move.from === 63 || move.to === 63) castle = castle.replace("k", "");
  let ep = -1;
  if ((piece === "P" || piece === "p") && Math.abs(move.to - move.from) === 16) ep = (move.from + move.to) >> 1;
  const pawn = piece.toLowerCase() === "p";
  const half = pawn || captured || move.to === state.ep ? 0 : state.half + 1;
  return { board, turn: opp(side), castle, ep, half, winner: "", note: "" };
}

export function legalChess(state: ChessState): ChessMove[] {
  if (state.winner) return [];
  return pseudo(state).filter((move) => !inCheck(applyChessRaw(state, move).board, state.turn));
}

function decorateChess(state: ChessState): ChessState {
  if (state.half >= 100) return { ...state, winner: "draw", note: "stalemate" };
  const moves = legalChess(state);
  const check = inCheck(state.board, state.turn);
  if (!moves.length) return { ...state, winner: check ? opp(state.turn) : "draw", note: check ? "mate" : "stalemate" };
  return { ...state, winner: "", note: check ? "check" : "" };
}

export function applyChess(state: ChessState, move: ChessMove): ChessState {
  return decorateChess(applyChessRaw(state, move));
}

function chessValue(state: ChessState): number {
  const worth: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  let score = 0;
  for (let i = 0; i < 64; i += 1) {
    const piece = state.board[i];
    if (piece === ".") continue;
    let value = worth[piece.toLowerCase()];
    if (piece.toLowerCase() === "p") value += (piece === "P" ? (i >> 3) : 7 - (i >> 3)) * 6;
    if (piece.toLowerCase() === "n" || piece.toLowerCase() === "b") {
      const file = i & 7;
      const rank = i >> 3;
      const center = 4 - Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5));
      value += center * 4;
    }
    score += piece === piece.toUpperCase() ? value : -value;
  }
  return state.turn === "w" ? score : -score;
}

function negamaxChess(state: ChessState, depth: number, alpha: number, beta: number): number {
  if (state.winner === "draw") return 0;
  if (state.winner) return -100000 - depth;
  if (depth === 0) return chessValue(state);
  let best = -200000;
  const moves = legalChess(state);
  for (const move of moves) {
    const score = -negamaxChess(applyChess(state, move), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

export type Skill = "easy" | "normal" | "hard";

export function cpuChess(state: ChessState, skill: Skill = "normal"): ChessMove | null {
  const moves = legalChess(state);
  if (!moves.length) return null;
  if (skill === "easy" && Math.random() < 0.42) return moves[Math.floor(Math.random() * moves.length)] ?? null;
  const pieces = [...state.board].filter((piece) => piece !== ".").length;
  const depth = skill === "hard" ? 3 : skill === "easy" ? 1 : pieces <= 10 ? 3 : 2;
  const slack = skill === "hard" ? 4 : skill === "easy" ? 48 : 12;
  let best = -200000;
  const pool: ChessMove[] = [];
  for (const move of moves) {
    const score = -negamaxChess(applyChess(state, move), depth - 1, -200000, 200000);
    if (score > best + slack) {
      best = score;
      pool.length = 0;
      pool.push(move);
    } else if (score >= best - slack) pool.push(move);
  }
  return pool[Math.floor(Math.random() * pool.length)] ?? moves[0];
}

export function checkersStart(): CheckersState {
  const cells = Array(64).fill(".");
  for (let i = 0; i < 64; i += 1) {
    const file = i & 7;
    const rank = i >> 3;
    if ((file + rank) % 2 !== 0) continue;
    if (rank <= 2) cells[i] = "w";
    else if (rank >= 5) cells[i] = "b";
  }
  return { board: cells.join(""), turn: "w", winner: "", quiet: 0 };
}

function pieceSide(piece: string): Side | "" {
  if (piece === "w" || piece === "W") return "w";
  if (piece === "b" || piece === "B") return "b";
  return "";
}

function jumpsFrom(board: string, pos: number, side: Side): Array<{ over: number; to: number }> {
  const file = pos & 7;
  const rank = pos >> 3;
  const king = board[pos] === "W" || board[pos] === "B";
  const out: Array<{ over: number; to: number }> = [];
  for (const [df, dr] of BISHOP) {
    if (!king) {
      const midF = file + df;
      const midR = rank + dr;
      const toF = file + df * 2;
      const toR = rank + dr * 2;
      if (!onBoard(toF, toR)) continue;
      const mid = board[midR * 8 + midF];
      if (pieceSide(mid) && pieceSide(mid) !== side && board[toR * 8 + toF] === ".") out.push({ over: midR * 8 + midF, to: toR * 8 + toF });
      continue;
    }
    let f = file + df;
    let r = rank + dr;
    let seen = -1;
    while (onBoard(f, r)) {
      const index = r * 8 + f;
      const piece = board[index];
      if (piece === ".") {
        if (seen >= 0) out.push({ over: seen, to: index });
      } else if (seen >= 0 || pieceSide(piece) === side) break;
      else seen = index;
      f += df;
      r += dr;
    }
  }
  return out;
}

function land(board: string, from: number, over: number, to: number): string {
  const cells = board.split("");
  let piece = cells[from];
  cells[from] = ".";
  if (over >= 0) cells[over] = ".";
  const rank = to >> 3;
  if (piece === "w" && rank === 7) piece = "W";
  if (piece === "b" && rank === 0) piece = "B";
  cells[to] = piece;
  return cells.join("");
}

function capturePaths(board: string, from: number, side: Side): CheckersMove[] {
  const found: CheckersMove[] = [];
  const walk = (current: string, pos: number, path: number[], depth: number) => {
    const jumps = depth > 12 ? [] : jumpsFrom(current, pos, side);
    if (!jumps.length) {
      if (path.length) found.push({ from, path });
      return;
    }
    for (const jump of jumps) walk(land(current, pos, jump.over, jump.to), jump.to, [...path, jump.to], depth + 1);
  };
  walk(board, from, [], 0);
  return found;
}

function quietPaths(board: string, from: number, side: Side): CheckersMove[] {
  const piece = board[from];
  const file = from & 7;
  const rank = from >> 3;
  const king = piece === "W" || piece === "B";
  const dirs = king ? BISHOP : side === "w" ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]];
  const out: CheckersMove[] = [];
  for (const [df, dr] of dirs) {
    let f = file + df;
    let r = rank + dr;
    while (onBoard(f, r) && board[r * 8 + f] === ".") {
      out.push({ from, path: [r * 8 + f] });
      if (!king) break;
      f += df;
      r += dr;
    }
  }
  return out;
}

export function checkersMoves(state: CheckersState): CheckersMove[] {
  if (state.winner) return [];
  const captures: CheckersMove[] = [];
  const quiet: CheckersMove[] = [];
  for (let i = 0; i < 64; i += 1) {
    if (pieceSide(state.board[i]) !== state.turn) continue;
    const paths = capturePaths(state.board, i, state.turn);
    if (paths.length) captures.push(...paths);
    else quiet.push(...quietPaths(state.board, i, state.turn));
  }
  return captures.length ? captures : quiet;
}

function jumped(board: string, from: number, to: number): number {
  const df = Math.sign((to & 7) - (from & 7));
  const dr = Math.sign((to >> 3) - (from >> 3));
  let f = (from & 7) + df;
  let r = (from >> 3) + dr;
  let enemy = -1;
  while (f !== (to & 7) || r !== (to >> 3)) {
    const piece = board[r * 8 + f];
    if (piece !== ".") enemy = r * 8 + f;
    f += df;
    r += dr;
  }
  return enemy;
}

export function applyCheckers(state: CheckersState, move: CheckersMove): CheckersState {
  let board = state.board;
  let pos = move.from;
  let captured = false;
  for (const to of move.path) {
    const over = jumped(board, pos, to);
    if (over >= 0) captured = true;
    board = land(board, pos, over, to);
    pos = to;
  }
  const next: CheckersState = { board, turn: opp(state.turn), winner: "", quiet: captured ? 0 : state.quiet + 1 };
  if (next.quiet >= 80) return { ...next, winner: "draw" };
  if (!checkersMoves(next).length) return { ...next, winner: state.turn };
  return next;
}

function checkersValue(state: CheckersState): number {
  let score = 0;
  for (let i = 0; i < 64; i += 1) {
    const piece = state.board[i];
    const rank = i >> 3;
    if (piece === "w") score += 100 + rank * 6;
    if (piece === "W") score += 280;
    if (piece === "b") score -= 100 + (7 - rank) * 6;
    if (piece === "B") score -= 280;
  }
  return state.turn === "w" ? score : -score;
}

function negamaxCheckers(state: CheckersState, depth: number, alpha: number, beta: number): number {
  if (state.winner === "draw") return 0;
  if (state.winner) return -100000 - depth;
  if (depth === 0) return checkersValue(state);
  let best = -200000;
  for (const move of checkersMoves(state)) {
    const score = -negamaxCheckers(applyCheckers(state, move), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

export function cpuCheckers(state: CheckersState, skill: Skill = "normal"): CheckersMove | null {
  const moves = checkersMoves(state);
  if (!moves.length) return null;
  if (skill === "easy" && Math.random() < 0.4) return moves[Math.floor(Math.random() * moves.length)] ?? null;
  const depth = skill === "hard" ? 3 : skill === "easy" ? 1 : 2;
  const slack = skill === "hard" ? 2 : skill === "easy" ? 36 : 8;
  let best = -200000;
  const pool: CheckersMove[] = [];
  for (const move of moves) {
    const score = -negamaxCheckers(applyCheckers(state, move), depth, -200000, 200000);
    if (score > best + slack) {
      best = score;
      pool.length = 0;
      pool.push(move);
    } else if (score >= best - slack) pool.push(move);
  }
  return pool[Math.floor(Math.random() * pool.length)] ?? moves[0];
}

export function shipCells(x: number, y: number, len: number, horizontal: boolean): number[] | null {
  const cells: number[] = [];
  for (let i = 0; i < len; i += 1) {
    const nx = x + (horizontal ? i : 0);
    const ny = y + (horizontal ? 0 : i);
    if (nx < 0 || nx > 9 || ny < 0 || ny > 9) return null;
    cells.push(ny * 10 + nx);
  }
  return cells;
}

export function canPlace(ships: Ship[], cells: number[]): boolean {
  const blocked = new Set<number>();
  for (const ship of ships) {
    for (const cell of ship.cells) {
      const x = cell % 10;
      const y = Math.floor(cell / 10);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) blocked.add(ny * 10 + nx);
        }
      }
    }
  }
  return cells.every((cell) => !blocked.has(cell));
}

export function randomFleet(attempt = 0): Ship[] {
  if (attempt > 40) return [];
  const ships: Ship[] = [];
  for (const len of FLEET) {
    let placed = false;
    for (let n = 0; n < 100; n += 1) {
      const horizontal = Math.random() < 0.5;
      const x = Math.floor(Math.random() * (horizontal ? 11 - len : 10));
      const y = Math.floor(Math.random() * (horizontal ? 10 : 11 - len));
      const cells = shipCells(x, y, len, horizontal);
      if (!cells || !canPlace(ships, cells)) continue;
      ships.push({ cells });
      placed = true;
      break;
    }
    if (!placed) return randomFleet(attempt + 1);
  }
  return ships;
}

export function seaStart(): SeaPublic {
  return {
    phase: "place",
    turn: "w",
    ready: { w: false, b: false },
    winner: "",
    shots: { w: Array(100).fill(0), b: Array(100).fill(0) },
  };
}

export function applySeaReady(sea: SeaPublic, seat: Side): SeaPublic {
  const ready = { ...sea.ready, [seat]: true };
  return { ...sea, ready, phase: ready.w && ready.b ? "battle" : sea.phase };
}

export function shootResult(ships: Ship[], already: Set<number>, index: number): { hit: boolean; sunk: boolean; win: boolean } {
  const ship = ships.find((item) => item.cells.includes(index));
  if (!ship) return { hit: false, sunk: false, win: false };
  const hits = new Set(already);
  hits.add(index);
  const sunk = ship.cells.every((cell) => hits.has(cell));
  const win = ships.every((item) => item.cells.every((cell) => hits.has(cell)));
  return { hit: true, sunk, win };
}

export function applySeaResult(sea: SeaPublic, seat: Side, index: number, hit: boolean, win: boolean): SeaPublic {
  const shots = { w: sea.shots.w.slice(), b: sea.shots.b.slice() };
  shots[seat][index] = hit ? 2 : 1;
  return {
    ...sea,
    shots,
    winner: win ? seat : "",
    turn: win ? sea.turn : opp(seat),
    phase: win ? "done" : "battle",
  };
}

export function cpuSeaShot(shots: number[], skill: Skill = "normal"): number {
  const unknown: number[] = [];
  const targets: number[] = [];
  for (let i = 0; i < 100; i += 1) if (!shots[i]) unknown.push(i);
  if (skill === "easy") return unknown[Math.floor(Math.random() * unknown.length)] ?? 0;
  for (let i = 0; i < 100; i += 1) {
    if (shots[i] !== 2) continue;
    const x = i % 10;
    const y = Math.floor(i / 10);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > 9 || ny < 0 || ny > 9) continue;
      const next = ny * 10 + nx;
      if (!shots[next]) targets.push(next);
    }
  }
  const pool = targets.length ? targets : unknown.filter((cell) => ((cell % 10) + Math.floor(cell / 10)) % 2 === 0);
  const source = pool.length ? pool : unknown;
  return source[Math.floor(Math.random() * source.length)] ?? 0;
}

export function selfCheckGames(): string[] {
  const errors: string[] = [];
  const start = chessStart();
  if (legalChess(start).length !== 20) errors.push(`chess openings ${legalChess(start).length}`);
  const f3 = legalChess(start).find((move) => move.from === 13 && move.to === 21);
  const afterF3 = f3 ? applyChess(start, f3) : start;
  const e5 = legalChess(afterF3).find((move) => move.from === 52 && move.to === 36);
  const afterE5 = e5 ? applyChess(afterF3, e5) : afterF3;
  const g4 = legalChess(afterE5).find((move) => move.from === 14 && move.to === 30);
  const afterG4 = g4 ? applyChess(afterE5, g4) : afterE5;
  const qh4 = legalChess(afterG4).find((move) => move.from === 59 && move.to === 31);
  const mate = qh4 ? applyChess(afterG4, qh4) : afterG4;
  if (!f3 || !e5 || !g4 || !qh4 || mate.note !== "mate" || mate.winner !== "b") errors.push("fools mate");
  const checkers = checkersStart();
  const opening = checkersMoves(checkers);
  if (opening.length !== 7 || opening.some((move) => move.path.length !== 1)) errors.push(`checkers opening ${opening.length}`);
  const fleet = randomFleet();
  if (fleet.length !== 10 || fleet.reduce((sum, ship) => sum + ship.cells.length, 0) !== 20) errors.push("fleet");
  const blocked = new Set<number>();
  for (const ship of fleet) for (const cell of ship.cells) blocked.add(cell);
  if (blocked.size !== 20) errors.push("fleet overlap");
  return errors;
}
