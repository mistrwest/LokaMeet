import type { CheckersCell, CheckersPiece, CheckersSnapshot, GameColor, Square } from "../types";

const DIRS: Square[] = [
  { r: -1, c: -1 },
  { r: -1, c: 1 },
  { r: 1, c: -1 },
  { r: 1, c: 1 }
];

export type CheckersMove = {
  path: Square[];
  captures: Square[];
};

type Board = CheckersCell[][];

function inBounds(r: number, c: number) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

export function isPlayableSquare(r: number, c: number) {
  return inBounds(r, c) && (r + c) % 2 === 1;
}

export function lastRowFor(color: GameColor) {
  return color === "white" ? 0 : 7;
}

function manForwardDirs(color: GameColor): Square[] {
  return color === "white"
    ? [
        { r: -1, c: -1 },
        { r: -1, c: 1 }
      ]
    : [
        { r: 1, c: -1 },
        { r: 1, c: 1 }
      ];
}

function sqKey(s: Square) {
  return `${s.r},${s.c}`;
}

function clonePiece(p: CheckersPiece): CheckersPiece {
  return { id: p.id, color: p.color, king: p.king };
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((cell) => (cell ? clonePiece(cell) : null)));
}

function emptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array<CheckersCell>(8).fill(null));
}

export function boardFromSnapshot(snapshot: CheckersSnapshot): Board {
  const board = emptyBoard();
  for (const piece of snapshot.pieces) {
    if (!isPlayableSquare(piece.r, piece.c)) continue;
    board[piece.r][piece.c] = { id: piece.id, color: piece.color, king: piece.king };
  }
  return board;
}

export function snapshotFromBoard(
  board: Board,
  rest: Omit<CheckersSnapshot, "pieces" | "kind">
): CheckersSnapshot {
  const pieces: CheckersSnapshot["pieces"] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell) pieces.push({ ...cell, r, c });
    }
  }
  return { ...rest, kind: "checkers", pieces };
}

export function createInitialSnapshot(score?: { white: number; black: number }): CheckersSnapshot {
  const board = emptyBoard();
  let whiteN = 0;
  let blackN = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!isPlayableSquare(r, c)) continue;
      if (r < 3) {
        board[r][c] = { id: `b${blackN++}`, color: "black", king: false };
      } else if (r > 4) {
        board[r][c] = { id: `w${whiteN++}`, color: "white", king: false };
      }
    }
  }
  return snapshotFromBoard(board, {
    turn: "white",
    winner: null,
    continueFrom: null,
    score: score ?? { white: 0, black: 0 },
    lastMove: null,
    drawOfferedBy: null,
    kingMovesWithoutCapture: 0
  });
}

function at(board: Board, s: Square) {
  return board[s.r][s.c];
}

function enemyBetween(from: Square, to: Square, board: Board, color: GameColor): Square | null {
  const dr = Math.sign(to.r - from.r);
  const dc = Math.sign(to.c - from.c);
  if (dr === 0 || dc === 0 || Math.abs(to.r - from.r) !== Math.abs(to.c - from.c)) return null;
  let enemy: Square | null = null;
  let r = from.r + dr;
  let c = from.c + dc;
  while (r !== to.r || c !== to.c) {
    const piece = board[r][c];
    if (piece) {
      if (piece.color === color) return null;
      if (enemy) return null;
      enemy = { r, c };
    }
    r += dr;
    c += dc;
  }
  return enemy;
}

function manJumpLandings(board: Board, from: Square, color: GameColor): Array<{ to: Square; captured: Square }> {
  const out: Array<{ to: Square; captured: Square }> = [];
  for (const dir of DIRS) {
    const mid: Square = { r: from.r + dir.r, c: from.c + dir.c };
    const to: Square = { r: from.r + dir.r * 2, c: from.c + dir.c * 2 };
    if (!isPlayableSquare(to.r, to.c)) continue;
    const victim = at(board, mid);
    if (!victim || victim.color === color) continue;
    if (at(board, to)) continue;
    out.push({ to, captured: mid });
  }
  return out;
}

function kingJumpLandings(board: Board, from: Square, color: GameColor): Array<{ to: Square; captured: Square }> {
  const out: Array<{ to: Square; captured: Square }> = [];
  for (const dir of DIRS) {
    let r = from.r + dir.r;
    let c = from.c + dir.c;
    let victim: Square | null = null;
    while (inBounds(r, c)) {
      const piece = board[r][c];
      if (!victim) {
        if (!piece) {
          r += dir.r;
          c += dir.c;
          continue;
        }
        if (piece.color === color) break;
        victim = { r, c };
        r += dir.r;
        c += dir.c;
        continue;
      }
      if (piece) break;
      if (isPlayableSquare(r, c)) out.push({ to: { r, c }, captured: victim });
      r += dir.r;
      c += dir.c;
    }
  }
  return out;
}

function applyJump(board: Board, from: Square, to: Square, captured: Square): { board: Board; king: boolean; color: GameColor; id: string } {
  const next = cloneBoard(board);
  const piece = next[from.r][from.c];
  if (!piece) throw new Error("empty from");
  next[from.r][from.c] = null;
  next[captured.r][captured.c] = null;
  let king = piece.king;
  if (!king && to.r === lastRowFor(piece.color)) king = true;
  next[to.r][to.c] = { ...piece, king };
  return { board: next, king, color: piece.color, id: piece.id };
}

function captureSequences(board: Board, from: Square, color: GameColor, king: boolean, path: Square[]): CheckersMove[] {
  const jumps = king ? kingJumpLandings(board, from, color) : manJumpLandings(board, from, color);
  if (jumps.length === 0) {
    if (path.length > 1) {
      const captures: Square[] = [];
      const temp = cloneBoard(board);
      // Reconstruct captures from path against original is handled by caller.
      return [{ path, captures }];
    }
    return [];
  }
  const results: CheckersMove[] = [];
  for (const jump of jumps) {
    const applied = applyJump(board, from, jump.to, jump.captured);
    const nextPath = [...path, jump.to];
    const rest = captureSequences(applied.board, jump.to, color, applied.king, nextPath);
    if (rest.length === 0) {
      results.push({ path: nextPath, captures: [jump.captured] });
    } else {
      for (const seq of rest) results.push(seq);
    }
  }
  return results;
}

function fillCaptures(board: Board, move: CheckersMove): CheckersMove {
  const captures: Square[] = [];
  let cur = cloneBoard(board);
  for (let i = 0; i < move.path.length - 1; i++) {
    const from = move.path[i];
    const to = move.path[i + 1];
    const captured = enemyBetween(from, to, cur, at(cur, from)?.color ?? "white");
    if (!captured) continue;
    captures.push(captured);
    const piece = cur[from.r][from.c];
    cur[from.r][from.c] = null;
    cur[captured.r][captured.c] = null;
    if (piece) {
      const king = piece.king || to.r === lastRowFor(piece.color);
      cur[to.r][to.c] = { ...piece, king };
    }
  }
  return { path: move.path, captures };
}

function quietMoves(board: Board, from: Square, color: GameColor, king: boolean): CheckersMove[] {
  const moves: CheckersMove[] = [];
  if (king) {
    for (const dir of DIRS) {
      let r = from.r + dir.r;
      let c = from.c + dir.c;
      while (isPlayableSquare(r, c) && !board[r][c]) {
        moves.push({ path: [from, { r, c }], captures: [] });
        r += dir.r;
        c += dir.c;
      }
    }
    return moves;
  }
  for (const dir of manForwardDirs(color)) {
    const to = { r: from.r + dir.r, c: from.c + dir.c };
    if (!isPlayableSquare(to.r, to.c) || board[to.r][to.c]) continue;
    moves.push({ path: [from, to], captures: [] });
  }
  return moves;
}

export function listLegalMoves(snapshot: CheckersSnapshot): CheckersMove[] {
  if (snapshot.winner) return [];
  const board = boardFromSnapshot(snapshot);
  const color = snapshot.turn;
  const origin = snapshot.continueFrom;
  const captures: CheckersMove[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece.color !== color) continue;
      if (origin && (origin.r !== r || origin.c !== c)) continue;
      const seq = captureSequences(board, { r, c }, color, piece.king, [{ r, c }]);
      for (const move of seq) captures.push(fillCaptures(board, move));
    }
  }
  if (captures.length > 0) return captures;
  if (origin) return [];
  const quiet: CheckersMove[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece.color !== color) continue;
      quiet.push(...quietMoves(board, { r, c }, color, piece.king));
    }
  }
  return quiet;
}

export function nextSquares(snapshot: CheckersSnapshot, path: Square[]): Square[] {
  const legal = listLegalMoves(snapshot).filter((move) => {
    if (move.path.length <= path.length) return false;
    return path.every((sq, i) => move.path[i]?.r === sq.r && move.path[i]?.c === sq.c);
  });
  const seen = new Set<string>();
  const out: Square[] = [];
  for (const move of legal) {
    const next = move.path[path.length];
    if (!next) continue;
    const key = sqKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

function pieceCount(board: Board, color: GameColor) {
  let n = 0;
  for (const row of board) for (const cell of row) if (cell?.color === color) n++;
  return n;
}

function hasAnyMove(snapshot: CheckersSnapshot, color: GameColor) {
  return listLegalMoves({ ...snapshot, turn: color, winner: null, continueFrom: null }).length > 0;
}

export function applyPath(snapshot: CheckersSnapshot, path: Square[]): CheckersSnapshot | null {
  if (snapshot.winner || path.length < 2) return null;
  const legal = listLegalMoves(snapshot);
  const match = legal.find(
    (move) => move.path.length === path.length && move.path.every((sq, i) => sq.r === path[i].r && sq.c === path[i].c)
  );
  if (!match) return null;
  const board = boardFromSnapshot(snapshot);
  const from = path[0];
  const piece = at(board, from);
  if (!piece) return null;
  let cur = cloneBoard(board);
  let moving = clonePiece(piece);
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const captured = enemyBetween(a, b, cur, moving.color);
    cur[a.r][a.c] = null;
    if (captured) cur[captured.r][captured.c] = null;
    if (!moving.king && b.r === lastRowFor(moving.color)) moving = { ...moving, king: true };
    cur[b.r][b.c] = moving;
  }
  const capturedAny = match.captures.length > 0;
  const bothKings = moving.king && match.captures.length === 0;
  const kingMovesWithoutCapture = bothKings ? snapshot.kingMovesWithoutCapture + 1 : capturedAny ? 0 : snapshot.kingMovesWithoutCapture;
  const opponent: GameColor = snapshot.turn === "white" ? "black" : "white";
  let winner: CheckersSnapshot["winner"] = null;
  if (pieceCount(cur, opponent) === 0) winner = snapshot.turn;
  const nextSnap = snapshotFromBoard(cur, {
    turn: opponent,
    winner,
    continueFrom: null,
    score: snapshot.score,
    lastMove: path,
    drawOfferedBy: null,
    kingMovesWithoutCapture
  });
  if (!winner && !hasAnyMove(nextSnap, opponent)) {
    nextSnap.winner = snapshot.turn;
  }
  if (!nextSnap.winner && kingMovesWithoutCapture >= 15) {
    nextSnap.winner = "draw";
  }
  if (nextSnap.winner && nextSnap.winner !== "draw") {
    const w = nextSnap.winner;
    nextSnap.score = { ...nextSnap.score, [w]: nextSnap.score[w] + 1 };
  }
  return nextSnap;
}

export function applyResign(snapshot: CheckersSnapshot, by: GameColor): CheckersSnapshot {
  if (snapshot.winner) return snapshot;
  const winner: GameColor = by === "white" ? "black" : "white";
  return {
    ...snapshot,
    winner,
    drawOfferedBy: null,
    score: { ...snapshot.score, [winner]: snapshot.score[winner] + 1 }
  };
}

export function applyDraw(snapshot: CheckersSnapshot): CheckersSnapshot {
  if (snapshot.winner) return snapshot;
  return { ...snapshot, winner: "draw", drawOfferedBy: null };
}

export function squareLabel(sq: Square) {
  return `${String.fromCharCode(97 + sq.c)}${8 - sq.r}`;
}

export function remainingPieces(snapshot: CheckersSnapshot, color: GameColor) {
  return snapshot.pieces.filter((p) => p.color === color).length;
}

export function sameSquare(a: Square | null | undefined, b: Square | null | undefined) {
  return Boolean(a && b && a.r === b.r && a.c === b.c);
}
