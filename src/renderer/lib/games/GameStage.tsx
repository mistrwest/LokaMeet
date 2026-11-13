import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BattleshipGame } from "./battleship/BattleshipGame";
import { CheckersGame } from "./checkers/CheckersGame";
import { ChessGame } from "./chess/ChessGame";
import { isBattleshipSnapshot, isCheckersSnapshot, isChessSnapshot } from "./lifecycle";
import { getGameCatalogItem } from "./registry";
import type { BattleshipShip, GameSession, Square } from "./types";
import { DEFAULT_GAMES_SETTINGS, type GamesSettings } from "./settings";

export function GameStage(props: {
  session: GameSession;
  avatarUrls: Record<string, string>;
  onMove: (path: Square[]) => void;
  onPlace: (ships: BattleshipShip[]) => void;
  onResign: () => void;
  onDrawOffer: () => void;
  onDrawAccept: () => void;
  onDrawDecline: () => void;
  onRematch: () => void;
  onLeave: () => void;
  onCollapse: () => void;
  settings?: GamesSettings;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const game = getGameCatalogItem(props.session.gameId);
  const snap = props.session.snapshot;
  const settings = props.settings ?? DEFAULT_GAMES_SETTINGS;

  function resign() {
    if (settings.confirmResign && !window.confirm(t("gamesConfirmResign"))) return;
    props.onResign();
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function toggleFullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // ignore
    }
  }

  const shared = {
    white: props.session.white,
    black: props.session.black,
    myColor: props.session.myColor,
    role: props.session.role,
    localRematch: props.session.localRematch,
    remoteRematch: props.session.remoteRematch,
    avatarUrls: props.avatarUrls,
    settings,
    onResign: resign,
    onDrawOffer: props.onDrawOffer,
    onDrawAccept: props.onDrawAccept,
    onDrawDecline: props.onDrawDecline,
    onRematch: props.onRematch,
    onLeave: props.onLeave,
    rulesOpen,
    onToggleRules: () => setRulesOpen((v) => !v)
  };

  return (
    <div
      ref={wrapRef}
      className={`gameStage${isBattleshipSnapshot(snap) ? " is-naval" : isChessSnapshot(snap) ? " is-chess" : ""}`}
    >
      <div className="gameStageBar">
        <div className="gameStageTitle">
          <span className="gameStageMark" />
          {game ? t(game.titleKey) : props.session.gameId}
          {props.session.role === "spectator" ? <span className="gamesSoonBadge">{t("gamesSpectating")}</span> : null}
          {props.session.vsComputer &&
          !props.session.snapshot.winner &&
          props.session.myColor &&
          props.session.snapshot.turn !== props.session.myColor &&
          (props.session.snapshot.kind !== "battleship" || props.session.snapshot.phase === "battle") ? (
            <span className="gamesCpuThink">{t("gamesComputerThinking")}</span>
          ) : null}
        </div>
        <div className="gameStageBarActions">
          <button className="btn" onClick={toggleFullscreen}>
            {isFullscreen ? t("screenShareExitFullscreen") : t("screenShareEnterFullscreen")}
          </button>
          <button className="btn" onClick={props.onCollapse}>
            {t("gamesToTiles")}
          </button>
        </div>
      </div>
      {isCheckersSnapshot(snap) ? (
        <CheckersGame {...shared} snapshot={snap} onMove={props.onMove} />
      ) : isChessSnapshot(snap) ? (
        <ChessGame {...shared} snapshot={snap} onMove={props.onMove} />
      ) : isBattleshipSnapshot(snap) ? (
        <BattleshipGame {...shared} snapshot={snap} onShot={props.onMove} onPlace={props.onPlace} />
      ) : (
        <div className="muted" style={{ padding: 24 }}>
          {t("gamesSoon")}
        </div>
      )}
    </div>
  );
}
