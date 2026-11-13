import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BS_FLEET,
  BS_SIZE,
  canPlaceShip,
  isShipSunk,
  latinCellLabel,
  randomFleet,
  remainingShips,
  shipAt,
  shipCells
} from "./engine";
import type { BattleshipShip, BattleshipShot, BattleshipSnapshot, GameColor, GamePlayer, GameRole, Square } from "../types";
import { DEFAULT_GAMES_SETTINGS, playGameSound, type GamesSettings } from "../settings";

const RULE_KEYS = [
  "battleshipRule1",
  "battleshipRule2",
  "battleshipRule3",
  "battleshipRule4",
  "battleshipRule5",
  "battleshipRule6",
  "battleshipRule7"
] as const;

function shotAt(incoming: BattleshipShot[], r: number, c: number) {
  return incoming.find((s) => s.r === r && s.c === c) ?? null;
}

function shipNameKey(size: number) {
  if (size >= 4) return "battleshipShip4";
  if (size === 3) return "battleshipShip3";
  if (size === 2) return "battleshipShip2";
  return "battleshipShip1";
}

function shipBounds(cells: Square[]) {
  const r = Math.min(...cells.map((cell) => cell.r));
  const c = Math.min(...cells.map((cell) => cell.c));
  const size = cells.length;
  const horiz = size < 2 || cells[0].r === cells[1].r;
  return { r, c, size, horiz };
}

function ShipHull({ size, length: L }: { size: number; length: number }) {
  const funnels = size >= 4 ? [0.38, 0.5] : size === 3 ? [0.4, 0.52] : size === 2 ? [0.46] : [];
  const turrets = size >= 4 ? [0.2, 0.74] : size === 3 ? [0.72] : size === 2 ? [0.24] : [];
  const bridgeX = size === 1 ? L * 0.22 : L * 0.3;
  const bridgeW = size === 1 ? L * 0.36 : size === 2 ? L * 0.2 : L * 0.16;
  const funnelW = size >= 4 ? 5.5 : 4.6;
  const hull = [
    `M ${Math.max(5, L * 0.08)} 11`,
    `Q 2.5 20 ${Math.max(5, L * 0.08)} 29`,
    `L ${L - 18} 29`,
    `Q ${L - 5} 25 ${L - 1.2} 20`,
    `Q ${L - 5} 15 ${L - 18} 11`,
    "Z"
  ].join(" ");
  const boot = [
    `M ${Math.max(6, L * 0.09)} 23.5`,
    `L ${L - 16} 23.5`,
    `Q ${L - 6} 22.5 ${L - 1.2} 20`,
    `Q ${L - 6} 26 ${L - 18} 29`,
    `L ${Math.max(6, L * 0.09)} 29`,
    `Q 3.5 24 ${Math.max(6, L * 0.09)} 23.5`,
    "Z"
  ].join(" ");
  const deck = [
    `M ${Math.max(9, L * 0.14)} 13.2`,
    `L ${L - 22} 13.2`,
    `Q ${L - 12} 14.5 ${L - 8} 20`,
    `Q ${L - 12} 18.2 ${L - 22} 17.2`,
    `L ${Math.max(9, L * 0.14)} 17.2`,
    "Z"
  ].join(" ");
  return (
    <g>
      <ellipse cx={L * 0.5} cy={31.5} rx={L * 0.44} ry={4.2} fill="rgba(8, 47, 73, 0.32)" />
      <path d={hull} fill="#8fa0b3" stroke="#2f3e4e" strokeWidth="1.15" strokeLinejoin="round" />
      <path d={boot} fill="#6b2a2a" />
      <path d={deck} fill="#d7c4a3" />
      <path
        d={`M ${L * 0.16} 18.6 H ${L * (size === 1 ? 0.62 : 0.78)}`}
        stroke="#c4b089"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      {turrets.map((t) => (
        <g key={`t-${t}`}>
          <circle cx={L * t} cy={20.2} r={size >= 4 ? 4.4 : 3.6} fill="#64748b" stroke="#334155" strokeWidth="0.8" />
          <rect x={L * t} y={18.7} width={size >= 4 ? 11 : 8} height={3} rx={1.2} fill="#475569" />
        </g>
      ))}
      <rect
        x={bridgeX}
        y={size === 1 ? 14 : 12.2}
        width={bridgeW}
        height={size === 1 ? 9 : 9.5}
        rx={1.6}
        fill="#e8eef4"
        stroke="#475569"
        strokeWidth="0.75"
      />
      {size >= 2 ? (
        <rect
          x={bridgeX + bridgeW * 0.18}
          y={8.6}
          width={bridgeW * 0.64}
          height={4.2}
          rx={1}
          fill="#f8fafc"
          stroke="#64748b"
          strokeWidth="0.55"
        />
      ) : (
        <path d={`M ${bridgeX + 2} 14 H ${bridgeX + bridgeW - 2}`} stroke="#7dd3fc" strokeWidth="1.1" opacity="0.85" />
      )}
      {size >= 2 ? (
        <path d={`M ${bridgeX + bridgeW * 0.5} 8.6 V 1.8`} stroke="#334155" strokeWidth="1.05" strokeLinecap="round" />
      ) : null}
      {funnels.map((f) => (
        <g key={`f-${f}`}>
          <rect x={L * f} y={5.2} width={funnelW} height={10.5} rx={0.9} fill="#3f4a58" />
          <rect x={L * f} y={4.2} width={funnelW} height={2.3} rx={0.6} fill="#1e293b" />
          <rect x={L * f + 1} y={6.2} width={funnelW - 2} height={3.2} fill="#94a3b8" opacity="0.35" />
        </g>
      ))}
    </g>
  );
}

function ShipArt(props: {
  size: number;
  horiz: boolean;
  sunk?: boolean;
  ghost?: boolean;
  ghostOk?: boolean;
}) {
  const size = Math.max(1, Math.min(4, Math.round(props.size)));
  const L = size * 40;
  const H = 40;
  const hull = <ShipHull size={size} length={L} />;
  return (
    <svg
      className={[
        "bsShipArt",
        props.sunk ? "is-sunk" : "",
        props.ghost ? (props.ghostOk ? "is-ghost-ok" : "is-ghost-bad") : ""
      ]
        .filter(Boolean)
        .join(" ")}
      viewBox={props.horiz ? `0 0 ${L} ${H}` : `0 0 ${H} ${L}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {props.horiz ? hull : <g transform={`translate(${H} 0) rotate(90)`}>{hull}</g>}
    </svg>
  );
}

function ShipSprite(props: {
  cells: Square[];
  size: number;
  sunk?: boolean;
  ghost?: boolean;
  ghostOk?: boolean;
}) {
  if (!props.cells.length) return null;
  const { r, c, size, horiz } = shipBounds(props.cells);
  return (
    <div
      className={`bsShipSprite${horiz ? " is-h" : " is-v"}`}
      style={{
        gridColumn: horiz ? `${c + 1} / span ${size}` : c + 1,
        gridRow: horiz ? r + 1 : `${r + 1} / span ${size}`
      }}
    >
      <ShipArt size={props.size || size} horiz={horiz} sunk={props.sunk} ghost={props.ghost} ghostOk={props.ghostOk} />
    </div>
  );
}

function Grid(props: {
  title: string;
  ships: BattleshipShip[];
  incoming: BattleshipShot[];
  showShips: boolean;
  interactive?: boolean;
  preview?: Square[];
  previewOk?: boolean;
  lastShot?: BattleshipShot | null;
  highlightLast?: boolean;
  showSunkOutline?: boolean;
  onHover?: (sq: Square | null) => void;
  onClick?: (sq: Square) => void;
}) {
  const files = Array.from({ length: BS_SIZE }, (_, i) => String.fromCharCode(65 + i));
  const ranks = Array.from({ length: BS_SIZE }, (_, i) => i + 1);
  return (
    <div className="bsBoardWrap">
      <div className="bsBoardTitle">{props.title}</div>
      <div className="bsBoardFrame">
        <div className="bsFiles">
          {files.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
        <div className="bsBoardRow">
          <div className="bsRanks">
            {ranks.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          <div className="bsBoard" role="grid">
            {Array.from({ length: BS_SIZE * BS_SIZE }, (_, i) => {
              const r = Math.floor(i / BS_SIZE);
              const c = i % BS_SIZE;
              const ship = shipAt(props.ships, r, c);
              const shot = shotAt(props.incoming, r, c);
              const preview = props.preview?.some((p) => p.r === r && p.c === c);
              const last = Boolean(props.highlightLast !== false && props.lastShot && props.lastShot.r === r && props.lastShot.c === c);
              const sunk = ship ? isShipSunk(ship, props.incoming) : false;
              const showShip = Boolean(ship && (props.showShips || (sunk && props.showSunkOutline !== false)));
              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  style={{ gridColumn: c + 1, gridRow: r + 1 }}
                  className={[
                    "bsCell",
                    showShip ? "is-ship" : "",
                    sunk && showShip ? "is-sunk" : "",
                    shot?.result === "miss" ? "is-miss" : "",
                    shot?.result === "hit" ? "is-hit" : "",
                    shot?.result === "sunk" ? "is-sunk-hit" : "",
                    preview ? (props.previewOk ? "is-preview-ok" : "is-preview-bad") : "",
                    last ? "is-last" : "",
                    props.interactive ? "is-interactive" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!props.interactive}
                  aria-label={latinCellLabel(r, c)}
                  onMouseEnter={() => props.onHover?.({ r, c })}
                  onMouseLeave={() => props.onHover?.(null)}
                  onClick={() => props.onClick?.({ r, c })}
                >
                  {shot?.result === "miss" ? <span className="bsSplash" /> : null}
                  {shot?.result === "hit" || shot?.result === "sunk" ? <span className="bsFire" /> : null}
                </button>
              );
            })}
            <div className="bsShipLayer" aria-hidden>
              {props.ships.map((ship) => {
                const sunk = isShipSunk(ship, props.incoming);
                const showShip = props.showShips || (sunk && props.showSunkOutline !== false);
                if (!showShip || !ship.cells.length) return null;
                return <ShipSprite key={ship.id} cells={ship.cells} size={ship.size} sunk={sunk} />;
              })}
              {props.preview && props.preview.length > 0 ? (
                <ShipSprite
                  cells={props.preview}
                  size={props.preview.length}
                  ghost
                  ghostOk={props.previewOk}
                />
              ) : null}
            </div>
          </div>
          <div className="bsRanks">
            {ranks.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>
        <div className="bsFiles">
          {files.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BattleshipGame(props: {
  snapshot: BattleshipSnapshot;
  white: GamePlayer;
  black: GamePlayer;
  myColor: GameColor | null;
  role: GameRole;
  localRematch: boolean;
  remoteRematch: boolean;
  avatarUrls: Record<string, string>;
  onShot: (path: Square[]) => void;
  onPlace: (ships: BattleshipShip[]) => void;
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
  const me = myColor ? (myColor === "white" ? snapshot.white : snapshot.black) : snapshot.white;
  const foe = myColor ? (myColor === "white" ? snapshot.black : snapshot.white) : snapshot.black;
  const placing = snapshot.phase === "placing";
  const canPlace = role === "player" && placing && myColor && !me.ready;
  const canShoot =
    role === "player" && snapshot.phase === "battle" && !snapshot.winner && myColor === snapshot.turn;

  const [draft, setDraft] = useState<BattleshipShip[]>([]);
  const [horizontal, setHorizontal] = useState(true);
  const [hover, setHover] = useState<Square | null>(null);
  const [pickedSize, setPickedSize] = useState<number | null>(4);
  const soundsReady = useRef(false);
  const lastShotKey = snapshot.lastShot
    ? `${snapshot.lastShot.r},${snapshot.lastShot.c},${snapshot.lastShot.result}`
    : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") setHorizontal((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!soundsReady.current || !snapshot.lastShot) return;
    playGameSound(snapshot.lastShot.result, opt);
  }, [lastShotKey]);

  useEffect(() => {
    if (!soundsReady.current) return;
    if (snapshot.winner && snapshot.winner !== "draw") playGameSound("win", opt);
  }, [snapshot.winner]);

  useEffect(() => {
    soundsReady.current = true;
  }, []);

  const usedSizes = draft.map((s) => s.size).sort((a, b) => b - a);
  const remainingSizes = useMemo(() => {
    const left = [...BS_FLEET];
    for (const size of usedSizes) {
      const idx = left.indexOf(size as (typeof BS_FLEET)[number]);
      if (idx >= 0) left.splice(idx, 1);
    }
    return left;
  }, [usedSizes]);

  const activeSize = pickedSize && remainingSizes.includes(pickedSize as (typeof BS_FLEET)[number]) ? pickedSize : remainingSizes[0] ?? null;
  const preview = canPlace && hover && activeSize ? shipCells(hover, activeSize, horizontal) : null;
  const previewOk = Boolean(preview && canPlaceShip(draft, preview));

  const myShips = me.ready ? me.ships : draft;
  const showFoeShips = role === "spectator" || snapshot.phase === "over";

  function placeAt(sq: Square) {
    if (!canPlace || !activeSize) return;
    const existing = shipAt(draft, sq.r, sq.c);
    if (existing) {
      setDraft((prev) => prev.filter((s) => s.id !== existing.id));
      setPickedSize(existing.size);
      return;
    }
    const cells = shipCells(sq, activeSize, horizontal);
    if (!cells || !canPlaceShip(draft, cells)) return;
    setDraft((prev) => [...prev, { id: `local-${Date.now()}-${prev.length}`, size: activeSize, cells }]);
    playGameSound("place", opt);
  }

  const turnName = snapshot.turn === "white" ? props.white.userName : props.black.userName;
  const drawForMe = snapshot.drawOfferedBy && snapshot.drawOfferedBy !== myColor && role === "player";
  const lastMine = snapshot.lastShot && myColor && snapshot.lastShot.by !== myColor ? snapshot.lastShot : null;
  const lastFoe = snapshot.lastShot && myColor && snapshot.lastShot.by === myColor ? snapshot.lastShot : null;

  return (
    <div
      className={`bsLayout${!opt.showCoordinates ? " is-no-coords" : ""}`}
    >
      <aside className="bsHud">
        <div className={`bsAdmiral${snapshot.turn === (myColor ?? "white") && snapshot.phase === "battle" ? " is-active" : ""}`}>
          {props.avatarUrls[myColor === "black" ? props.black.peerId : props.white.peerId] ? (
            <img
              className="chkAvatar"
              src={props.avatarUrls[myColor === "black" ? props.black.peerId : props.white.peerId]}
              alt=""
            />
          ) : (
            <span className="chkAvatar chkAvatarFallback" />
          )}
          <div>
            <div className="chkPlayerName">
              {myColor === "black" ? props.black.userName : props.white.userName}
              {role === "player" ? <span className="chkYou">{t("you")}</span> : null}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {t("battleshipYourFleet")} · {t("battleshipShipsLeft", { n: remainingShips(me.ready ? me : { ...me, ships: draft }) })}
            </div>
          </div>
        </div>
        <div className="chkScoreBoard bsScore">
          <div className="chkScoreLabel">{t("checkersMatchScore")}</div>
          <div className="chkScoreValue">
            {snapshot.score.white} : {snapshot.score.black}
          </div>
        </div>
        <div className={`chkTurnBanner${canShoot ? " is-mine" : ""}`}>
          {snapshot.winner
            ? snapshot.winner === "draw"
              ? t("checkersDraw")
              : t("checkersWinner", {
                  name: snapshot.winner === "white" ? props.white.userName : props.black.userName
                })
            : placing
              ? me.ready
                ? t("battleshipWaitOpponent")
                : t("battleshipPlaceHint")
              : canShoot
                ? t("battleshipYourShot")
                : t("battleshipTurn", { name: turnName })}
        </div>
        {role === "spectator" && <div className="chkSpectatorTag">{t("gamesSpectating")}</div>}
        {snapshot.lastShot && snapshot.phase !== "placing" && (
          <div className={`bsLastShot is-${snapshot.lastShot.result}`}>
            {t("battleshipLastShot", {
              cell: latinCellLabel(snapshot.lastShot.r, snapshot.lastShot.c),
              result: t(`battleshipResult_${snapshot.lastShot.result}`)
            })}
          </div>
        )}
      </aside>

      <div className="bsSeas" data-scale={opt.boardScale}>
        <Grid
          title={role === "spectator" ? props.white.userName : t("battleshipYourFleet")}
          ships={role === "spectator" ? snapshot.white.ships : myShips}
          incoming={role === "spectator" ? snapshot.white.incoming : me.incoming}
          showShips
          interactive={Boolean(canPlace)}
          preview={canPlace ? preview ?? undefined : undefined}
          previewOk={previewOk}
          highlightLast={opt.highlightLastMove}
          showSunkOutline={opt.battleshipShowSunkOutline}
          lastShot={role === "spectator" ? snapshot.lastShot : lastMine}
          onHover={canPlace ? setHover : undefined}
          onClick={canPlace ? placeAt : undefined}
        />
        <Grid
          title={role === "spectator" ? props.black.userName : t("battleshipEnemyFleet")}
          ships={role === "spectator" ? snapshot.black.ships : foe.ships}
          incoming={role === "spectator" ? snapshot.black.incoming : foe.incoming}
          showShips={showFoeShips}
          interactive={canShoot}
          highlightLast={opt.highlightLastMove}
          showSunkOutline={opt.battleshipShowSunkOutline}
          lastShot={role === "spectator" ? snapshot.lastShot : lastFoe}
          onClick={(sq) => {
            if (!canShoot) return;
            if (foe.incoming.some((s) => s.r === sq.r && s.c === sq.c)) return;
            props.onShot([sq]);
          }}
        />
      </div>

      <aside className="bsHud bsHud--right">
        {canPlace && (
          <div className="bsDock">
            <div className="bsDockTitle">{t("battleshipDock")}</div>
            <div className="bsDockList">
              {remainingSizes.map((size, i) => (
                <button
                  key={`${size}-${i}`}
                  type="button"
                  className={`bsDockShip${activeSize === size && remainingSizes.indexOf(size as (typeof BS_FLEET)[number]) === i ? " is-picked" : ""}`}
                  onClick={() => setPickedSize(size)}
                >
                  <span className="bsDockName">{t(shipNameKey(size))}</span>
                  <span className="bsDockMini">
                    <ShipArt size={size} horiz />
                  </span>
                </button>
              ))}
            </div>
            <div className="chkActions">
              <button className="btn" onClick={() => setHorizontal((v) => !v)}>
                {horizontal ? t("battleshipRotateH") : t("battleshipRotateV")}
              </button>
              <button className="btn" onClick={() => setDraft(randomFleet())}>
                {t("battleshipRandom")}
              </button>
              <button className="btn" onClick={() => setDraft([])}>
                {t("battleshipClear")}
              </button>
              <button
                className="btn btnPrimary"
                disabled={draft.length !== BS_FLEET.length}
                onClick={() => props.onPlace(draft)}
              >
                {t("battleshipReady")}
              </button>
            </div>
          </div>
        )}

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
          {role === "player" && !snapshot.winner && snapshot.phase !== "placing" && (
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
              <div className="gamesMenuTitle">{t("battleshipRulesTitle")}</div>
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
