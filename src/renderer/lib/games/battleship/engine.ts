import type {
  BattleshipShip,
  BattleshipShot,
  BattleshipSide,
  BattleshipSnapshot,
  GameColor,
  Square
} from "../types";

export const BS_SIZE = 10;
export const BS_FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1] as const;

const AROUND = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
];

function inBounds(r: number, c: number) {
  return r >= 0 && r < BS_SIZE && c >= 0 && c < BS_SIZE;
}

function keyOf(r: number, c: number) {
  return `${r},${c}`;
}

function emptySide(): BattleshipSide {
  return { ready: false, ships: [], incoming: [] };
}

export function createBattleshipSnapshot(score?: { white: number; black: number }): BattleshipSnapshot {
  return {
    kind: "battleship",
    phase: "placing",
    turn: "white",
    winner: null,
    score: score ?? { white: 0, black: 0 },
    white: emptySide(),
    black: emptySide(),
    lastShot: null,
    drawOfferedBy: null
  };
}

export function shipCells(origin: Square, size: number, horizontal: boolean): Square[] | null {
  const cells: Square[] = [];
  for (let i = 0; i < size; i++) {
    const r = origin.r + (horizontal ? 0 : i);
    const c = origin.c + (horizontal ? i : 0);
    if (!inBounds(r, c)) return null;
    cells.push({ r, c });
  }
  return cells;
}

function occupiedKeys(ships: BattleshipShip[], exceptId?: string) {
  const set = new Set<string>();
  for (const ship of ships) {
    if (exceptId && ship.id === exceptId) continue;
    for (const cell of ship.cells) set.add(keyOf(cell.r, cell.c));
  }
  return set;
}

function blockedKeys(ships: BattleshipShip[], exceptId?: string) {
  const blocked = new Set<string>();
  for (const ship of ships) {
    if (exceptId && ship.id === exceptId) continue;
    for (const cell of ship.cells) {
      blocked.add(keyOf(cell.r, cell.c));
      for (const [dr, dc] of AROUND) {
        const r = cell.r + dr;
        const c = cell.c + dc;
        if (inBounds(r, c)) blocked.add(keyOf(r, c));
      }
    }
  }
  return blocked;
}

export function canPlaceShip(ships: BattleshipShip[], cells: Square[], exceptId?: string) {
  if (!cells.length) return false;
  const blocked = blockedKeys(ships, exceptId);
  return cells.every((cell) => !blocked.has(keyOf(cell.r, cell.c)));
}

export function validateFleet(ships: BattleshipShip[]) {
  if (ships.length !== BS_FLEET.length) return false;
  const sizes = ships.map((s) => s.size).sort((a, b) => b - a);
  const expected = [...BS_FLEET];
  if (sizes.some((size, i) => size !== expected[i])) return false;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i];
    if (ship.cells.length !== ship.size) return false;
    const horiz = ship.cells.every((c) => c.r === ship.cells[0].r);
    const vert = ship.cells.every((c) => c.c === ship.cells[0].c);
    if (!horiz && !vert) return false;
    if (!canPlaceShip(ships, ship.cells, ship.id)) return false;
  }
  return true;
}

export function randomFleet(): BattleshipShip[] {
  const ships: BattleshipShip[] = [];
  for (let i = 0; i < BS_FLEET.length; i++) {
    const size = BS_FLEET[i];
    let placed: BattleshipShip | null = null;
    for (let attempt = 0; attempt < 400; attempt++) {
      const horizontal = Math.random() < 0.5;
      const origin = {
        r: Math.floor(Math.random() * BS_SIZE),
        c: Math.floor(Math.random() * BS_SIZE)
      };
      const cells = shipCells(origin, size, horizontal);
      if (!cells || !canPlaceShip(ships, cells)) continue;
      placed = { id: `s${i}-${size}`, size, cells };
      break;
    }
    if (!placed) return randomFleet();
    ships.push(placed);
  }
  return ships;
}

function sideOf(snapshot: BattleshipSnapshot, color: GameColor) {
  return color === "white" ? snapshot.white : snapshot.black;
}

function withSide(snapshot: BattleshipSnapshot, color: GameColor, side: BattleshipSide): BattleshipSnapshot {
  return color === "white" ? { ...snapshot, white: side } : { ...snapshot, black: side };
}

export function applyBattleshipPlace(
  snapshot: BattleshipSnapshot,
  color: GameColor,
  ships: BattleshipShip[]
): BattleshipSnapshot | null {
  if (snapshot.phase !== "placing" || snapshot.winner) return null;
  const current = sideOf(snapshot, color);
  if (current.ready) return null;
  if (!validateFleet(ships)) return null;
  const next = withSide(snapshot, color, { ready: true, ships, incoming: [] });
  if (next.white.ready && next.black.ready) {
    return { ...next, phase: "battle", turn: "white", lastShot: null };
  }
  return next;
}

function shotAt(incoming: BattleshipShot[], r: number, c: number) {
  return incoming.find((s) => s.r === r && s.c === c) ?? null;
}

export function shipAt(ships: BattleshipShip[], r: number, c: number) {
  return ships.find((ship) => ship.cells.some((cell) => cell.r === r && cell.c === c)) ?? null;
}

export function isShipSunk(ship: BattleshipShip, incoming: BattleshipShot[]) {
  return ship.cells.every((cell) => {
    const hit = shotAt(incoming, cell.r, cell.c);
    return Boolean(hit && hit.result !== "miss");
  });
}

export function allShipsSunk(ships: BattleshipShip[], incoming: BattleshipShot[]) {
  return ships.length > 0 && ships.every((ship) => isShipSunk(ship, incoming));
}

function surroundSunk(ship: BattleshipShip, incoming: BattleshipShot[]): BattleshipShot[] {
  const extra: BattleshipShot[] = [...incoming];
  const seen = new Set(incoming.map((s) => keyOf(s.r, s.c)));
  for (const cell of ship.cells) {
    for (const [dr, dc] of AROUND) {
      const r = cell.r + dr;
      const c = cell.c + dc;
      if (!inBounds(r, c) || seen.has(keyOf(r, c))) continue;
      if (shipAt([ship], r, c)) continue;
      extra.push({ r, c, result: "miss" });
      seen.add(keyOf(r, c));
    }
  }
  return extra;
}

export function applyBattleshipShot(
  snapshot: BattleshipSnapshot,
  path: Square[]
): BattleshipSnapshot | null {
  if (snapshot.phase !== "battle" || snapshot.winner || path.length !== 1) return null;
  const target = path[0];
  if (!inBounds(target.r, target.c)) return null;
  const attacker = snapshot.turn;
  const defender: GameColor = attacker === "white" ? "black" : "white";
  const defSide = sideOf(snapshot, defender);
  if (shotAt(defSide.incoming, target.r, target.c)) return null;
  const ship = shipAt(defSide.ships, target.r, target.c);
  let incoming = [...defSide.incoming];
  let result: BattleshipShot["result"] = "miss";
  if (ship) {
    incoming.push({ r: target.r, c: target.c, result: "hit" });
    if (isShipSunk(ship, incoming)) {
      incoming = incoming.map((s) =>
        ship.cells.some((cell) => cell.r === s.r && cell.c === s.c) ? { ...s, result: "sunk" as const } : s
      );
      incoming = surroundSunk(ship, incoming);
      result = "sunk";
    } else {
      result = "hit";
    }
  } else {
    incoming.push({ r: target.r, c: target.c, result: "miss" });
  }
  const nextDef = { ...defSide, incoming };
  let next = withSide(snapshot, defender, nextDef);
  const winner = allShipsSunk(nextDef.ships, incoming) ? attacker : null;
  next = {
    ...next,
    lastShot: { r: target.r, c: target.c, result, by: attacker },
    turn: result === "miss" ? defender : attacker,
    drawOfferedBy: null,
    winner,
    phase: winner ? "over" : "battle",
    score: winner ? { ...snapshot.score, [winner]: snapshot.score[winner] + 1 } : snapshot.score
  };
  return next;
}

export function applyBattleshipResign(snapshot: BattleshipSnapshot, by: GameColor): BattleshipSnapshot {
  if (snapshot.winner) return snapshot;
  const winner: GameColor = by === "white" ? "black" : "white";
  return {
    ...snapshot,
    winner,
    phase: "over",
    drawOfferedBy: null,
    score: { ...snapshot.score, [winner]: snapshot.score[winner] + 1 }
  };
}

export function applyBattleshipDraw(snapshot: BattleshipSnapshot): BattleshipSnapshot {
  if (snapshot.winner) return snapshot;
  return { ...snapshot, winner: "draw", phase: "over", drawOfferedBy: null };
}

export function remainingShips(side: BattleshipSide) {
  if (!side.ships.length) return 0;
  return side.ships.filter((ship) => !isShipSunk(ship, side.incoming)).length;
}

export function cellLabel(r: number, c: number) {
  return `${String.fromCharCode(1040 + c)}${r + 1}`;
}

export function latinCellLabel(r: number, c: number) {
  return `${String.fromCharCode(65 + c)}${r + 1}`;
}

export function occupiedSet(ships: BattleshipShip[]) {
  return occupiedKeys(ships);
}
