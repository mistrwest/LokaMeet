export type GameId = "checkers" | "chess" | "battleship";

export type GameStatus = "ready" | "soon";

export type GameColor = "white" | "black";

export type GameRole = "player" | "spectator";

export type Square = { r: number; c: number };

export type CheckersPiece = {
  id: string;
  color: GameColor;
  king: boolean;
};

export type CheckersCell = CheckersPiece | null;

export type CheckersWinner = GameColor | "draw" | null;

export type CheckersSnapshot = {
  kind: "checkers";
  pieces: Array<CheckersPiece & Square>;
  turn: GameColor;
  winner: CheckersWinner;
  continueFrom: Square | null;
  score: { white: number; black: number };
  lastMove: Square[] | null;
  drawOfferedBy: GameColor | null;
  kingMovesWithoutCapture: number;
};

export type BattleshipShotResult = "miss" | "hit" | "sunk";

export type BattleshipShot = {
  r: number;
  c: number;
  result: BattleshipShotResult;
};

export type BattleshipShip = {
  id: string;
  size: number;
  cells: Square[];
};

export type BattleshipSide = {
  ready: boolean;
  ships: BattleshipShip[];
  incoming: BattleshipShot[];
};

export type BattleshipSnapshot = {
  kind: "battleship";
  phase: "placing" | "battle" | "over";
  turn: GameColor;
  winner: CheckersWinner;
  score: { white: number; black: number };
  white: BattleshipSide;
  black: BattleshipSide;
  lastShot: (BattleshipShot & { by: GameColor }) | null;
  drawOfferedBy: GameColor | null;
};

export type ChessPieceType = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";

export type ChessPiece = {
  id: string;
  color: GameColor;
  type: ChessPieceType;
};

export type ChessCastling = {
  whiteK: boolean;
  whiteQ: boolean;
  blackK: boolean;
  blackQ: boolean;
};

export type ChessSnapshot = {
  kind: "chess";
  pieces: Array<ChessPiece & Square>;
  turn: GameColor;
  winner: CheckersWinner;
  score: { white: number; black: number };
  lastMove: Square[] | null;
  drawOfferedBy: GameColor | null;
  castling: ChessCastling;
  enPassant: Square | null;
  halfmove: number;
  positionKeys: string[];
  inCheck: boolean;
  lastCapture: boolean;
};

export type GameSnapshot = CheckersSnapshot | BattleshipSnapshot | ChessSnapshot;

export type GamePlayer = {
  peerId: string;
  userName: string;
};

export type GameDifficulty = "easy" | "medium" | "hard";

export type GameSession = {
  sessionId: string;
  gameId: GameId;
  hostPeerId: string;
  white: GamePlayer;
  black: GamePlayer;
  role: GameRole;
  myColor: GameColor | null;
  snapshot: GameSnapshot;
  collapsed: boolean;
  localRematch: boolean;
  remoteRematch: boolean;
  vsComputer?: GameDifficulty;
};

export type IncomingGameInvite = {
  sessionId: string;
  gameId: GameId;
  fromPeerId: string;
  fromUserName: string;
};

export type WatchOffer = {
  sessionId: string;
  gameId: GameId;
  hostPeerId: string;
  white: GamePlayer;
  black: GamePlayer;
  snapshot: GameSnapshot;
};

export type GameCatalogItem = {
  id: GameId;
  status: GameStatus;
  titleKey: string;
  blurbKey: string;
  icon: "checkers" | "chess" | "battleship";
};
