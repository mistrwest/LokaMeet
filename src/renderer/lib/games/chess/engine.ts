import type {
  ChessCastling,
  ChessPiece,
  ChessPieceType,
  ChessSnapshot,
  GameColor,
  Square
} from "../types";

export type ChessCell = ChessPiece | null;
type Board = ChessCell[][];

export type ChessMove = {
  path: Square[];
  from: Square;
  to: Square;
  promo: ChessPieceType | null;
  capture: boolean;
};

const PROMO_TYPES: ChessPieceType[] = ["queen", "rook", "bishop", "knight"];
const PIECE_VALUE: Record<ChessPieceType, number> = {
  king: 0,
  queen: 9,
  rook: 5,
  bishop: 3,
  knight: 3,
  pawn: 1
};

const KNIGHT_DELTAS: Square[] = [
  { r: -2, c: -1 },
  { r: -2, c: 1 },
  { r: -1, c: -2 },
  { r: -1, c: 2 },
  { r: 1, c: -2 },
  { r: 1, c: 2 },
  { r: 2, c: -1 },
  { r: 2, c: 1 }
];

const KING_DELTAS: Square[] = [
  { r: -1, c: -1 },
  { r: -1, c: 0 },
  { r: -1, c: 1 },
  { r: 0, c: -1 },
  { r: 0, c: 1 },
  { r: 1, c: -1 },
  { r: 1, c: 0 },
  { r: 1, c: 1 }
];

const ROOK_DIRS: Square[] = [
  { r: -1, c: 0 },
  { r: 1, c: 0 },
  { r: 0, c: -1 },
  { r: 0, c: 1 }
];

const BISHOP_DIRS: Square[] = [
  { r: -1, c: -1 },
  { r: -1, c: 1 },
  { r: 1, c: -1 },
  { r: 1, c: 1 }
];

function inBounds(r: number, c: number) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function sqKey(s: Square) {
  return `${s.r},${s.c}`;
}

export function sameSquare(a: Square | null | undefined, b: Square | null | undefined) {
  return Boolean(a && b && a.r === b.r && a.c === b.c);
}

export function squareLabel(sq: Square) {
  return `${String.fromCharCode(97 + sq.c)}${8 - sq.r}`;
}

export function encodePromo(type: ChessPieceType): Square {
  const i = PROMO_TYPES.indexOf(type);
  return { r: 8, c: i < 0 ? 0 : i };
}

export function decodePromo(path: Square[]): ChessPieceType | null {
  if (path.length < 3) return null;
  const extra = path[2];
  if (extra.r !== 8) return null;
  return PROMO_TYPES[extra.c] ?? "queen";
}

function clonePiece(p: ChessPiece): ChessPiece {
  return { id: p.id, color: p.color, type: p.type };
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((cell) => (cell ? clonePiece(cell) : null)));
}

function emptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array<ChessCell>(8).fill(null));
}

function at(board: Board, s: Square) {
  return board[s.r][s.c];
}

export function boardFromSnapshot(snapshot: ChessSnapshot): Board {
  const board = emptyBoard();
  for (const piece of snapshot.pieces) {
    if (!inBounds(piece.r, piece.c)) continue;
    board[piece.r][piece.c] = { id: piece.id, color: piece.color, type: piece.type };
  }
  return board;
}

export function snapshotFromBoard(
  board: Board,
  rest: Omit<ChessSnapshot, "pieces" | "kind">
): ChessSnapshot {
  const pieces: ChessSnapshot["pieces"] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell) pieces.push({ ...cell, r, c });
    }
  }
  return { ...rest, kind: "chess", pieces };
}

function place(board: Board, id: string, type: ChessPieceType, color: GameColor, r: number, c: number) {
  board[r][c] = { id, color, type };
}

export function createInitialSnapshot(score?: { white: number; black: number }): ChessSnapshot {
  const board = emptyBoard();
  const back: ChessPieceType[] = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let c = 0; c < 8; c++) {
    place(board, `b-${back[c]}-${files[c]}`, back[c], "black", 0, c);
    place(board, `b-pawn-${files[c]}`, "pawn", "black", 1, c);
    place(board, `w-pawn-${files[c]}`, "pawn", "white", 6, c);
    place(board, `w-${back[c]}-${files[c]}`, back[c], "white", 7, c);
  }
  const castling: ChessCastling = { whiteK: true, whiteQ: true, blackK: true, blackQ: true };
  const snap = snapshotFromBoard(board, {
    turn: "white",
    winner: null,
    score: score ?? { white: 0, black: 0 },
    lastMove: null,
    drawOfferedBy: null,
    castling,
    enPassant: null,
    halfmove: 0,
    positionKeys: [],
    inCheck: false,
    lastCapture: false
  });
  snap.positionKeys = [positionKey(snap, board)];
  return snap;
}

function findKing(board: Board, color: GameColor): Square | null {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell?.type === "king" && cell.color === color) return { r, c };
    }
  }
  return null;
}

function rayHits(board: Board, from: Square, dirs: Square[], want: ChessPieceType[], byColor: GameColor) {
  for (const dir of dirs) {
    let r = from.r + dir.r;
    let c = from.c + dir.c;
    while (inBounds(r, c)) {
      const piece = board[r][c];
      if (piece) {
        if (piece.color === byColor && want.includes(piece.type)) return true;
        break;
      }
      r += dir.r;
      c += dir.c;
    }
  }
  return false;
}

export function isSquareAttacked(board: Board, square: Square, byColor: GameColor) {
  const pawnDir = byColor === "white" ? 1 : -1;
  for (const dc of [-1, 1]) {
    const r = square.r + pawnDir;
    const c = square.c + dc;
    if (inBounds(r, c)) {
      const piece = board[r][c];
      if (piece?.type === "pawn" && piece.color === byColor) return true;
    }
  }
  for (const d of KNIGHT_DELTAS) {
    const r = square.r + d.r;
    const c = square.c + d.c;
    if (!inBounds(r, c)) continue;
    const piece = board[r][c];
    if (piece?.type === "knight" && piece.color === byColor) return true;
  }
  for (const d of KING_DELTAS) {
    const r = square.r + d.r;
    const c = square.c + d.c;
    if (!inBounds(r, c)) continue;
    const piece = board[r][c];
    if (piece?.type === "king" && piece.color === byColor) return true;
  }
  if (rayHits(board, square, ROOK_DIRS, ["rook", "queen"], byColor)) return true;
  if (rayHits(board, square, BISHOP_DIRS, ["bishop", "queen"], byColor)) return true;
  return false;
}

export function isInCheck(board: Board, color: GameColor) {
  const king = findKing(board, color);
  if (!king) return true;
  return isSquareAttacked(board, king, color === "white" ? "black" : "white");
}

function pushMove(
  out: ChessMove[],
  from: Square,
  to: Square,
  capture: boolean,
  promo: ChessPieceType | null
) {
  const path = promo ? [from, to, encodePromo(promo)] : [from, to];
  out.push({ path, from, to, promo, capture });
}

function pawnMoves(board: Board, from: Square, color: GameColor, enPassant: Square | null, out: ChessMove[]) {
  const dir = color === "white" ? -1 : 1;
  const startRow = color === "white" ? 6 : 1;
  const lastRow = color === "white" ? 0 : 7;
  const one: Square = { r: from.r + dir, c: from.c };
  const addPawn = (to: Square, capture: boolean) => {
    if (to.r === lastRow) {
      for (const promo of PROMO_TYPES) pushMove(out, from, to, capture, promo);
    } else {
      pushMove(out, from, to, capture, null);
    }
  };
  if (inBounds(one.r, one.c) && !at(board, one)) {
    addPawn(one, false);
    const two: Square = { r: from.r + dir * 2, c: from.c };
    if (from.r === startRow && inBounds(two.r, two.c) && !at(board, two)) addPawn(two, false);
  }
  for (const dc of [-1, 1]) {
    const cap: Square = { r: from.r + dir, c: from.c + dc };
    if (!inBounds(cap.r, cap.c)) continue;
    const victim = at(board, cap);
    if (victim && victim.color !== color) addPawn(cap, true);
    else if (enPassant && sameSquare(enPassant, cap)) addPawn(cap, true);
  }
}

function slideMoves(board: Board, from: Square, color: GameColor, dirs: Square[], out: ChessMove[]) {
  for (const dir of dirs) {
    let r = from.r + dir.r;
    let c = from.c + dir.c;
    while (inBounds(r, c)) {
      const piece = board[r][c];
      if (!piece) {
        pushMove(out, from, { r, c }, false, null);
      } else {
        if (piece.color !== color) pushMove(out, from, { r, c }, true, null);
        break;
      }
      r += dir.r;
      c += dir.c;
    }
  }
}

function kingMoves(board: Board, from: Square, color: GameColor, out: ChessMove[]) {
  for (const d of KING_DELTAS) {
    const to = { r: from.r + d.r, c: from.c + d.c };
    if (!inBounds(to.r, to.c)) continue;
    const piece = at(board, to);
    if (piece && piece.color === color) continue;
    pushMove(out, from, to, Boolean(piece), null);
  }
}

function empty(board: Board, r: number, c: number) {
  return inBounds(r, c) && !board[r][c];
}

function castleMoves(
  board: Board,
  color: GameColor,
  castling: ChessCastling,
  out: ChessMove[]
) {
  const row = color === "white" ? 7 : 0;
  const kingFrom: Square = { r: row, c: 4 };
  const enemy: GameColor = color === "white" ? "black" : "white";
  const rightsK = color === "white" ? castling.whiteK : castling.blackK;
  const rightsQ = color === "white" ? castling.whiteQ : castling.blackQ;
  const king = at(board, kingFrom);
  if (!king || king.type !== "king" || king.color !== color) return;
  if (isSquareAttacked(board, kingFrom, enemy)) return;

  if (rightsK && empty(board, row, 5) && empty(board, row, 6)) {
    const rook = board[row][7];
    if (rook?.type === "rook" && rook.color === color) {
      if (!isSquareAttacked(board, { r: row, c: 5 }, enemy) && !isSquareAttacked(board, { r: row, c: 6 }, enemy)) {
        pushMove(out, kingFrom, { r: row, c: 6 }, false, null);
      }
    }
  }
  if (rightsQ && empty(board, row, 3) && empty(board, row, 2) && empty(board, row, 1)) {
    const rook = board[row][0];
    if (rook?.type === "rook" && rook.color === color) {
      if (!isSquareAttacked(board, { r: row, c: 3 }, enemy) && !isSquareAttacked(board, { r: row, c: 2 }, enemy)) {
        pushMove(out, kingFrom, { r: row, c: 2 }, false, null);
      }
    }
  }
}

function pseudoMoves(board: Board, snapshot: Pick<ChessSnapshot, "turn" | "castling" | "enPassant">): ChessMove[] {
  const color = snapshot.turn;
  const out: ChessMove[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece.color !== color) continue;
      const from = { r, c };
      if (piece.type === "pawn") pawnMoves(board, from, color, snapshot.enPassant, out);
      else if (piece.type === "knight") {
        for (const d of KNIGHT_DELTAS) {
          const to = { r: r + d.r, c: c + d.c };
          if (!inBounds(to.r, to.c)) continue;
          const target = at(board, to);
          if (target && target.color === color) continue;
          pushMove(out, from, to, Boolean(target), null);
        }
      } else if (piece.type === "bishop") slideMoves(board, from, color, BISHOP_DIRS, out);
      else if (piece.type === "rook") slideMoves(board, from, color, ROOK_DIRS, out);
      else if (piece.type === "queen") slideMoves(board, from, color, [...ROOK_DIRS, ...BISHOP_DIRS], out);
      else if (piece.type === "king") kingMoves(board, from, color, out);
    }
  }
  castleMoves(board, color, snapshot.castling, out);
  return out;
}

function applyOnBoard(
  board: Board,
  move: ChessMove,
  enPassant: Square | null
): { board: Board; captured: boolean; pawnMove: boolean; castle: boolean } {
  const next = cloneBoard(board);
  const moving = at(next, move.from);
  if (!moving) return { board: next, captured: false, pawnMove: false, castle: false };
  const target = at(next, move.to);
  let captured = Boolean(target);
  next[move.from.r][move.from.c] = null;
  let piece: ChessPiece = clonePiece(moving);
  if (move.promo) piece = { ...piece, type: move.promo };

  const isCastle = piece.type === "king" && Math.abs(move.to.c - move.from.c) === 2;
  if (isCastle) {
    const row = move.from.r;
    if (move.to.c === 6) {
      const rook = next[row][7];
      next[row][7] = null;
      next[row][5] = rook;
    } else if (move.to.c === 2) {
      const rook = next[row][0];
      next[row][0] = null;
      next[row][3] = rook;
    }
  }

  if (moving.type === "pawn" && enPassant && sameSquare(move.to, enPassant) && !target) {
    const dir = moving.color === "white" ? 1 : -1;
    next[move.to.r + dir][move.to.c] = null;
    captured = true;
  }

  next[move.to.r][move.to.c] = piece;
  return { board: next, captured, pawnMove: moving.type === "pawn", castle: isCastle };
}

export function listLegalMoves(snapshot: ChessSnapshot): ChessMove[] {
  if (snapshot.winner) return [];
  const board = boardFromSnapshot(snapshot);
  const color = snapshot.turn;
  const legal: ChessMove[] = [];
  for (const move of pseudoMoves(board, snapshot)) {
    const applied = applyOnBoard(board, move, snapshot.enPassant);
    if (!isInCheck(applied.board, color)) legal.push(move);
  }
  return legal;
}

export function legalTargets(snapshot: ChessSnapshot, from: Square): Square[] {
  const seen = new Set<string>();
  const out: Square[] = [];
  for (const move of listLegalMoves(snapshot)) {
    if (!sameSquare(move.from, from)) continue;
    const key = sqKey(move.to);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(move.to);
  }
  return out;
}

export function isPromotionMove(snapshot: ChessSnapshot, from: Square, to: Square) {
  const piece = snapshot.pieces.find((p) => p.r === from.r && p.c === from.c);
  if (!piece || piece.type !== "pawn") return false;
  const lastRow = piece.color === "white" ? 0 : 7;
  return to.r === lastRow;
}

function updateCastling(castling: ChessCastling, from: Square, to: Square, moving: ChessPiece): ChessCastling {
  const next = { ...castling };
  if (moving.type === "king") {
    if (moving.color === "white") {
      next.whiteK = false;
      next.whiteQ = false;
    } else {
      next.blackK = false;
      next.blackQ = false;
    }
  }
  const clearCorner = (r: number, c: number) => {
    if (r === 7 && c === 7) next.whiteK = false;
    if (r === 7 && c === 0) next.whiteQ = false;
    if (r === 0 && c === 7) next.blackK = false;
    if (r === 0 && c === 0) next.blackQ = false;
  };
  if (moving.type === "rook") clearCorner(from.r, from.c);
  clearCorner(to.r, to.c);
  return next;
}

function letter(piece: ChessPiece) {
  const map: Record<ChessPieceType, string> = {
    king: "k",
    queen: "q",
    rook: "r",
    bishop: "b",
    knight: "n",
    pawn: "p"
  };
  const ch = map[piece.type];
  return piece.color === "white" ? ch.toUpperCase() : ch;
}

function positionKey(snapshot: Pick<ChessSnapshot, "turn" | "castling" | "enPassant">, board: Board) {
  let cells = "";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      cells += piece ? letter(piece) : ".";
    }
  }
  const cas = snapshot.castling;
  const ep = snapshot.enPassant ? sqKey(snapshot.enPassant) : "-";
  return `${snapshot.turn}|${cas.whiteK ? "K" : ""}${cas.whiteQ ? "Q" : ""}${cas.blackK ? "k" : ""}${cas.blackQ ? "q" : ""}|${ep}|${cells}`;
}

function isInsufficientMaterial(board: Board) {
  const extras: Array<{ type: ChessPieceType; color: GameColor; r: number; c: number }> = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece.type === "king") continue;
      extras.push({ type: piece.type, color: piece.color, r, c });
    }
  }
  if (extras.length === 0) return true;
  if (extras.some((p) => p.type === "queen" || p.type === "rook" || p.type === "pawn")) return false;
  if (extras.length === 1 && (extras[0].type === "knight" || extras[0].type === "bishop")) return true;
  if (extras.length === 2 && extras.every((p) => p.type === "bishop")) {
    const a = extras[0];
    const b = extras[1];
    if (a.color !== b.color && (a.r + a.c) % 2 === (b.r + b.c) % 2) return true;
  }
  return false;
}

export function applyPath(snapshot: ChessSnapshot, path: Square[]): ChessSnapshot | null {
  if (snapshot.winner || path.length < 2) return null;
  const from = path[0];
  const to = path[1];
  let promo = decodePromo(path);
  if (!promo && isPromotionMove(snapshot, from, to)) promo = "queen";
  const legal = listLegalMoves(snapshot);
  const match = legal.find(
    (move) =>
      sameSquare(move.from, from) &&
      sameSquare(move.to, to) &&
      (move.promo ?? null) === (promo ?? null)
  );
  if (!match) return null;
  const board = boardFromSnapshot(snapshot);
  const moving = at(board, from);
  if (!moving) return null;
  const applied = applyOnBoard(board, match, snapshot.enPassant);
  const opponent: GameColor = snapshot.turn === "white" ? "black" : "white";
  let enPassant: Square | null = null;
  if (moving.type === "pawn" && Math.abs(to.r - from.r) === 2) {
    enPassant = { r: (from.r + to.r) / 2, c: from.c };
  }
  const halfmove = applied.pawnMove || applied.captured ? 0 : snapshot.halfmove + 1;
  const nextTurn: GameColor = opponent;
  const inCheck = isInCheck(applied.board, nextTurn);
  const nextPartial: Omit<ChessSnapshot, "pieces" | "kind"> = {
    turn: nextTurn,
    winner: null,
    score: snapshot.score,
    lastMove: [from, to],
    drawOfferedBy: null,
    castling: updateCastling(snapshot.castling, from, to, moving),
    enPassant,
    halfmove,
    positionKeys: snapshot.positionKeys,
    inCheck,
    lastCapture: applied.captured
  };
  const key = positionKey(nextPartial, applied.board);
  const positionKeys = [...snapshot.positionKeys, key].slice(-200);
  nextPartial.positionKeys = positionKeys;

  let winner: ChessSnapshot["winner"] = null;
  const probe: ChessSnapshot = snapshotFromBoard(applied.board, nextPartial);
  const reply = listLegalMoves(probe);
  if (reply.length === 0) winner = inCheck ? snapshot.turn : "draw";
  else if (halfmove >= 100) winner = "draw";
  else if (positionKeys.filter((k) => k === key).length >= 3) winner = "draw";
  else if (isInsufficientMaterial(applied.board)) winner = "draw";

  probe.winner = winner;
  if (winner && winner !== "draw") {
    probe.score = { ...probe.score, [winner]: probe.score[winner] + 1 };
  }
  return probe;
}

export function applyResign(snapshot: ChessSnapshot, by: GameColor): ChessSnapshot {
  if (snapshot.winner) return snapshot;
  const winner: GameColor = by === "white" ? "black" : "white";
  return {
    ...snapshot,
    winner,
    drawOfferedBy: null,
    score: { ...snapshot.score, [winner]: snapshot.score[winner] + 1 }
  };
}

export function applyDraw(snapshot: ChessSnapshot): ChessSnapshot {
  if (snapshot.winner) return snapshot;
  return { ...snapshot, winner: "draw", drawOfferedBy: null };
}

export function remainingPieces(snapshot: ChessSnapshot, color: GameColor) {
  return snapshot.pieces.filter((p) => p.color === color).length;
}

export function materialOf(snapshot: ChessSnapshot, color: GameColor) {
  return snapshot.pieces
    .filter((p) => p.color === color)
    .reduce((sum, p) => sum + PIECE_VALUE[p.type], 0);
}

const START_COUNTS: Record<ChessPieceType, number> = {
  king: 1,
  queen: 1,
  rook: 2,
  bishop: 2,
  knight: 2,
  pawn: 8
};

const CAPTURE_ORDER: ChessPieceType[] = ["pawn", "knight", "bishop", "rook", "queen"];

export function capturedBy(snapshot: ChessSnapshot, capturer: GameColor): ChessPieceType[] {
  const victim: GameColor = capturer === "white" ? "black" : "white";
  const have: Record<ChessPieceType, number> = {
    king: 0,
    queen: 0,
    rook: 0,
    bishop: 0,
    knight: 0,
    pawn: 0
  };
  for (const piece of snapshot.pieces) {
    if (piece.color === victim) have[piece.type] += 1;
  }
  const out: ChessPieceType[] = [];
  for (const type of CAPTURE_ORDER) {
    const missing = Math.max(0, START_COUNTS[type] - have[type]);
    for (let i = 0; i < missing; i++) out.push(type);
  }
  return out;
}

export function kingSquare(snapshot: ChessSnapshot, color: GameColor): Square | null {
  const piece = snapshot.pieces.find((p) => p.color === color && p.type === "king");
  return piece ? { r: piece.r, c: piece.c } : null;
}

export function pieceAt(snapshot: ChessSnapshot, r: number, c: number) {
  return snapshot.pieces.find((p) => p.r === r && p.c === c) ?? null;
}
