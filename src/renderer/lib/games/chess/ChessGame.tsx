import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  capturedBy,
  isPromotionMove,
  kingSquare,
  legalTargets,
  listLegalMoves,
  materialOf,
  pieceAt,
  remainingPieces,
  sameSquare,
  squareLabel
} from "./engine";
import { ChessPieceView } from "./pieces";
import type { ChessPieceType, ChessSnapshot, GameColor, GamePlayer, GameRole, Square } from "../types";
import { DEFAULT_GAMES_SETTINGS, playGameSound, type GamesSettings } from "../settings";

const RULE_KEYS = [
  "chessRule1",
  "chessRule2",
  "chessRule3",
  "chessRule4",
  "chessRule5",
  "chessRule6",
  "chessRule7"
] as const;

const PROMO_CHOICES: ChessPieceType[] = ["queen", "rook", "bishop", "knight"];

export function ChessGame(props: {
  snapshot: ChessSnapshot;
  white: GamePlayer;
  black: GamePlayer;
  myColor: GameColor | null;
  role: GameRole;
  localRematch: boolean;
  remoteRematch: boolean;
  avatarUrls: Record<string, string>;
  onMove: (path: Square[]) => void;
  onResign: () => void;
  onDrawOffer: () => void;
  onDrawAccept: () => void;
  onDrawDecline: () => void;
  onRematch: () => void;
  onLeave: () => void;
  onToggleRules: () => void;
  rulesOpen: boolean;
  settings?: GamesSettings;
}) {
  const { t } = useTranslation();
  const { snapshot, myColor, role } = props;
  const opt = props.settings ?? DEFAULT_GAMES_SETTINGS;
  const flipped = myColor === "black";
  const [selected, setSelected] = useState<Square | null>(null);
  const [promo, setPromo] = useState<{ from: Square; to: Square } | null>(null);
  const interactive = role === "player" && !snapshot.winner && myColor === snapshot.turn && !promo;
  const lastMoveKey = (snapshot.lastMove ?? []).map((s) => `${s.r},${s.c}`).join("-");
  const soundsReady = useRef(false);

  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [snapshot.turn, snapshot.lastMove, snapshot.winner]);

  useEffect(() => {
    if (!soundsReady.current) return;
    if (!lastMoveKey) return;
    playGameSound(snapshot.lastCapture ? "hit" : "move", opt);
  }, [lastMoveKey]);

  useEffect(() => {
    if (!soundsReady.current) return;
    if (snapshot.winner && snapshot.winner !== "draw") playGameSound("win", opt);
  }, [snapshot.winner]);

  useEffect(() => {
    soundsReady.current = true;
  }, []);

  const legal = useMemo(() => listLegalMoves(snapshot), [snapshot]);
  const targets = selected ? legalTargets(snapshot, selected) : [];
  const selectableOrigins = useMemo(() => {
    const set = new Set<string>();
    for (const move of legal) set.add(`${move.path[0].r},${move.path[0].c}`);
    return set;
  }, [legal]);

  const lastSet = useMemo(() => {
    const set = new Set<string>();
    for (const sq of snapshot.lastMove ?? []) set.add(`${sq.r},${sq.c}`);
    return set;
  }, [snapshot.lastMove]);

  const checkedKing = snapshot.inCheck ? kingSquare(snapshot, snapshot.turn) : null;
  const displayRows = [0, 1, 2, 3, 4, 5, 6, 7];
  const displayCols = [0, 1, 2, 3, 4, 5, 6, 7];

  function clickSquare(r: number, c: number) {
    if (!interactive) return;
    const clicked: Square = { r, c };
    if (!selected) {
      if (!selectableOrigins.has(`${r},${c}`)) return;
      setSelected(clicked);
      return;
    }
    if (sameSquare(selected, clicked)) {
      setSelected(null);
      return;
    }
    const canStep = targets.some((sq) => sameSquare(sq, clicked));
    if (!canStep) {
      if (selectableOrigins.has(`${r},${c}`)) setSelected(clicked);
      else setSelected(null);
      return;
    }
    if (isPromotionMove(snapshot, selected, clicked)) {
      setPromo({ from: selected, to: clicked });
      return;
    }
    setSelected(null);
    props.onMove([selected, clicked]);
  }

  function choosePromo(type: (typeof PROMO_CHOICES)[number]) {
    if (!promo) return;
    const code = PROMO_CHOICES.indexOf(type);
    props.onMove([promo.from, promo.to, { r: 8, c: code }]);
    setPromo(null);
    setSelected(null);
  }

  const turnName = snapshot.turn === "white" ? props.white.userName : props.black.userName;
  const myTurn = interactive;
  const drawForMe = snapshot.drawOfferedBy && snapshot.drawOfferedBy !== myColor && role === "player";
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];

  let statusText: string;
  if (snapshot.winner) {
    statusText =
      snapshot.winner === "draw"
        ? t("chessDraw")
        : t("chessWinner", {
            name: snapshot.winner === "white" ? props.white.userName : props.black.userName
          });
  } else if (snapshot.inCheck) {
    statusText = myTurn ? t("chessYourCheck") : t("chessCheck", { name: turnName });
  } else if (myTurn) {
    statusText = t("chessYourTurn");
  } else {
    statusText = t("chessTurn", { name: turnName });
  }

  return (
    <div className={`chkLayout chsLayout${!opt.showCoordinates ? " is-no-coords" : ""}`} data-scale={opt.boardScale}>
      <aside className="chkHud chkHud--left">
        <PlayerCard
          player={flipped ? props.white : props.black}
          color={flipped ? "white" : "black"}
          active={snapshot.turn === (flipped ? "white" : "black") && !snapshot.winner}
          remaining={remainingPieces(snapshot, flipped ? "white" : "black")}
          captured={capturedBy(snapshot, flipped ? "white" : "black")}
          advantage={materialOf(snapshot, flipped ? "white" : "black") - materialOf(snapshot, flipped ? "black" : "white")}
          avatarUrl={props.avatarUrls[flipped ? props.white.peerId : props.black.peerId]}
          you={myColor === (flipped ? "white" : "black")}
        />
        <div className="chkScoreBoard chsScoreBoard">
          <div className="chkScoreLabel">{t("checkersMatchScore")}</div>
          <div className="chkScoreValue">
            {snapshot.score.white} : {snapshot.score.black}
          </div>
        </div>
      </aside>

      <div className="chkBoardWrap">
        <div className="chsBoardFrame">
          <div className="chsFrameInlay">
            <div className="chkFiles chkFiles--top chsCoords">
              {files.map((f) => (
                <span key={`t-${f}`}>{f}</span>
              ))}
            </div>
            <div className="chkBoardRow">
              <div className="chkRanks chsCoords">
                {ranks.map((n) => (
                  <span key={`l-${n}`}>{n}</span>
                ))}
              </div>
              <div className="chsBoard" role="grid" aria-label={t("gameChessTitle")}>
                {displayRows.map((r) =>
                  displayCols.map((c) => {
                    const vr = flipped ? 7 - r : r;
                    const vc = c;
                    const light = (vr + vc) % 2 === 0;
                    const piece = pieceAt(snapshot, vr, vc);
                    const isSel = sameSquare(selected, { r: vr, c: vc });
                    const isTarget = targets.some((s) => s.r === vr && s.c === vc);
                    const isLast = opt.highlightLastMove && lastSet.has(`${vr},${vc}`);
                    const canSelect = interactive && selectableOrigins.has(`${vr},${vc}`);
                    const showOrigin = canSelect && opt.chessShowHints;
                    const isCheckSq = checkedKing && checkedKing.r === vr && checkedKing.c === vc;
                    return (
                      <button
                        key={`${vr}-${vc}`}
                        type="button"
                        className={`chsCell${light ? " is-light" : " is-dark"}${isSel ? " is-selected" : ""}${isTarget ? " is-target" : ""}${isLast ? " is-last" : ""}${showOrigin ? " is-origin" : ""}${isCheckSq ? " is-check" : ""}`}
                        onClick={() => clickSquare(vr, vc)}
                        disabled={!interactive}
                        aria-label={squareLabel({ r: vr, c: vc })}
                      >
                        {isTarget && <span className={`chkTargetDot chsTargetDot${piece ? " is-capture" : ""}`} />}
                        {piece && (
                          <span className={`chsPieceWrap${isSel ? " is-selected" : ""}`}>
                            <ChessPieceView type={piece.type} color={piece.color} selected={isSel} />
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="chkRanks chsCoords">
                {ranks.map((n) => (
                  <span key={`r-${n}`}>{n}</span>
                ))}
              </div>
            </div>
            <div className="chkFiles chsCoords">
              {files.map((f) => (
                <span key={`b-${f}`}>{f}</span>
              ))}
            </div>
          </div>
          {promo && (
            <div className="chsPromoOverlay">
              <div className="chsPromoCard">
                <div className="chsPromoTitle">{t("chessPromote")}</div>
                <div className="chsPromoRow">
                  {PROMO_CHOICES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className="chsPromoBtn"
                      onClick={() => choosePromo(type)}
                      aria-label={t(`chessPiece_${type}`)}
                    >
                      <ChessPieceView type={type} color={myColor ?? "white"} />
                      <span>{t(`chessPiece_${type}`)}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setPromo(null);
                    setSelected(null);
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <aside className="chkHud chkHud--right">
        <PlayerCard
          player={flipped ? props.black : props.white}
          color={flipped ? "black" : "white"}
          active={snapshot.turn === (flipped ? "black" : "white") && !snapshot.winner}
          remaining={remainingPieces(snapshot, flipped ? "black" : "white")}
          captured={capturedBy(snapshot, flipped ? "black" : "white")}
          advantage={materialOf(snapshot, flipped ? "black" : "white") - materialOf(snapshot, flipped ? "white" : "black")}
          avatarUrl={props.avatarUrls[flipped ? props.black.peerId : props.white.peerId]}
          you={myColor === (flipped ? "black" : "white")}
        />

        <div className={`chkTurnBanner${myTurn ? " is-mine" : ""}${snapshot.inCheck && !snapshot.winner ? " is-check" : ""}`}>
          {statusText}
        </div>

        {role === "spectator" && <div className="chkSpectatorTag">{t("gamesSpectating")}</div>}

        {drawForMe && (
          <div className="chkDrawOffer">
            <div>{t("checkersDrawOffered")}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btnPrimary grow" onClick={props.onDrawAccept}>
                {t("accept")}
              </button>
              <button className="btn grow" onClick={props.onDrawDecline}>
                {t("reject")}
              </button>
            </div>
          </div>
        )}

        <div className="chkActions">
          <button className="btn" onClick={props.onToggleRules}>
            {t("checkersRulesBtn")}
          </button>
          {role === "player" && !snapshot.winner && (
            <>
              <button className="btn" disabled={Boolean(snapshot.drawOfferedBy)} onClick={props.onDrawOffer}>
                {snapshot.drawOfferedBy === myColor ? t("checkersDrawWaiting") : t("checkersOfferDraw")}
              </button>
              <button className="btn btnDanger" onClick={props.onResign}>
                {t("checkersResign")}
              </button>
            </>
          )}
          {snapshot.winner && role === "player" && (
            <button className="btn btnPrimary" onClick={props.onRematch}>
              {props.localRematch ? t("checkersRematchWaiting") : t("checkersRematch")}
            </button>
          )}
          {props.remoteRematch && role === "player" && snapshot.winner && (
            <div className="muted" style={{ fontSize: 12 }}>
              {t("checkersOpponentRematch")}
            </div>
          )}
          <button className="btn" onClick={props.onLeave}>
            {role === "spectator" ? t("gamesStopWatching") : t("gamesLeave")}
          </button>
        </div>
      </aside>

      {props.rulesOpen && (
        <div className="chkRulesOverlay" onMouseDown={props.onToggleRules}>
          <div className="chkRulesPanel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="gamesMenuHead">
              <div className="gamesMenuTitle">{t("chessRulesTitle")}</div>
              <button className="btn" onClick={props.onToggleRules}>
                {t("close")}
              </button>
            </div>
            <ol className="chkRulesList">
              {RULE_KEYS.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerCard(props: {
  player: GamePlayer;
  color: GameColor;
  active: boolean;
  remaining: number;
  captured: ChessPieceType[];
  advantage: number;
  avatarUrl?: string;
  you: boolean;
}) {
  const { t } = useTranslation();
  const capturedColor: GameColor = props.color === "white" ? "black" : "white";
  return (
    <div className={`chkPlayerCard chsPlayerCard chkPlayerCard--${props.color}${props.active ? " is-active" : ""}`}>
      <div className="chkPlayerTop">
        {props.avatarUrl ? (
          <img className="chkAvatar" src={props.avatarUrl} alt="" />
        ) : (
          <span className={`chkAvatar chkAvatarFallback chsAvatarFallback chsAvatarFallback--${props.color}`} />
        )}
        <div className="chkPlayerMeta">
          <div className="chkPlayerName">
            {props.player.userName}
            {props.you ? <span className="chkYou">{t("you")}</span> : null}
            {props.advantage > 0 ? <span className="chsAdv">+{props.advantage}</span> : null}
          </div>
          <div className="muted chkPlayerColor">
            {props.color === "white" ? t("checkersWhite") : t("checkersBlack")} · {t("checkersPiecesLeft", { n: props.remaining })}
          </div>
        </div>
      </div>
      <div className="chsCaptureTray" aria-hidden="true">
        {props.captured.map((type, i) => (
          <span key={`${type}-${i}`} className="chsMiniLost">
            <ChessPieceView type={type} color={capturedColor} mini />
          </span>
        ))}
      </div>
    </div>
  );
}
