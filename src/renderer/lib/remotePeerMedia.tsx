import { useEffect, useMemo, useRef, useState } from "react";
import { createPeerTileStream, pruneStaleRemoteStreamTracks } from "./screenShare";

type RemotePeerMediaProps = {
  stream: MediaStream;
  muted?: boolean;
  volume?: number;
  sinkId?: string;
  className?: string;
  /** Исключает звук демонстрации, чтобы громкость микрофона не влияла на громкость трансляции. */
  excludeScreenAudioTrackId?: string;
};

function videoLiveSignature(stream: MediaStream) {
  return stream
    .getVideoTracks()
    .map((t) => `${t.id}:${t.readyState}:${t.enabled ? 1 : 0}:${t.muted ? 1 : 0}`)
    .join("|");
}

function audioLiveSignature(stream: MediaStream, excludeScreenAudioTrackId?: string) {
  const audible = createPeerTileStream(stream, excludeScreenAudioTrackId);
  return audible
    .getAudioTracks()
    .map((t) => `${t.id}:${t.readyState}:${t.enabled ? 1 : 0}`)
    .join("|");
}

/**
 * Видео и микрофон играются разными элементами.
 * Иначе Chromium замолкает весь video-элемент, когда кадр камеры становится muted
 * (выключение камеры во время демонстрации со звуком).
 */
export function RemotePeerMedia({
  stream,
  muted = false,
  volume = 1,
  sinkId,
  className,
  excludeScreenAudioTrackId
}: RemotePeerMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoHolder = useRef<MediaStream>(new MediaStream());
  const audioHolder = useRef<MediaStream>(new MediaStream());
  const [trackSignature, setTrackSignature] = useState(() => videoLiveSignature(stream));
  const hasLiveVideo = stream
    .getVideoTracks()
    .some((t) => t.enabled && t.readyState === "live" && !t.muted);
  const audioSignature = useMemo(
    () => audioLiveSignature(stream, excludeScreenAudioTrackId),
    [stream, trackSignature, excludeScreenAudioTrackId]
  );

  useEffect(() => {
    const bump = () => setTrackSignature(videoLiveSignature(stream));
    for (const track of stream.getTracks()) {
      track.addEventListener("mute", bump);
      track.addEventListener("unmute", bump);
      track.addEventListener("ended", bump);
    }
    bump();
    return () => {
      for (const track of stream.getTracks()) {
        track.removeEventListener("mute", bump);
        track.removeEventListener("unmute", bump);
        track.removeEventListener("ended", bump);
      }
    };
  }, [stream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    pruneStaleRemoteStreamTracks(stream);
    const holder = videoHolder.current;
    const want = stream.getVideoTracks().filter((t) => t.readyState !== "ended");
    const wantIds = new Set(want.map((t) => t.id));
    for (const track of [...holder.getVideoTracks()]) {
      if (!wantIds.has(track.id)) holder.removeTrack(track);
    }
    for (const track of want) {
      if (!holder.getVideoTracks().some((t) => t.id === track.id)) holder.addTrack(track);
    }
    if (el.srcObject !== holder) el.srcObject = holder;
    el.muted = true;
    el.style.visibility = hasLiveVideo ? "visible" : "hidden";
    if (hasLiveVideo && el.paused) void el.play().catch(() => undefined);
  }, [stream, trackSignature, hasLiveVideo]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const holder = audioHolder.current;
    const want = createPeerTileStream(stream, excludeScreenAudioTrackId).getAudioTracks();
    const wantIds = new Set(want.map((t) => t.id));
    for (const track of [...holder.getAudioTracks()]) {
      if (!wantIds.has(track.id)) holder.removeTrack(track);
    }
    for (const track of want) {
      if (!holder.getAudioTracks().some((t) => t.id === track.id)) holder.addTrack(track);
    }
    if (el.srcObject !== holder) el.srcObject = holder;
    el.muted = muted || want.length === 0;
    el.volume = Math.max(0, Math.min(1, volume));
    const anyEl = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId && typeof anyEl.setSinkId === "function") {
      void anyEl.setSinkId(sinkId).catch(() => undefined);
    }
    if (!el.muted && el.paused) {
      void el.play().catch((err: unknown) => {
        if (!(err instanceof DOMException) || err.name !== "AbortError") return;
        window.setTimeout(() => {
          if (audioRef.current !== el || el.muted || !el.paused) return;
          void el.play().catch(() => undefined);
        }, 80);
      });
    }
  }, [stream, audioSignature, excludeScreenAudioTrackId, muted, volume, sinkId]);

  return (
    <>
      <video ref={videoRef} className={className} playsInline autoPlay muted />
      <audio ref={audioRef} className="peerMicAudio" autoPlay />
    </>
  );
}
