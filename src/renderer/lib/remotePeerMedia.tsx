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
    .getTracks()
    .map((t) => `${t.id}:${t.readyState}:${t.enabled ? 1 : 0}:${t.muted ? 1 : 0}`)
    .join("|");
}

/** Сохраняет один MediaStream на элементе, чтобы сброс srcObject не обрывал звук при обновлении треков. */
export function RemotePeerMedia({
  stream,
  muted = false,
  volume = 1,
  sinkId,
  className,
  excludeScreenAudioTrackId
}: RemotePeerMediaProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [trackSignature, setTrackSignature] = useState(() => videoLiveSignature(stream));
  const hasLiveVideo = stream
    .getVideoTracks()
    .some((t) => t.enabled && t.readyState === "live" && !t.muted);

  const playbackStream = useMemo(() => {
    if (!excludeScreenAudioTrackId && stream.getAudioTracks().length <= 1) {
      const audioCount = stream.getAudioTracks().length;
      if (audioCount < 2) return stream;
    }
    return createPeerTileStream(stream, excludeScreenAudioTrackId);
  }, [stream, trackSignature, excludeScreenAudioTrackId]);

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
    const el = ref.current;
    if (!el) return;

    pruneStaleRemoteStreamTracks(stream, { dropMutedVideo: !hasLiveVideo });

    if (el.srcObject !== playbackStream) {
      el.srcObject = playbackStream;
    }
    // Скрытие зависшего кадра позволяет показать аватар вместо устаревшего изображения камеры или экрана.
    el.style.visibility = hasLiveVideo ? "visible" : "hidden";
    el.muted = muted;
    el.volume = volume;

    const anyEl = el as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId && typeof anyEl.setSinkId === "function") {
      void anyEl.setSinkId(sinkId).catch(() => undefined);
    }

    if (el.paused) {
      void el.play().catch(() => undefined);
    }

  }, [stream, playbackStream, trackSignature, muted, volume, sinkId, hasLiveVideo]);

  return <video ref={ref} className={className} playsInline autoPlay />;
}
