import {
  applyDraw as applyCheckersDraw,
  applyPath as applyCheckersPath,
  applyResign as applyCheckersResign,
  createInitialSnapshot as createCheckersSnapshot
} from "./checkers/engine";
import {
  applyDraw as applyChessDraw,
  applyPath as applyChessPath,
  applyResign as applyChessResign,
  createInitialSnapshot as createChessSnapshot
} from "./chess/engine";
import {
  applyBattleshipDraw,
  applyBattleshipPlace,
  applyBattleshipResign,
  applyBattleshipShot,
  createBattleshipSnapshot
} from "./battleship/engine";
import type {
  BattleshipShip,
  BattleshipSnapshot,
  CheckersSnapshot,
  ChessSnapshot,
  GameColor,
  GameId,
  GameSnapshot,
  Square
} from "./types";

export function isCheckersSnapshot(snapshot: GameSnapshot): snapshot is CheckersSnapshot {
  return snapshot.kind === "checkers";
}

export function isChessSnapshot(snapshot: GameSnapshot): snapshot is ChessSnapshot {
  return snapshot.kind === "chess";
}

export function isBattleshipSnapshot(snapshot: GameSnapshot): snapshot is BattleshipSnapshot {
  return snapshot.kind === "battleship";
}

export function createGameSnapshot(gameId: GameId, score?: { white: number; black: number }): GameSnapshot {
  if (gameId === "battleship") return createBattleshipSnapshot(score);
  if (gameId === "chess") return createChessSnapshot(score);
  return createCheckersSnapshot(score);
}

export function applyGameMove(snapshot: GameSnapshot, path: Square[]): GameSnapshot | null {
  if (isBattleshipSnapshot(snapshot)) return applyBattleshipShot(snapshot, path);
  if (isChessSnapshot(snapshot)) return applyChessPath(snapshot, path);
  return applyCheckersPath(snapshot, path);
}

export function applyGamePlace(
  snapshot: GameSnapshot,
  color: GameColor,
  ships: BattleshipShip[]
): GameSnapshot | null {
  if (!isBattleshipSnapshot(snapshot)) return null;
  return applyBattleshipPlace(snapshot, color, ships);
}

export function applyGameResign(snapshot: GameSnapshot, by: GameColor): GameSnapshot {
  if (isBattleshipSnapshot(snapshot)) return applyBattleshipResign(snapshot, by);
  if (isChessSnapshot(snapshot)) return applyChessResign(snapshot, by);
  return applyCheckersResign(snapshot, by);
}

export function applyGameDraw(snapshot: GameSnapshot): GameSnapshot {
  if (isBattleshipSnapshot(snapshot)) return applyBattleshipDraw(snapshot);
  if (isChessSnapshot(snapshot)) return applyChessDraw(snapshot);
  return applyCheckersDraw(snapshot);
}

export function withDrawOffer(snapshot: GameSnapshot, by: GameColor | null): GameSnapshot {
  return { ...snapshot, drawOfferedBy: by };
}
