import React, { useId } from "react";
import type { ChessPieceType, GameColor } from "../types";

function gid(prefix: string, uid: string) {
  return `${prefix}-${uid}`;
}

export function ChessPieceView(props: {
  type: ChessPieceType;
  color: GameColor;
  selected?: boolean;
  mini?: boolean;
}) {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, "");
  const uid = raw || "p";
  const fill = gid("fill", uid);
  const rim = gid("rim", uid);
  const gloss = gid("gloss", uid);
  const dark = props.color === "black";

  return (
    <svg
      className={`chsPieceSvg${props.selected ? " is-selected" : ""}${props.mini ? " is-mini" : ""} chsPieceSvg--${props.color}`}
      viewBox="0 0 80 80"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={fill} x1="22%" y1="8%" x2="78%" y2="96%">
          {dark ? (
            <>
              <stop offset="0%" stopColor="#6a4a38" />
              <stop offset="38%" stopColor="#2c1810" />
              <stop offset="100%" stopColor="#0c0705" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#fffaf0" />
              <stop offset="42%" stopColor="#efe0c4" />
              <stop offset="100%" stopColor="#c9a56a" />
            </>
          )}
        </linearGradient>
        <linearGradient id={rim} x1="0%" y1="0%" x2="100%" y2="100%">
          {dark ? (
            <>
              <stop offset="0%" stopColor="#d7b07a" />
              <stop offset="100%" stopColor="#7a5230" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#f3e0b0" />
              <stop offset="100%" stopColor="#8a6230" />
            </>
          )}
        </linearGradient>
        <radialGradient id={gloss} cx="32%" cy="22%" r="55%">
          <stop offset="0%" stopColor={dark ? "rgba(255,220,180,0.28)" : "rgba(255,255,255,0.7)"} />
          <stop offset="55%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="40" cy="73.5" rx="22" ry="4.2" fill={dark ? "rgba(0,0,0,0.45)" : "rgba(70,40,10,0.28)"} />
      <g fill={`url(#${fill})`} stroke={`url(#${rim})`} strokeWidth={dark ? 1.7 : 1.55} strokeLinejoin="round">
        {silhouettes[props.type]}
      </g>
      <g fill={`url(#${gloss})`} stroke="none" pointerEvents="none">
        {highlights[props.type]}
      </g>
      {props.type === "knight" ? (
        <circle cx="53.2" cy="29.8" r="1.65" fill={dark ? "#f3e0b8" : "#3a2410"} />
      ) : null}
    </svg>
  );
}

const silhouettes: Record<ChessPieceType, React.ReactNode> = {
  pawn: (
    <>
      <path d="M22 70h36c1.2 0 2 .8 2 2v2.5c0 1.2-.8 2-2 2H22c-1.2 0-2-.8-2-2V72c0-1.2.8-2 2-2z" />
      <path d="M25 64.5c0-2.4 4.4-5 15-5s15 2.6 15 5v4H25z" />
      <path d="M32 50c0-3 2.4-5.4 8-6.2 5.6.8 8 3.2 8 6.2 0 4.6-3.4 7.2-8 8.4-4.6-1.2-8-3.8-8-8.4z" />
      <circle cx="40" cy="34" r="9.4" />
    </>
  ),
  rook: (
    <>
      <path d="M18 70h44c1.3 0 2.2.9 2.2 2.2v2.4c0 1.3-.9 2.2-2.2 2.2H18c-1.3 0-2.2-.9-2.2-2.2v-2.4c0-1.3.9-2.2 2.2-2.2z" />
      <path d="M22 61.5h36v8.5H22z" />
      <path d="M26 32h28v30H26z" />
      <path d="M22 24h8v10h-8zm14 0h8v10h-8zm14 0h8v10h-8z" />
      <path d="M22 20h36v5.5H22z" />
    </>
  ),
  knight: (
    <>
      <path d="M19 70h42c1.2 0 2 .8 2 2v2.6c0 1.2-.8 2-2 2H19c-1.2 0-2-.8-2-2V72c0-1.2.8-2 2-2z" />
      <path d="M23 64c1-9.5 5.2-17 11.8-23.2C36 32.6 37.2 24 42.4 18.2c2.2-2.4 6.6-3.4 9.6-1.2 1.6 1.2 1.6 3.4.4 5 2.6.6 5.6 2.6 7.4 5.6 2.2 3.6 2 8.2-1 11.4-1.2 1.4-1.4 3.4-.4 5 2.6 4.2 4.4 9.2 5 12.8  .4 2.4-1.4 4.4-3.8 4.4H23.4c-1.4 0-2.4-1.2-2.2-2.6.6-5 1.4-9.8 1.8-12.6z" />
      <path d="M31.5 30.5c-5 3.4-8.8 8.6-10.6 14.4 3-.8 6.2-.4 8.8 1.4.2-5.6 1-10.4 1.8-15.8z" />
      <path d="M48.5 22.2c2.4-3.2 1.6-7.2-1.2-8.6-1.8-.9-3.8.2-4.2 2.2-.4 1.8.6 3.4 2.2 4.2 1.4.6 2.6 1.2 3.2 2.2z" />
    </>
  ),
  bishop: (
    <>
      <path d="M22 70h36c1.2 0 2 .8 2 2v2.5c0 1.2-.8 2-2 2H22c-1.2 0-2-.8-2-2V72c0-1.2.8-2 2-2z" />
      <path d="M26 63.5h28v6.5H26z" />
      <path d="M32 56c0-10 3.2-18.4 8-26.8 4.8 8.4 8 16.8 8 26.8 0 4.4-3.4 7-8 7s-8-2.6-8-7z" />
      <circle cx="40" cy="24.5" r="6.2" />
      <path d="M39.1 18.2h1.8v13.4h-1.8zM34.6 24.1h10.8v1.8H34.6z" />
    </>
  ),
  queen: (
    <>
      <path d="M20 70h40c1.3 0 2.2.9 2.2 2.2v2.4c0 1.3-.9 2.2-2.2 2.2H20c-1.3 0-2.2-.9-2.2-2.2v-2.4c0-1.3.9-2.2 2.2-2.2z" />
      <path d="M24 62.5h32v7.5H24z" />
      <path d="M28 52c1.2-8.5 4.6-14 12-17.5 7.4 3.5 10.8 9 12 17.5v8H28z" />
      <path d="M22 28 32.5 50h15L58 28l-8.2 14L40 24l-9.8 18z" />
      <circle cx="22" cy="25.5" r="3.4" />
      <circle cx="31.2" cy="21.2" r="3.1" />
      <circle cx="40" cy="18.4" r="3.6" />
      <circle cx="48.8" cy="21.2" r="3.1" />
      <circle cx="58" cy="25.5" r="3.4" />
    </>
  ),
  king: (
    <>
      <path d="M20 70h40c1.3 0 2.2.9 2.2 2.2v2.4c0 1.3-.9 2.2-2.2 2.2H20c-1.3 0-2.2-.9-2.2-2.2v-2.4c0-1.3.9-2.2 2.2-2.2z" />
      <path d="M24 62.8h32v7.2H24z" />
      <path d="M29 36c0-6.5 5-11.5 11-11.5S51 29.5 51 36c0 11-4.4 18.5-11 21.5-6.6-3-11-10.5-11-21.5z" />
      <path d="M38.8 14.2h2.4v16.2h-2.4zM33.6 20.4h12.8v2.4H33.6z" />
      <circle cx="40" cy="12.4" r="3.2" />
    </>
  )
};

const highlights: Record<ChessPieceType, React.ReactNode> = {
  pawn: <ellipse cx="36" cy="31" rx="4.2" ry="3.2" />,
  rook: <rect x="29" y="36" width="8" height="18" rx="1.5" opacity={0.85} />,
  knight: <ellipse cx="52" cy="32" rx="5" ry="6.5" />,
  bishop: <ellipse cx="37" cy="40" rx="4" ry="9" />,
  queen: <ellipse cx="36" cy="42" rx="6" ry="10" />,
  king: <ellipse cx="36" cy="40" rx="6" ry="11" />
};
