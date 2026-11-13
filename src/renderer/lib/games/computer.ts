import { applyGameMove } from "./lifecycle";
import { BS_FLEET, BS_SIZE, isShipSunk } from "./battleship/engine";
import { listLegalMoves as listCheckersMoves } from "./checkers/engine";
import { listLegalMoves as listChessMoves, type ChessMove } from "./chess/engine";
import type {
  BattleshipSide,
  BattleshipSnapshot,
  CheckersSnapshot,
  ChessPieceType,
  ChessSnapshot,
  GameColor,
  GameDifficulty,
  GameSnapshot,
  Square
} from "./types";

export const COMPUTER_PEER_ID = "computer";

const CHESS_VALUE: Record<ChessPieceType, number> = {
  king: 0,
  queen: 900,
  rook: 500,
  bishop: 330,
  knight: 320,
  pawn: 100
};

type SearchMove = { path: Square[]; rank: number };

function centerPull(r: number, c: number) {
  return 8 - Math.round((Math.abs(r - 3.5) + Math.abs(c - 3.5)) * 2);
}

function evalChess(snapshot: ChessSnapshot) {
  const me = snapshot.turn;
  let material = 0;
  let score = snapshot.inCheck ? -28 : 0;
  for (const piece of snapshot.pieces) {
    if (piece.type !== "king") material += CHESS_VALUE[piece.type];
  }
  const endgame = material < 1500;
  for (const piece of snapshot.pieces) {
    let value = CHESS_VALUE[piece.type];
    if (piece.type === "pawn") {
      const adv = piece.color === "white" ? 6 - piece.r : piece.r - 1;
      value += Math.max(0, adv) * 6 + centerPull(piece.r, piece.c);
    } else if (piece.type === "knight" || piece.type === "bishop") {
      value += centerPull(piece.r, piece.c) * 2;
    } else if (piece.type === "king" && endgame) {
      value += centerPull(piece.r, piece.c) * 6;
    }
    score += piece.color === me ? value : -value;
  }
  return score;
}

function evalCheckers(snapshot: CheckersSnapshot) {
  const me = snapshot.turn;
  let score = 0;
  for (const piece of snapshot.pieces) {
    const adv = piece.color === "white" ? 7 - piece.r : piece.r;
    const value = piece.king ? 36 + centerPull(piece.r, piece.c) : 10 + adv * 2;
    score += piece.color === me ? value : -value;
  }
  return score;
}

function terminalScore(snapshot: GameSnapshot) {
  if (!snapshot.winner) return null;
  if (snapshot.winner === "draw") return 0;
  return snapshot.winner === snapshot.turn ? 100_000 : -100_000;
}

function evaluate(snapshot: GameSnapshot) {
  const done = terminalScore(snapshot);
  if (done !== null) return done;
  if (snapshot.kind === "chess") return evalChess(snapshot);
  if (snapshot.kind === "checkers") return evalCheckers(snapshot);
  return 0;
}

function movesOf(snapshot: GameSnapshot): SearchMove[] {
  if (snapshot.kind === "chess") {
    return listChessMoves(snapshot).map((move: ChessMove) => ({
      path: move.path,
      rank: (move.capture ? 4 : 0) + (move.promo ? 5 : 0)
    }));
  }
  if (snapshot.kind === "checkers") {
    return listCheckersMoves(snapshot).map((move) => ({
      path: move.path,
      rank: move.captures.length * 4 + (move.path[move.path.length - 1]?.r === 0 || move.path[move.path.length - 1]?.r === 7 ? 1 : 0)
    }));
  }
  return [];
}

function searchBest(snapshot: CheckersSnapshot | ChessSnapshot, difficulty: GameDifficulty): Square[] | null {
  const rootMoves = movesOf(snapshot).sort((a, b) => b.rank - a.rank);
  if (rootMoves.length === 0) return null;
  const maxDepth = difficulty === "hard" ? 3 : difficulty === "medium" ? 2 : 1;
  const budgetMs = difficulty === "hard" ? 520 : difficulty === "medium" ? 220 : 40;
  const deadline = performance.now() + budgetMs;
  let bestPath = rootMoves[0].path;
  const aborted = { v: false };

  const negamax = (node: GameSnapshot, depth: number, alphaIn: number, betaIn: number): number => {
    const done = terminalScore(node);
    if (done !== null) return done;
    if (depth === 0 || performance.now() > deadline) {
      if (performance.now() > deadline) aborted.v = true;
      return evaluate(node);
    }
    const moves = movesOf(node).sort((a, b) => b.rank - a.rank);
    if (moves.length === 0) return evaluate(node);
    let alpha = alphaIn;
    let best = -200_000;
    for (const move of moves) {
      const next = applyGameMove(node, move.path);
      if (!next) continue;
      const score = -negamax(next, depth - 1, -betaIn, -alpha);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= betaIn) break;
      if (aborted.v) break;
    }
    return best;
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    aborted.v = false;
    let best = -200_000;
    let path = bestPath;
    let alpha = -200_000;
    for (const move of rootMoves) {
      const next = applyGameMove(snapshot, move.path);
      if (!next) continue;
      let score = -negamax(next, depth - 1, -200_000, -alpha);
      if (difficulty === "easy") score += (Math.random() - 0.5) * 160;
      else if (difficulty === "medium") score += (Math.random() - 0.5) * 16;
      if (score > best) {
        best = score;
        path = move.path;
      }
      if (score > alpha) alpha = score;
      if (aborted.v) break;
    }
    if (!aborted.v) bestPath = path;
    if (aborted.v || performance.now() > deadline) break;
  }
  return bestPath;
}

function inBoard(r: number, c: number) {
  return r >= 0 && r < BS_SIZE && c >= 0 && c < BS_SIZE;
}

function shotKey(r: number, c: number) {
  return `${r},${c}`;
}

function remainingSizes(side: BattleshipSide) {
  const left = [...BS_FLEET];
  for (const ship of side.ships) {
    if (!isShipSunk(ship, side.incoming)) continue;
    const idx = left.indexOf(ship.size as (typeof BS_FLEET)[number]);
    if (idx >= 0) left.splice(idx, 1);
  }
  return left;
}

function heatmap(side: BattleshipSide) {
  const blocked = new Set<string>();
  for (const shot of side.incoming) {
    if (shot.result !== "hit") blocked.add(shotKey(shot.r, shot.c));
  }
  const grid = Array.from({ length: BS_SIZE }, () => Array<number>(BS_SIZE).fill(0));
  for (const size of remainingSizes(side)) {
    for (let r = 0; r < BS_SIZE; r++) {
      for (let c = 0; c < BS_SIZE; c++) {
        for (const horizontal of [true, false]) {
          const cells: Square[] = [];
          let ok = true;
          for (let i = 0; i < size; i++) {
            const rr = r + (horizontal ? 0 : i);
            const cc = c + (horizontal ? i : 0);
            if (!inBoard(rr, cc) || blocked.has(shotKey(rr, cc))) {
              ok = false;
              break;
            }
            cells.push({ r: rr, c: cc });
          }
          if (!ok) continue;
          for (const cell of cells) {
            if (side.incoming.some((shot) => shot.r === cell.r && shot.c === cell.c)) continue;
            grid[cell.r][cell.c] += 1;
          }
        }
      }
    }
  }
  return grid;
}

function targetCells(hits: Square[], tried: Set<string>) {
  const out: Square[] = [];
  const push = (r: number, c: number) => {
    if (!inBoard(r, c) || tried.has(shotKey(r, c))) return;
    if (out.some((cell) => cell.r === r && cell.c === c)) return;
    out.push({ r, c });
  };
  if (hits.length >= 2) {
    const sameRow = hits.every((cell) => cell.r === hits[0].r);
    const sameCol = hits.every((cell) => cell.c === hits[0].c);
    if (sameRow) {
      const cols = hits.map((cell) => cell.c);
      push(hits[0].r, Math.min(...cols) - 1);
      push(hits[0].r, Math.max(...cols) + 1);
    }
    if (sameCol) {
      const rows = hits.map((cell) => cell.r);
      push(Math.min(...rows) - 1, hits[0].c);
      push(Math.max(...rows) + 1, hits[0].c);
    }
    if (out.length > 0) return out;
  }
  for (const hit of hits) {
    push(hit.r - 1, hit.c);
    push(hit.r + 1, hit.c);
    push(hit.r, hit.c - 1);
    push(hit.r, hit.c + 1);
  }
  return out;
}

function chooseBattleshipShot(snapshot: BattleshipSnapshot, difficulty: GameDifficulty): Square[] | null {
  const defender: BattleshipSide = snapshot.turn === "white" ? snapshot.black : snapshot.white;
  const tried = new Set(defender.incoming.map((shot) => shotKey(shot.r, shot.c)));
  const unknown: Square[] = [];
  for (let r = 0; r < BS_SIZE; r++) {
    for (let c = 0; c < BS_SIZE; c++) {
      if (!tried.has(shotKey(r, c))) unknown.push({ r, c });
    }
  }
  if (unknown.length === 0) return null;
  const hits = defender.incoming.filter((shot) => shot.result === "hit").map((shot) => ({ r: shot.r, c: shot.c }));
  if (difficulty !== "easy" && hits.length > 0) {
    const aimed = targetCells(hits, tried);
    if (aimed.length > 0) {
      if (difficulty === "medium") return [aimed[Math.floor(Math.random() * aimed.length)]];
      const heat = heatmap(defender);
      aimed.sort((a, b) => heat[b.r][b.c] - heat[a.r][a.c]);
      const best = heat[aimed[0].r][aimed[0].c];
      const tied = aimed.filter((cell) => heat[cell.r][cell.c] === best);
      return [tied[Math.floor(Math.random() * tied.length)]];
    }
  }
  if (difficulty === "easy") {
    if (hits.length > 0 && Math.random() < 0.35) {
      const aimed = targetCells(hits, tried);
      if (aimed.length > 0) return [aimed[Math.floor(Math.random() * aimed.length)]];
    }
    return [unknown[Math.floor(Math.random() * unknown.length)]];
  }
  const heat = heatmap(defender);
  let pool = unknown;
  if (difficulty === "medium" && hits.length === 0) {
    const parity = unknown.filter((cell) => (cell.r + cell.c) % 2 === 0);
    if (parity.length > 0) pool = parity;
  }
  let best = -1;
  const tied: Square[] = [];
  for (const cell of pool) {
    const value = heat[cell.r][cell.c];
    if (value > best) {
      best = value;
      tied.length = 0;
      tied.push(cell);
    } else if (value === best) tied.push(cell);
  }
  const pick = tied[Math.floor(Math.random() * tied.length)] ?? pool[0];
  return [pick];
}

export function chooseComputerMove(snapshot: GameSnapshot, color: GameColor, difficulty: GameDifficulty): Square[] | null {
  if (snapshot.winner || snapshot.turn !== color) return null;
  if (snapshot.kind === "battleship") {
    if (snapshot.phase !== "battle") return null;
    return chooseBattleshipShot(snapshot, difficulty);
  }
  if (snapshot.kind === "chess" || snapshot.kind === "checkers") return searchBest(snapshot, difficulty);
  return null;
}
