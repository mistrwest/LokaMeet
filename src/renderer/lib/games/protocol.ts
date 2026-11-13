import type { BattleshipShip, GameId, GamePlayer, GameSnapshot, Square } from "./types";

export type GameMessage =
  | {
      t: "game";
      action: "invite";
      sessionId: string;
      gameId: GameId;
      fromPeerId: string;
      fromUserName: string;
    }
  | {
      t: "game";
      action: "accept";
      sessionId: string;
      gameId: GameId;
    }
  | {
      t: "game";
      action: "decline";
      sessionId: string;
      gameId: GameId;
    }
  | {
      t: "game";
      action: "move";
      sessionId: string;
      path: Square[];
    }
  | {
      t: "game";
      action: "state";
      sessionId: string;
      gameId: GameId;
      hostPeerId: string;
      white: GamePlayer;
      black: GamePlayer;
      snapshot: GameSnapshot;
    }
  | {
      t: "game";
      action: "place";
      sessionId: string;
      ships: BattleshipShip[];
    }
  | {
      t: "game";
      action: "resign";
      sessionId: string;
    }
  | {
      t: "game";
      action: "draw-offer";
      sessionId: string;
    }
  | {
      t: "game";
      action: "draw-accept";
      sessionId: string;
    }
  | {
      t: "game";
      action: "draw-decline";
      sessionId: string;
    }
  | {
      t: "game";
      action: "rematch";
      sessionId: string;
    }
  | {
      t: "game";
      action: "leave";
      sessionId: string;
    }
  | {
      t: "game";
      action: "watch-offer";
      sessionId: string;
      gameId: GameId;
      hostPeerId: string;
      white: GamePlayer;
      black: GamePlayer;
      snapshot: GameSnapshot;
    }
  | {
      t: "game";
      action: "watch-join";
      sessionId: string;
    };

export function isGameMessage(value: unknown): value is GameMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { t?: unknown; action?: unknown; sessionId?: unknown };
  return msg.t === "game" && typeof msg.action === "string" && typeof msg.sessionId === "string";
}
