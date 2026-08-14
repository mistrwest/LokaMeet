import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Показывает состояние демонстрации рядом с именем, чтобы его было видно даже в плотной раскладке. */
export function ScreenSharingDot({ title }: { title?: string }) {
  return <span className="screenSharingDot" title={title} aria-label={title} />;
}

/** Камера в карточке при демонстрации экрана; при записи рядом медленно мигает REC. */
export function PeerShareMarks({
  sharing,
  recording,
  shareTitle,
  recTitle
}: {
  sharing: boolean;
  recording?: boolean;
  shareTitle?: string;
  recTitle?: string;
}) {
  if (!sharing) return null;
  return (
    <span className="peerShareMarks">
      <span className="peerShareCamera" title={shareTitle} aria-label={shareTitle}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9A2.5 2.5 0 0 1 13.5 19h-7A2.5 2.5 0 0 1 4 16.5v-9Zm13.2 1.7 3.3-1.9c.6-.3 1.3.1 1.3.8v8c0 .7-.7 1.1-1.3.8l-3.3-1.9V9.2Z"
          />
        </svg>
      </span>
      {recording ? (
        <span className="peerShareRec" title={recTitle} aria-label={recTitle}>
          <span className="peerShareRecDot" />
          REC
        </span>
      ) : null}
    </span>
  );
}

type ScreenShareLocalSidebarProps = {
  containerRef: React.RefObject<HTMLElement | null>;
  onStop: () => void;
};

/** Даёт ведущему быстрый доступ к полноэкранному режиму и остановке без перекрытия содержимого демонстрации. */
export function ScreenShareLocalSidebar({ containerRef, onStop }: ScreenShareLocalSidebarProps) {
  const { t } = useTranslation();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [containerRef]);

  async function handleFullscreenClick() {
    const target = containerRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        await target.requestFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // Отказ браузера от полноэкранного режима не должен нарушать просмотр трансляции.
    }
  }

  return (
    <div className="screenShareLocalSidebar" role="toolbar" aria-label={t("screenShareTitle")}>
      <button
        type="button"
        className="screenShareLocalSidebarBtn"
        title={isFullscreen ? t("screenShareExitFullscreen") : t("screenShareEnterFullscreen")}
        onClick={() => void handleFullscreenClick()}
      >
        {isFullscreen ? "⤡" : "⛶"}
      </button>
      <button
        type="button"
        className="screenShareLocalSidebarBtn screenShareLocalSidebarBtnDanger"
        title={t("screenShareStop")}
        onClick={onStop}
      >
        ✕
      </button>
    </div>
  );
}

type ScreenShareViewerProps = {
  stream: MediaStream;
  cameraStream?: MediaStream | null;
  broadcasterName: string;
  controlsHidden: boolean;
  broadcastMuted: boolean;
  volume: number; // Дробная шкала соответствует свойству HTMLMediaElement.volume.
  onVolumeChange: (volume: number) => void;
  onToggleBroadcastMute: () => void;
  onHideControls: () => void;
  onShowControls: () => void;
  onExitToTiles: () => void;
};

type PresenterCameraPipProps = {
  stream: MediaStream | null | undefined;
  draggable?: boolean;
  onActivate?: () => void;
  className?: string;
  ariaLabel?: string;
};

export function PresenterCameraPip({ stream, draggable, onActivate, className, ariaLabel }: PresenterCameraPipProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<{ pointerId: number; moved: boolean; grabX: number; grabY: number } | null>(null);
  const [, setTrackEpoch] = useState(0);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const track = stream?.getVideoTracks().find((t) => t.readyState !== "ended") ?? null;
  const show = Boolean(track && track.enabled && track.readyState === "live");

  useEffect(() => {
    if (!track) return;
    const bump = () => setTrackEpoch((n) => n + 1);
    track.addEventListener("mute", bump);
    track.addEventListener("unmute", bump);
    track.addEventListener("ended", bump);
    return () => {
      track.removeEventListener("mute", bump);
      track.removeEventListener("unmute", bump);
      track.removeEventListener("ended", bump);
    };
  }, [track]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!show || !stream || !track) {
      el.srcObject = null;
      return;
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = true;
    const play = () => {
      if (el.paused) void el.play().catch(() => undefined);
    };
    play();
    track.addEventListener("unmute", play);
    el.addEventListener("pause", play);
    return () => {
      track.removeEventListener("unmute", play);
      el.removeEventListener("pause", play);
    };
  }, [stream, track, show]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggable || e.button !== 0) return;
    const node = rootRef.current;
    const parent = node?.offsetParent as HTMLElement | null;
    if (!node || !parent) return;
    e.preventDefault();
    e.stopPropagation();
    const nodeRect = node.getBoundingClientRect();
    node.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      moved: false,
      grabX: e.clientX - nodeRect.left,
      grabY: e.clientY - nodeRect.top
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const node = rootRef.current;
    const parent = node?.offsetParent as HTMLElement | null;
    if (!drag || drag.pointerId !== e.pointerId || !node || !parent) return;
    e.preventDefault();
    const parentRect = parent.getBoundingClientRect();
    const maxX = Math.max(0, parent.clientWidth - node.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - node.offsetHeight);
    const x = Math.max(0, Math.min(maxX, e.clientX - parentRect.left - drag.grabX));
    const y = Math.max(0, Math.min(maxY, e.clientY - parentRect.top - drag.grabY));
    if (Math.abs(x - node.offsetLeft) > 3 || Math.abs(y - node.offsetTop) > 3) drag.moved = true;
    setOffset({ x, y });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      const wasClick = !drag.moved;
      dragRef.current = null;
      try {
        rootRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // захват мог уже сняться
      }
      if (wasClick && onActivate) {
        e.preventDefault();
        e.stopPropagation();
        onActivate();
      }
      return;
    }
    if (onActivate && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    }
  }

  if (!show || !stream || !track) return null;
  const interactive = Boolean(draggable || onActivate);
  return (
    <div
      ref={rootRef}
      className={`presenterCameraPip${draggable ? " is-draggable" : ""}${onActivate ? " is-clickable" : ""}${className ? ` ${className}` : ""}`}
      style={offset ? { left: offset.x, top: offset.y, right: "auto", bottom: "auto" } : undefined}
      aria-label={ariaLabel ?? t("screenSharePresenterCamera")}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={draggable ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
    >
      <video ref={videoRef} playsInline autoPlay muted />
    </div>
  );
}

export function ScreenShareViewer({
  stream,
  cameraStream,
  broadcasterName,
  controlsHidden,
  broadcastMuted,
  volume,
  onVolumeChange,
  onToggleBroadcastMute,
  onHideControls,
  onShowControls,
  onExitToTiles
}: ScreenShareViewerProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.muted = false;
    el.volume = Math.max(0, Math.min(1, volume));
    if (el.paused) {
      void el.play().catch(() => undefined);
    }
  }, [stream, volume]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let lastTime = 0;
    let stalledTicks = 0;
    const id = window.setInterval(() => {
      if (el.paused) void el.play().catch(() => undefined);
      const t = el.currentTime;
      if (t === lastTime && !el.paused && el.readyState >= 2) {
        stalledTicks += 1;
        if (stalledTicks >= 3) {
          const src = el.srcObject;
          el.srcObject = null;
          el.srcObject = src;
          void el.play().catch(() => undefined);
          stalledTicks = 0;
        }
      } else {
        stalledTicks = 0;
        lastTime = t;
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [stream]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  async function handleFullscreenClick() {
    const target = containerRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        await target.requestFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // Отказ браузера от полноэкранного режима не должен нарушать просмотр трансляции.
    }
  }

  const volumePercent = Math.round(Math.max(0, Math.min(1, volume)) * 100);
  const [swapped, setSwapped] = useState(false);
  const cameraMainRef = useRef<HTMLVideoElement>(null);
  const hasCamera = Boolean(
    cameraStream?.getVideoTracks().some((t) => t.readyState === "live" && t.enabled)
  );

  useEffect(() => {
    if (!hasCamera && swapped) setSwapped(false);
  }, [hasCamera, swapped]);

  useEffect(() => {
    const el = cameraMainRef.current;
    if (!el || !cameraStream || !swapped) return;
    if (el.srcObject !== cameraStream) el.srcObject = cameraStream;
    el.muted = true;
    if (el.paused) void el.play().catch(() => undefined);
  }, [cameraStream, swapped]);

  return (
    <div ref={containerRef} className={`screenShareView${swapped ? " is-camera-main" : ""}`}>
      <video
        ref={videoRef}
        className={swapped ? "shareStagePip is-clickable" : "shareStageMain"}
        playsInline
        autoPlay
        title={swapped ? t("screenShareSwapToScreen") : undefined}
        onClick={swapped ? () => setSwapped(false) : undefined}
      />
      {hasCamera && swapped ? (
        <video ref={cameraMainRef} className="shareStageMain shareStageCameraMain" playsInline autoPlay muted />
      ) : null}
      {hasCamera && !swapped ? (
        <PresenterCameraPip
          stream={cameraStream}
          onActivate={() => setSwapped(true)}
          ariaLabel={t("screenShareSwapToCamera")}
        />
      ) : null}

      {!controlsHidden && (
        <>
          <div className="screenShareBadge">
            {t("screenShareBroadcasting", { name: broadcasterName })}
            <ScreenSharingDot title={t("screenShareIndicator")} />
          </div>

          <div className="screenShareControls">
            <button
              type="button"
              className="screenShareControlBtn"
              title={isFullscreen ? t("screenShareExitFullscreen") : t("screenShareEnterFullscreen")}
              onClick={() => void handleFullscreenClick()}
            >
              {isFullscreen ? "⤡" : "⛶"}
            </button>
            <button
              type="button"
              className="screenShareControlBtn"
              title={broadcastMuted ? t("screenShareUnmuteBroadcast") : t("screenShareMuteBroadcast")}
              onClick={onToggleBroadcastMute}
            >
              {broadcastMuted ? "🔇" : "🔊"}
            </button>
            <label className="screenShareVolume" title={t("screenShareVolume")}>
              <input
                type="range"
                min={0}
                max={100}
                value={volumePercent}
                onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                aria-label={t("screenShareVolume")}
              />
              <span className="screenShareVolumeValue">{volumePercent}%</span>
            </label>
            <button type="button" className="screenShareControlBtn" title={t("screenShareHideControls")} onClick={onHideControls}>
              ▼
            </button>
            <button
              type="button"
              className="screenShareControlBtn screenShareControlBtnExit"
              title={t("screenShareExitToTiles")}
              onClick={() => {
                if (document.fullscreenElement) {
                  void document.exitFullscreen().catch(() => undefined);
                }
                onExitToTiles();
              }}
            >
              ▦
            </button>
          </div>
        </>
      )}

      {controlsHidden && (
        <button type="button" className="screenShareShowControlsBtn" title={t("screenShareShowControls")} onClick={onShowControls}>
          ⋯
        </button>
      )}
    </div>
  );
}
