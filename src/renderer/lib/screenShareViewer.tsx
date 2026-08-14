import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Показывает состояние демонстрации рядом с именем, чтобы его было видно даже в плотной раскладке. */
export function ScreenSharingDot({ title }: { title?: string }) {
  return <span className="screenSharingDot" title={title} aria-label={title} />;
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

export function PresenterCameraPip({ stream }: { stream: MediaStream | null | undefined }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [, setTrackEpoch] = useState(0);
  const track = stream?.getVideoTracks().find((t) => t.readyState !== "ended") ?? null;
  const show = Boolean(track && track.enabled && track.readyState === "live" && !track.muted);

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

  if (!show || !stream || !track) return null;
  return (
    <div className="presenterCameraPip" aria-label={t("screenSharePresenterCamera")}>
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

  return (
    <div ref={containerRef} className="screenShareView">
      <video ref={videoRef} playsInline autoPlay />
      <PresenterCameraPip stream={cameraStream} />

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
