import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isPlayableSquare,
  listLegalMoves,
  nextSquares,
  remainingPieces,
  sameSquare,
  squareLabel
} from "./engine";
import type { CheckersSnapshot, GameColor, GamePlayer, GameRole, Square } from "../types";
import { DEFAULT_GAMES_SETTINGS, playGameSound, type GamesSettings } from "../settings";

function Crown() {
  return (
    <svg className="chkCrown" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.2 18.5h17.6l-1.3-9.2-4.2 3.4L12 7.2 8.7 12.7 4.5 9.3zM5 20h14v2H5z"
      />
    </svg>
  );
}

function PieceView({
  color,
  king,
  selected
}: {
  color: GameColor;
  king: boolean;
  selected?: boolean;
}) {
  return (
    <span className={`chkPiece chkPiece--${color}${king ? " is-king" : ""}${selected ? " is-selected" : ""}`}>
      <span className="chkPieceRim" />
      <span className="chkPieceFace" />
      <span className="chkPieceShine" />
      {king ? <Crown /> : null}
    </span>
  );
}

const RULE_KEYS = [
  "checkersRule1",
  "checkersRule2",
  "checkersRule3",
  "checkersRule4",
  "checkersRule5",
  "checkersRule6",
  "checkersRule7",
  "checkersRule8",
  "checkersRule9"
] as const;

export function CheckersGame(props: {
  snapshot: CheckersSnapshot;
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
  const [selected, setSelected] = useState<Square[]>([]);
  const interactive = role === "player" && !snapshot.winner && myColor === snapshot.turn;

  const lastMoveKey = (snapshot.lastMove ?? []).map((s) => `${s.r},${s.c}`).join("-");
  const soundsReady = useRef(false);

  useEffect(() => {
    setSelected([]);
  }, [snapshot.turn, snapshot.lastMove, snapshot.winner]);

  useEffect(() => {
    if (!soundsReady.current) return;
    if (lastMoveKey) playGameSound("move", opt);
  }, [lastMoveKey]);

  useEffect(() => {
    if (!soundsReady.current) return;
    if (snapshot.winner && snapshot.winner !== "draw") playGameSound("win", opt);
  }, [snapshot.winner]);

  useEffect(() => {
    soundsReady.current = true;
  }, []);

  const legal = useMemo(() => listLegalMoves(snapshot), [snapshot]);
  const targets = selected.length > 0 ? nextSquares(snapshot, selected) : [];
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

  const displayRows = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7];
  const displayCols = [0, 1, 2, 3, 4, 5, 6, 7];

  function cellAt(r: number, c: number) {
    return snapshot.pieces.find((p) => p.r === r && p.c === c) ?? null;
  }

  function clickSquare(r: number, c: number) {
    if (!interactive || !isPlayableSquare(r, c)) return;
    const clicked: Square = { r, c };
    if (selected.length === 0) {
      if (!selectableOrigins.has(`${r},${c}`)) return;
      setSelected([clicked]);
      return;
    }
    if (sameSquare(selected[0], clicked) && selected.length === 1) {
      setSelected([]);
      return;
    }
    const canStep = targets.some((sq) => sameSquare(sq, clicked));
    if (!canStep) {
      if (selectableOrigins.has(`${r},${c}`)) setSelected([clicked]);
      else setSelected([]);
      return;
    }
    const nextPath = [...selected, clicked];
    const more = nextSquares(snapshot, nextPath);
    if (more.length === 0) {
      setSelected([]);
      props.onMove(nextPath);
      return;
    }
    setSelected(nextPath);
  }

  const turnName = snapshot.turn === "white" ? props.white.userName : props.black.userName;
  const myTurn = interactive;
  const drawForMe = snapshot.drawOfferedBy && snapshot.drawOfferedBy !== myColor && role === "player";

  return (
    <div className={`chkLayout${!opt.showCoordinates ? " is-no-coords" : ""}`} data-scale={opt.boardScale}>
      <aside className="chkHud chkHud--left">
        <PlayerCard
          player={flipped ? props.white : props.black}
          color={flipped ? "white" : "black"}
          active={snapshot.turn === (flipped ? "white" : "black") && !snapshot.winner}
          remaining={remainingPieces(snapshot, flipped ? "white" : "black")}
          score={snapshot.score[flipped ? "white" : "black"]}
          avatarUrl={props.avatarUrls[flipped ? props.white.peerId : props.black.peerId]}
          you={myColor === (flipped ? "white" : "black")}
        />
        <div className="chkScoreBoard">
          <div className="chkScoreLabel">{t("checkersMatchScore")}</div>
          <div className="chkScoreValue">
            {snapshot.score.white} : {snapshot.score.black}
          </div>
        </div>
      </aside>

      <div className="chkBoardWrap">
        <div className="chkBoardFrame">
          <div className="chkFiles chkFiles--top">
            {(flipped ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"]).map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
          <div className="chkBoardRow">
            <div className="chkRanks">
              {(flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1]).map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
            <div className="chkBoard" role="grid" aria-label={t("gameCheckersTitle")}>
              {displayRows.map((r) =>
                displayCols.map((c) => {
                  const vr = flipped ? 7 - r : r;
                  const vc = flipped ? 7 - c : c;
                  const dark = isPlayableSquare(vr, vc);
                  const piece = cellAt(vr, vc);
                  const isSel = selected.some((s) => s.r === vr && s.c === vc);
                  const isTarget = targets.some((s) => s.r === vr && s.c === vc);
                  const isLast = opt.highlightLastMove && lastSet.has(`${vr},${vc}`);
                  const canSelect = interactive && selectableOrigins.has(`${vr},${vc}`);
                  const showOrigin = canSelect && opt.checkersShowHints;
                  return (
                    <button
                      key={`${vr}-${vc}`}
                      type="button"
                      className={`chkCell${dark ? " is-dark" : " is-light"}${isSel ? " is-selected" : ""}${isTarget ? " is-target" : ""}${isLast ? " is-last" : ""}${showOrigin ? " is-origin" : ""}`}
                      onClick={() => clickSquare(vr, vc)}
                      disabled={!interactive}
                      aria-label={squareLabel({ r: vr, c: vc })}
                    >
                      {isTarget && <span className={`chkTargetDot${piece ? " is-capture" : ""}`} />}
                      {piece && (
                        <PieceView color={piece.color} king={piece.king} selected={isSel} />
                      )}
                    </button>
                  );
                })
              )}
            </div>
            <div className="chkRanks">
              {(flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1]).map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
          </div>
          <div className="chkFiles">
            {(flipped ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"]).map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        </div>
      </div>

      <aside className="chkHud chkHud--right">
        <PlayerCard
          player={flipped ? props.black : props.white}
          color={flipped ? "black" : "white"}
          active={snapshot.turn === (flipped ? "black" : "white") && !snapshot.winner}
          remaining={remainingPieces(snapshot, flipped ? "black" : "white")}
          score={snapshot.score[flipped ? "black" : "white"]}
          avatarUrl={props.avatarUrls[flipped ? props.black.peerId : props.white.peerId]}
          you={myColor === (flipped ? "black" : "white")}
        />

        <div className={`chkTurnBanner${myTurn ? " is-mine" : ""}`}>
          {snapshot.winner
            ? snapshot.winner === "draw"
              ? t("checkersDraw")
              : t("checkersWinner", {
                  name: snapshot.winner === "white" ? props.white.userName : props.black.userName
                })
            : myTurn
              ? t("checkersYourTurn")
              : t("checkersTurn", { name: turnName })}
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
              <button
                className="btn"
                disabled={Boolean(snapshot.drawOfferedBy)}
                onClick={props.onDrawOffer}
              >
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
              <div className="gamesMenuTitle">{t("checkersRulesTitle")}</div>
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
  score: number;
  avatarUrl?: string;
  you: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`chkPlayerCard chkPlayerCard--${props.color}${props.active ? " is-active" : ""}`}>
      <div className="chkPlayerTop">
        {props.avatarUrl ? (
          <img className="chkAvatar" src={props.avatarUrl} alt="" />
        ) : (
          <span className={`chkAvatar chkAvatarFallback chkPiece--${props.color}`} />
        )}
        <div className="chkPlayerMeta">
          <div className="chkPlayerName">
            {props.player.userName}
            {props.you ? <span className="chkYou">{t("you")}</span> : null}
          </div>
          <div className="muted chkPlayerColor">
            {props.color === "white" ? t("checkersWhite") : t("checkersBlack")} · {t("checkersPiecesLeft", { n: props.remaining })}
          </div>
        </div>
      </div>
      <div className="chkMiniTray" aria-hidden="true">
        {Array.from({ length: Math.max(0, 12 - props.remaining) }, (_, i) => (
          <span key={i} className={`chkMiniLost chkPiece--${props.color === "white" ? "black" : "white"}`} />
        ))}
      </div>
    </div>
  );
}
