export interface CallTileRef {
  source: string;
  peerId: string;
}

export function railTiles<T extends CallTileRef>(tiles: T[], selfId: string): T[] {
  const screens = new Set(tiles.filter((tile) => tile.source === "screen").map((tile) => tile.peerId));
  return tiles.filter((tile) => {
    if (tile.source === "screen") return true;
    if (tile.source === "self") return !screens.has(selfId);
    if (tile.source === "camera") return !screens.has(tile.peerId);
    return true;
  });
}

export function showSelfFloat(stage: CallTileRef | undefined, selfId: string, camOn = true): boolean {
  if (!stage || stage.source === "self") return false;
  if (stage.source === "screen" && stage.peerId === selfId) return camOn;
  return true;
}
