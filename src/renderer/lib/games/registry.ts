import type { GameCatalogItem } from "./types";

export const GAME_CATALOG: GameCatalogItem[] = [
  {
    id: "checkers",
    status: "ready",
    titleKey: "gameCheckersTitle",
    blurbKey: "gameCheckersBlurb",
    icon: "checkers"
  },
  {
    id: "chess",
    status: "ready",
    titleKey: "gameChessTitle",
    blurbKey: "gameChessBlurb",
    icon: "chess"
  },
  {
    id: "battleship",
    status: "ready",
    titleKey: "gameBattleshipTitle",
    blurbKey: "gameBattleshipBlurb",
    icon: "battleship"
  }
];

export function getGameCatalogItem(id: string) {
  return GAME_CATALOG.find((item) => item.id === id) ?? null;
}
