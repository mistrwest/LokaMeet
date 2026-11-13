import React from "react";
import { useTranslation } from "react-i18next";
import { GAME_CATALOG, getGameCatalogItem } from "./registry";
import type { GameDifficulty, GameId, GamePlayer, WatchOffer } from "./types";

function CatalogIcon({ icon }: { icon: "checkers" | "chess" | "battleship" }) {
  if (icon === "chess") {
    return (
      <svg viewBox="0 0 64 64" className="gamesMenuIconSvg" aria-hidden="true">
        <path
          fill="currentColor"
          d="M14 54h36c1 0 1.6.7 1.6 1.6v2.2c0 1-.6 1.6-1.6 1.6H14c-1 0-1.6-.6-1.6-1.6v-2.2c0-.9.6-1.6 1.6-1.6z"
        />
        <path
          fill="currentColor"
          d="M18 48.5c1.2-8.4 5.2-15.4 11-21.2 1.4-7.6 5.6-13.2 13-16.2 2.2-.9 4.2.8 3.8 3-.4 2 .4 4 2.4 5 3.2 1.5 5.8 4.4 6.2 8.4.4 4.8-2 8.6-6 11 2.4 3 4 6.8 4.6 10H18z"
        />
        <path fill="currentColor" opacity="0.45" d="M27 27c-4 2.8-7.2 7-9 12 2.2-1.2 4.8-1.8 7.6-1-1.4-3.8-.8-7.6 1.4-11z" />
      </svg>
    );
  }
  if (icon === "battleship") {
    return (
      <svg viewBox="0 0 64 64" className="gamesMenuIconSvg" aria-hidden="true">
        <path fill="currentColor" d="M8 40h48l-6 10H14zm18-22h4v18h-4zm10 6h4v12h-4zM18 28h4v10h-4z" />
        <path fill="currentColor" opacity="0.55" d="M6 52h52v4H6z" />
      </svg>
    );
  }
  return (
    <div className="gamesMenuMiniBoard" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => {
        const r = Math.floor(i / 4);
        const c = i % 4;
        const dark = (r + c) % 2 === 1;
        const piece = dark && (r < 1 || r > 2);
        return (
          <span key={i} className={`gamesMenuMiniCell${dark ? " is-dark" : ""}${piece ? (r < 1 ? " is-black" : " is-white") : ""}`} />
        );
      })}
    </div>
  );
}

export function GamesMenu(props: {
  open: boolean;
  mode: "direct" | "room";
  participants: GamePlayer[];
  selfPeerId: string;
  watchOffer: WatchOffer | null;
  busy: boolean;
  onClose: () => void;
  onPlay: (gameId: GameId, opponent: GamePlayer) => void;
  onPlayComputer: (gameId: GameId, difficulty: GameDifficulty) => void;
  onWatch: () => void;
}) {
  const { t } = useTranslation();
  const [pickFor, setPickFor] = React.useState<GameId | null>(null);
  const [cpuFor, setCpuFor] = React.useState<GameId | null>(null);
  const opponents = props.participants.filter((p) => p.peerId !== props.selfPeerId);
  const difficulties: GameDifficulty[] = ["easy", "medium", "hard"];
  const difficultyLabel: Record<GameDifficulty, string> = {
    easy: t("gamesEasy"),
    medium: t("gamesMedium"),
    hard: t("gamesHard")
  };

  if (!props.open) return null;

  return (
    <div className="gamesMenuOverlay" onMouseDown={props.onClose}>
      <div className="gamesMenuPanel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-labelledby="gamesMenuTitle">
        <div className="gamesMenuHead">
          <div>
            <div id="gamesMenuTitle" className="gamesMenuTitle">
              {t("gamesMenuTitle")}
            </div>
            <div className="muted gamesMenuSubtitle">{t("gamesMenuSubtitle")}</div>
          </div>
          <button className="btn" onClick={props.onClose}>
            {t("close")}
          </button>
        </div>

        {props.watchOffer && (
          <button className="gamesWatchBanner" type="button" onClick={props.onWatch}>
            <span className="gamesWatchDot" />
            <span>
              {t("gamesWatchLive", {
                white: props.watchOffer.white.userName,
                black: props.watchOffer.black.userName,
                game: t(getGameCatalogItem(props.watchOffer.gameId)?.titleKey ?? "games")
              })}
            </span>
            <span className="gamesWatchCta">{t("gamesWatch")}</span>
          </button>
        )}

        <div className="gamesMenuGrid">
          {GAME_CATALOG.map((item) => {
            const ready = item.status === "ready";
            return (
              <div key={item.id} className={`gamesMenuCard${ready ? "" : " is-soon"}`}>
                <button
                  type="button"
                  className="gamesMenuCardMain"
                  disabled={!ready || props.busy || opponents.length === 0}
                  onClick={() => {
                    if (!ready || props.busy) return;
                    if (props.mode === "direct" && opponents[0]) {
                      props.onPlay(item.id, opponents[0]);
                      return;
                    }
                    setCpuFor(null);
                    setPickFor(item.id);
                  }}
                >
                  <div className="gamesMenuCardArt">
                    <CatalogIcon icon={item.icon} />
                  </div>
                  <div className="gamesMenuCardBody">
                    <div className="gamesMenuCardTitle">
                      {t(item.titleKey)}
                      {!ready && <span className="gamesSoonBadge">{t("gamesSoon")}</span>}
                    </div>
                    <div className="muted gamesMenuCardBlurb">{t(item.blurbKey)}</div>
                  </div>
                </button>
                {ready && (
                  <div className="gamesCardActions">
                    <button
                      type="button"
                      className="btn btnPrimary gamesPeerBtn"
                      disabled={props.busy || opponents.length === 0}
                      onClick={() => {
                        if (props.busy) return;
                        setCpuFor(null);
                        if (props.mode === "direct" && opponents[0]) {
                          props.onPlay(item.id, opponents[0]);
                          return;
                        }
                        setPickFor(item.id);
                      }}
                    >
                      {t("gamesPlayWithPeer")}
                    </button>
                    <button
                      type="button"
                      className="btn gamesCpuBtn"
                      disabled={props.busy}
                      onClick={() => {
                        setPickFor(null);
                        setCpuFor(item.id);
                      }}
                    >
                      {t("gamesVsComputer")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {pickFor && props.mode === "room" && (
          <div className="gamesPickOpponent">
            <div className="gamesPickTitle">{t("gamesPickOpponent")}</div>
            <div className="gamesPickList">
              {opponents.map((p) => (
                <button
                  key={p.peerId}
                  type="button"
                  className="btn btnPrimary gamesPickBtn"
                  disabled={props.busy}
                  onClick={() => {
                    props.onPlay(pickFor, p);
                    setPickFor(null);
                  }}
                >
                  {p.userName}
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => setPickFor(null)}>
              {t("cancel")}
            </button>
          </div>
        )}

        {cpuFor && (
          <div className="gamesPickOpponent">
            <div className="gamesPickTitle">{t("gamesVsComputer")}</div>
            <div className="muted" style={{ marginBottom: 8 }}>
              {t("gamesDifficulty")}
            </div>
            <div className="gamesPickList">
              {difficulties.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="btn btnPrimary gamesPickBtn"
                  disabled={props.busy}
                  onClick={() => {
                    props.onPlayComputer(cpuFor, level);
                    setCpuFor(null);
                  }}
                >
                  {difficultyLabel[level]}
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => setCpuFor(null)}>
              {t("cancel")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
