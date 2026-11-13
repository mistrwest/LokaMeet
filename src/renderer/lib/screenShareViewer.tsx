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
  onActivate?: () => void;
  className?: string;
  ariaLabel?: string;
};

export function PresenterCameraPip({ stream, onActivate, className, ariaLabel }: PresenterCameraPipProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [, setTrackEpoch] = useState(0);
  const track = stream?.getVideoTracks().find((t) => t.readyState !== "ended") ?? null;
  const show = Boolean(track && track.enabled && track.readyState === "live" && !track.muted);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const placeholder = frameSize.w > 0 && frameSize.h > 0 && frameSize.w <= 16 && frameSize.h <= 16;

  useEffect(() => {
    setFrameSize({ w: 0, h: 0 });
  }, [track?.id]);

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
    const readSize = () => setFrameSize({ w: el.videoWidth, h: el.videoHeight });
    const play = () => {
      if (el.paused) void el.play().catch(() => undefined);
      readSize();
    };
    play();
    el.addEventListener("resize", readSize);
    track.addEventListener("unmute", play);
    el.addEventListener("pause", play);
    return () => {
      el.removeEventListener("resize", readSize);
      track.removeEventListener("unmute", play);
      el.removeEventListener("pause", play);
    };
  }, [stream, track, show]);

  if (!show || !stream || !track) return null;
  return (
    <div
      className={`presenterCameraPip${onActivate ? " is-clickable" : ""}${className ? ` ${className}` : ""}`}
      style={placeholder ? { display: "none" } : undefined}
      aria-label={ariaLabel ?? t("screenSharePresenterCamera")}
      aria-hidden={placeholder || undefined}
      onClick={placeholder ? undefined : onActivate}
    >
      <video ref={videoRef} playsInline autoPlay muted />
    </div>
  );
}

/** Звук демонстрации вне большого окна, отдельно от громкости микрофона. */
export function ScreenShareAudio({ stream, volume }: { stream: MediaStream; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = false;
    el.volume = Math.max(0, Math.min(1, volume));
    if (el.paused) void el.play().catch(() => undefined);
  }, [stream, volume]);

  return <audio ref={ref} className="screenShareAudio" autoPlay />;
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
  const [, setCameraEpoch] = useState(0);
  const cameraMainRef = useRef<HTMLVideoElement>(null);
  const hasCamera = Boolean(
    cameraStream?.getVideoTracks().some((t) => t.readyState === "live" && t.enabled && !t.muted)
  );

  useEffect(() => {
    const tracks = cameraStream?.getVideoTracks() ?? [];
    if (tracks.length === 0) return;
    const bump = () => setCameraEpoch((n) => n + 1);
    for (const track of tracks) {
      track.addEventListener("mute", bump);
      track.addEventListener("unmute", bump);
      track.addEventListener("ended", bump);
    }
    return () => {
      for (const track of tracks) {
        track.removeEventListener("mute", bump);
        track.removeEventListener("unmute", bump);
        track.removeEventListener("ended", bump);
      }
    };
  }, [cameraStream]);

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
