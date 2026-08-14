import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvailabilityStatus, AvatarPosition, ChatAttachment, ChatMessage, ChatScope, PeerInfo, RoomInfo, RtcSignal, UserProfile, WsEnvelope } from "../shared/types";
import { createPeerConnection, getVideoConstraints, replaceAudioTrack, replaceVideoTrack, replaceVideoTrackAsync, replaceMicAudioTrack, addScreenAudioTrack, detachScreenAudioTrack, addSecondaryVideoTrack, detachSecondaryVideoTrack, restoreCameraAfterScreenShare, tuneScreenShareSender, requestScreenShareKeyframe, type LocalMediaConfig, type VideoQuality } from "./lib/webrtc";
import {
  applyCameraControlsDebounced,
  cameraHasManualControls,
  defaultCameraControls,
  normalizeCameraControls,
  readCameraCapabilities,
  type CameraCapabilityInfo,
  type CameraControls
} from "./lib/cameraControls";
import {
  bindCameraFx,
  CAMERA_PRESETS,
  cameraBgAssetUrl,
  cameraFxNeedsProcessing,
  defaultCameraFxOptions,
  getCameraFxStream,
  getCameraFxTrack,
  isRawCameraTrack,
  markRawCameraTrack,
  normalizeCameraFxOptions,
  setCameraFxOptions,
  stopCameraFx,
  type CameraFxOptions
} from "./lib/cameraFx";
import {
  captureDesktopMedia,
  categorizeScreenSources,
  createPeerTileStream,
  createScreenShareViewStream,
  findPresenterCameraTrack,
  findScreenBroadcastAudioTrack,
  getMicAudioTrack,
  isScreenBroadcastAudioTrack,
  isScreenVideoTrack,
  pruneStaleRemoteStreamTracks,
  type ScreenShareTab
} from "./lib/screenShare";
import { createFilePreviewDataUrl, isVideoAttachmentMime } from "./lib/filePreview";
import { ScreenShareViewer, ScreenShareLocalSidebar, ScreenSharingDot, PresenterCameraPip, PeerShareMarks } from "./lib/screenShareViewer";
import { RemotePeerMedia } from "./lib/remotePeerMedia";
import { CallRecorder, recordingFileName, normalizeRecordingSettings, RECORDING_SIZE, type RecordingBitrate, type RecordingFormat, type RecordingFps, type RecordingQuality, type RecordSource } from "./lib/callRecorder";
import { speakRecordAnnouncement } from "./lib/recordVoice";
import { Select } from "./lib/Select";
import {
  MAX_CONFERENCE_PARTICIPANTS,
  applyConferenceHubFromRoom,
  canJoinConference,
  conferenceRejectMessage,
  createHostConferenceState,
  createJoinConferenceState,
  isConferenceCall,
  isDirectCall,
  resolveConferenceRoom
} from "./lib/conference";

const isSettingsWindow =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("window") === "settings";

const VIDEO_QUALITY_OPTIONS: Array<{ value: VideoQuality; labelKey: string }> = [
  { value: "low", labelKey: "videoQ_low" },
  { value: "medium", labelKey: "videoQ_medium" },
  { value: "high", labelKey: "videoQ_high" },
  { value: "fullhd", labelKey: "videoQ_fullhd" },
  { value: "qhd", labelKey: "videoQ_qhd" },
  { value: "uhd", labelKey: "videoQ_uhd" }
];

type FileTransferItem = {
  key: string;
  direction: "send" | "receive";
  peerId: string;
  fileId?: string;
  fileName: string;
  transferred: number;
  total: number;
  percent: number;
};

type CallContext =
  | {
      mode: "direct";
      peerId: string;
      peerName: string;
      signalHubPeerId: string;
      signalHubHost?: string;
      signalHubPort?: number;
    }
  | {
      mode: "room";
      roomId: string;
      roomName: string;
      hostPeerId: string;
      signalHubPeerId: string;
      signalHubHost?: string;
      signalHubPort?: number;
      hasPassword?: boolean;
      participants: Array<{ peerId: string; userName: string }>;
    };

type RemoteTrack = {
  peerId: string;
  userName: string;
  stream: MediaStream;
};

function formatTime(ts: number, showSeconds: boolean) {
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString(
    [],
    showSeconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" }
  );
  return `${date} ${time}`;
}

/** Убирает эмодзи/символы в начале статусных сообщений чата (в т.ч. из старой истории). */
function stripChatStatusEmoji(text: string) {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function formatDurationMs(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss.padStart(2, "0")}`;
}

/** Вертикальный или горизонтальный разделитель для изменения размера панелей */
function PanelResizer({
  axis,
  onDrag
}: {
  axis: "horizontal" | "vertical";
  onDrag: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const startRef = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startRef.current = axis === "horizontal" ? e.clientX : e.clientY;
    const handleMove = (e2: MouseEvent) => {
      const current = axis === "horizontal" ? e2.clientX : e2.clientY;
      const delta = current - startRef.current;
      startRef.current = current;
      onDragRef.current(delta);
    };
    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = axis === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  const isVertical = axis === "horizontal";
  return (
    <div
      className="panel-resizer"
      data-axis={axis}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      title={isVertical ? t("resizeWidth") : t("resizeHeight")}
    />
  );
}

function ProfileAvatar({
  src,
  name,
  className = "",
  position,
  onClick
}: {
  src: string;
  name: string;
  className?: string;
  position?: AvatarPosition;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const x = position?.x ?? 50;
  const y = position?.y ?? 50;
  const zoom = Math.max(1, Math.min(3, (position?.zoom ?? 100) / 100));
  return (
    <span
      className={`profileAvatar ${className}${onClick ? " profileAvatarClickable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => (event.key === "Enter" || event.key === " " ? (event.preventDefault(), onClick()) : undefined) : undefined}
    >
      <img
        className="profileAvatarInner"
        src={src}
        alt={t("avatarAlt", { name })}
        style={{
          objectPosition: `${x}% ${y}%`,
          transform: `scale(${zoom})`,
          transformOrigin: `${x}% ${y}%`
        }}
        draggable={false}
      />
    </span>
  );
}

function parentDirOf(filePath: string) {
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

export function App() {
  const { t, i18n } = useTranslation();
  const statusLabel = (s: AvailabilityStatus) => t(`status_${s}`);

  const isBusyStatus = (s: AvailabilityStatus) => s === "in_call" || s === "in_conference";
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [bootProgress, setBootProgress] = useState(0);
  const [bootLabel, setBootLabel] = useState("loading");
  const [bootReady, setBootReady] = useState(false);
  const [signalingPort, setSignalingPort] = useState<number>(0);
  const [appVersion, setAppVersion] = useState("1.1.0");
  const [localIps, setLocalIps] = useState<string[]>([]);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [unreadPeerIds, setUnreadPeerIds] = useState<Set<string>>(new Set());
  const [unreadMessageIds, setUnreadMessageIds] = useState<Set<string>>(new Set());
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const [avatarViewer, setAvatarViewer] = useState<{ peerId: string; name: string } | null>(null);
  const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
  const selectedPeerRef = useRef<PeerInfo | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<RoomInfo | null>(null);
  const [incomingCall, setIncomingCall] = useState<{ peerId: string; userName: string } | null>(null);
  const [incomingCallBlink, setIncomingCallBlink] = useState(false);
  const incomingCallTimerRef = useRef<number | null>(null);
  const incomingCallSoundIntervalRef = useRef<number | null>(null);
  const incomingCallTimeoutRef = useRef<number | null>(null);
  const [incomingRoomInvite, setIncomingRoomInvite] = useState<{
    fromPeerId: string;
    fromUserName: string;
    room: RoomInfo;
  } | null>(null);
  const [incomingRoomInviteBlink, setIncomingRoomInviteBlink] = useState(false);
  const incomingRoomInviteTimerRef = useRef<number | null>(null);
  const incomingRoomInviteTimeoutRef = useRef<number | null>(null);
  const [inviteRejectedNotice, setInviteRejectedNotice] = useState<{ userName: string; roomName: string } | null>(null);
  const inviteRejectedTimeoutRef = useRef<number | null>(null);
  const [pendingInvitePeerIds, setPendingInvitePeerIds] = useState<Set<string>>(new Set());
  const pendingInviteTimeoutRef = useRef<Map<string, number>>(new Map());
  const [pendingCallPeerIds, setPendingCallPeerIds] = useState<Set<string>>(new Set());
  const pendingCallTimeoutRef = useRef<Map<string, number>>(new Map());
  const [peerActionIndicators, setPeerActionIndicators] = useState<Map<string, "message" | "call">>(new Map());
  const [flashingPeerActionIds, setFlashingPeerActionIds] = useState<Set<string>>(new Set());
  const peerActionFlashTimeoutRef = useRef<Map<string, number>>(new Map());
  const intentionalPeerDisconnectsRef = useRef<Set<string>>(new Set());
  const fileTransferCancelRef = useRef<Set<string>>(new Set());
  const [typingPeers, setTypingPeers] = useState<Set<string>>(new Set());
  const typingTimeoutRef = useRef<Map<string, number>>(new Map());
  const [fileTransfers, setFileTransfers] = useState<FileTransferItem[]>([]);
  const fileTransferUiThrottleRef = useRef<Map<string, number>>(new Map());
  const [call, setCall] = useState<CallContext | null>(null);
  const callRef = useRef<CallContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const isSharingRef = useRef(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const recordingActiveRef = useRef(false);
  const [remoteRecordings, setRemoteRecordings] = useState<Array<{ peerId: string; userName: string }>>([]);
  const [recordingDir, setRecordingDir] = useState("");
  const [lastRecordingPath, setLastRecordingPath] = useState("");
  const [recordingFormat, setRecordingFormat] = useState<RecordingFormat>("mp4");
  const [recordingQuality, setRecordingQuality] = useState<RecordingQuality>("1080p");
  const [recordingFps, setRecordingFps] = useState<RecordingFps>(30);
  const [recordingBitrate, setRecordingBitrate] = useState<RecordingBitrate>("high");
  const callRecorderRef = useRef<CallRecorder | null>(null);
  const recordingSessionRef = useRef<string | null>(null);
  const appWindowCaptureRef = useRef<MediaStream | null>(null);
  const [remoteScreenShare, setRemoteScreenShare] = useState<{
    peerId: string;
    userName: string;
    screenAudioTrackId?: string;
    screenVideoTrackId?: string;
  } | null>(null);
  const [screenViewControlsHidden, setScreenViewControlsHidden] = useState(false);
  const [screenShareViewCollapsed, setScreenShareViewCollapsed] = useState(false);
  const [screenBroadcastMuted, setScreenBroadcastMuted] = useState(false);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>("");
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string>("");
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string>("");
  const [manualHost, setManualHost] = useState("127.0.0.1");
  const [manualPort, setManualPort] = useState("");
  const [manualPeers, setManualPeers] = useState<PeerInfo[]>([]);
  const [smilesFiles, setSmilesFiles] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsWindow);
  const [chatHeight, setChatHeight] = useState(380);
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [fontScale, setFontScale] = useState(0.95);
  const [compactUi, setCompactUi] = useState(false);
  const [showSeconds, setShowSeconds] = useState(false);
  const [autoAwayMinutes, setAutoAwayMinutes] = useState(5);
  const [autoSwitchToChat, setAutoSwitchToChat] = useState(true);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [chatAutoScroll, setChatAutoScroll] = useState(true);
  const [chatSmileSizePx, setChatSmileSizePx] = useState(24);
  const [chatFontSize, setChatFontSize] = useState(14);
  const [chatDisplayLimit, setChatDisplayLimit] = useState(0);
  const [speakingIndicator, setSpeakingIndicator] = useState(true);
  const [tileAspect, setTileAspect] = useState<"auto" | "16x9" | "4x3" | "1x1">("16x9");
  const [tileObjectFit, setTileObjectFit] = useState<"cover" | "contain">("cover");
  const [tileRadius, setTileRadius] = useState(12);
  const [tileGap, setTileGap] = useState(5);
  const [microphoneVolume, setMicrophoneVolume] = useState(100);
  const [speakerVolume, setSpeakerVolume] = useState(100); // legacy alias → remoteMicVolume
  const [remoteMicVolume, setRemoteMicVolume] = useState(100);
  const [remoteScreenShareVolume, setRemoteScreenShareVolume] = useState(100);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [noiseSuppressionSensitivity, setNoiseSuppressionSensitivity] = useState(50);
  const [soundNotificationsEnabled, setSoundNotificationsEnabled] = useState(true);
  const [soundNotificationVolume, setSoundNotificationVolume] = useState(50);
  const [callSoundFile, setCallSoundFile] = useState("snds/call.mp3");
  const [messageSoundFile, setMessageSoundFile] = useState("snds/sms.mp3");
  const [callerSoundFile, setCallerSoundFile] = useState("snds/call_1.mp3");
  const [connectionSoundFile, setConnectionSoundFile] = useState("snds/int.mp3");
  const [recordingSoundFile, setRecordingSoundFile] = useState("");
  const [callSoundVolume, setCallSoundVolume] = useState(50);
  const [messageSoundVolume, setMessageSoundVolume] = useState(50);
  const [callerSoundVolume, setCallerSoundVolume] = useState(50);
  const [connectionSoundVolume, setConnectionSoundVolume] = useState(50);
  const [recordingSoundVolume, setRecordingSoundVolume] = useState(50);
  const [settingsTab, setSettingsTab] = useState<"media" | "camera" | "audio" | "ui" | "connection" | "help">("media");
  const [cameraControls, setCameraControls] = useState<CameraControls>(defaultCameraControls);
  const [cameraCaps, setCameraCaps] = useState<CameraCapabilityInfo | null>(null);
  const cameraControlsRef = useRef<CameraControls>(defaultCameraControls);
  const [cameraFx, setCameraFx] = useState<CameraFxOptions>(defaultCameraFxOptions);
  const cameraFxRef = useRef<CameraFxOptions>(defaultCameraFxOptions);
  const cameraFxNeedRef = useRef(false);
  const cameraRawStreamRef = useRef<MediaStream | null>(null);
  const [exitConfirmKind, setExitConfirmKind] = useState<"quit" | "leave" | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [customCameraBgs, setCustomCameraBgs] = useState<Array<{ id: string; dataUrl: string }>>([]);
  const [previewDragging, setPreviewDragging] = useState(false);
  const previewDragRef = useRef<{ x: number; y: number; panX: number; panY: number; width: number; height: number } | null>(null);
  const testSoundAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioNotificationRef = useRef<HTMLAudioElement | null>(null);

  const [micLevel, setMicLevel] = useState(0); // 0..1 (settings preview)
  const [speakerLevelByPeerId, setSpeakerLevelByPeerId] = useState<Record<string, number>>({}); // peerId -> 0..1
  const [localStreamVer, setLocalStreamVer] = useState(0);

  const connectedPeersRef = useRef<Set<string>>(new Set());
  const connectingPeerRef = useRef<Map<string, Promise<void>>>(new Map());
  const disconnectTimersRef = useRef<Map<string, number>>(new Map());
  const avatarRequestsRef = useRef<Set<string>>(new Set());

  const onEnvelopeRef = useRef<(env: WsEnvelope) => void>(() => undefined);

  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  /** При true крестик/Отмена на диалоге имени закрывают приложение (старт). */
  const [nameDialogExitsApp, setNameDialogExitsApp] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingStatus, setPendingStatus] = useState<AvailabilityStatus>("online");

  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const [roomPassDraft, setRoomPassDraft] = useState("");

  const [roomJoinPassOpen, setRoomJoinPassOpen] = useState(false);
  const [roomJoinPassDraft, setRoomJoinPassDraft] = useState("");
  const [roomJoinTarget, setRoomJoinTarget] = useState<RoomInfo | null>(null);
  const [roomJoinFromInvite, setRoomJoinFromInvite] = useState<{ fromUserName: string } | null>(null);
  const lastJoinRoomRef = useRef<RoomInfo | null>(null);
  const joiningRoomFromInviteRef = useRef(false);

  const [screenShareDialogOpen, setScreenShareDialogOpen] = useState(false);
  const [screenSources, setScreenSources] = useState<Array<{ id: string; name: string; thumbnail: string }>>([]);
  const [screenShareTab, setScreenShareTab] = useState<ScreenShareTab>("screen");
  const [selectedScreenSource, setSelectedScreenSource] = useState<string | null>(null);
  const [screenShareWithAudio, setScreenShareWithAudio] = useState(true);

  const [mediaCfg, setMediaCfg] = useState<LocalMediaConfig>({
    videoEnabled: false,
    audioEnabled: true,
    videoQuality: "medium"
  });
  const videoEnabledRef = useRef(false);
  videoEnabledRef.current = mediaCfg.videoEnabled;
  const audioEnabledRef = useRef(true);
  audioEnabledRef.current = mediaCfg.audioEnabled;
  const restoringMicRef = useRef<Promise<void> | null>(null);
  const helloStatusRef = useRef(new Map<string, AvailabilityStatus>());
  const applyHelloStatus = (peers: PeerInfo[]) => {
    const hello = helloStatusRef.current;
    if (hello.size === 0) return peers;
    return peers.map((p) => {
      const status = hello.get(p.peerId);
      return status && status !== p.status ? { ...p, status } : p;
    });
  };

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localTileRef = useRef<HTMLDivElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const shareTrackRef = useRef<MediaStreamTrack | null>(null);
  const shareScreenAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  const applyCameraToTrack = (track: MediaStreamTrack | null | undefined) => {
    if (!track || track.kind !== "video") return;
    if (shareTrackRef.current && (track === shareTrackRef.current || track.id === shareTrackRef.current.id)) return;
    if (!isRawCameraTrack(track) && !track.getSettings()?.deviceId) return;
    void applyCameraControlsDebounced(track, cameraControlsRef.current);
  };

  const applyCameraToStream = (stream: MediaStream | null | undefined) => {
    if (!stream) return;
    for (const track of stream.getVideoTracks()) applyCameraToTrack(track);
  };

  const stopRawCamera = () => {
    const raw = cameraRawStreamRef.current;
    cameraRawStreamRef.current = null;
    raw?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // игнор
      }
    });
    stopCameraFx({ stopOutput: true });
  };

  const prepareCameraTrack = async (raw: MediaStreamTrack | null): Promise<MediaStreamTrack | null> => {
    if (!raw) return null;
    markRawCameraTrack(raw);
    const prevRaw = cameraRawStreamRef.current;
    const rawStream = new MediaStream([raw]);
    cameraRawStreamRef.current = rawStream;
    applyCameraToTrack(raw);
    const fx = cameraFxRef.current;
    setCameraFxOptions(fx);
    cameraFxNeedRef.current = cameraFxNeedsProcessing(fx);
    if (!cameraFxNeedsProcessing(fx)) {
      stopCameraFx({ stopOutput: true });
      if (prevRaw && prevRaw !== rawStream) {
        for (const t of prevRaw.getTracks()) {
          if (t !== raw) {
            try {
              t.stop();
            } catch {
              // игнор
            }
          }
        }
      }
      return raw;
    }
    await bindCameraFx(rawStream);
    if (prevRaw && prevRaw !== rawStream) {
      for (const t of prevRaw.getTracks()) {
        if (t !== raw) {
          try {
            t.stop();
          } catch {
            // игнор
          }
        }
      }
    }
    return getCameraFxTrack() ?? raw;
  };

  const installProcessedCamera = (local: MediaStream, processed: MediaStreamTrack | null) => {
    if (!processed) return;
    const oldCams = local.getVideoTracks().filter((t) => t !== shareTrackRef.current && t !== processed);
    for (const old of oldCams) {
      local.removeTrack(old);
      if (!isRawCameraTrack(old)) {
        try {
          old.stop();
        } catch {
          // игнор
        }
      }
    }
    if (!local.getVideoTracks().includes(processed)) local.addTrack(processed);
  };
  /** sourceId текущей демонстрации (screen:/window:). */
  const shareSourceIdRef = useRef<string | null>(null);
  const pendingRenegotiateRef = useRef<Map<string, string | undefined>>(new Map());
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dcsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const remoteRef = useRef<Map<string, RemoteTrack>>(new Map());
  const fileUrlByIdRef = useRef<Map<string, string>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneGainNodeRef = useRef<GainNode | null>(null);
  const incomingFileRef = useRef<
    Map<
      string,
      {
        id: string;
        name: string;
        size: number;
        mime?: string;
        received: number;
        chunks: ArrayBuffer[];
      }
    >
  >(new Map());
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrack[]>([]);
  const prevStatusRef = useRef<AvailabilityStatus | null>(null);
  const lastActivityRef = useRef(Date.now());
  const autoAwayAppliedRef = useRef(false);
  const autoAwayMinutesRef = useRef(5);
  const profileStatusRef = useRef<AvailabilityStatus>("online");
  profileStatusRef.current = profile?.status ?? "online";
  autoAwayMinutesRef.current = autoAwayMinutes;
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const speakerPrevRef = useRef<Record<string, number>>({});

  // Функция для преобразования пути к файлу в URL для Electron
  function getSoundFileUrl(filePath: string): string {
    if (!filePath) return "";
    
    // Если уже URL (http://, https://, file://), возвращаем как есть
    if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.startsWith("file://")) {
      return filePath;
    }
    
    // Проверяем, является ли путь абсолютным Windows путем (C:\ или C:/)
    const windowsPathMatch = filePath.match(/^([A-Za-z]):[\\/]/);
    if (windowsPathMatch) {
      // Windows путь: C:\path\to\file.mp3 или C:/path/to/file.mp3 -> file:///C:/path/to/file.mp3
      const normalizedPath = filePath.replace(/\\/g, "/");
      return `file:///${normalizedPath}`;
    }
    
    // Проверяем, является ли путь абсолютным Unix путем (начинается с /)
    if (filePath.startsWith("/")) {
      // Unix путь: /path/to/file.mp3 -> file:///path/to/file.mp3
      return `file://${filePath}`;
    }
    
    // Относительный путь: используем текущее местоположение как базу
    // В Electron это будет работать относительно текущего HTML файла
    try {
      const baseUrl = window.location.href;
      const basePath = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
      return new URL(filePath, basePath).href;
    } catch {
      // Если не удалось создать URL, возвращаем исходный путь
      return filePath;
    }
  }

  // Функция для воспроизведения звуковых уведомлений
  function playNotificationSound(soundFile: string, volume?: number) {
    if (!soundNotificationsEnabled) return;
    try {
      const fileUrl = getSoundFileUrl(soundFile);
      const audio = new Audio(fileUrl);
      audio.volume = (volume ?? soundNotificationVolume) / 100;
      audio.play().catch(() => {
        // Игнорируем ошибки воспроизведения (например, если файл не найден)
      });
    } catch {
      // Игнорируем ошибки
    }
  }

  function playRecordingAnnouncement(kind: "start" | "stop") {
    if (recordingSoundFile) {
      playNotificationSound(recordingSoundFile, recordingSoundVolume);
      return;
    }
    speakRecordAnnouncement(kind);
  }

  function statusBadgeClass(s: AvailabilityStatus) {
    if (s === "online") return "badgeOk";
    if (s === "in_call") return "badgeInCall";
    if (s === "in_conference") return "badgeInConference";
    if (s === "away") return "badgeAway";
    if (s === "dnd") return "badgeDnd";
    return "badgeOffline";
  }

  // Единые ограничения для микрофона: ideal вместо strict, чтобы браузер не давал «тихий» трек при шумоподавлении
  function getAudioConstraintsForMic(deviceId = selectedAudioInputId): MediaTrackConstraints {
    const ac: MediaTrackConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: noiseSuppression },
      autoGainControl: { ideal: noiseSuppressionSensitivity > 30 },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    };
    if (deviceId) (ac as any).deviceId = { ideal: deviceId };
    return ac;
  }

  function isNotFoundMediaError(err: unknown) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    return name === "NotFoundError" || /requested device not found/i.test(msg) || /device not found/i.test(msg);
  }

  function clearStaleMediaDeviceIds(kind?: "audio" | "video" | "both") {
    const clearAudio = kind !== "video";
    const clearVideo = kind !== "audio";
    if (clearAudio && selectedAudioInputId) {
      setSelectedAudioInputId("");
      void window.lokameet.app.updateProfile({ audioInputDeviceId: "" }).catch(() => undefined);
    }
    if (clearVideo && selectedVideoDeviceId) {
      setSelectedVideoDeviceId("");
      void window.lokameet.app.updateProfile({ videoInputDeviceId: "" }).catch(() => undefined);
    }
  }

  function getKnownPeerHost(peerId: string): string | null {
    const p = peers.find((x) => x.peerId === peerId) ?? manualPeers.find((x) => x.peerId === peerId) ?? null;
    return p?.host ?? null;
  }

  function ipv4Prefix24(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip.trim());
    return m ? m[1] : null;
  }

  function extractCandidateIp(cand: string): string | null {
    // candidate:... <ip> <port> typ ...
    const m = /candidate:\S+ \d+ (udp|tcp) \d+ (\d{1,3}(?:\.\d{1,3}){3}) \d+ typ/.exec(cand);
    return m ? m[2] : null;
  }

  function shouldSendIceCandidate(remotePeerId: string, cand: RTCIceCandidateInit): boolean {
    const s = cand.candidate ?? "";
    if (!s) return true;
    if (/\btcp\b/i.test(s)) return false;

    const remoteHost = getKnownPeerHost(remotePeerId) ?? call?.signalHubHost ?? null;
    const pref = ipv4Prefix24(remoteHost);
    if (!pref) return true;

    const ip = extractCandidateIp(s);
    if (!ip) return true;
    const ipPref = ipv4Prefix24(ip);
    if (!ipPref) return true;
    return ipPref === pref;
  }

  function tileGridColumns(count: number) {
    if (count <= 1) return 1;
    if (count === 2) return 2;
    if (count <= 4) return 2;
    if (count <= 6) return 3;
    if (count <= 9) return 3;
    if (count <= 12) return 4;
    if (count <= 16) return 4;
    return Math.max(4, Math.ceil(Math.sqrt(count)));
  }

  function tileAspectCss(aspect: typeof tileAspect) {
    if (aspect === "16x9") return "16 / 9";
    if (aspect === "4x3") return "4 / 3";
    if (aspect === "1x1") return "1 / 1";
    return "auto";
  }

  function speakingVars(level: number): React.CSSProperties {
    const lv = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    // Чуть ярче: выше floor и круче кривая, чтобы кольцо и квадрат у ника лучше читались.
    const intensity = lv <= 0.01 ? 0 : Math.min(1, 0.34 + Math.pow(lv, 0.75) * 0.78);
    return { ["--speak-level" as string]: String(intensity) };
  }

  function quitApp() {
    void window.lokameet.app.quit().catch(() => undefined);
  }

  function closeNameDialog() {
    if (nameDialogExitsApp) {
      quitApp();
      return;
    }
    setNameDialogOpen(false);
  }

  useEffect(() => {
    // Тик таймера во время звонка/конференции
    if (!callStartedAt) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [callStartedAt]);

  useEffect(() => {
    // Сразу применяем UI-настройки
    document.documentElement.style.fontSize = `${Math.round(16 * (fontScale || 1))}px`;
    document.documentElement.dataset.compact = compactUi ? "1" : "0";
    document.documentElement.style.setProperty("--chatSmileSize", `${Math.max(16, Math.min(128, chatSmileSizePx || 24))}px`);
    document.documentElement.style.setProperty("--tile-gap", `${Math.max(4, Math.min(24, tileGap))}px`);
    document.documentElement.style.setProperty("--tile-radius", `${Math.max(4, Math.min(28, tileRadius))}px`);
    document.documentElement.style.setProperty("--tile-fit", tileObjectFit);
    document.documentElement.style.setProperty("--tile-aspect", tileAspectCss(tileAspect));
  }, [fontScale, compactUi, chatSmileSizePx, tileGap, tileRadius, tileObjectFit, tileAspect]);

  useEffect(() => {
    // Превью уровня мика, пока открыты настройки.
    // Используем существующий локальный поток, если он есть, чтобы не открывать второй getUserMedia
    // с другими ограничениями — иначе звук может пропадать при переключении шумоподавления.
    if (!settingsOpen) return;
    let stopped = false;
    let ctx: AudioContext | null = null;
    let tempStream: MediaStream | null = null;
    let timer: number | null = null;

    (async () => {
      try {
        const local = localStreamRef.current ?? null;
        const useLocal = (local?.getAudioTracks()?.length ?? 0) > 0;
        let stream: MediaStream;

        if (useLocal && local) {
          stream = local;
        } else {
          const ac = getAudioConstraintsForMic();
          tempStream = await navigator.mediaDevices.getUserMedia({ audio: ac, video: false });
          if (!tempStream) {
            setMicLevel(0);
            return;
          }
          stream = tempStream;
        }
        if (stopped) return;
        ctx = new AudioContext();
        await ctx.resume().catch(() => undefined);
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.85;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        timer = window.setInterval(() => {
          if (stopped) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          const norm = Math.max(0, Math.min(1, (rms - 0.01) / 0.15));
          setMicLevel(norm);
        }, 80);
      } catch {
        setMicLevel(0);
      }
    })();

    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
      setMicLevel(0);
      try {
        tempStream?.getTracks().forEach((t) => t.stop());
      } catch {
        // игнор
      }
      try {
        void ctx?.close();
      } catch {
        // игнор
      }
    };
  }, [settingsOpen, selectedAudioInputId, noiseSuppression, noiseSuppressionSensitivity, localStreamVer]);

  useEffect(() => {
    cameraControlsRef.current = cameraControls;
    applyCameraToStream(cameraRawStreamRef.current);
  }, [cameraControls]);

  useEffect(() => {
    cameraFxRef.current = cameraFx;
    setCameraFxOptions(cameraFx);
    const need = cameraFxNeedsProcessing(cameraFx);
    if (need === cameraFxNeedRef.current) return;
    cameraFxNeedRef.current = need;
    if (!videoEnabledRef.current) return;
    const raw = cameraRawStreamRef.current?.getVideoTracks().find((t) => t.readyState === "live") ?? null;
    if (!raw) return;
    void (async () => {
      const processed = await prepareCameraTrack(raw);
      const local = localStreamRef.current;
      if (!local || !processed) return;
      await publishLocalCameraTrack(processed, local);
      syncLocalVideoPreview();
    })().catch(() => undefined);
  }, [cameraFx]);

  useEffect(() => {
    if (isSettingsWindow) document.documentElement.dataset.settingsWindow = "1";
    else delete document.documentElement.dataset.settingsWindow;
  }, []);

  useEffect(() => {
    return window.lokameet.chat.onCleared(() => setChats([]));
  }, []);

  const settingsDraftReadyRef = useRef(!isSettingsWindow);
  const settingsLiveRef = useRef({
    cameraFx,
    cameraControls,
    videoQuality: mediaCfg.videoQuality,
    selectedVideoDeviceId,
    selectedAudioInputId,
    selectedAudioOutputId,
    microphoneVolume,
    remoteMicVolume,
    remoteScreenShareVolume,
    noiseSuppression,
    noiseSuppressionSensitivity,
    chatHeight,
    sidebarWidth,
    fontScale,
    compactUi,
    showSeconds,
    autoAwayMinutes,
    autoSwitchToChat,
    chatAutoScroll,
    chatSmileSizePx,
    chatFontSize,
    chatDisplayLimit,
    speakingIndicator,
    tileAspect,
    tileObjectFit,
    tileRadius,
    tileGap,
    recordingFormat,
    recordingQuality,
    recordingFps,
    recordingBitrate,
    recordingDir,
    lastRecordingPath
  });
  settingsLiveRef.current = {
    cameraFx,
    cameraControls,
    videoQuality: mediaCfg.videoQuality,
    selectedVideoDeviceId,
    selectedAudioInputId,
    selectedAudioOutputId,
    microphoneVolume,
    remoteMicVolume,
    remoteScreenShareVolume,
    noiseSuppression,
    noiseSuppressionSensitivity,
    chatHeight,
    sidebarWidth,
    fontScale,
    compactUi,
    showSeconds,
    autoAwayMinutes,
    autoSwitchToChat,
    chatAutoScroll,
    chatSmileSizePx,
    chatFontSize,
    chatDisplayLimit,
    speakingIndicator,
    tileAspect,
    tileObjectFit,
    tileRadius,
    tileGap,
    recordingFormat,
    recordingQuality,
    recordingFps,
    recordingBitrate,
    recordingDir,
    lastRecordingPath
  };

  useEffect(() => {
    const bc = new BroadcastChannel("lokameet-settings-sync");
    const applyLive = (payload: Partial<typeof settingsLiveRef.current>) => {
      if (payload.cameraFx) setCameraFx(payload.cameraFx);
      if (payload.cameraControls) setCameraControls(payload.cameraControls);
      if (payload.videoQuality) setMediaCfg((c) => ({ ...c, videoQuality: payload.videoQuality! }));
      if (typeof payload.selectedVideoDeviceId === "string") setSelectedVideoDeviceId(payload.selectedVideoDeviceId);
      if (typeof payload.selectedAudioInputId === "string") setSelectedAudioInputId(payload.selectedAudioInputId);
      if (typeof payload.selectedAudioOutputId === "string") setSelectedAudioOutputId(payload.selectedAudioOutputId);
      if (typeof payload.microphoneVolume === "number") setMicrophoneVolume(payload.microphoneVolume);
      if (typeof payload.remoteMicVolume === "number") setRemoteMicVolume(payload.remoteMicVolume);
      if (typeof payload.remoteScreenShareVolume === "number") setRemoteScreenShareVolume(payload.remoteScreenShareVolume);
      if (typeof payload.noiseSuppression === "boolean") setNoiseSuppression(payload.noiseSuppression);
      if (typeof payload.noiseSuppressionSensitivity === "number") setNoiseSuppressionSensitivity(payload.noiseSuppressionSensitivity);
      if (typeof payload.chatHeight === "number") setChatHeight(payload.chatHeight);
      if (typeof payload.sidebarWidth === "number") setSidebarWidth(payload.sidebarWidth);
      if (typeof payload.fontScale === "number") setFontScale(payload.fontScale);
      if (typeof payload.compactUi === "boolean") setCompactUi(payload.compactUi);
      if (typeof payload.showSeconds === "boolean") setShowSeconds(payload.showSeconds);
      if (typeof payload.autoAwayMinutes === "number") setAutoAwayMinutes(payload.autoAwayMinutes);
      if (typeof payload.autoSwitchToChat === "boolean") setAutoSwitchToChat(payload.autoSwitchToChat);
      if (typeof payload.chatAutoScroll === "boolean") setChatAutoScroll(payload.chatAutoScroll);
      if (typeof payload.chatSmileSizePx === "number") setChatSmileSizePx(payload.chatSmileSizePx);
      if (typeof payload.chatFontSize === "number") setChatFontSize(payload.chatFontSize);
      if (typeof payload.chatDisplayLimit === "number") setChatDisplayLimit(payload.chatDisplayLimit);
      if (typeof payload.speakingIndicator === "boolean") setSpeakingIndicator(payload.speakingIndicator);
      if (payload.tileAspect) setTileAspect(payload.tileAspect);
      if (payload.tileObjectFit) setTileObjectFit(payload.tileObjectFit);
      if (typeof payload.tileRadius === "number") setTileRadius(payload.tileRadius);
      if (typeof payload.tileGap === "number") setTileGap(payload.tileGap);
      if (payload.recordingFormat === "avi" || payload.recordingFormat === "mp4") setRecordingFormat(payload.recordingFormat);
      if (payload.recordingQuality === "480p" || payload.recordingQuality === "720p" || payload.recordingQuality === "1080p" || payload.recordingQuality === "1440p") {
        setRecordingQuality(payload.recordingQuality);
      }
      if (payload.recordingFps === 15 || payload.recordingFps === 24 || payload.recordingFps === 30) setRecordingFps(payload.recordingFps);
      if (payload.recordingBitrate === "low" || payload.recordingBitrate === "medium" || payload.recordingBitrate === "high" || payload.recordingBitrate === "max") {
        setRecordingBitrate(payload.recordingBitrate);
      }
      if (typeof payload.recordingDir === "string") setRecordingDir(payload.recordingDir);
      if (typeof payload.lastRecordingPath === "string") setLastRecordingPath(payload.lastRecordingPath);
    };
    bc.onmessage = (ev) => {
      const data = ev.data as { type?: string; payload?: Partial<typeof settingsLiveRef.current> } | undefined;
      if (!data) return;
      if (isSettingsWindow && data.type === "draft" && data.payload) {
        settingsDraftReadyRef.current = true;
        applyLive(data.payload);
      }
      if (!isSettingsWindow && data.type === "live" && data.payload) applyLive(data.payload);
      if (!isSettingsWindow && data.type === "requestDraft") {
        bc.postMessage({ type: "draft", payload: settingsLiveRef.current });
      }
    };
    if (isSettingsWindow && bootReady) bc.postMessage({ type: "requestDraft" });
    return () => bc.close();
  }, [bootReady]);

  useEffect(() => {
    if (!isSettingsWindow || !bootReady || !settingsDraftReadyRef.current) return;
    const bc = new BroadcastChannel("lokameet-settings-sync");
    bc.postMessage({ type: "live", payload: settingsLiveRef.current });
    bc.close();
  }, [
    cameraFx,
    cameraControls,
    mediaCfg.videoQuality,
    selectedVideoDeviceId,
    selectedAudioInputId,
    selectedAudioOutputId,
    microphoneVolume,
    remoteMicVolume,
    remoteScreenShareVolume,
    noiseSuppression,
    noiseSuppressionSensitivity,
    chatHeight,
    sidebarWidth,
    fontScale,
    compactUi,
    showSeconds,
    autoAwayMinutes,
    autoSwitchToChat,
    chatAutoScroll,
    chatSmileSizePx,
    chatFontSize,
    chatDisplayLimit,
    speakingIndicator,
    tileAspect,
    tileObjectFit,
    tileRadius,
    tileGap,
    recordingFormat,
    recordingQuality,
    recordingFps,
    recordingBitrate,
    recordingDir,
    bootReady
  ]);

  async function addCustomCameraBackground() {
    try {
      const sourcePath = await window.lokameet.app.showOpenDialog({
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }]
      });
      if (!sourcePath) return;
      const saved = await window.lokameet.cameraBg.saveFromPath(sourcePath);
      setCustomCameraBgs((list) => [...list, saved]);
      setCameraFx((c) => ({ ...c, backgroundMode: "custom", customId: saved.id, customDataUrl: saved.dataUrl }));
    } catch {
      setError(t("errPickFile"));
    }
  }

  async function deleteCustomCameraBackground(id: string) {
    await window.lokameet.cameraBg.remove(id).catch(() => undefined);
    setCustomCameraBgs((list) => list.filter((item) => item.id !== id));
    setCameraFx((c) => (c.customId === id ? { ...c, backgroundMode: "none", customId: null, customDataUrl: null } : c));
  }

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "camera") {
      setCameraCaps(null);
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      if (!videoEnabledRef.current) stopRawCamera();
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const liveRaw =
          cameraRawStreamRef.current?.getVideoTracks().find((t) => t.readyState === "live") ?? null;
        if (liveRaw && cameraRawStreamRef.current) {
          setCameraCaps(readCameraCapabilities(liveRaw));
          setCameraFxOptions(cameraFxRef.current);
          await bindCameraFx(cameraRawStreamRef.current);
          if (cancelled) return;
          if (cameraPreviewRef.current) {
            cameraPreviewRef.current.srcObject = getCameraFxStream();
            await cameraPreviewRef.current.play().catch(() => undefined);
          }
          return;
        }

        const vc = getVideoConstraints(mediaCfg.videoQuality);
        if (selectedVideoDeviceId) (vc as MediaTrackConstraints & { deviceId?: ConstrainDOMString }).deviceId = { ideal: selectedVideoDeviceId };
        const stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const camTrack = stream.getVideoTracks()[0] ?? null;
        if (camTrack) {
          markRawCameraTrack(camTrack);
          cameraRawStreamRef.current = stream;
          applyCameraToTrack(camTrack);
          setCameraFxOptions(cameraFxRef.current);
          await bindCameraFx(stream);
          setCameraCaps(readCameraCapabilities(camTrack));
          if (typeof camTrack.getSettings === "function") {
            const settings = camTrack.getSettings() as MediaTrackSettings & Record<string, number | string | undefined>;
            setCameraControls((current) => ({
              ...current,
              focusDistance: current.focusDistance ?? (typeof settings.focusDistance === "number" ? settings.focusDistance : undefined),
              zoom: current.zoom ?? (typeof settings.zoom === "number" ? settings.zoom : undefined),
              brightness: current.brightness ?? (typeof settings.brightness === "number" ? settings.brightness : undefined),
              contrast: current.contrast ?? (typeof settings.contrast === "number" ? settings.contrast : undefined),
              saturation: current.saturation ?? (typeof settings.saturation === "number" ? settings.saturation : undefined),
              sharpness: current.sharpness ?? (typeof settings.sharpness === "number" ? settings.sharpness : undefined),
              exposureCompensation:
                current.exposureCompensation ??
                (typeof settings.exposureCompensation === "number" ? settings.exposureCompensation : undefined),
              colorTemperature:
                current.colorTemperature ?? (typeof settings.colorTemperature === "number" ? settings.colorTemperature : undefined)
            }));
          }
        }
        if (cancelled) return;
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = getCameraFxStream();
          await cameraPreviewRef.current.play().catch(() => undefined);
        }
      } catch {
        if (!cancelled && cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      }
    })();

    return () => {
      cancelled = true;
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      if (!videoEnabledRef.current) stopRawCamera();
    };
  }, [settingsOpen, settingsTab, selectedVideoDeviceId, mediaCfg.videoQuality]);

  useEffect(() => {
    // Индикатор говорящего (локальный + удалённый)
    if (!call || !speakingIndicator) {
      setSpeakerLevelByPeerId({});
      speakerPrevRef.current = {};
      return;
    }

    let stopped = false;
    const ctx = new AudioContext();
    void ctx.resume().catch(() => undefined);
    const analysers = new Map<string, AnalyserNode>();
    const sources: Array<MediaStreamAudioSourceNode> = [];
    const bufById = new Map<string, Uint8Array>();

    const addStream = (id: string, stream: MediaStream | null) => {
      if (!stream) return;
      if (analysers.has(id)) return;
      const liveAudio = stream.getAudioTracks().find((t) => t.readyState === "live" && t.enabled);
      if (!liveAudio) return;
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([liveAudio]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.35;
        src.connect(analyser);
        sources.push(src);
        analysers.set(id, analyser);
        bufById.set(id, new Uint8Array(analyser.fftSize));
      } catch {
        // игнор
      }
    };

    const local = localStreamRef.current;
    const screenAudioId = shareScreenAudioTrackRef.current?.id;
    const selfMic = local ? getMicAudioTrack(local, screenAudioId) : null;
    if (selfMic && selfMic.readyState === "live" && selfMic.enabled) {
      addStream("self", new MediaStream([selfMic]));
    }
    for (const r of remoteTracks) {
      const tile = createPeerTileStream(
        r.stream,
        remoteScreenShare?.peerId === r.peerId ? remoteScreenShare.screenAudioTrackId : undefined
      );
      addStream(r.peerId, tile);
    }

    const timer = window.setInterval(() => {
      if (stopped) return;
      const next: Record<string, number> = {};
      for (const [id, analyser] of analysers) {
        const buf = bufById.get(id);
        if (!buf) continue;
        analyser.getByteTimeDomainData(buf as unknown as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Типичный RMS речи → 0..1; тихая комната около 0.
        const raw = Math.max(0, Math.min(1, (rms - 0.015) / 0.14));
        const prev = speakerPrevRef.current[id] ?? 0;
        // Мягче attack; короткое плавное затухание в тишине.
        const smoothed = raw >= prev ? prev * 0.42 + raw * 0.58 : prev * 0.72 + raw * 0.28;
        next[id] = smoothed < 0.012 ? 0 : smoothed;
      }
      speakerPrevRef.current = next;
      setSpeakerLevelByPeerId(next);
    }, 40);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      try {
        for (const src of sources) src.disconnect();
      } catch {
        // игнор
      }
      try {
        void ctx.close();
      } catch {
        // игнор
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    call?.mode,
    call ? (call.mode === "room" ? call.roomId : call.peerId) : "none",
    localStreamVer,
    remoteTracks.map((r) => r.peerId).join("|"),
    remoteScreenShare?.peerId,
    remoteScreenShare?.screenAudioTrackId,
    speakingIndicator
  ]);

  const scope = useMemo(() => {
    if (call?.mode === "room") return { type: "room" as const, roomId: call.roomId };
    if (call?.mode === "direct") return { type: "direct" as const, peerId: call.peerId };
    if (selectedPeer) return { type: "direct" as const, peerId: selectedPeer.peerId };
    if (selectedRoom) return { type: "room" as const, roomId: selectedRoom.roomId };
    return null;
  }, [call, selectedPeer, selectedRoom]);

  const scopedMessages = useMemo(() => {
    if (!scope) return [];
    const base = chats.filter((m) => {
      if (scope.type === "direct" && m.scope.type === "direct") return m.scope.peerId === scope.peerId;
      if (scope.type === "room" && m.scope.type === "room") return m.scope.roomId === scope.roomId;
      return false;
    });
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) => (m.text ?? "").toLowerCase().includes(q) || (m.attachment && "name" in m.attachment ? (m.attachment.name ?? "").toLowerCase().includes(q) : false));
  }, [chats, scope, search]);

  const visibleMessages = useMemo(() => {
    const lim = Math.max(0, Number(chatDisplayLimit || 0) || 0);
    if (!lim) return scopedMessages;
    if (scopedMessages.length <= lim) return scopedMessages;
    return scopedMessages.slice(scopedMessages.length - lim);
  }, [scopedMessages, chatDisplayLimit]);

  useEffect(() => {
    // Автопрокрутка к последнему сообщению (настраивается)
    if (!scope || !chatAutoScroll) return;
    const id = requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [
    chatAutoScroll,
    scope?.type,
    scope && scope.type === "direct" ? (scope as any).peerId : scope && scope.type === "room" ? (scope as any).roomId : "none",
    visibleMessages.length
  ]);

  // Периодически обновляем состояние треков для корректной индикации микрофона/камеры
  useEffect(() => {
    if (!call || remoteTracks.length === 0) return;
    const interval = setInterval(() => {
      const next = Array.from(remoteRef.current.values());
      setRemoteTracks((prev) => {
        if (prev.length !== next.length) return next;
        for (let i = 0; i < prev.length; i++) {
          const p = prev[i];
          const n = next[i];
          if (p.peerId !== n.peerId || p.stream.id !== n.stream.id) return next;
          const pt = p.stream.getTracks();
          const nt = n.stream.getTracks();
          if (pt.length !== nt.length) return next;
          for (let j = 0; j < pt.length; j++) {
            if (pt[j].id !== nt[j].id || pt[j].enabled !== nt[j].enabled || pt[j].readyState !== nt[j].readyState) {
              return next;
            }
          }
        }
        return prev;
      });
    }, 1500);
    return () => clearInterval(interval);
  }, [call, remoteTracks.length]);

  useEffect(() => {
    if (!remoteScreenShare) return;
    const remote = remoteRef.current.get(remoteScreenShare.peerId);
    if (!remote) return;
    const screenAudio = findScreenBroadcastAudioTrack(remote.stream, remoteScreenShare.screenAudioTrackId);
    if (!screenAudio) return;
    screenAudio.enabled = !screenBroadcastMuted;
  }, [remoteScreenShare, screenBroadcastMuted, remoteTracks]);

  const smilesSet = useMemo(() => new Set(smilesFiles.map((f) => f.toLowerCase())), [smilesFiles]);
  const categorizedScreenSources = useMemo(() => categorizeScreenSources(screenSources), [screenSources]);

  useEffect(() => {
    callRef.current = call;
  }, [call]);

  useEffect(() => {
    selectedPeerRef.current = selectedPeer;
  }, [selectedPeer]);

  function setConferenceCall(next: CallContext | null) {
    callRef.current = next;
    setCall(next);
    if (!next) {
      resetScreenShareViewState();
      clearChatSelection();
    }
  }

  function clearChatSelection() {
    setSelectedPeer(null);
    selectedPeerRef.current = null;
    setSelectedRoom(null);
    setSearch("");
  }

  function resetScreenShareViewState() {
    setRemoteScreenShare(null);
    setScreenViewControlsHidden(false);
    setScreenBroadcastMuted(false);
    setScreenShareViewCollapsed(false);
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  async function broadcastScreenShareSignal(
    payload:
      | { type: "screen-share-start"; userName: string; screenAudioTrackId?: string; screenVideoTrackId?: string }
      | { type: "screen-share-stop" }
  ) {
    const activeCall = callRef.current;
    if (!activeCall || !profile) return;

    if (isDirectCall(activeCall)) {
      await sendRtc({
        ...payload,
        fromPeerId: profile.peerId,
        toPeerId: activeCall.peerId
      });
      return;
    }

    if (isConferenceCall(activeCall)) {
      const roomId = activeCall.roomId;
      for (const participant of activeCall.participants) {
        if (participant.peerId === profile.peerId) continue;
        await sendRtc({
          ...payload,
          roomId,
          fromPeerId: profile.peerId,
          toPeerId: participant.peerId
        });
      }
    }
  }

  async function broadcastRecordingSignal(
    payload: { type: "recording-start"; userName: string } | { type: "recording-stop" }
  ) {
    const activeCall = callRef.current;
    if (!activeCall || !profile) return;
    if (isDirectCall(activeCall)) {
      await sendRtc({
        ...payload,
        fromPeerId: profile.peerId,
        toPeerId: activeCall.peerId
      });
      return;
    }
    if (isConferenceCall(activeCall)) {
      const roomId = activeCall.roomId;
      for (const participant of activeCall.participants) {
        if (participant.peerId === profile.peerId) continue;
        await sendRtc({
          ...payload,
          roomId,
          fromPeerId: profile.peerId,
          toPeerId: participant.peerId
        });
      }
    }
  }

  async function chooseRecordingFolder() {
    const dir = await window.lokameet.app.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: recordingDir || undefined
    });
    if (!dir) return null;
    setRecordingDir(dir);
    void window.lokameet.app.updateProfile({ recordingDir: dir }).catch(() => undefined);
    return dir;
  }

  function getLocalCameraTrack() {
    const local = localStreamRef.current;
    if (!local) return null;
    const screenId = shareTrackRef.current?.id;
    return (
      local.getVideoTracks().find(
        (t) => t !== shareTrackRef.current && t.readyState === "live" && !isScreenVideoTrack(t, screenId)
      ) ?? null
    );
  }

  async function ensurePresenterCamera() {
    if (!isSharingRef.current || !videoEnabledRef.current) return;
    const local = localStreamRef.current;
    if (!local) return;
    let cam = getLocalCameraTrack();
    if (!cam) {
      try {
        const liveRaw = cameraRawStreamRef.current?.getVideoTracks().find((t) => t.readyState === "live") ?? null;
        if (liveRaw) {
          cam = await prepareCameraTrack(liveRaw);
        } else {
          const vc = getVideoConstraints(mediaCfg.videoQuality);
          if (selectedVideoDeviceId) (vc as any).deviceId = { ideal: selectedVideoDeviceId };
          const captured = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
          cam = await prepareCameraTrack(captured.getVideoTracks()[0] ?? null);
        }
      } catch (err) {
        void window.lokameet.log.write({
          level: "WARN",
          scope: "renderer/screen",
          msg: "Failed to reacquire presenter camera",
          data: { error: String(err) }
        });
        return;
      }
    }
    if (!cam || !isSharingRef.current) return;
    installProcessedCamera(local, cam);
    setLocalStreamVer((v) => v + 1);
    const screenId = shareTrackRef.current?.id ?? "";
    const roomId = callRef.current && isConferenceCall(callRef.current) ? callRef.current.roomId : undefined;
    const peersNeedingRenegotiation = new Set<string>();
    for (const [peerId, pc] of pcsRef.current.entries()) {
      if (addSecondaryVideoTrack(pc, cam, local, screenId)) peersNeedingRenegotiation.add(peerId);
    }
    for (const peerId of peersNeedingRenegotiation) {
      await renegotiatePeerConnection(peerId, roomId);
    }
    cam.onended = () => {
      if (!isSharingRef.current || !videoEnabledRef.current) return;
      window.setTimeout(() => {
        void ensurePresenterCamera();
      }, 400);
    };
  }

  async function publishLocalCameraTrack(processed: MediaStreamTrack, local: MediaStream) {
    installProcessedCamera(local, processed);
    setLocalStreamVer((v) => v + 1);
    const screenId = shareTrackRef.current?.id;
    const roomId = callRef.current && isConferenceCall(callRef.current) ? callRef.current.roomId : undefined;
    const peersNeedingRenegotiation = new Set<string>();
    for (const [peerId, pc] of pcsRef.current.entries()) {
      const needsRenegotiate = screenId
        ? addSecondaryVideoTrack(pc, processed, local, screenId)
        : replaceVideoTrack(pc, processed, local);
      if (needsRenegotiate) peersNeedingRenegotiation.add(peerId);
    }
    for (const peerId of peersNeedingRenegotiation) {
      await renegotiatePeerConnection(peerId, roomId);
    }
  }

  function stopAppWindowCapture() {
    const stream = appWindowCaptureRef.current;
    appWindowCaptureRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // игнор
      }
    }
  }

  async function ensureAppWindowCapture() {
    const live = appWindowCaptureRef.current?.getVideoTracks().some((t) => t.readyState === "live");
    if (live && appWindowCaptureRef.current) return appWindowCaptureRef.current;
    stopAppWindowCapture();
    try {
      const sourceId = await window.lokameet.screen.getAppWindowSourceId();
      if (!sourceId) return null;
      const stream = await captureDesktopMedia(sourceId, false);
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") {
        for (const t of stream.getTracks()) t.stop();
        return null;
      }
      track.onended = () => {
        if (appWindowCaptureRef.current === stream) appWindowCaptureRef.current = null;
      };
      appWindowCaptureRef.current = stream;
      return stream;
    } catch (err) {
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/media",
        msg: "App window capture failed",
        data: { error: String(err) }
      });
      return null;
    }
  }

  function collectRecordingInputs(): { sources: RecordSource[]; audio: MediaStream[] } {
    const sources: RecordSource[] = [];
    const audio: MediaStream[] = [];
    const local = localStreamRef.current;
    if (local) audio.push(local);
    for (const remote of remoteRef.current.values()) audio.push(remote.stream);

    const localShare = shareTrackRef.current?.readyState === "live" ? shareTrackRef.current : null;
    const remoteShare = remoteScreenShare;

    if (localShare) {
      const screenTracks: MediaStreamTrack[] = [localShare];
      if (shareScreenAudioTrackRef.current?.readyState === "live") {
        screenTracks.push(shareScreenAudioTrackRef.current);
      }
      sources.push({
        id: `local-screen-${localShare.id}`,
        label: `${profile?.userName ?? "You"} · screen`,
        stream: new MediaStream(screenTracks),
        role: "screen"
      });
      const cam = getLocalCameraTrack();
      if (cam) {
        sources.push({
          id: `local-cam-${cam.id}`,
          label: profile?.userName ?? "You",
          stream: new MediaStream([cam]),
          role: "camera"
        });
      }
      for (const remote of remoteRef.current.values()) {
        const camVideo = remote.stream.getVideoTracks().find((t) => t.readyState === "live");
        if (camVideo) {
          sources.push({
            id: `remote-cam-${remote.peerId}-${camVideo.id}`,
            label: remote.userName,
            stream: new MediaStream([camVideo]),
            role: "camera"
          });
        }
      }
      return { sources, audio };
    }

    if (remoteShare) {
      const remote = remoteRef.current.get(remoteShare.peerId);
      if (remote) {
        sources.push({
          id: `remote-screen-${remote.peerId}`,
          label: `${remote.userName} · screen`,
          stream: createScreenShareViewStream(remote.stream, remoteShare.screenAudioTrackId, remoteShare.screenVideoTrackId),
          role: "screen"
        });
      }
      const localCam = getLocalCameraTrack();
      if (localCam) {
        sources.push({
          id: `local-cam-${localCam.id}`,
          label: profile?.userName ?? "You",
          stream: new MediaStream([localCam]),
          role: "camera"
        });
      }
      for (const other of remoteRef.current.values()) {
        const camVideo =
          other.peerId === remoteShare.peerId
            ? findPresenterCameraTrack(other.stream, remoteShare.screenVideoTrackId)
            : other.stream.getVideoTracks().find((t) => t.readyState === "live") ?? null;
        if (camVideo) {
          sources.push({
            id: `remote-cam-${other.peerId}-${camVideo.id}`,
            label: other.userName,
            stream: new MediaStream([camVideo]),
            role: "camera"
          });
        }
      }
      return { sources, audio };
    }

    const appWindow = appWindowCaptureRef.current;
    const appTrack = appWindow?.getVideoTracks().find((t) => t.readyState === "live");
    if (appTrack && appWindow) {
      sources.push({
        id: `app-window-${appTrack.id}`,
        label: "LokaMeet",
        stream: appWindow,
        role: "screen"
      });
    }
    return { sources, audio };
  }

  async function stopCallRecording(opts?: { silent?: boolean }) {
    if (!recordingActiveRef.current && !callRecorderRef.current) return;
    recordingActiveRef.current = false;
    setRecordingActive(false);
    const recorder = callRecorderRef.current;
    callRecorderRef.current = null;
    const sessionId = recordingSessionRef.current;
    let wrote = false;
    try {
      wrote = (await recorder?.stop()) === true;
    } catch {
      // останавливаем даже если кадр не успел записаться
    }
    recordingSessionRef.current = null;
    stopAppWindowCapture();
    if (sessionId) {
      const filePath = await window.lokameet.recording.finish(sessionId).catch(() => null);
      if (filePath) {
        setLastRecordingPath(filePath);
        void window.lokameet.app.updateProfile({ lastRecordingPath: filePath }).catch(() => undefined);
        void window.lokameet.log.write({ level: "INFO", scope: "renderer/media", msg: "Recording saved", data: { filePath } });
      }
      if (!wrote && !opts?.silent) setError(t("errRecordingEmpty"));
    }
    if (!opts?.silent) {
      playRecordingAnnouncement("stop");
      await broadcastRecordingSignal({ type: "recording-stop" }).catch(() => undefined);
      await sendRecordingChatStatus("stop").catch(() => undefined);
    }
  }

  async function sendRecordingChatStatus(kind: "start" | "stop") {
    const activeCall = callRef.current;
    if (!activeCall || !profile) return;
    const text = kind === "start" ? t("chatStatusRecordingStart") : t("chatStatusRecordingStop");
    if (isDirectCall(activeCall)) {
      await sendChatStatus({ type: "direct", peerId: activeCall.peerId }, text);
      return;
    }
    if (isConferenceCall(activeCall)) {
      await sendChatStatus({ type: "room", roomId: activeCall.roomId }, text);
    }
  }

  async function startCallRecording() {
    if (!callRef.current || recordingActiveRef.current) return;
    let dir = recordingDir;
    if (!dir) dir = (await chooseRecordingFolder()) ?? "";
    if (!dir) return;
    const settings = normalizeRecordingSettings({
      format: recordingFormat,
      quality: recordingQuality,
      fps: recordingFps,
      bitrate: recordingBitrate
    });
    const size = RECORDING_SIZE[settings.quality];
    const begun = await window.lokameet.recording.begin(
      dir,
      recordingFileName(new Date(), settings.format),
      settings.format === "avi"
        ? { format: "avi", width: size.width, height: size.height, fps: settings.fps, sampleRate: 48000 }
        : undefined
    );
    if (!begun) {
      setError(t("errRecording"));
      return;
    }
    const sharingNow = Boolean(shareTrackRef.current) || Boolean(remoteScreenShare);
    if (!sharingNow) await ensureAppWindowCapture();
    const { sources, audio } = collectRecordingInputs();
    void window.lokameet.log.write({
      level: "INFO",
      scope: "renderer/media",
      msg: "Recording begin",
      data: {
        dir,
        format: settings.format,
        quality: settings.quality,
        fps: settings.fps,
        bitrate: settings.bitrate,
        width: size.width,
        height: size.height,
        sources: sources.length,
        audioStreams: audio.length,
        sourceLabels: sources.map((s) => `${s.role}:${s.label}`),
        filePath: begun.filePath
      }
    });
    const recorder = new CallRecorder();
    recorder.setInputs(sources, audio);
    const sessionId = begun.id;
    recordingSessionRef.current = sessionId;
    callRecorderRef.current = recorder;
    recordingActiveRef.current = true;
    setRecordingActive(true);
    try {
      await recorder.start(
        {
          writeBytes: (data) => window.lokameet.recording.append(sessionId, data),
          writeJpeg: (data) => window.lokameet.recording.aviJpeg(sessionId, data),
          writePcm: (data) => window.lokameet.recording.aviPcm(sessionId, data)
        },
        settings,
        (level, msg, data) => {
          void window.lokameet.log.write({ level, scope: "renderer/media", msg, data });
        }
      );
    } catch {
      recordingActiveRef.current = false;
      setRecordingActive(false);
      callRecorderRef.current = null;
      const sessionId = recordingSessionRef.current;
      recordingSessionRef.current = null;
      stopAppWindowCapture();
      if (sessionId) await window.lokameet.recording.finish(sessionId).catch(() => null);
      setError(t("errRecording"));
      return;
    }
    playRecordingAnnouncement("start");
    await broadcastRecordingSignal({ type: "recording-start", userName: profile?.userName ?? "User" }).catch(() => undefined);
    await sendRecordingChatStatus("start").catch(() => undefined);
  }

  async function toggleCallRecording() {
    if (recordingActiveRef.current) await stopCallRecording();
    else await startCallRecording();
  }

  async function renegotiatePeerConnection(peerId: string, roomId?: string) {
    const pc = pcsRef.current.get(peerId);
    if (!pc || !profile) return;
    if (pc.signalingState !== "stable") {
      // Glare: дождёмся stable и повторим (не ломаем входящий offer)
      pendingRenegotiateRef.current.set(peerId, roomId);
      return;
    }
    try {
      const offer = await pc.createOffer();
      // Пока ждали createOffer, мог прийти remote offer
      if (pc.signalingState !== "stable") {
        pendingRenegotiateRef.current.set(peerId, roomId);
        return;
      }
      await pc.setLocalDescription(offer);
      await sendRtc({
        type: "rtc-offer",
        roomId,
        fromPeerId: profile.peerId,
        toPeerId: peerId,
        sdp: { type: offer.type, sdp: offer.sdp ?? undefined }
      });
      pendingRenegotiateRef.current.delete(peerId);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("have-remote-offer") || msg.includes("wrong state")) {
        pendingRenegotiateRef.current.set(peerId, roomId);
        void window.lokameet.log.write({
          level: "INFO",
          scope: "renderer/screen",
          msg: "Peer renegotiation deferred (signaling glare)",
          data: { peerId, roomId, signalingState: pc.signalingState }
        });
        return;
      }
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/screen",
        msg: "Peer renegotiation failed",
        data: { peerId, roomId, error: msg }
      });
    }
  }

  function flushPendingRenegotiation(peerId: string) {
    if (!pendingRenegotiateRef.current.has(peerId)) return;
    const roomId = pendingRenegotiateRef.current.get(peerId);
    pendingRenegotiateRef.current.delete(peerId);
    void renegotiatePeerConnection(peerId, roomId);
  }

  function isScreenShareCall(callState: CallContext | null | undefined) {
    return isDirectCall(callState) || isConferenceCall(callState);
  }

  function restoreMicOnPeerConnections(screenAudioTrackId?: string) {
    const local = localStreamRef.current;
    if (!local || !audioEnabledRef.current) return;
    const micTrack = getMicAudioTrack(local, screenAudioTrackId);
    if (!micTrack || micTrack.readyState !== "live") return;
    const isScreenAudio = (track: MediaStreamTrack) => isScreenBroadcastAudioTrack(track, local, screenAudioTrackId);
    for (const pc of pcsRef.current.values()) {
      replaceMicAudioTrack(pc, micTrack, isScreenAudio, local);
    }
  }

  async function restoreMicAfterCameraChange() {
    if (!audioEnabledRef.current) return;
    if (restoringMicRef.current) return restoringMicRef.current;
    const run = (async () => {
      const local = localStreamRef.current;
      const screenAudioId = shareScreenAudioTrackRef.current?.id;
      const mic = local ? getMicAudioTrack(local, screenAudioId) : null;
      if (mic && mic.readyState === "live") {
        mic.enabled = true;
        watchLocalMicTracks(local);
        restoreMicOnPeerConnections(screenAudioId);
        return;
      }
      if (mic && local) {
        try {
          local.removeTrack(mic);
        } catch {
          // игнор
        }
        try {
          mic.stop();
        } catch {
          // игнор
        }
      }
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/media",
        msg: "Microphone track ended after camera change; reacquiring",
        data: { hadTrack: Boolean(mic), readyState: mic?.readyState ?? "missing" }
      });
      await ensureAudioTrackPresent();
      restoreMicOnPeerConnections(screenAudioId);
      watchLocalMicTracks(localStreamRef.current);
    })();
    restoringMicRef.current = run;
    try {
      await run;
    } finally {
      restoringMicRef.current = null;
    }
  }

  function watchLocalMicTracks(stream: MediaStream | null | undefined) {
    if (!stream) return;
    const mic = getMicAudioTrack(stream, shareScreenAudioTrackRef.current?.id);
    if (!mic || mic.readyState !== "live") return;
    mic.onended = () => {
      if (!audioEnabledRef.current) return;
      void restoreMicAfterCameraChange();
    };
  }

  function refreshRemotePeerVideo(peerId: string, opts?: { dropMutedVideo?: boolean }) {
    const remote = remoteRef.current.get(peerId);
    if (!remote) return;
    pruneStaleRemoteStreamTracks(remote.stream, opts);
    setRemoteTracks(Array.from(remoteRef.current.values()));
  }

  useEffect(() => {
    if (!profile) return;
    const busyStatus: AvailabilityStatus | null = call
      ? call.mode === "room"
        ? "in_conference"
        : "in_call"
      : null;

    if (busyStatus) {
      if (profile.status !== busyStatus) {
        if (!isBusyStatus(profile.status) && prevStatusRef.current === null) {
          prevStatusRef.current = profile.status;
        }
        window.lokameet.app
          .updateProfile({ status: busyStatus })
          .then((p) => setProfile(p))
          .catch(() => undefined);
      }
    } else if (isBusyStatus(profile.status)) {
      const restore = prevStatusRef.current && !isBusyStatus(prevStatusRef.current) ? prevStatusRef.current : "online";
      prevStatusRef.current = null;
      window.lokameet.app
        .updateProfile({ status: restore })
        .then((p) => setProfile(p))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.mode, call ? (call.mode === "room" ? call.roomId : call.peerId) : "none", profile?.status]);

  // Авто-статус «Отошел» при отсутствии активности
  useEffect(() => {
    if (isSettingsWindow) return;
    const markActivity = () => {
      lastActivityRef.current = Date.now();
      if (autoAwayAppliedRef.current && profileStatusRef.current === "away" && !callRef.current) {
        autoAwayAppliedRef.current = false;
        window.lokameet.app
          .updateProfile({ status: "online" })
          .then((p) => setProfile(p))
          .catch(() => undefined);
      }
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "wheel", "focus"] as const;
    for (const ev of events) window.addEventListener(ev, markActivity, opts);
    const interval = window.setInterval(() => {
      const mins = autoAwayMinutesRef.current;
      if (!mins || mins <= 0) return;
      if (callRef.current) return;
      if (profileStatusRef.current !== "online") return;
      if (Date.now() - lastActivityRef.current < mins * 60_000) return;
      autoAwayAppliedRef.current = true;
      window.lokameet.app
        .updateProfile({ status: "away" })
        .then((p) => setProfile(p))
        .catch(() => undefined);
    }, 10_000);
    return () => {
      for (const ev of events) window.removeEventListener(ev, markActivity, opts);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let unsubDisc: (() => void) | null = null;
    let unsubEnv: (() => void) | null = null;
    let cancelled = false;

    const markBoot = (pct: number, labelKey: string) => {
      if (cancelled) return;
      setBootProgress(Math.max(0, Math.min(100, Math.round(pct))));
      setBootLabel(labelKey);
    };

    (async () => {
      markBoot(4, "bootStarting");
      document.getElementById("boot-splash")?.remove();

      markBoot(12, "bootState");
      const s = await window.lokameet.app.getState();
      if (cancelled) return;

      markBoot(28, "bootProfile");
      if (!isSettingsWindow && (s.profile.status === "in_call" || s.profile.status === "in_conference")) {
        const normalized = await window.lokameet.app.updateProfile({ status: "online" });
        if (cancelled) return;
        setProfile(normalized);
      } else {
        setProfile(s.profile);
      }

      markBoot(38, "bootAvatar");
      if (s.profile.avatarHash) {
        const ownAvatar = await window.lokameet.avatar.get(s.profile.peerId, s.profile.avatarHash).catch(() => null);
        if (cancelled) return;
        if (ownAvatar) setAvatarUrls((current) => ({ ...current, [s.profile.peerId]: ownAvatar.dataUrl }));
      }

      markBoot(48, "bootSettings");
      setChats(s.chats);
      setSignalingPort(s.signalingPort);
      if (s.appVersion) {
        setAppVersion(s.appVersion);
        document.title = `LokaMeet ${s.appVersion}`;
      }
      document.documentElement.dataset.theme = s.profile.theme;
      await i18n.changeLanguage(s.profile.language);
      document.documentElement.lang = s.profile.language;
      if (cancelled) return;
      setChatHeight(Math.max(360, Math.min(440, s.profile.uiChatHeight ?? 380)));
      setSidebarWidth(Math.max(360, Math.min(420, s.profile.uiSidebarWidth ?? 380)));
      setFontScale(s.profile.uiFontScale ?? 0.95);
      setCompactUi(Boolean(s.profile.uiCompact));
      setShowSeconds(Boolean(s.profile.uiShowSeconds));
      setAutoAwayMinutes(Math.max(0, Math.min(120, Number(s.profile.autoAwayMinutes ?? 5) || 0)));
      setAutoSwitchToChat(s.profile.autoSwitchToChatOnAccept ?? true);
      setSelectedAudioInputId(s.profile.audioInputDeviceId ?? "");
      setSelectedAudioOutputId(s.profile.audioOutputDeviceId ?? "");
      setSelectedVideoDeviceId(s.profile.videoInputDeviceId ?? "");
      const loadedCameraControls = normalizeCameraControls(s.profile.cameraControls);
      cameraControlsRef.current = loadedCameraControls;
      setCameraControls(loadedCameraControls);
      const listed = await window.lokameet.cameraBg.list().catch(() => []);
      if (cancelled) return;
      setCustomCameraBgs(listed);
      const loadedFx = normalizeCameraFxOptions({
        cropZoom: s.profile.cameraFx?.cropZoom,
        cropPanX: s.profile.cameraFx?.cropPanX,
        cropPanY: s.profile.cameraFx?.cropPanY,
        backgroundMode: s.profile.cameraFx?.backgroundMode,
        presetId: s.profile.cameraFx?.backgroundPreset,
        customId: s.profile.cameraFx?.backgroundCustomId,
        blurAmount: s.profile.cameraFx?.blurAmount
      });
      if (loadedFx.backgroundMode === "custom") {
        const chosen = listed.find((item) => item.id === loadedFx.customId) ?? listed[0];
        loadedFx.customId = chosen?.id ?? null;
        loadedFx.customDataUrl = chosen?.dataUrl ?? null;
        if (!loadedFx.customDataUrl) loadedFx.backgroundMode = "none";
      }
      cameraFxRef.current = loadedFx;
      cameraFxNeedRef.current = cameraFxNeedsProcessing(loadedFx);
      setCameraFx(loadedFx);
      setCameraFxOptions(loadedFx);
      setChatAutoScroll(s.profile.chatAutoScroll ?? true);
      setChatSmileSizePx(Math.max(16, Math.min(128, Number(s.profile.chatSmileSizePx ?? 24) || 24)));
      setChatFontSize(Math.max(10, Math.min(24, Number(s.profile.chatFontSize ?? 14) || 14)));
      setChatDisplayLimit(Number(s.profile.chatDisplayLimit ?? 0) || 0);
      setSpeakingIndicator(s.profile.uiSpeakingIndicator ?? true);
      // Стандартный вид 1920×1080 (как на референс-скриншотах)
      const layoutV = Number(s.profile.uiLayoutVersion ?? 0) || 0;
      if (layoutV < 2) {
        setTileAspect("16x9");
        setTileObjectFit("cover");
        setTileRadius(12);
        setTileGap(5);
        setFontScale(0.95);
        setChatHeight(380);
        setSidebarWidth(360);
        void window.lokameet.app
          .updateProfile({
            uiTileAspect: "16x9",
            uiTileObjectFit: "cover",
            uiTileRadius: 12,
            uiTileGap: 5,
            uiFontScale: 0.95,
            uiChatHeight: 380,
            uiSidebarWidth: 380,
            uiLayoutVersion: 2
          })
          .catch(() => undefined);
      } else {
        setTileAspect(s.profile.uiTileAspect ?? "16x9");
        setTileObjectFit(s.profile.uiTileObjectFit ?? "cover");
        setTileRadius(Math.max(4, Math.min(28, Number(s.profile.uiTileRadius ?? 12) || 12)));
        setTileGap(Math.max(4, Math.min(24, Number(s.profile.uiTileGap ?? 5) || 5)));
      }
      setMicrophoneVolume(Math.max(0, Math.min(100, Number(s.profile.microphoneVolume ?? 100) || 100)));
      const micVol = Math.max(
        0,
        Math.min(100, Number(s.profile.remoteMicVolume ?? s.profile.speakerVolume ?? 100) || 100)
      );
      setSpeakerVolume(micVol);
      setRemoteMicVolume(micVol);
      setRemoteScreenShareVolume(
        Math.max(0, Math.min(100, Number(s.profile.remoteScreenShareVolume ?? 100) || 100))
      );
      setNoiseSuppression(s.profile.noiseSuppression ?? false);
      setNoiseSuppressionSensitivity(Math.max(0, Math.min(100, Number(s.profile.noiseSuppressionSensitivity ?? 50) || 50)));
      setSoundNotificationsEnabled(s.profile.soundNotificationsEnabled ?? true);
      setSoundNotificationVolume(Math.max(0, Math.min(100, Number(s.profile.soundNotificationVolume ?? 50) || 50)));
      setCallSoundFile(s.profile.callSoundFile ?? "snds/call.mp3");
      setMessageSoundFile(s.profile.messageSoundFile ?? "snds/sms.mp3");
      setCallerSoundFile(s.profile.callerSoundFile ?? "snds/call_1.mp3");
      setConnectionSoundFile(s.profile.connectionSoundFile ?? "snds/int.mp3");
      setRecordingSoundFile(typeof s.profile.recordingSoundFile === "string" ? s.profile.recordingSoundFile : "");
      setCallSoundVolume(Math.max(0, Math.min(100, Number(s.profile.callSoundVolume ?? 50) || 50)));
      setMessageSoundVolume(Math.max(0, Math.min(100, Number(s.profile.messageSoundVolume ?? 50) || 50)));
      setCallerSoundVolume(Math.max(0, Math.min(100, Number(s.profile.callerSoundVolume ?? 50) || 50)));
      setConnectionSoundVolume(Math.max(0, Math.min(100, Number(s.profile.connectionSoundVolume ?? 50) || 50)));
      setRecordingSoundVolume(Math.max(0, Math.min(100, Number(s.profile.recordingSoundVolume ?? 50) || 50)));
      setRecordingDir(typeof s.profile.recordingDir === "string" ? s.profile.recordingDir : "");
      setLastRecordingPath(typeof s.profile.lastRecordingPath === "string" ? s.profile.lastRecordingPath : "");
      const rec = normalizeRecordingSettings({
        format: s.profile.recordingFormat === "avi" ? "avi" : "mp4",
        quality: s.profile.recordingQuality,
        fps: s.profile.recordingFps,
        bitrate: s.profile.recordingBitrate
      });
      setRecordingFormat(rec.format);
      setRecordingQuality(rec.quality);
      setRecordingFps(rec.fps);
      setRecordingBitrate(rec.bitrate);
      if (s.profile.defaultVideoQuality) {
        setMediaCfg((c) => ({ ...c, videoQuality: s.profile.defaultVideoQuality! }));
      }

      markBoot(62, "bootNetwork");
      // Параллельная инициализация для быстрого старта
      const [li, ips, smileList] = await Promise.all([
        window.lokameet.log.getInfo().catch(() => ({ logFilePath: null, logDirPath: null })),
        window.lokameet.net.getLocalIPv4().catch(() => []),
        window.lokameet.smiles.list().catch(() => [])
      ]);
      if (cancelled) return;

      markBoot(78, "bootSmiles");
      setLogFilePath(li.logFilePath);
      setLocalIps(ips);
      setSmilesFiles(smileList);

      void window.lokameet.log.write({ level: "INFO", scope: "renderer", msg: "Renderer started", data: { signalingPort: s.signalingPort } });

      // Всегда спрашиваем имя при старте
      setPendingName(s.profile.userName || "User");
      setPendingStatus(
        s.profile.status === "in_call" || s.profile.status === "in_conference" ? "online" : s.profile.status
      );

      if (isSettingsWindow) {
        markBoot(100, "bootReady");
        setSettingsOpen(true);
        setBootReady(true);
        return;
      }

      markBoot(88, "bootDiscovery");
      const snap = await window.lokameet.discovery.getSnapshot();
      if (cancelled) return;
      const discoveredPeers = snap.peers.filter((p) => p.peerId !== s.profile.peerId);
      setPeers(applyHelloStatus(discoveredPeers));
      setRooms(snap.rooms.filter((r) => r.hostPeerId !== s.profile.peerId));
      void Promise.all(discoveredPeers.map((peer) => refreshPeerAvatar(peer, s.profile.peerId)));

      unsubDisc = window.lokameet.discovery.onUpdate((u) => {
        const updatedPeers = u.peers.filter((p) => p.peerId !== s.profile.peerId);
        setPeers(applyHelloStatus(updatedPeers));
        setRooms(u.rooms.filter((r) => r.hostPeerId !== s.profile.peerId));
        void Promise.all(updatedPeers.map((peer) => refreshPeerAvatar(peer, s.profile.peerId)));
      });

      unsubEnv = window.lokameet.net.onEnvelope((env) => onEnvelopeRef.current(env));

      markBoot(100, "bootReady");
      setNameDialogExitsApp(true);
      setNameDialogOpen(true);
      setBootReady(true);
    })().catch((e) => {
      if (!cancelled) {
        setError(String(e?.message ?? e));
        setBootProgress(100);
        setBootReady(true);
      }
    });

    return () => {
      cancelled = true;
      unsubDisc?.();
      unsubEnv?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    async function refreshDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const vids = list.filter((d) => d.kind === "videoinput");
        const aIns = list.filter((d) => d.kind === "audioinput");
        const aOuts = list.filter((d) => d.kind === "audiooutput");
        if (!mounted) return;
        setVideoDevices(vids);
        setAudioInputDevices(aIns);
        setAudioOutputDevices(aOuts);
        if (selectedVideoDeviceId && !vids.some((d) => d.deviceId === selectedVideoDeviceId)) {
          setSelectedVideoDeviceId(vids[0]?.deviceId ?? "");
          void window.lokameet.app.updateProfile({ videoInputDeviceId: vids[0]?.deviceId ?? "" }).catch(() => undefined);
        } else if (!selectedVideoDeviceId && vids[0]?.deviceId) {
          setSelectedVideoDeviceId(vids[0].deviceId);
        }
        if (selectedAudioInputId && !aIns.some((d) => d.deviceId === selectedAudioInputId)) {
          setSelectedAudioInputId(aIns[0]?.deviceId ?? "");
          void window.lokameet.app.updateProfile({ audioInputDeviceId: aIns[0]?.deviceId ?? "" }).catch(() => undefined);
        } else if (!selectedAudioInputId && aIns[0]?.deviceId) {
          setSelectedAudioInputId(aIns[0].deviceId);
        }
        if (selectedAudioOutputId && !aOuts.some((d) => d.deviceId === selectedAudioOutputId)) {
          setSelectedAudioOutputId(aOuts[0]?.deviceId ?? "");
        } else if (!selectedAudioOutputId && aOuts[0]?.deviceId) {
          setSelectedAudioOutputId(aOuts[0].deviceId);
        }
      } catch {
        // игнор
      }
    }
    void refreshDevices();
    const handler = () => void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener("devicechange", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideoDeviceId, selectedAudioInputId, selectedAudioOutputId]);

  function syncLocalVideoPreview(opts?: { videoEnabled?: boolean }) {
    const el = localVideoRef.current;
    if (!el) return;
    const local = localStreamRef.current;
    const share = shareTrackRef.current;
    if (share && share.readyState === "live") {
      const current = el.srcObject;
      const already =
        current instanceof MediaStream && current.getVideoTracks().length === 1 && current.getVideoTracks()[0] === share;
      if (!already) el.srcObject = new MediaStream([share]);
      void el.play().catch(() => undefined);
      return;
    }
    const videoOn = opts?.videoEnabled ?? mediaCfg.videoEnabled;
    const hasLiveVideo =
      videoOn && local && local.getVideoTracks().some((t) => t.readyState === "live");
    if (hasLiveVideo && local) {
      if (el.srcObject !== local) el.srcObject = local;
      void el.play().catch(() => undefined);
      return;
    }
    el.srcObject = null;
  }

  async function ensureLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;

    // getUserMedia запрещает {audio:false, video:false}
    if (!mediaCfg.audioEnabled && !mediaCfg.videoEnabled) {
      const empty = new MediaStream();
      localStreamRef.current = empty;
      setLocalStreamVer((v) => v + 1);
      return empty;
    }

    const buildConstraints = (audioDeviceId: string, videoDeviceId: string) => {
      let video: boolean | MediaTrackConstraints = false;
      if (mediaCfg.videoEnabled) {
        const vc = getVideoConstraints(mediaCfg.videoQuality);
        if (videoDeviceId) (vc as any).deviceId = { ideal: videoDeviceId };
        video = vc;
      }
      let audio: boolean | MediaTrackConstraints = false;
      if (mediaCfg.audioEnabled) {
        audio = getAudioConstraintsForMic(audioDeviceId);
      }
      return { video, audio };
    };

    const tryGet = async (audioDeviceId: string, videoDeviceId: string) => {
      const { video, audio } = buildConstraints(audioDeviceId, videoDeviceId);
      if (!video && !audio) return new MediaStream();
      return navigator.mediaDevices.getUserMedia({ video, audio });
    };

    try {
      const stream = await tryGet(selectedAudioInputId, selectedVideoDeviceId);
      const rawVideo = stream.getVideoTracks()[0] ?? null;
      if (rawVideo) {
        const processed = await prepareCameraTrack(rawVideo);
        if (processed && processed !== rawVideo) {
          stream.removeTrack(rawVideo);
          stream.addTrack(processed);
        }
      }
      localStreamRef.current = stream;
      watchLocalMicTracks(stream);
      setLocalStreamVer((v) => v + 1);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play().catch(() => undefined);
      }
      return stream;
    } catch (err) {

      // Устаревший deviceId (часто после перезагрузки Windows / смены USB) → fallback без exact id
      if (isNotFoundMediaError(err) && (selectedAudioInputId || selectedVideoDeviceId)) {
        void window.lokameet.log.write({
          level: "WARN",
          scope: "renderer/media",
          msg: "Stale media deviceId, retrying defaults",
          data: { error: String(err), audioInputDeviceId: selectedAudioInputId || null, videoInputDeviceId: selectedVideoDeviceId || null }
        });
        clearStaleMediaDeviceIds("both");
        try {
          const stream = await tryGet("", "");
          const rawVideo = stream.getVideoTracks()[0] ?? null;
          if (rawVideo) {
            const processed = await prepareCameraTrack(rawVideo);
            if (processed && processed !== rawVideo) {
              stream.removeTrack(rawVideo);
              stream.addTrack(processed);
            }
          }
          localStreamRef.current = stream;
          watchLocalMicTracks(stream);
          setLocalStreamVer((v) => v + 1);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            await localVideoRef.current.play().catch(() => undefined);
          }
          return stream;
        } catch (retryErr) {
          err = retryErr;
        }
      }

      if (mediaCfg.videoEnabled && mediaCfg.audioEnabled) {
        void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to get video+audio, retrying with audio only", data: { error: String(err) } });
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: getAudioConstraintsForMic("")
          });
          localStreamRef.current = stream;
          watchLocalMicTracks(stream);
          setLocalStreamVer((v) => v + 1);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            await localVideoRef.current.play().catch(() => undefined);
          }
          setMediaCfg((c) => ({ ...c, videoEnabled: false }));
          return stream;
        } catch (audioErr) {
          // крайний случай: пустой local stream, чтобы answer/offer всё же прошли
          if (isNotFoundMediaError(audioErr) || isNotFoundMediaError(err)) {
            const empty = new MediaStream();
            localStreamRef.current = empty;
            setLocalStreamVer((v) => v + 1);
            // Не сбрасываем mediaCfg.audioEnabled — иначе следующий join упрётся в audio:false+video:false
            void window.lokameet.log.write({
              level: "WARN",
              scope: "renderer/media",
              msg: "No local A/V devices; continuing with empty stream",
              data: { error: String(audioErr) }
            });
            return empty;
          }
          throw audioErr;
        }
      }

      if (isNotFoundMediaError(err)) {
        const empty = new MediaStream();
        localStreamRef.current = empty;
        setLocalStreamVer((v) => v + 1);
        void window.lokameet.log.write({
          level: "WARN",
          scope: "renderer/media",
          msg: "No local media device; continuing with empty stream",
          data: { error: String(err) }
        });
        return empty;
      }
      throw err;
    }
  }

  async function ensureVideoTrackPresent() {
    if (!mediaCfg.videoEnabled) return;
    try {
      const local = await ensureLocalMedia();
      if (local.getVideoTracks().length > 0) return;
      const vc = getVideoConstraints(mediaCfg.videoQuality);
      if (selectedVideoDeviceId) (vc as any).deviceId = { ideal: selectedVideoDeviceId };
      const cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
      const camTrack = cam.getVideoTracks()[0] ?? null;
      if (!camTrack) return;
      const processed = await prepareCameraTrack(camTrack);
      installProcessedCamera(local, processed);
      setLocalStreamVer((v) => v + 1);
      const roomId = callRef.current && isConferenceCall(callRef.current) ? callRef.current.roomId : undefined;
      for (const [peerId, pc] of pcsRef.current.entries()) {
        const needsRenegotiate = replaceVideoTrack(pc, processed, local);
        if (needsRenegotiate) await renegotiatePeerConnection(peerId, roomId);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = local;
        await localVideoRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      // Если камера недоступна, отключаем видео в настройках и логируем ошибку
      void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to get video track, disabling video", data: { error: String(err) } });
      setMediaCfg((c) => ({ ...c, videoEnabled: false }));
    }
  }

  async function ensureAudioTrackPresent() {
    if (!audioEnabledRef.current) return;
    const local = await ensureLocalMedia();
    const screenAudioId = shareScreenAudioTrackRef.current?.id;
    let existingTrack = getMicAudioTrack(local, screenAudioId);

    if (existingTrack && existingTrack.readyState !== "live") {
      try {
        local.removeTrack(existingTrack);
      } catch {
        // игнор
      }
      try {
        existingTrack.stop();
      } catch {
        // игнор
      }
      existingTrack = undefined;
    }

    // Проверяем, нужно ли пересоздать трек из-за изменения шумоподавления
    if (existingTrack) {
      const currentNoiseSuppression = existingTrack.getSettings().noiseSuppression ?? true;
      if (currentNoiseSuppression !== noiseSuppression) {
        // Настройки изменились - пересоздаем трек
        local.removeTrack(existingTrack);
        try {
          existingTrack.stop();
        } catch {
          // игнор
        }
        // Продолжаем создание нового трека ниже
      } else {
        // Настройки не изменились — включаем существующий трек и вешаем на PC снова
        existingTrack.enabled = true;
        watchLocalMicTracks(local);
        await applyMicrophoneVolume();
        const isScreenAudio = (track: MediaStreamTrack) => isScreenBroadcastAudioTrack(track, local, screenAudioId);
        for (const pc of pcsRef.current.values()) replaceMicAudioTrack(pc, existingTrack, isScreenAudio, local);
        return;
      }
    }

    // Создаем новый трек с текущими настройками (как в v01.1.2)
    const ac = getAudioConstraintsForMic();
    const mic = await navigator.mediaDevices.getUserMedia({ audio: ac, video: false });
    const micTrack = mic.getAudioTracks()[0] ?? null;
    if (!micTrack) return;
    local.addTrack(micTrack);
    watchLocalMicTracks(local);
    setLocalStreamVer((v) => v + 1);
    await applyMicrophoneVolume();
    const isScreenAudio = (track: MediaStreamTrack) => isScreenBroadcastAudioTrack(track, local, screenAudioId);
    for (const pc of pcsRef.current.values()) replaceMicAudioTrack(pc, micTrack, isScreenAudio, local);
  }

  async function recreateAudioTrack() {
    if (!mediaCfg.audioEnabled) return;
    const local = await ensureLocalMedia();
    const oldTrack = getMicAudioTrack(local);
    if (oldTrack) {
      local.removeTrack(oldTrack);
      try {
        oldTrack.stop();
      } catch {
        // игнор
      }
    }
    await ensureAudioTrackPresent();
  }

  async function applyMicrophoneVolume() {
    // Громкость микрофона применяется через constraints при создании трека
    // Для изменения громкости нужно пересоздать трек с новыми настройками
    // Это делается при изменении настройки через useEffect ниже
    const local = localStreamRef.current;
    if (!local) return;
    const audioTracks = local.getAudioTracks();
    if (audioTracks.length === 0) return;

    // Применяем громкость через Web Audio API если доступен
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const ctx = audioContextRef.current;
      await ctx.resume().catch(() => undefined);

      if (!microphoneGainNodeRef.current) {
        microphoneGainNodeRef.current = ctx.createGain();
      }
      microphoneGainNodeRef.current.gain.value = microphoneVolume / 100;
    } catch (e) {
      // Игнор — громкость через constraints
    }
  }

  // Эффект для применения громкости микрофона при изменении
  useEffect(() => {
    if (localStreamRef.current && mediaCfg.audioEnabled) {
      const local = localStreamRef.current;
      const micTrack = getMicAudioTrack(local);
      if (micTrack) {
        const settings = micTrack.getSettings();
        const currentNoiseSuppression = settings.noiseSuppression ?? true;
        if (noiseSuppression !== currentNoiseSuppression) {
          void recreateAudioTrack().catch(() => undefined);
        } else {
          void applyMicrophoneVolume().catch(() => undefined);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [microphoneVolume, noiseSuppression, noiseSuppressionSensitivity]);

  useEffect(() => {
    if (!recordingActive || !callRecorderRef.current) return;
    let cancelled = false;
    void (async () => {
      const sharingNow = Boolean(isSharing) || Boolean(remoteScreenShare);
      if (sharingNow) stopAppWindowCapture();
      else await ensureAppWindowCapture();
      if (cancelled || !callRecorderRef.current) return;
      const { sources, audio } = collectRecordingInputs();
      callRecorderRef.current.setInputs(sources, audio);
    })();
    return () => {
      cancelled = true;
    };
  }, [recordingActive, localStreamVer, remoteTracks, isSharing, remoteScreenShare]);

  useEffect(() => {
    if (!isSharing) return;
    const tick = () => {
      void window.lokameet.screen.keepCapturerAlive().catch(() => undefined);
      const share = shareTrackRef.current;
      if (!share || share.readyState !== "live") return;
      for (const pc of pcsRef.current.values()) {
        tuneScreenShareSender(pc, share);
        requestScreenShareKeyframe(pc, share);
      }
    };
    tick();
    const id = window.setInterval(tick, 2500);
    return () => window.clearInterval(id);
  }, [isSharing]);

  useEffect(() => {
    const keepCamera = () => {
      if (!isSharingRef.current || !videoEnabledRef.current) return;
      const raw = cameraRawStreamRef.current?.getVideoTracks()[0];
      if (raw && raw.readyState === "live") {
        raw.enabled = true;
      }
      void ensurePresenterCamera();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") keepCamera();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", keepCamera);
    const id = window.setInterval(() => {
      if (!isSharingRef.current || !videoEnabledRef.current) return;
      const cam = getLocalCameraTrack();
      if (!cam || cam.readyState !== "live") void ensurePresenterCamera();
    }, 2000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", keepCamera);
      window.clearInterval(id);
    };
  }, []);

  async function switchCamera(deviceId: string) {
    setSelectedVideoDeviceId(deviceId);
    if (!mediaCfg.videoEnabled) return;

    const cam = await navigator.mediaDevices.getUserMedia({
      video: { ...(getVideoConstraints(mediaCfg.videoQuality) as any), deviceId: { ideal: deviceId } },
      audio: false
    });
    const camTrack = cam.getVideoTracks()[0] ?? null;
    const processed = await prepareCameraTrack(camTrack);
    const local = await ensureLocalMedia();
    if (processed) await publishLocalCameraTrack(processed, local);
    await restoreMicAfterCameraChange();
    syncLocalVideoPreview({ videoEnabled: true });
  }

  async function applyVideoQuality(quality: VideoQuality) {
    setMediaCfg((c) => ({ ...c, videoQuality: quality }));
    if (!videoEnabledRef.current) return;
    try {
      const vc = getVideoConstraints(quality);
      if (selectedVideoDeviceId) (vc as MediaTrackConstraints & { deviceId?: ConstrainDOMString }).deviceId = { ideal: selectedVideoDeviceId };
      const cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
      const camTrack = cam.getVideoTracks()[0] ?? null;
      const processed = await prepareCameraTrack(camTrack);
      const local = await ensureLocalMedia();
      if (processed) await publishLocalCameraTrack(processed, local);
      await restoreMicAfterCameraChange();
      syncLocalVideoPreview({ videoEnabled: true });
    } catch (err) {
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/media",
        msg: "Failed to apply camera resolution",
        data: { quality, error: String(err) }
      });
    }
  }

  async function switchMicrophone(deviceId: string) {
    setSelectedAudioInputId(deviceId);
    if (!mediaCfg.audioEnabled) return;
    const ac = getAudioConstraintsForMic(deviceId);
    const mic = await navigator.mediaDevices.getUserMedia({ audio: ac, video: false });
    const micTrack = mic.getAudioTracks()[0] ?? null;
    const local = await ensureLocalMedia();
    const old = getMicAudioTrack(local);
    if (old) {
      local.removeTrack(old);
      try {
        old.stop();
      } catch {
        // игнор
      }
    }
    if (micTrack) local.addTrack(micTrack);
    watchLocalMicTracks(local);
    setLocalStreamVer((v) => v + 1);
    await applyMicrophoneVolume();
    const isScreenAudio = (track: MediaStreamTrack) => isScreenBroadcastAudioTrack(track, local);
    for (const pc of pcsRef.current.values()) replaceMicAudioTrack(pc, micTrack, isScreenAudio, local);
  }

  async function startScreenShare() {
    if (isSharingRef.current) return;
    if (!isScreenShareCall(callRef.current)) {
      setError(t("screenShareInCallOnly"));
      return;
    }

    try {
      // Загружаем источники экрана через Electron API
      if (window.lokameet?.screen?.getSources) {
        try {
          const sources = await window.lokameet.screen.getSources();
          setScreenSources(sources ?? []);
          setScreenShareTab(sources?.some((s) => s.id.startsWith("screen:")) ? "screen" : "app");
          setSelectedScreenSource(null);
          setScreenShareDialogOpen(true);
          return;
        } catch (err) {
          try {
            if (window.lokameet?.log?.write) {
              void window.lokameet.log.write({ level: "WARN", scope: "renderer/screen", msg: "Failed to get screen sources, using getDisplayMedia", data: { error: String(err) } });
            }
          } catch {
            // Игнорируем ошибки логирования
          }
        }
      }
      
      // Fallback: используем стандартный getDisplayMedia если нет доступа к Electron API
      await startScreenShareWithSource(null, screenShareWithAudio);
    } catch (err) {
      console.error("Error in startScreenShare:", err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(t("errScreenShareStart", { msg: errorMsg }));
      isSharingRef.current = false;
      setIsSharing(false);
    }
  }

  async function startScreenShareWithSource(sourceId: string | null, withAudio: boolean) {
    if (isSharingRef.current) {
      console.warn("Screen share already active");
      return;
    }
    if (!isScreenShareCall(callRef.current)) {
      setError(t("screenShareInCallOnly"));
      return;
    }

    try {
      if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        setError(t("errScreenShareUnsupported"));
        try {
          if (window.lokameet?.log?.write) {
            void window.lokameet.log.write({ level: "ERROR", scope: "renderer/screen", msg: "getDisplayMedia not supported" });
          }
        } catch {
          // Игнорируем ошибки логирования
        }
        return;
      }
      
      let display: MediaStream;
      try {
        display = await captureDesktopMedia(sourceId, withAudio);
      } catch (err) {
        const errorName = err instanceof Error ? err.name : String(err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (
          errorName === "NotAllowedError" ||
          errorName === "AbortError" ||
          errorMsg.toLowerCase().includes("cancel") ||
          errorMsg.toLowerCase().includes("denied") ||
          errorMsg.toLowerCase().includes("not allowed") ||
          errorMsg.toLowerCase().includes("permission")
        ) {
          try {
            if (window.lokameet?.log?.write) {
              void window.lokameet.log.write({ level: "INFO", scope: "renderer/screen", msg: "User cancelled screen share selection", data: { errorName } });
            }
          } catch {
            // Игнорируем ошибки логирования
          }
          return;
        }
        throw err;
      }
      
      const videoTrack = display.getVideoTracks()[0];
        if (!videoTrack) {
        isSharingRef.current = false;
        setIsSharing(false);
        setError(t("errScreenShareNoVideo"));
        try {
          if (window.lokameet?.log?.write) {
            void window.lokameet.log.write({ level: "WARN", scope: "renderer/screen", msg: "No video track in display media" });
          }
        } catch {
          // Игнорируем ошибки логирования
        }
        return;
      }
      
      shareTrackRef.current = videoTrack;
      shareSourceIdRef.current = sourceId;
      isSharingRef.current = true;
      setIsSharing(true);

      videoTrack.onended = () => {
        void stopScreenShare();
      };
      videoTrack.addEventListener("mute", () => {
        void window.lokameet.screen.keepCapturerAlive().catch(() => undefined);
      });

      // Аудио трек экрана (не заменяет микрофон — голос остаётся)
      const audioTracks = display.getAudioTracks();
      const screenAudioTrack = audioTracks[0] ?? null;
      shareScreenAudioTrackRef.current = screenAudioTrack;
      for (const audioTrack of audioTracks) {
        audioTrack.onended = () => {
          void stopScreenShare();
        };
      }

      // Меняем локальный preview и sender'ы у всех пиров.
      // Не включаем камеру автоматически — уважаем mediaCfg.videoEnabled.
      let local = localStreamRef.current;
      if (!local) {
        try {
          local = await ensureLocalMedia();
        } catch (err) {
          // Захват экрана уже успешен — не роняем share из‑за устаревшего deviceId мика/камеры.
          void window.lokameet.log.write({
            level: "WARN",
            scope: "renderer/screen",
            msg: "ensureLocalMedia failed after display capture; using screen-only stream",
            data: { error: String(err) }
          });
          local = new MediaStream();
          localStreamRef.current = local;
        }
      }
      if (screenAudioTrack && !local.getAudioTracks().includes(screenAudioTrack)) {
        local.addTrack(screenAudioTrack);
      }
      const existingCam = mediaCfg.videoEnabled
        ? local.getVideoTracks().find((t) => t !== videoTrack && t.readyState === "live" && !isScreenVideoTrack(t, videoTrack.id)) ?? null
        : null;
      if (!local.getVideoTracks().includes(videoTrack)) {
        local.addTrack(videoTrack);
      }
      setLocalStreamVer((v) => v + 1);
      syncLocalVideoPreview();

      const isScreenAudio = (track: MediaStreamTrack) =>
        isScreenBroadcastAudioTrack(track, local, screenAudioTrack?.id);
      if (!mediaCfg.audioEnabled) {
        const micTrack = getMicAudioTrack(local, screenAudioTrack?.id);
        if (micTrack) micTrack.enabled = false;
      }

      const activeCall = callRef.current;
      const peersNeedingRenegotiation = new Set<string>();
      for (const [peerId, peerPc] of pcsRef.current.entries()) {
        if (await replaceVideoTrackAsync(peerPc, videoTrack, local)) {
          peersNeedingRenegotiation.add(peerId);
        }
        tuneScreenShareSender(peerPc, videoTrack);
        if (existingCam && addSecondaryVideoTrack(peerPc, existingCam, local, videoTrack.id)) {
          peersNeedingRenegotiation.add(peerId);
        }
        if (!mediaCfg.audioEnabled) {
          replaceMicAudioTrack(peerPc, null, isScreenAudio);
        } else {
          const micTrack = getMicAudioTrack(local, screenAudioTrack?.id);
          if (micTrack && micTrack.readyState === "live") {
            micTrack.enabled = true;
            replaceMicAudioTrack(peerPc, micTrack, isScreenAudio, local);
          }
        }
        if (screenAudioTrack && addScreenAudioTrack(peerPc, screenAudioTrack, local)) {
          peersNeedingRenegotiation.add(peerId);
        }
      }


      const roomId = activeCall && isConferenceCall(activeCall) ? activeCall.roomId : undefined;
      for (const peerId of peersNeedingRenegotiation) {
        await renegotiatePeerConnection(peerId, roomId);
      }

      setRemoteScreenShare(null);
      if (activeCall && isScreenShareCall(activeCall) && profile) {
        await broadcastScreenShareSignal({
          type: "screen-share-start",
          userName: profile.userName,
          screenAudioTrackId: screenAudioTrack?.id,
          screenVideoTrackId: videoTrack.id
        });
      }
      try {
        if (window.lokameet?.log?.write) {
          void window.lokameet.log.write({
            level: "INFO",
            scope: "renderer/screen",
            msg: "Screen share started",
            data: {
              hasAudio: audioTracks.length > 0,
              sourceId,
              micEnabled: mediaCfg.audioEnabled
            }
          });
        }
      } catch {
        // Игнорируем ошибки логирования
      }
      if (mediaCfg.videoEnabled) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        await ensurePresenterCamera();
      }
    } catch (err) {
      // В случае ошибки сбрасываем все состояния
      try {
        isSharingRef.current = false;
        setIsSharing(false);
        shareTrackRef.current = null;
        shareSourceIdRef.current = null;
      } catch (stateErr) {
        console.error("Error resetting state:", stateErr);
      }
      
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorName = err instanceof Error ? err.name : "";
      
      // Проверяем, не отменил ли пользователь выбор экрана
      if (errorName === "NotAllowedError" || errorName === "AbortError" || 
          errorMsg.toLowerCase().includes("cancel") || 
          errorMsg.toLowerCase().includes("denied") || 
          errorMsg.toLowerCase().includes("not allowed") ||
          errorMsg.toLowerCase().includes("permission")) {
        // Пользователь отменил или отказал в доступе - это нормально, не показываем ошибку
        try {
          if (window.lokameet?.log?.write) {
            void window.lokameet.log.write({ level: "INFO", scope: "renderer/screen", msg: "User cancelled or denied screen share", data: { errorName } });
          }
        } catch {
          // Игнорируем ошибки логирования
        }
        return; // Выходим без ошибки
      }
      
      console.error("Failed to start screen share:", errorMsg, err);
      
      try {
        setError(t("errScreenShareStart", { msg: errorMsg }));
      } catch (errorStateErr) {
        console.error("Error setting error message:", errorStateErr);
      }
      
      try {
        if (window.lokameet?.log?.write) {
          void window.lokameet.log.write({ level: "ERROR", scope: "renderer/screen", msg: "Failed to start screen share", data: { error: errorMsg, errorName } });
        }
      } catch {
        // Игнорируем ошибки логирования
      }
    }
  }

  async function stopScreenShare() {
    if (!isSharingRef.current && !shareTrackRef.current) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    const activeCall = callRef.current;
    const me = profile?.peerId;
    isSharingRef.current = false;
    setIsSharing(false);
    const share = shareTrackRef.current;
    const shareAudio = shareScreenAudioTrackRef.current;
    const screenAudioTrackId = shareAudio?.id;
    shareTrackRef.current = null;
    shareScreenAudioTrackRef.current = null;
    shareSourceIdRef.current = null;
    
    const local = localStreamRef.current;
    if (local) {
      // Останавливаем все треки экрана (видео и аудио)
      for (const track of local.getTracks()) {
        // Определяем треки экрана по типу или по shareTrackRef
        if (track === share || (track.kind === "video" && share && track.id === share.id)) {
          local.removeTrack(track);
          try {
            track.stop();
          } catch {
            // игнор
          }
        } else if (
          (shareAudio && track.id === shareAudio.id) ||
          (track.kind === "audio" && track.label?.toLowerCase().includes("screen"))
        ) {
          local.removeTrack(track);
          try {
            track.stop();
          } catch {
            // игнор
          }
        }
      }
    }

    for (const pc of pcsRef.current.values()) {
      detachScreenAudioTrack(pc, shareAudio);
    }
    
    try {
      share?.stop();
    } catch {
      // игнор
    }
    try {
      shareAudio?.stop();
    } catch {
      // игнор
    }

    const peersNeedingRenegotiation = new Set<string>();
    const roomId = activeCall && isConferenceCall(activeCall) ? activeCall.roomId : undefined;

    // Камера могла остаться на local stream во время демонстрации — не перезахватываем зря.
    if (mediaCfg.videoEnabled) {
      try {
        let processed =
          local?.getVideoTracks().find((t) => t !== share && t.readyState === "live") ?? null;
        if (!processed) {
          const vc = getVideoConstraints(mediaCfg.videoQuality);
          if (selectedVideoDeviceId) (vc as any).deviceId = { ideal: selectedVideoDeviceId };
          const cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
          const camTrack = cam.getVideoTracks()[0] ?? null;
          processed = await prepareCameraTrack(camTrack);
        }
        if (processed && local) {
          installProcessedCamera(local, processed);
          setLocalStreamVer((v) => v + 1);
          for (const [peerId, pc] of pcsRef.current.entries()) {
            if (restoreCameraAfterScreenShare(pc, processed, share?.id ?? "", local)) {
              peersNeedingRenegotiation.add(peerId);
            }
          }
        }
      } catch (err) {
        void window.lokameet.log.write({ level: "WARN", scope: "renderer/screen", msg: "Failed to reacquire camera after screen share", data: { error: String(err) } });
      }
      syncLocalVideoPreview({ videoEnabled: true });
    } else {
      // Камера выкл — убираем любые оставшиеся video-треки и возвращаем стандартную плитку
      if (local) {
        for (const t of [...local.getVideoTracks()]) {
          local.removeTrack(t);
          try {
            t.stop();
          } catch {
            // игнор
          }
        }
      }
      for (const pc of pcsRef.current.values()) {
        replaceVideoTrack(pc, null);
      }
      setLocalStreamVer((v) => v + 1);
      for (const peerId of pcsRef.current.keys()) {
        peersNeedingRenegotiation.add(peerId);
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      syncLocalVideoPreview({ videoEnabled: false });
    }

    const micTrack = local ? getMicAudioTrack(local, screenAudioTrackId) : null;
    if (mediaCfg.audioEnabled && micTrack && micTrack.readyState === "live") {
      micTrack.enabled = true;
      const isScreenAudio = (track: MediaStreamTrack) => isScreenBroadcastAudioTrack(track, local!, screenAudioTrackId);
      for (const [peerId, pc] of pcsRef.current.entries()) {
        replaceMicAudioTrack(pc, micTrack, isScreenAudio, local!);
        peersNeedingRenegotiation.add(peerId);
      }
    } else if (mediaCfg.audioEnabled) {
      await ensureAudioTrackPresent();
      restoreMicOnPeerConnections(screenAudioTrackId);
      for (const peerId of pcsRef.current.keys()) {
        peersNeedingRenegotiation.add(peerId);
      }
    } else {
      // Микрофон выключен в UI — не восстанавливаем и не шлём mic
      if (micTrack) micTrack.enabled = false;
      const isScreenAudio = (track: MediaStreamTrack) =>
        local ? isScreenBroadcastAudioTrack(track, local, screenAudioTrackId) : false;
      for (const pc of pcsRef.current.values()) {
        replaceMicAudioTrack(pc, null, isScreenAudio);
      }
    }

    for (const peerId of peersNeedingRenegotiation) {
      await renegotiatePeerConnection(peerId, roomId);
    }

    if (activeCall && isScreenShareCall(activeCall) && me) {
      await broadcastScreenShareSignal({ type: "screen-share-stop" });
    }
    void window.lokameet.log.write({ level: "INFO", scope: "renderer/screen", msg: "Screen share stopped" });
  }

  function stopAllPeerConnections() {
    for (const pc of pcsRef.current.values()) {
      try {
        pc.close();
      } catch {
        // игнор
      }
    }
    pcsRef.current.clear();
    for (const dc of dcsRef.current.values()) {
      try {
        dc.close();
      } catch {
        // игнор
      }
    }
    dcsRef.current.clear();
    remoteRef.current.clear();
    setRemoteTracks([]);
    resetScreenShareViewState();
  }

  function stopLocalMedia() {
    const s = localStreamRef.current;
    localStreamRef.current = null;
    if (s) {
      for (const t of s.getTracks()) t.stop();
    }
    stopRawCamera();
    shareTrackRef.current = null;
    shareScreenAudioTrackRef.current = null;
    shareSourceIdRef.current = null;
    isSharingRef.current = false;
    setIsSharing(false);
    stopAppWindowCapture();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  }

  async function sendToHub(env: WsEnvelope) {
    const activeCall = callRef.current;
    if (!activeCall) return;
    // Хост комнаты не должен слать через "hub" (это был бы он сам).
    if (profile && activeCall.mode === "room" && activeCall.hostPeerId === profile.peerId && activeCall.signalHubPeerId === profile.peerId) return;
    // Best-effort: шлём; reconnect+retry только при неудаче.
    let ok = await window.lokameet.net.sendToPeer(activeCall.signalHubPeerId, env).catch(() => false);
    if (!ok) {
      if (activeCall.mode === "direct") {
        await ensureDirectSignaling(activeCall.peerId);
      } else if (activeCall.mode === "room" && activeCall.signalHubHost && activeCall.signalHubPort) {
        await window.lokameet.net.connect(activeCall.signalHubHost, activeCall.signalHubPort).catch(() => undefined);
      }
      ok = await window.lokameet.net.sendToPeer(activeCall.signalHubPeerId, env).catch(() => false);
    }
    if (!ok) {
      setError(t("errChatDeliver"));
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/net",
        msg: "sendToHub failed",
        data: {
          mode: activeCall.mode,
          hubPeerId: activeCall.signalHubPeerId,
          hubHost: activeCall.signalHubHost,
          hubPort: activeCall.signalHubPort,
          envType: env.type
        }
      });
    }
  }

  async function sendToRoomIfHost(env: WsEnvelope) {
    if (!profile || !call || call.mode !== "room") return false;
    if (call.hostPeerId !== profile.peerId) return false;
    // Хост шлёт напрямую (без "hub"-соединения к себе).
    for (const p of call.participants) {
      if (p.peerId === profile.peerId) continue;
      await window.lokameet.net.sendToPeer(p.peerId, env).catch(() => undefined);
    }
    return true;
  }

  async function ensureDirectSignaling(peerId: string) {
    // Если знаем host/port пира — убеждаемся, что signaling-соединение есть.
    const p = peers.find((x) => x.peerId === peerId) ?? manualPeers.find((x) => x.peerId === peerId) ?? null;
    if (!p) return;
    if (connectedPeersRef.current.has(peerId)) return;
    const existing = connectingPeerRef.current.get(peerId);
    if (existing) return await existing;
    const task = (async () => {
      try {
        await window.lokameet.net.connect(p.host, p.port);
        connectedPeersRef.current.add(peerId);
      } catch {
        // игнор
      } finally {
        connectingPeerRef.current.delete(peerId);
      }
    })();
    connectingPeerRef.current.set(peerId, task);
    await task;
  }

  async function refreshPeerAvatar(peer: PeerInfo, recipientPeerId: string) {
    if (!peer.avatarHash) {
      setAvatarUrls((current) => {
        const next = { ...current };
        delete next[peer.peerId];
        return next;
      });
      return;
    }

    const cached = await window.lokameet.avatar.get(peer.peerId, peer.avatarHash).catch(() => null);
    if (cached) {
      setAvatarUrls((current) => ({ ...current, [peer.peerId]: cached.dataUrl }));
      return;
    }

    const requestKey = `${peer.peerId}:${peer.avatarHash}`;
    if (avatarRequestsRef.current.has(requestKey)) return;
    avatarRequestsRef.current.add(requestKey);
    try {
      await window.lokameet.net.connect(peer.host, peer.port);
      await window.lokameet.net.sendToPeer(peer.peerId, {
        type: "avatar-request",
        peerId: recipientPeerId,
        avatarHash: peer.avatarHash
      });
    } catch {
      // Повтор при следующей смене аватара или перезапуске приложения.
    }
  }

  async function onEnvelope(env: WsEnvelope) {
    if (env.type === "direct-call-request" || env.type === "direct-call-accept" || env.type === "direct-call-reject" || env.type === "room-invite" || env.type === "room-invite-reject" || env.type === "room-join" || env.type === "room-welcome" || env.type === "room-peer-joined" || env.type === "room-peer-left" || env.type === "rtc-signal" || env.type === "chat-message") {
      void window.lokameet.log.write({ level: "INFO", scope: "renderer/envelope", msg: env.type, data: env });
    } else {
      void window.lokameet.log.write({ level: "DEBUG", scope: "renderer/envelope", msg: env.type, data: env });
    }
    if (env.type === "hello") {
      if (!env.peerId || env.peerId === profile?.peerId) return;
      if (isBusyStatus(env.status)) helloStatusRef.current.set(env.peerId, env.status);
      else helloStatusRef.current.delete(env.peerId);
      const patch = {
        status: env.status,
        userName: env.userName,
        statusText: env.statusText,
        avatarHash: env.avatarHash,
        avatarPosition: env.avatarPosition,
        lastSeenAt: Date.now()
      };
      const applyHello = (list: PeerInfo[]) =>
        list.map((p) => (p.peerId === env.peerId ? { ...p, ...patch } : p));
      setPeers((prev) => applyHello(prev));
      setManualPeers((prev) => applyHello(prev));
      return;
    }
    if (env.type === "avatar-request") {
      if (!profile?.avatarHash) return;
      const avatar = await window.lokameet.avatar.get(profile.peerId, profile.avatarHash).catch(() => null);
      if (avatar) {
        await window.lokameet.net
          .sendToPeer(env.peerId, {
            type: "avatar-data",
            peerId: profile.peerId,
            avatarHash: avatar.avatarHash,
            dataUrl: avatar.dataUrl
          })
          .catch(() => undefined);
      }
      return;
    }
    if (env.type === "avatar-data") {
      const avatar = await window.lokameet.avatar.storeRemote(env.peerId, env.avatarHash, env.dataUrl).catch(() => null);
      if (avatar) setAvatarUrls((current) => ({ ...current, [env.peerId]: avatar.dataUrl }));
      return;
    }
    if (env.type === "direct-call-request") {
      // Очищаем предыдущие таймеры если есть
      if (incomingCallTimerRef.current) clearInterval(incomingCallTimerRef.current);
      if (incomingCallSoundIntervalRef.current) clearInterval(incomingCallSoundIntervalRef.current);
      if (incomingCallTimeoutRef.current) clearTimeout(incomingCallTimeoutRef.current);
      
      markPeerAction(env.fromPeerId, "call");
      setIncomingCall({ peerId: env.fromPeerId, userName: env.fromUserName });
      setIncomingCallBlink(true);
      
      // Мигание каждые 500мс
      incomingCallTimerRef.current = window.setInterval(() => {
        setIncomingCallBlink((b) => !b);
      }, 500);
      
      // Звуковое уведомление каждые 1.5 секунды
      const playSound = () => {
        playNotificationSound(callSoundFile, callSoundVolume);
      };
      
      playSound(); // Сразу один раз
      incomingCallSoundIntervalRef.current = window.setInterval(playSound, 1500);
      
      // Таймер на 7 секунд для пропущенного звонка
      incomingCallTimeoutRef.current = window.setTimeout(() => {
        setIncomingCall(null);
        setIncomingCallBlink(false);
        if (incomingCallTimerRef.current) {
          clearInterval(incomingCallTimerRef.current);
          incomingCallTimerRef.current = null;
        }
        if (incomingCallSoundIntervalRef.current) {
          clearInterval(incomingCallSoundIntervalRef.current);
          incomingCallSoundIntervalRef.current = null;
        }
        // Добавляем уведомление о пропущенном звонке в чат
        const peer = peers.find((x) => x.peerId === env.fromPeerId) ?? manualPeers.find((x) => x.peerId === env.fromPeerId);
        if (peer && profile) {
          const missedCallMsg: ChatMessage = {
            id: `missed-call-${Date.now()}-${env.fromPeerId}`,
            scope: { type: "direct", peerId: env.fromPeerId },
            fromPeerId: env.fromPeerId,
            fromUserName: env.fromUserName,
            sentAt: Date.now(),
            text: "❌ Пропущенный звонок"
          };
          void window.lokameet.chat.append(missedCallMsg);
          setChats((prev) => [...prev, missedCallMsg]);
        }
      }, 7000);
      return;
    }
    if (env.type === "direct-call-accept") {
      // Мы инициатор звонка: начинаем offer.
      const activeCall = callRef.current;
      if (!activeCall || activeCall.mode !== "direct") return;
      clearPendingCall(activeCall.peerId);
      clearPeerAction(activeCall.peerId);
      setCallStartedAt(Date.now());
      // Воспроизводим звук установки соединения для звонящего
      playNotificationSound(connectionSoundFile, connectionSoundVolume);
      // Фокусируем UI на этом прямом чате/звонке (caller переключается при accept).
      if (autoSwitchToChat) {
        setSelectedRoom(null);
        const p = peers.find((x) => x.peerId === activeCall.peerId) ?? manualPeers.find((x) => x.peerId === activeCall.peerId) ?? null;
        if (p) setSelectedPeer(p);
        setSearch("");
      }
      try {
        await ensureLocalMedia();
        // Треки должны быть до createOffer, иначе video может не попасть в SDP
        await ensureAudioTrackPresent().catch(() => undefined);
        await ensureVideoTrackPresent().catch(() => undefined);
      } catch (err) {
        void window.lokameet.log.write({ level: "WARN", scope: "renderer/call", msg: "Media ensure failed before offer", data: { error: String((err as Error)?.message ?? err) } });
      }
      await ensurePeerConnection(activeCall.peerId, activeCall.peerName, { initiator: true, roomId: undefined });
      return;
    }
    if (env.type === "direct-call-reject") {
      if (env.fromPeerId) clearPendingCall(env.fromPeerId);
      if (call && isDirectCall(call)) clearPendingCall(call.peerId);
      setError(conferenceRejectMessage(env.reason, t));
      setIncomingCall(null);
      if (call && isDirectCall(call)) {
        intentionalPeerDisconnectsRef.current.add(call.peerId);
        stopAllPeerConnections();
        setConferenceCall(null);
        setCallStartedAt(null);
      }
      return;
    }

    if (env.type === "room-invite") {
      if (isBusyStatus(profile?.status ?? "online") || call) {
        // Уже заняты — молча отклоняем, чтобы пригласивший получил отказ
        const peer = peers.find((x) => x.peerId === env.fromPeerId) ?? manualPeers.find((x) => x.peerId === env.fromPeerId);
        if (peer && profile) {
          await window.lokameet.net.connect(peer.host, peer.port).catch(() => undefined);
          await window.lokameet.net
            .sendToPeer(env.fromPeerId, {
              type: "room-invite-reject",
              fromPeerId: profile.peerId,
              fromUserName: profile.userName,
              roomId: env.roomId,
              roomName: env.roomName
            })
            .catch(() => undefined);
        }
        return;
      }
      if (incomingRoomInviteTimerRef.current) clearInterval(incomingRoomInviteTimerRef.current);
      if (incomingRoomInviteTimeoutRef.current) clearTimeout(incomingRoomInviteTimeoutRef.current);
      setIncomingRoomInvite({
        fromPeerId: env.fromPeerId,
        fromUserName: env.fromUserName,
        room: {
          roomId: env.roomId,
          roomName: env.roomName,
          hostPeerId: env.hostPeerId,
          host: env.host,
          port: env.port,
          hasPassword: env.hasPassword,
          maxParticipants: env.maxParticipants,
          participantsApprox: env.participantsApprox,
          lastSeenAt: Date.now()
        }
      });
      setIncomingRoomInviteBlink(true);
      incomingRoomInviteTimerRef.current = window.setInterval(() => {
        setIncomingRoomInviteBlink((b) => !b);
      }, 500);
      playNotificationSound(callSoundFile, callSoundVolume);
      incomingRoomInviteTimeoutRef.current = window.setTimeout(() => {
        clearIncomingRoomInviteUi();
      }, 30000);
      return;
    }

    if (env.type === "room-invite-reject") {
      clearPendingInvite(env.fromPeerId);
      if (inviteRejectedTimeoutRef.current) clearTimeout(inviteRejectedTimeoutRef.current);
      setInviteRejectedNotice({ userName: env.fromUserName, roomName: env.roomName });
      inviteRejectedTimeoutRef.current = window.setTimeout(() => {
        setInviteRejectedNotice(null);
        inviteRejectedTimeoutRef.current = null;
      }, 8000);
      const activeCall = callRef.current;
      if (activeCall?.mode === "room" && activeCall.roomId === env.roomId && activeCall.hostPeerId === profile?.peerId) {
        const message = appendSystemChatStatus(
          { type: "room", roomId: env.roomId },
          env.fromPeerId,
          env.fromUserName,
          t("chatStatusInviteRejected")
        );
        const statusEnv: WsEnvelope = { type: "chat-message", message };
        await Promise.all(
          activeCall.participants
            .filter((participant) => participant.peerId !== profile?.peerId)
            .map((participant) => window.lokameet.net.sendToPeer(participant.peerId, statusEnv).catch(() => undefined))
        );
      }
      return;
    }

    if (env.type === "room-welcome") {
      const room =
        resolveConferenceRoom(env.roomId, {
          rooms,
          selectedRoom,
          lastJoinRoom: lastJoinRoomRef.current
        }) ?? lastJoinRoomRef.current;
      const conferenceState = applyConferenceHubFromRoom(
        createJoinConferenceState({
          roomId: env.roomId,
          roomName: room?.roomName ?? t("conference"),
          hostPeerId: env.hostPeerId,
          participants: env.participants,
          room
        }),
        room
      );
      setCallStartedAt(Date.now());
      setConferenceCall(conferenceState);
      if (room) setSelectedRoom(room);
      {
        const hostParticipant =
          env.participants.find((p) => p.peerId === env.hostPeerId) ??
          (profile?.peerId === env.hostPeerId
            ? { peerId: profile.peerId, userName: profile.userName }
            : null);
        if (hostParticipant && profile?.peerId !== hostParticipant.peerId) {
          appendSystemChatStatus(
            { type: "room", roomId: env.roomId },
            hostParticipant.peerId,
            hostParticipant.userName,
            t("chatStatusCreatedConference")
          );
        }
      }
      if (joiningRoomFromInviteRef.current) {
        joiningRoomFromInviteRef.current = false;
        await sendChatStatus({ type: "room", roomId: env.roomId }, t("chatStatusInviteAccepted"));
      }
      await sendChatStatus({ type: "room", roomId: env.roomId }, t("chatStatusOpened"));
      // КРИТИЧЕСКИ ВАЖНО: запрашиваем медиа перед созданием соединений
      try {
        await ensureLocalMedia();
        await ensureAudioTrackPresent().catch((err) => {
          void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to ensure audio track in room", data: { error: String(err) } });
        });
        await ensureVideoTrackPresent().catch((err) => {
          void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to ensure video track in room", data: { error: String(err) } });
        });
      } catch (err) {
        void window.lokameet.log.write({ level: "ERROR", scope: "renderer/media", msg: "Failed to ensure local media in room", data: { error: String(err) } });
      }
      // Новый участник инициирует WebRTC только к уже присутствующим в комнате.
      const me = profile?.peerId;
      for (const p of env.participants) {
        if (p.peerId === me) continue;
        await ensurePeerConnection(p.peerId, p.userName, { initiator: true, roomId: env.roomId });
      }
      return;
    }
    if (env.type === "room-peer-joined") {
      const activeCall = callRef.current;
      if (activeCall?.mode !== "room" || activeCall.roomId !== env.roomId) return;
      clearPendingInvite(env.peerId);
      setCall((c) => {
        if (!c || c.mode !== "room") return c;
        const exists = c.participants.some((p) => p.peerId === env.peerId);
        if (exists) return c;
        return { ...c, participants: [...c.participants, { peerId: env.peerId, userName: env.userName }] };
      });
      // Существующие участники только готовят медиа и ждут offer от нового участника.
      if (profile) {
        try {
          await ensureLocalMedia();
          await ensureAudioTrackPresent().catch((err) => {
            void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to ensure audio track for new peer", data: { error: String(err) } });
          });
          await ensureVideoTrackPresent().catch((err) => {
            void window.lokameet.log.write({ level: "WARN", scope: "renderer/media", msg: "Failed to ensure video track for new peer", data: { error: String(err) } });
          });
        } catch (err) {
          void window.lokameet.log.write({ level: "ERROR", scope: "renderer/media", msg: "Failed to ensure local media for new peer", data: { error: String(err) } });
        }
      }
      return;
    }
    if (env.type === "room-peer-left") {
      const activeCall = callRef.current;
      if (activeCall?.mode !== "room" || activeCall.roomId !== env.roomId) return;
      const departedPeer = activeCall.participants.find((participant) => participant.peerId === env.peerId);
      appendSystemChatStatus(
        { type: "room", roomId: env.roomId },
        env.peerId,
        departedPeer?.userName ?? "User",
        t("chatStatusLeft")
      );
      if (env.peerId === activeCall.hostPeerId) {
        stopAllPeerConnections();
        setConferenceCall(null);
        setCallStartedAt(null);
        setError(t("conferenceClosed"));
        return;
      }
      closePeer(env.peerId);
      setCall((c) => {
        if (!c || c.mode !== "room") return c;
        return { ...c, participants: c.participants.filter((p) => p.peerId !== env.peerId) };
      });
      return;
    }

    if (env.type === "chat-message") {
      // Нормализуем scope прямого чата: обе стороны ключуют по peerId собеседника.
      const me = profile?.peerId;
      const msg: ChatMessage = { ...env.message, scope: { ...env.message.scope } as any };
      if (me && msg.scope.type === "direct" && msg.scope.peerId === me) {
        msg.scope = { type: "direct", peerId: msg.fromPeerId };
      }
      // Воспроизводим звук уведомления для сообщений (только если сообщение не от нас)
      if (msg.fromPeerId !== me && msg.kind !== "system") {
        playNotificationSound(messageSoundFile, messageSoundVolume);
        // Индикацию видит только получатель; отправитель (fromPeerId === me) сюда не попадает.
        if (msg.scope.type === "direct") {
          const viewingSender = selectedPeerRef.current?.peerId === msg.fromPeerId;
          const inDirectCallWithSender =
            callRef.current?.mode === "direct" && callRef.current.peerId === msg.fromPeerId;
          if (!viewingSender && !inDirectCallWithSender) {
            markPeerAction(msg.fromPeerId, "message");
            setUnreadPeerIds((current) => new Set(current).add(msg.fromPeerId));
            setUnreadMessageIds((current) => new Set(current).add(msg.id));
          }
        }
      }
      setChats((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        const next = [...prev, msg];
        window.lokameet.chat.append(msg).catch(() => undefined);
        return next;
      });
      return;
    }

    if (env.type === "rtc-signal") {
      const sig = env.signal;
      const me = profile?.peerId;
      if (!me) return;
      if (sig.toPeerId !== me) return;

      const name = guessPeerName(sig.fromPeerId);
      if (sig.type === "rtc-offer") {
        // Если это личный звонок (нет roomId) и у нас еще нет call state, нужно его установить
        if (!sig.roomId && (!call || call.mode !== "direct" || call.peerId !== sig.fromPeerId)) {
          const peer = peers.find((x) => x.peerId === sig.fromPeerId) ?? manualPeers.find((x) => x.peerId === sig.fromPeerId);
          if (peer) {
            setCall({ mode: "direct", peerId: sig.fromPeerId, peerName: peer.userName, signalHubPeerId: sig.fromPeerId, signalHubHost: peer.host, signalHubPort: peer.port });
            setCallStartedAt(Date.now());
            if (autoSwitchToChat) {
              setSelectedRoom(null);
              setSelectedPeer(peer);
              setSearch("");
            }
          }
        }
        // КРИТИЧЕСКИ ВАЖНО: для конференций закрываем существующие соединения с тем же peerId, если они были для личного звонка
        if (sig.roomId) {
          const existingPc = pcsRef.current.get(sig.fromPeerId);
          if (existingPc && (!call || call.mode !== "room" || call.roomId !== sig.roomId)) {
            // Закрываем старое соединение, если оно было для другого типа звонка
            void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "Closing existing connection before room offer", data: { remotePeerId: sig.fromPeerId, roomId: sig.roomId, existingCallMode: call?.mode } });
            try {
              existingPc.close();
              pcsRef.current.delete(sig.fromPeerId);
              remoteRef.current.delete(sig.fromPeerId);
              dcsRef.current.delete(sig.fromPeerId);
              setRemoteTracks(Array.from(remoteRef.current.values()));
            } catch (err) {
              void window.lokameet.log.write({ level: "WARN", scope: "renderer/webrtc", msg: "Error closing existing connection", data: { remotePeerId: sig.fromPeerId, error: String(err) } });
            }
          }
        }
        await ensureLocalMedia().catch((err) => {
          void window.lokameet.log.write({
            level: "WARN",
            scope: "renderer/webrtc",
            msg: "ensureLocalMedia failed on rtc-offer; continuing for answer",
            data: { fromPeerId: sig.fromPeerId, error: String(err) }
          });
        });
        await ensureAudioTrackPresent().catch(() => undefined);
        await ensureVideoTrackPresent().catch(() => undefined);
        const pc = await ensurePeerConnection(sig.fromPeerId, name, { initiator: false, roomId: sig.roomId });
        if (pc.signalingState === "have-local-offer") {
          try {
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
          } catch {
            // игнорируем ошибки rollback
          }
        }
        // КРИТИЧЕСКИ ВАЖНО: треки должны быть добавлены ДО setRemoteDescription
        // ensurePeerConnection уже добавил треки, но проверим еще раз на всякий случай
        const local = localStreamRef.current;
        if (local) {
          const tracksBefore = pc.getSenders().length;
          for (const track of local.getTracks()) {
            if (track.readyState !== "live") continue;
            const isScreenTrack = Boolean(
              shareTrackRef.current &&
                (track === shareTrackRef.current || track.id === shareTrackRef.current.id)
            );
            if (track.kind === "video" && !isScreenTrack && !mediaCfg.videoEnabled) continue;
            if (
              track.kind === "audio" &&
              !isScreenBroadcastAudioTrack(track, local, shareScreenAudioTrackRef.current?.id) &&
              !mediaCfg.audioEnabled
            ) {
              continue;
            }
            const existingSender = pc.getSenders().find((s) => s.track === track);
            if (!existingSender) {
              try {
                pc.addTrack(track, local);
                void window.lokameet.log.write({
                  level: "INFO",
                  scope: "renderer/webrtc",
                  msg: "Added track before setRemoteDescription",
                  data: { remotePeerId: sig.fromPeerId, trackId: track.id, kind: track.kind }
                });
              } catch (err) {
                void window.lokameet.log.write({
                  level: "WARN",
                  scope: "renderer/webrtc",
                  msg: "Failed to add track before setRemoteDescription",
                  data: {
                    remotePeerId: sig.fromPeerId,
                    trackId: track.id,
                    kind: track.kind,
                    error: String(err)
                  }
                });
              }
            }
          }
          const tracksAfter = pc.getSenders().length;
          void window.lokameet.log.write({
            level: "INFO",
            scope: "renderer/webrtc",
            msg: "Tracks before setRemoteDescription",
            data: { remotePeerId: sig.fromPeerId, tracksBefore, tracksAfter }
          });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendRtc({
          type: "rtc-answer",
          roomId: sig.roomId,
          fromPeerId: me,
          toPeerId: sig.fromPeerId,
          sdp: { type: answer.type, sdp: answer.sdp ?? undefined }
        });
        if (pc.signalingState === "stable") {
          flushPendingRenegotiation(sig.fromPeerId);
        }
      } else if (sig.type === "rtc-answer") {
        const pc = pcsRef.current.get(sig.fromPeerId);
        if (!pc) {
          void window.lokameet.log.write({ level: "WARN", scope: "renderer/webrtc", msg: "rtc-answer received but no peer connection", data: { fromPeerId: sig.fromPeerId, roomId: sig.roomId } });
          return;
        }
        // Логируем состояние треков перед setRemoteDescription
        const sendersBefore = pc.getSenders().length;
        const receiversBefore = pc.getReceivers().length;
        void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "Processing rtc-answer", data: { fromPeerId: sig.fromPeerId, roomId: sig.roomId, sendersBefore, receiversBefore } });
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp as RTCSessionDescriptionInit));
        // После setRemoteDescription проверим состояние
        const sendersAfter = pc.getSenders().length;
        const receiversAfter = pc.getReceivers().length;
        void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "rtc-answer processed", data: { fromPeerId: sig.fromPeerId, roomId: sig.roomId, sendersAfter, receiversAfter } });
        if (pc.signalingState === "stable") {
          flushPendingRenegotiation(sig.fromPeerId);
        }
      } else if (sig.type === "rtc-ice") {
        const pc = pcsRef.current.get(sig.fromPeerId);
        if (!pc) return;
        if (sig.candidate) await pc.addIceCandidate(sig.candidate).catch(() => undefined);
      } else if (sig.type === "screen-share-start") {
        if (!callRef.current || !isScreenShareCall(callRef.current)) return;
        if (isSharingRef.current) {
          void stopScreenShare();
        }
        setRemoteScreenShare({
          peerId: sig.fromPeerId,
          userName: sig.userName,
          screenAudioTrackId: sig.screenAudioTrackId,
          screenVideoTrackId: sig.screenVideoTrackId
        });
        setScreenViewControlsHidden(false);
        setScreenBroadcastMuted(false);
        setScreenShareViewCollapsed(false);
      } else if (sig.type === "screen-share-stop") {
        setRemoteScreenShare((prev) => (prev?.peerId === sig.fromPeerId ? null : prev));
        setScreenViewControlsHidden(false);
        setScreenBroadcastMuted(false);
        setScreenShareViewCollapsed(false);
        // Сбрасываем muted/ended screen video, иначе video-элемент держит последний кадр
        refreshRemotePeerVideo(sig.fromPeerId, { dropMutedVideo: true });
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        }
      } else if (sig.type === "recording-start") {
        setRemoteRecordings((list) =>
          list.some((item) => item.peerId === sig.fromPeerId)
            ? list
            : [...list, { peerId: sig.fromPeerId, userName: sig.userName }]
        );
        playRecordingAnnouncement("start");
      } else if (sig.type === "recording-stop") {
        setRemoteRecordings((list) => list.filter((item) => item.peerId !== sig.fromPeerId));
        playRecordingAnnouncement("stop");
      }
      return;
    }
  }

  // Держим обработчик envelope актуальным для подписки, созданной на mount.
  onEnvelopeRef.current = (env) => {
    void onEnvelope(env);
  };

  function guessPeerName(peerId: string) {
    if (call?.mode === "direct" && call.peerId === peerId) return call.peerName;
    const p = peers.find((x) => x.peerId === peerId);
    if (p) return p.userName;
    if (call?.mode === "room") {
      const rp = call.participants.find((x) => x.peerId === peerId);
      if (rp) return rp.userName;
    }
    return "Peer";
  }

  async function sendRtc(signal: RtcSignal) {
    if (!callRef.current && !signal.roomId) {
      // Для личных звонков без call state все равно пытаемся отправить через прямое соединение
      const peer = peers.find((x) => x.peerId === signal.toPeerId) ?? manualPeers.find((x) => x.peerId === signal.toPeerId);
      if (peer) {
        const env: WsEnvelope = { type: "rtc-signal", signal };
        await window.lokameet.net.sendToPeer(signal.toPeerId, env).catch(() => undefined);
      }
      return;
    }

    const activeCall = callRef.current;
    if (!activeCall) {
      if (signal.roomId && lastJoinRoomRef.current?.roomId === signal.roomId) {
        const env: WsEnvelope = { type: "rtc-signal", signal };
        await window.lokameet.net.sendToPeer(lastJoinRoomRef.current.hostPeerId, env).catch(() => undefined);
      }
      return;
    }

    const env: WsEnvelope = { type: "rtc-signal", signal };
    // Если мы хост комнаты — ретранслируем напрямую цели (без hub).
    if (profile && activeCall.mode === "room" && activeCall.hostPeerId === profile.peerId) {
      await window.lokameet.net.sendToPeer(signal.toPeerId, env).catch(() => undefined);
      return;
    }
    await sendToHub(env);
  }

  async function ensurePeerConnection(
    remotePeerId: string,
    remoteUserName: string,
    opts: { initiator: boolean; roomId?: string }
  ): Promise<RTCPeerConnection> {
    const existing = pcsRef.current.get(remotePeerId);
    if (existing) {
      // Если соединение существует, убеждаемся что все треки добавлены
      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getTracks()) {
          if (track.readyState === "live") {
            const existingSender = existing.getSenders().find(s => s.track === track);
            if (!existingSender) {
              try {
                existing.addTrack(track, local);
              } catch {
                // Игнорируем ошибки
              }
            }
          }
        }
      }
      return existing;
    }
    const me = profile?.peerId;
    if (!me) throw new Error("no-profile");

    void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "Creating peer connection", data: { remotePeerId, remoteUserName, initiator: opts.initiator, roomId: opts.roomId } });

    const pc = createPeerConnection();
    pcsRef.current.set(remotePeerId, pc);
    pc.addEventListener("iceconnectionstatechange", () => {
      void window.lokameet.log.write({
        level: pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected" ? "WARN" : "INFO",
        scope: "renderer/webrtc",
        msg: "ICE connection state",
        data: { remotePeerId, remoteUserName, iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState, signalingState: pc.signalingState }
      });
    });
    pc.addEventListener("connectionstatechange", () => {
      void window.lokameet.log.write({
        level: pc.connectionState === "failed" || pc.connectionState === "disconnected" ? "WARN" : "INFO",
        scope: "renderer/webrtc",
        msg: "Peer connection state",
        data: { remotePeerId, remoteUserName, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState }
      });
    });
    pc.addEventListener("signalingstatechange", () => {
      if (pc.signalingState === "stable") {
        flushPendingRenegotiation(remotePeerId);
      }
    });

    const local = await ensureLocalMedia().catch((err) => {
      void window.lokameet.log.write({
        level: "WARN",
        scope: "renderer/webrtc",
        msg: "ensureLocalMedia failed inside ensurePeerConnection",
        data: { remotePeerId, error: String(err) }
      });
      if (!localStreamRef.current) {
        localStreamRef.current = new MediaStream();
        setLocalStreamVer((v) => v + 1);
      }
      return localStreamRef.current;
    });
    // Убеждаемся, что аудио и видео треки существуют перед добавлением в peer connection
    // Это критически важно для групповых вызовов
    if (mediaCfg.audioEnabled) {
      await ensureAudioTrackPresent().catch((err) => {
        void window.lokameet.log.write({ level: "WARN", scope: "renderer/webrtc", msg: "Failed to ensure audio track before peer connection", data: { remotePeerId, error: String(err) } });
      });
    }
    // Если идет демонстрация экрана, не пытаемся получить камеру - используем трек экрана
    if (mediaCfg.videoEnabled && !isSharingRef.current) {
      await ensureVideoTrackPresent().catch((err) => {
        void window.lokameet.log.write({ level: "WARN", scope: "renderer/webrtc", msg: "Failed to ensure video track before peer connection", data: { remotePeerId, error: String(err) } });
      });
    }
    // Обновляем local ссылку после ensure треков
    const updatedLocal = localStreamRef.current;
    if (!updatedLocal) {
      void window.lokameet.log.write({ level: "ERROR", scope: "renderer/webrtc", msg: "Local stream is null after ensuring tracks", data: { remotePeerId } });
      throw new Error("Local stream is null");
    }
    // Добавляем все треки из локального потока
    // Важно: если идет демонстрация экрана, трек экрана должен быть в localStreamRef
    for (const track of updatedLocal.getTracks()) {
      if (track.readyState !== "live") continue;
      // Не шлём микрофон, если он выключен в UI
      if (
        track.kind === "audio" &&
        !isScreenBroadcastAudioTrack(track, updatedLocal, shareScreenAudioTrackRef.current?.id) &&
        !mediaCfg.audioEnabled
      ) {
        continue;
      }
      const isScreenTrack = Boolean(
        isSharingRef.current &&
          shareTrackRef.current &&
          (track === shareTrackRef.current || track.id === shareTrackRef.current.id)
      );
      // Камера выкл и это не screen-share — не добавляем video (не «включаем камеру» неявно)
      if (track.kind === "video" && !isScreenTrack && !mediaCfg.videoEnabled) {
        continue;
      }
      try {
        if (isScreenTrack) {
          void window.lokameet.log.write({
            level: "INFO",
            scope: "renderer/webrtc",
            msg: "Adding screen share track to new peer connection",
            data: { remotePeerId, trackId: track.id }
          });
        }
        pc.addTrack(track, updatedLocal);
        void window.lokameet.log.write({
          level: "DEBUG",
          scope: "renderer/webrtc",
          msg: "Track added to peer connection",
          data: { remotePeerId, trackId: track.id, kind: track.kind, isScreenTrack }
        });
      } catch {
        void window.lokameet.log.write({
          level: "DEBUG",
          scope: "renderer/webrtc",
          msg: "Track already added",
          data: { remotePeerId, trackId: track.id, kind: track.kind }
        });
      }
    }

    // Дополнительная проверка: если идет демонстрация экрана, но трек не был добавлен, добавляем его явно
    if (isSharingRef.current && shareTrackRef.current) {
      const screenTrack = shareTrackRef.current;
      if (screenTrack.readyState === "live") {
        const existingSender = pc.getSenders().find(
          (s) => s.track === screenTrack || (s.track && s.track.id === screenTrack.id)
        );
        if (!existingSender) {
          try {
            pc.addTrack(screenTrack, updatedLocal);
            void window.lokameet.log.write({
              level: "INFO",
              scope: "renderer/webrtc",
              msg: "Screen share track explicitly added to peer connection",
              data: { remotePeerId, trackId: screenTrack.id }
            });
          } catch (e) {
            void window.lokameet.log.write({
              level: "WARN",
              scope: "renderer/webrtc",
              msg: "Failed to add screen share track",
              data: { remotePeerId, error: String(e) }
            });
          }
        }
      }
      const camTrack = updatedLocal.getVideoTracks().find(
        (t) => t !== screenTrack && t.readyState === "live" && mediaCfg.videoEnabled
      );
      if (camTrack && addSecondaryVideoTrack(pc, camTrack, updatedLocal, screenTrack.id)) {
        void window.lokameet.log.write({
          level: "INFO",
          scope: "renderer/webrtc",
          msg: "Presenter camera track added to peer connection",
          data: { remotePeerId, trackId: camTrack.id }
        });
      }
    }

    const setupDataChannel = (dc: RTCDataChannel) => {
      dc.binaryType = "arraybuffer";
      dcsRef.current.set(remotePeerId, dc);
      dc.onopen = () => {
        // DataChannel открыт, можно отправлять сообщения
      };
      dc.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as any;
            if (msg?.t === "file-meta") {
              incomingFileRef.current.set(remotePeerId, {
                id: String(msg.id),
                name: String(msg.name),
                size: Number(msg.size),
                mime: msg.mime ? String(msg.mime) : undefined,
                received: 0,
                chunks: []
              });
              const fileId = String(msg.id);
              const fileName = String(msg.name);
              const size = Number(msg.size);
              setFileTransfers((prev) => {
                const withoutPending = prev.filter((x) => x.key !== `recv:${remotePeerId}:pending`);
                const key = `recv:${remotePeerId}:${fileId}`;
                const item: FileTransferItem = {
                  key,
                  direction: "receive",
                  peerId: remotePeerId,
                  fileId,
                  fileName,
                  transferred: 0,
                  total: size,
                  percent: 0
                };
                const idx = withoutPending.findIndex((x) => x.key === key);
                if (idx === -1) return [...withoutPending, item];
                const next = withoutPending.slice();
                next[idx] = item;
                return next;
              });
            } else if (msg?.t === "typing") {
              // Уведомление о том, что собеседник печатает
              setTypingPeers((prev) => new Set(prev).add(remotePeerId));
              // Очищаем через 3 секунды
              const existingTimeout = typingTimeoutRef.current.get(remotePeerId);
              if (existingTimeout) clearTimeout(existingTimeout);
              const timeoutId = window.setTimeout(() => {
                setTypingPeers((prev) => {
                  const next = new Set(prev);
                  next.delete(remotePeerId);
                  return next;
                });
                typingTimeoutRef.current.delete(remotePeerId);
              }, 3000);
              typingTimeoutRef.current.set(remotePeerId, timeoutId);
            } else if (msg?.t === "file-sending") {
              const fileName = msg.name ? String(msg.name) : t("fileFallbackName");
              const key = `recv:${remotePeerId}:pending`;
              upsertFileTransfer(
                {
                  key,
                  direction: "receive",
                  peerId: remotePeerId,
                  fileName,
                  transferred: 0,
                  total: 0,
                  percent: 0
                },
                { force: true }
              );
            } else if (msg?.t === "file-cancel") {
              const cancelId = msg.id ? String(msg.id) : "";
              const pending = incomingFileRef.current.get(remotePeerId);
              if (pending && (!cancelId || pending.id === cancelId)) {
                incomingFileRef.current.delete(remotePeerId);
                setFileTransfers((prev) =>
                  prev.filter(
                    (x) =>
                      x.key !== `recv:${remotePeerId}:pending` &&
                      x.key !== `recv:${remotePeerId}:${pending.id}` &&
                      !(x.direction === "receive" && x.peerId === remotePeerId && x.fileId === pending.id)
                  )
                );
              } else if (cancelId) {
                setFileTransfers((prev) =>
                  prev.filter((x) => !(x.direction === "receive" && x.peerId === remotePeerId && x.fileId === cancelId))
                );
              }
            }
          } catch {
            // игнор
          }
          return;
        }

        const buf = ev.data as ArrayBuffer;
        const s = incomingFileRef.current.get(remotePeerId);
        if (!s) return;
        s.chunks.push(buf);
        s.received += buf.byteLength;
        const recvKey = `recv:${remotePeerId}:${s.id}`;
        const recvPercent = s.size > 0 ? Math.min(100, Math.round((s.received / s.size) * 100)) : 0;
        upsertFileTransfer(
          {
            key: recvKey,
            direction: "receive",
            peerId: remotePeerId,
            fileId: s.id,
            fileName: s.name,
            transferred: s.received,
            total: s.size,
            percent: recvPercent
          },
          { force: s.received >= s.size }
        );
        if (s.received >= s.size) {
          incomingFileRef.current.delete(remotePeerId);
          setFileTransfers((prev) => prev.filter((x) => x.key !== `recv:${remotePeerId}:pending`));
          removeFileTransfer(recvKey);
          const blob = new Blob(s.chunks, { type: s.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          fileUrlByIdRef.current.set(s.id, url);

          let previewDataUrl: string | undefined;
          try {
            previewDataUrl = await createFilePreviewDataUrl(blob, { mime: s.mime, name: s.name });
          } catch {
            // Игнорируем ошибки превью
          }

          if (profile) {
            // Определяем scope из текущего состояния
            const currentScope = call?.mode === "room" ? { type: "room" as const, roomId: call.roomId } : call?.mode === "direct" ? { type: "direct" as const, peerId: remotePeerId } : { type: "direct" as const, peerId: remotePeerId };
            const attachment: ChatAttachment = previewDataUrl
              ? isVideoAttachmentMime(s.mime, s.name)
                ? { kind: "video", fileId: s.id, name: s.name, size: s.size, mime: s.mime, previewDataUrl }
                : s.mime && s.mime.startsWith("image/")
                  ? { kind: "image", fileId: s.id, name: s.name, size: s.size, mime: s.mime, previewDataUrl }
                  : { kind: "file", fileId: s.id, name: s.name, size: s.size, mime: s.mime, previewDataUrl }
              : { kind: "file", fileId: s.id, name: s.name, size: s.size, mime: s.mime };
            const m: ChatMessage = {
              id: s.id, // Use file ID as message ID to prevent duplicates
              scope: currentScope,
              fromPeerId: remotePeerId,
              fromUserName: remoteUserName,
              sentAt: Date.now(),
              text: `Файл: ${s.name} (${Math.round(s.size / 1024)} KB)`,
              attachment
            };
            setChats((prev) => {
              // Защита от дублей по message ID
              if (prev.some((msg) => msg.id === m.id)) return prev;
              return [...prev, m];
            });
            window.lokameet.chat.append(m).catch(() => undefined);
          }
        }
      };
      dc.onclose = () => {
        if (dcsRef.current.get(remotePeerId) === dc) dcsRef.current.delete(remotePeerId);
      };
    };

    pc.ondatachannel = (e) => setupDataChannel(e.channel);
    if (opts.initiator) {
      const dc = pc.createDataChannel("lokameet");
      setupDataChannel(dc);
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const json = e.candidate.toJSON() as any;
      if (!shouldSendIceCandidate(remotePeerId, json)) return;
      void sendRtc({
        type: "rtc-ice",
        roomId: opts.roomId,
        fromPeerId: me,
        toPeerId: remotePeerId,
        candidate: json
      });
    };

    pc.ontrack = (e) => {
      const incoming = e.streams[0] ?? null;
      const prev = remoteRef.current.get(remotePeerId);
      const track = e.track;
      track.onunmute = () => {
        // После replaceTrack(null)/mute трек могли убрать из MediaStream (prune).
        // replaceTrack(screen|camera) не шлёт новый ontrack — возвращаем трек в stream.
        const remote = remoteRef.current.get(remotePeerId);
        if (remote && !remote.stream.getTracks().some((t) => t.id === track.id)) {
          try {
            remote.stream.addTrack(track);
          } catch {
            // игнор
          }
        }
        refreshRemotePeerVideo(remotePeerId);
      };
      track.onmute = () => {
        refreshRemotePeerVideo(remotePeerId);
      };
      
      // Отслеживать изменения состояния треков для обновления UI
      const updateRemoteTracks = () => {
        setRemoteTracks(Array.from(remoteRef.current.values()));
      };
      
      // Создаем прокси для отслеживания изменения enabled
      let lastEnabled = track.enabled;
      const updateCheck = () => {
        if (track.enabled !== lastEnabled) {
          lastEnabled = track.enabled;
          updateRemoteTracks();
        }
      };
      
      // Отслеживаем изменения enabled через polling (WebRTC треки не имеют событий для этого)
      const enabledCheckInterval = setInterval(() => {
        if (track.readyState === "ended") {
          clearInterval(enabledCheckInterval);
          updateRemoteTracks();
          return;
        }
        updateCheck();
      }, 1000);
      
      track.onended = () => {
        clearInterval(enabledCheckInterval);
        const remote = remoteRef.current.get(remotePeerId);
        if (remote) {
          try {
            remote.stream.removeTrack(track);
          } catch {
            // игнор
          }
          refreshRemotePeerVideo(remotePeerId);
        } else {
          updateRemoteTracks();
        }
      };
      
      if (incoming) {
        // Пир может слать screen audio отдельным MediaStream. Держим один
        // агрегированный stream на пира, чтобы audio-only не вытеснил
        // поток с активным видео камеры/экрана.
        if (!prev) {
          remoteRef.current.set(remotePeerId, { peerId: remotePeerId, userName: remoteUserName, stream: incoming });
          setRemoteTracks(Array.from(remoteRef.current.values()));
        } else {
          if (track.kind === "video") {
            for (const old of prev.stream.getVideoTracks()) {
              if (old.id !== track.id && old.readyState === "ended") {
                try {
                  prev.stream.removeTrack(old);
                } catch {
                  // игнор
                }
              }
            }
          }
          // Убеждаемся, что трек есть на stream.
          if (!prev.stream.getTracks().some((t) => t.id === track.id)) {
            try {
              prev.stream.addTrack(track);
              updateRemoteTracks();
            } catch {
              // игнор
            }
          }
          if (track.kind === "video") {
            refreshRemotePeerVideo(remotePeerId);
          }
        }
        return;
      }

      // Fallback: в event нет stream — один MediaStream на пира, добавляем треки в него.
      if (prev) {
        if (track.kind === "video") {
          for (const old of prev.stream.getVideoTracks()) {
            if (old.id !== track.id && old.readyState === "ended") {
              try {
                prev.stream.removeTrack(old);
              } catch {
                // игнор
              }
            }
          }
        }
        if (!prev.stream.getTracks().some((t) => t.id === track.id)) {
          try {
            prev.stream.addTrack(track);
            updateRemoteTracks();
          } catch {
            // игнор
          }
        }
        if (track.kind === "video") {
          refreshRemotePeerVideo(remotePeerId);
        }
      } else {
        const s = new MediaStream([track]);
        remoteRef.current.set(remotePeerId, { peerId: remotePeerId, userName: remoteUserName, stream: s });
        setRemoteTracks(Array.from(remoteRef.current.values()));
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") {
        handleUnexpectedDirectDisconnect(remotePeerId);
        closePeer(remotePeerId);
        return;
      }
      // "disconnected" на Windows часто временный — не рвём звонок сразу.
      if (st === "disconnected") {
        if (disconnectTimersRef.current.has(remotePeerId)) return;
        const id = window.setTimeout(() => {
          const pcNow = pcsRef.current.get(remotePeerId);
          if (pcNow && pcNow.connectionState === "disconnected") {
            handleUnexpectedDirectDisconnect(remotePeerId);
            closePeer(remotePeerId);
          }
          disconnectTimersRef.current.delete(remotePeerId);
        }, 8000);
        disconnectTimersRef.current.set(remotePeerId, id);
        return;
      }
      const t = disconnectTimersRef.current.get(remotePeerId);
      if (t) {
        window.clearTimeout(t);
        disconnectTimersRef.current.delete(remotePeerId);
      }
    };

    if (opts.initiator) {
      // КРИТИЧЕСКИ ВАЖНО: убеждаемся что все треки добавлены перед createOffer
      // Треки уже добавлены выше при создании соединения, но проверим еще раз
      const local = localStreamRef.current;
      if (local) {
        const tracksBefore = pc.getSenders().length;
        for (const track of local.getTracks()) {
          if (track.readyState === "live") {
            const existingSender = pc.getSenders().find(s => s.track === track);
            if (!existingSender) {
              try {
                pc.addTrack(track, local);
                void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "Added track before createOffer", data: { remotePeerId, trackId: track.id, kind: track.kind } });
              } catch (err) {
                void window.lokameet.log.write({ level: "WARN", scope: "renderer/webrtc", msg: "Failed to add track before createOffer", data: { remotePeerId, trackId: track.id, kind: track.kind, error: String(err) } });
              }
            }
          }
        }
        const tracksAfter = pc.getSenders().length;
        void window.lokameet.log.write({ level: "INFO", scope: "renderer/webrtc", msg: "Tracks before createOffer", data: { remotePeerId, tracksBefore, tracksAfter } });
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendRtc({
        type: "rtc-offer",
        roomId: opts.roomId,
        fromPeerId: me,
        toPeerId: remotePeerId,
        sdp: { type: offer.type, sdp: offer.sdp ?? undefined }
      });
    }

    return pc;
  }

  function closePeer(remotePeerId: string) {
    const t = disconnectTimersRef.current.get(remotePeerId);
    if (t) {
      window.clearTimeout(t);
      disconnectTimersRef.current.delete(remotePeerId);
    }
    const pc = pcsRef.current.get(remotePeerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // игнор
      }
    }
    pcsRef.current.delete(remotePeerId);
    const dc = dcsRef.current.get(remotePeerId);
    if (dc) {
      try {
        dc.close();
      } catch {
        // игнор
      }
    }
    dcsRef.current.delete(remotePeerId);
    remoteRef.current.delete(remotePeerId);
    setRemoteTracks(Array.from(remoteRef.current.values()));
  }

  function handleUnexpectedDirectDisconnect(remotePeerId: string) {
    if (intentionalPeerDisconnectsRef.current.has(remotePeerId)) return;
    const activeCall = callRef.current;
    if (!profile || activeCall?.mode !== "direct" || activeCall.peerId !== remotePeerId) return;
    appendSystemChatStatus(
      { type: "direct", peerId: remotePeerId },
      remotePeerId,
      activeCall.peerName,
      t("chatStatusLeft")
    );
    setConferenceCall(null);
    setCallStartedAt(null);
    stopLocalMedia();
  }

  async function startDirectCall(p: PeerInfo) {
    if (!profile) return;
    if (call) await leaveCall();
    setError(null);
    setSelectedRoom(null);
    setSelectedPeer(p);
    stopAllPeerConnections();
    intentionalPeerDisconnectsRef.current.delete(p.peerId);
    setCall({ mode: "direct", peerId: p.peerId, peerName: p.userName, signalHubPeerId: p.peerId, signalHubHost: p.host, signalHubPort: p.port });
    void window.lokameet.log.write({ level: "INFO", scope: "renderer/call", msg: "startDirectCall", data: { host: p.host, port: p.port, peerId: p.peerId } });
    // Воспроизводим звук для звонящего
    playNotificationSound(callerSoundFile, callerSoundVolume);
    markPendingCall(p.peerId);
    try {
      await window.lokameet.net.connect(p.host, p.port);
      await window.lokameet.net.sendToPeer(p.peerId, { type: "direct-call-request", fromPeerId: profile.peerId, fromUserName: profile.userName });
    } catch {
      clearPendingCall(p.peerId);
      setError(t("inviteSendFailed"));
    }
  }

  function appendSystemChatStatus(scope: ChatScope, fromPeerId: string, fromUserName: string, text: string) {
    const message: ChatMessage = { id: crypto.randomUUID(), scope, fromPeerId, fromUserName, sentAt: Date.now(), text, kind: "system" };
    setChats((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    void window.lokameet.chat.append(message).catch(() => undefined);
    return message;
  }

  async function sendChatStatus(scope: ChatScope, text: string) {
    if (!profile) return;
    const message = appendSystemChatStatus(scope, profile.peerId, profile.userName, text);
    const env: WsEnvelope = { type: "chat-message", message };

    if (scope.type === "direct") {
      await ensureDirectSignaling(scope.peerId).catch(() => undefined);
      await window.lokameet.net.sendToPeer(scope.peerId, env).catch(() => undefined);
      return;
    }

    const activeCall = callRef.current;
    if (activeCall?.mode !== "room" || activeCall.roomId !== scope.roomId) return;
    if (activeCall.hostPeerId === profile.peerId) {
      await Promise.all(
        activeCall.participants
          .filter((participant) => participant.peerId !== profile.peerId)
          .map((participant) => window.lokameet.net.sendToPeer(participant.peerId, env).catch(() => undefined))
      );
    } else {
      await sendToHub(env).catch(() => undefined);
    }
  }

  async function sendDirectChatStatus(peerId: string, text: string) {
    await sendChatStatus({ type: "direct", peerId }, text);
  }

  function selectPeerForChat(peer: PeerInfo) {
    const hadMessageIndicator = peerActionIndicators.get(peer.peerId) === "message";
    // Сразу снимаем рамку индикатора при клике «Написать» / по карточке.
    clearPeerAction(peer.peerId);
    if (hadMessageIndicator) {
      void sendDirectChatStatus(peer.peerId, t("chatStatusOpened"));
    }
    setSelectedRoom(null);
    setSelectedPeer(peer);
    setSearch("");
    setUnreadPeerIds((current) => {
      if (!current.has(peer.peerId)) return current;
      const next = new Set(current);
      next.delete(peer.peerId);
      return next;
    });
    setUnreadMessageIds((current) => {
      const next = new Set(current);
      for (const message of chats) {
        if (message.fromPeerId === peer.peerId) next.delete(message.id);
      }
      return next;
    });
  }

  async function acceptIncoming() {
    if (!incomingCall || !profile) return;
    if (call) await leaveCall();
    // Очищаем таймеры входящего звонка
    if (incomingCallTimerRef.current) {
      clearInterval(incomingCallTimerRef.current);
      incomingCallTimerRef.current = null;
    }
    if (incomingCallSoundIntervalRef.current) {
      clearInterval(incomingCallSoundIntervalRef.current);
      incomingCallSoundIntervalRef.current = null;
    }
    if (incomingCallTimeoutRef.current) {
      clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = null;
    }
    setIncomingCall(null);
    setIncomingCallBlink(false);
    stopAllPeerConnections();
    // Входящий звонок уже значит, что у caller есть signaling к нам.
    // Accept без resolve host/port (mDNS может быть заблокирован).
    const peerId = incomingCall.peerId;
    clearPeerAction(peerId);
    await sendDirectChatStatus(peerId, t("chatStatusCallAccepted"));
    const p = peers.find((x) => x.peerId === peerId) ?? manualPeers.find((x) => x.peerId === peerId) ?? null;
    const peerName = p?.userName ?? incomingCall.userName ?? "Peer";
    setCallStartedAt(Date.now());
    if (autoSwitchToChat) {
      setSelectedRoom(null);
      if (p) setSelectedPeer(p);
      setSearch("");
    }
    intentionalPeerDisconnectsRef.current.delete(peerId);
    setCall({ mode: "direct", peerId, peerName, signalHubPeerId: peerId, signalHubHost: p?.host, signalHubPort: p?.port });
    // Воспроизводим звук установки соединения для принимающего звонок
    playNotificationSound(connectionSoundFile);
    await window.lokameet.net.sendToPeer(peerId, { type: "direct-call-accept", fromPeerId: profile.peerId });
    await ensureLocalMedia();
    await ensureAudioTrackPresent().catch(() => undefined);
    await ensureVideoTrackPresent().catch(() => undefined);
    // Принимающая сторона ждёт offer.
  }

  async function rejectIncoming() {
    if (!incomingCall || !profile) return;
    // Очищаем таймеры входящего звонка
    if (incomingCallTimerRef.current) {
      clearInterval(incomingCallTimerRef.current);
      incomingCallTimerRef.current = null;
    }
    if (incomingCallSoundIntervalRef.current) {
      clearInterval(incomingCallSoundIntervalRef.current);
      incomingCallSoundIntervalRef.current = null;
    }
    if (incomingCallTimeoutRef.current) {
      clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = null;
    }
    const peerId = incomingCall.peerId;
    setIncomingCall(null);
    setIncomingCallBlink(false);
    await sendDirectChatStatus(peerId, t("chatStatusCallRejected"));
    await window.lokameet.net.sendToPeer(peerId, { type: "direct-call-reject", fromPeerId: profile.peerId, reason: "user-reject" });
  }

  function clearIncomingRoomInviteUi() {
    if (incomingRoomInviteTimerRef.current) {
      clearInterval(incomingRoomInviteTimerRef.current);
      incomingRoomInviteTimerRef.current = null;
    }
    if (incomingRoomInviteTimeoutRef.current) {
      clearTimeout(incomingRoomInviteTimeoutRef.current);
      incomingRoomInviteTimeoutRef.current = null;
    }
    setIncomingRoomInvite(null);
    setIncomingRoomInviteBlink(false);
  }

  function clearPendingInvite(peerId: string) {
    const existing = pendingInviteTimeoutRef.current.get(peerId);
    if (existing) {
      clearTimeout(existing);
      pendingInviteTimeoutRef.current.delete(peerId);
    }
    setPendingInvitePeerIds((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Set(prev);
      next.delete(peerId);
      return next;
    });
  }

  function markPendingInvite(peerId: string) {
    const existing = pendingInviteTimeoutRef.current.get(peerId);
    if (existing) clearTimeout(existing);
    setPendingInvitePeerIds((prev) => {
      const next = new Set(prev);
      next.add(peerId);
      return next;
    });
    const timeoutId = window.setTimeout(() => {
      clearPendingInvite(peerId);
    }, 30000);
    pendingInviteTimeoutRef.current.set(peerId, timeoutId);
  }

  function clearPendingCall(peerId: string) {
    const existing = pendingCallTimeoutRef.current.get(peerId);
    if (existing) {
      clearTimeout(existing);
      pendingCallTimeoutRef.current.delete(peerId);
    }
    setPendingCallPeerIds((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Set(prev);
      next.delete(peerId);
      return next;
    });
  }

  function markPendingCall(peerId: string) {
    const existing = pendingCallTimeoutRef.current.get(peerId);
    if (existing) clearTimeout(existing);
    setPendingCallPeerIds((prev) => {
      const next = new Set(prev);
      next.add(peerId);
      return next;
    });
    const timeoutId = window.setTimeout(() => {
      clearPendingCall(peerId);
    }, 30000);
    pendingCallTimeoutRef.current.set(peerId, timeoutId);
  }

  function markPeerAction(peerId: string, action: "message" | "call") {
    const existing = peerActionFlashTimeoutRef.current.get(peerId);
    if (existing) clearTimeout(existing);

    setPeerActionIndicators((prev) => {
      const next = new Map(prev);
      next.set(peerId, action);
      return next;
    });
    setFlashingPeerActionIds((prev) => new Set(prev).add(peerId));

    const timeoutId = window.setTimeout(() => {
      peerActionFlashTimeoutRef.current.delete(peerId);
      setFlashingPeerActionIds((prev) => {
        if (!prev.has(peerId)) return prev;
        const next = new Set(prev);
        next.delete(peerId);
        return next;
      });
    }, 3000);
    peerActionFlashTimeoutRef.current.set(peerId, timeoutId);
  }

  function clearPeerAction(peerId: string) {
    const existing = peerActionFlashTimeoutRef.current.get(peerId);
    if (existing) {
      clearTimeout(existing);
      peerActionFlashTimeoutRef.current.delete(peerId);
    }
    setPeerActionIndicators((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    setFlashingPeerActionIds((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Set(prev);
      next.delete(peerId);
      return next;
    });
  }

  async function invitePeerToConference(p: PeerInfo) {
    if (!profile || !isConferenceCall(call)) return;
    if (p.status !== "online") {
      setError(t("invitePeerNotOnline"));
      return;
    }
    if (call.participants.some((x) => x.peerId === p.peerId)) {
      setError(t("invitePeerAlreadyInRoom"));
      return;
    }
    const host =
      call.signalHubHost ??
      (call.hostPeerId === profile.peerId ? localIps[0] : undefined) ??
      peers.find((x) => x.peerId === call.hostPeerId)?.host ??
      manualPeers.find((x) => x.peerId === call.hostPeerId)?.host;
    const port =
      call.signalHubPort ??
      (call.hostPeerId === profile.peerId ? signalingPort : undefined) ??
      peers.find((x) => x.peerId === call.hostPeerId)?.port ??
      manualPeers.find((x) => x.peerId === call.hostPeerId)?.port;
    if (!host || !port) {
      setError(t("inviteMissingHost"));
      return;
    }
    setError(null);
    const env: WsEnvelope = {
      type: "room-invite",
      fromPeerId: profile.peerId,
      fromUserName: profile.userName,
      roomId: call.roomId,
      roomName: call.roomName,
      hostPeerId: call.hostPeerId,
      host,
      port,
      hasPassword: Boolean(call.hasPassword),
      maxParticipants: MAX_CONFERENCE_PARTICIPANTS,
      participantsApprox: call.participants.length
    };
    try {
      await window.lokameet.net.connect(p.host, p.port);
      const ok = await window.lokameet.net.sendToPeer(p.peerId, env);
      if (!ok) {
        setError(t("inviteSendFailed"));
        return;
      }
      markPendingInvite(p.peerId);
      playNotificationSound(callerSoundFile, callerSoundVolume);
    } catch {
      setError(t("inviteSendFailed"));
    }
  }

  async function acceptRoomInvite() {
    if (!incomingRoomInvite || !profile) return;
    const invite = incomingRoomInvite;
    clearIncomingRoomInviteUi();
    if (call) await leaveCall();
    const joinCheck = canJoinConference(invite.room);
    if (!joinCheck.ok) {
      setError(conferenceRejectMessage(joinCheck.reason, t));
      return;
    }
    setError(null);
    stopAllPeerConnections();
    setConferenceCall(null);
    setSelectedPeer(null);
    setSelectedRoom(invite.room);
    lastJoinRoomRef.current = invite.room;
    await window.lokameet.net.connect(invite.room.host, invite.room.port).catch(() => undefined);
    setRoomJoinTarget(invite.room);
    setRoomJoinPassDraft("");
    setRoomJoinFromInvite({ fromUserName: invite.fromUserName });
    setRoomJoinPassOpen(true);
  }

  async function rejectRoomInvite() {
    if (!incomingRoomInvite || !profile) return;
    const invite = incomingRoomInvite;
    clearIncomingRoomInviteUi();
    const peer =
      peers.find((x) => x.peerId === invite.fromPeerId) ?? manualPeers.find((x) => x.peerId === invite.fromPeerId);
    try {
      if (peer) await window.lokameet.net.connect(peer.host, peer.port).catch(() => undefined);
      await window.lokameet.net.sendToPeer(invite.fromPeerId, {
        type: "room-invite-reject",
        fromPeerId: profile.peerId,
        fromUserName: profile.userName,
        roomId: invite.room.roomId,
        roomName: invite.room.roomName
      });
    } catch {
      // игнор
    }
  }

  async function createRoom() {
    if (!profile) return;
    if (isDirectCall(call)) {
      setError(t("conferenceBusyDirect"));
      return;
    }
    setRoomNameDraft(`${profile.userName}'s room`);
    setRoomPassDraft("");
    setRoomDialogOpen(true);
  }

  async function confirmCreateRoom() {
    if (!profile) return;
    if (isDirectCall(call)) {
      setError(t("conferenceBusyDirect"));
      return;
    }
    const name = roomNameDraft.trim();
    if (!name) return;
    const pass = roomPassDraft.trim() ? roomPassDraft : undefined;
    const room = await window.lokameet.room.create({
      roomName: name,
      maxParticipants: MAX_CONFERENCE_PARTICIPANTS,
      password: pass
    });
    setSelectedPeer(null);
    setSelectedRoom(null);
    stopAllPeerConnections();
    setConferenceCall(
      createHostConferenceState({
        roomId: room.roomId,
        roomName: room.roomName,
        hostPeerId: profile.peerId,
        participants: Array.from(room.participants.values()),
        hasPassword: Boolean(pass),
        signalHubHost: localIps[0],
        signalHubPort: signalingPort
      })
    );
    setCallStartedAt(Date.now());
    appendSystemChatStatus(
      { type: "room", roomId: room.roomId },
      profile.peerId,
      profile.userName,
      t("chatStatusCreatedConference")
    );
    await ensureLocalMedia();
    await ensureAudioTrackPresent().catch(() => undefined);
    await ensureVideoTrackPresent().catch(() => undefined);
  }

  async function joinRoom(r: RoomInfo) {
    if (!profile) return;
    if (call) await leaveCall();
    const joinCheck = canJoinConference(r);
    if (!joinCheck.ok) {
      setError(conferenceRejectMessage(joinCheck.reason, t));
      return;
    }
    setError(null);
    stopAllPeerConnections();
    setConferenceCall(null);
    setSelectedPeer(null);
    setSelectedRoom(r);
    lastJoinRoomRef.current = r;
    joiningRoomFromInviteRef.current = false;
    await window.lokameet.net.connect(r.host, r.port);
    if (r.hasPassword) {
      setRoomJoinTarget(r);
      setRoomJoinPassDraft("");
      setRoomJoinFromInvite(null);
      setRoomJoinPassOpen(true);
      return;
    }
    await window.lokameet.net.sendToPeer(r.hostPeerId, { type: "room-join", roomId: r.roomId, peerId: profile.peerId, userName: profile.userName });
  }

  async function confirmJoinRoom() {
    if (!profile || !roomJoinTarget) return;
    const r = roomJoinTarget;
    const joinCheck = canJoinConference(r);
    if (!joinCheck.ok) {
      setError(conferenceRejectMessage(joinCheck.reason, t));
      setRoomJoinPassOpen(false);
      setRoomJoinTarget(null);
      setRoomJoinFromInvite(null);
      return;
    }
    setRoomJoinPassOpen(false);
    lastJoinRoomRef.current = r;
    joiningRoomFromInviteRef.current = Boolean(roomJoinFromInvite);
    setRoomJoinFromInvite(null);
    await window.lokameet.net.connect(r.host, r.port).catch(() => undefined);
    await window.lokameet.net.sendToPeer(r.hostPeerId, {
      type: "room-join",
      roomId: r.roomId,
      peerId: profile.peerId,
      userName: profile.userName,
      password: r.hasPassword ? roomJoinPassDraft : undefined
    });
  }

  async function leaveCall() {
    const activeCall = callRef.current;
    void window.lokameet.log.write({
      level: "INFO",
      scope: "renderer/call",
      msg: "leaveCall",
      data: activeCall
        ? { mode: activeCall.mode, peerId: "peerId" in activeCall ? activeCall.peerId : undefined, roomId: "roomId" in activeCall ? activeCall.roomId : undefined }
        : { mode: "none" }
    });
    await stopCallRecording().catch(() => undefined);
    setRemoteRecordings([]);
    if (activeCall?.mode === "direct") {
      clearPendingCall(activeCall.peerId);
      intentionalPeerDisconnectsRef.current.add(activeCall.peerId);
    }
    if (isSharing && isScreenShareCall(activeCall) && profile) {
      await broadcastScreenShareSignal({ type: "screen-share-stop" }).catch(() => undefined);
    }
    if (activeCall?.mode === "direct" && profile) {
      await sendDirectChatStatus(activeCall.peerId, t("chatStatusLeft"));
    }
    if (activeCall?.mode === "room" && profile) {
      if (activeCall.hostPeerId === profile.peerId) {
        await window.lokameet.room.close(activeCall.roomId);
      } else {
        await window.lokameet.net
          .sendToPeer(activeCall.signalHubPeerId, {
            type: "room-leave",
            roomId: activeCall.roomId,
            peerId: profile.peerId
          })
          .catch(() => undefined);
      }
    }
    stopAllPeerConnections();
    setConferenceCall(null);
    setCallStartedAt(null);
    stopLocalMedia();
  }

  async function setTheme(theme: UserProfile["theme"]) {
    if (!profile) return;
    document.documentElement.dataset.theme = theme;
    const updated = await window.lokameet.app.updateProfile({ theme });
    setProfile(updated);
  }

  function avatarPositionFor(peerId: string) {
    if (profile?.peerId === peerId) return profile.avatarPosition;
    return peers.find((peer) => peer.peerId === peerId)?.avatarPosition ?? manualPeers.find((peer) => peer.peerId === peerId)?.avatarPosition;
  }

  async function setAvatarPosition(axis: "x" | "y" | "zoom", value: number) {
    if (!profile) return;
    const current = profile.avatarPosition ?? { x: 50, y: 50, zoom: 100 };
    const clamped =
      axis === "zoom" ? Math.max(100, Math.min(300, value)) : Math.max(0, Math.min(100, value));
    const avatarPosition: AvatarPosition = { ...current, zoom: current.zoom ?? 100, [axis]: clamped };
    setProfile({ ...profile, avatarPosition });
    try {
      const updated = await window.lokameet.app.updateProfile({ avatarPosition });
      setProfile(updated);
    } catch {
      setError(t("errAvatarPosition"));
    }
  }

  async function chooseAvatar() {
    if (!profile) return;
    const sourcePath = await window.lokameet.app.showOpenDialog({
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }]
    });
    if (!sourcePath) return;
    try {
      const avatar = await window.lokameet.avatar.saveFromPath(sourcePath);
      setProfile({ ...profile, avatarHash: avatar.avatarHash });
      setAvatarUrls((current) => ({ ...current, [profile.peerId]: avatar.dataUrl }));
    } catch (err) {
      setError(`Не удалось сохранить аватар: ${String((err as Error).message ?? err)}`);
    }
  }

  async function removeAvatar() {
    if (!profile) return;
    try {
      await window.lokameet.avatar.remove();
      setProfile({ ...profile, avatarHash: undefined });
      setAvatarUrls((current) => {
        const next = { ...current };
        delete next[profile.peerId];
        return next;
      });
    } catch (err) {
      setError(`Не удалось удалить аватар: ${String((err as Error).message ?? err)}`);
    }
  }

  async function updateStatus(status: AvailabilityStatus) {
    if (!profile) return;
    autoAwayAppliedRef.current = false;
    lastActivityRef.current = Date.now();
    const updated = await window.lokameet.app.updateProfile({ status });
    setProfile(updated);
  }

  async function updateName() {
    if (!profile) return;
    setPendingName(profile.userName);
    setPendingStatus(
      profile.status === "in_call" || profile.status === "in_conference" ? "online" : profile.status
    );
    setNameDialogExitsApp(false);
    setNameDialogOpen(true);
  }

  async function toggleLanguage() {
    if (!profile) return;
    const next = profile.language === "ru" ? "en" : "ru";
    await i18n.changeLanguage(next);
    document.documentElement.lang = next;
    const updated = await window.lokameet.app.updateProfile({ language: next });
    setProfile(updated);
  }

  function upsertFileTransfer(item: FileTransferItem, opts?: { force?: boolean }) {
    const now = Date.now();
    const last = fileTransferUiThrottleRef.current.get(item.key) ?? 0;
    if (!opts?.force && item.percent < 100 && now - last < 80) return;
    fileTransferUiThrottleRef.current.set(item.key, now);
    setFileTransfers((prev) => {
      const idx = prev.findIndex((x) => x.key === item.key);
      if (idx === -1) return [...prev, item];
      const next = prev.slice();
      next[idx] = item;
      return next;
    });
  }

  function removeFileTransfer(key: string, delayMs = 900) {
    fileTransferUiThrottleRef.current.delete(key);
    window.setTimeout(() => {
      setFileTransfers((prev) => prev.filter((x) => x.key !== key));
    }, delayMs);
  }

  async function sendChat(text: string) {
    if (!profile || !scope || !text.trim()) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      scope,
      fromPeerId: profile.peerId,
      fromUserName: profile.userName,
      sentAt: Date.now(),
      text: text.trim()
    };

    setChats((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    await window.lokameet.chat.append(msg);

    const env: WsEnvelope = { type: "chat-message", message: msg };
    if (call) {
      if (call.mode === "room") {
        // Хост рассылает напрямую всем участникам
        if (call.hostPeerId === profile.peerId) {
          // Хост шлёт участникам напрямую (минуя сервер ради эффективности)
          for (const p of call.participants) {
            if (p.peerId === profile.peerId) continue;
            await window.lokameet.net.sendToPeer(p.peerId, env).catch(() => undefined);
          }
        } else {
          // Участник шлёт хосту через hub, хост разошлёт
          await sendToHub(env);
        }
        return;
      }
      // Прямой звонок
      await sendToHub(env);
    } else if (scope.type === "direct") {
      await ensureDirectSignaling(scope.peerId);
      await window.lokameet.net.sendToPeer(scope.peerId, env).catch(() => undefined);
    } else if (scope.type === "room") {
      // Нужно слать хосту (только в звонке). Вне звонка — игнор.
    }
  }

  // Смайлы вставляются в поле ввода (не отправляются сразу).

  async function sendFile(file: File) {
    if (!profile || !scope) return;
    if (!call) {
      setError(t("fileTransferOnlyInCall"));
      return;
    }
    const targets: Array<{ peerId: string; userName: string }> = [];
    if (call.mode === "direct") targets.push({ peerId: call.peerId, userName: call.peerName });
    if (call.mode === "room") {
      for (const p of call.participants) {
        if (p.peerId === profile.peerId) continue;
        targets.push(p);
      }
    }
    if (targets.length === 0) return;

    const fileId = crypto.randomUUID();
    const url = URL.createObjectURL(file);
    fileUrlByIdRef.current.set(fileId, url);
    fileTransferCancelRef.current.delete(fileId);

    let previewDataUrl: string | undefined;
    try {
      previewDataUrl = await createFilePreviewDataUrl(file, { mime: file.type, name: file.name });
    } catch {
      // Игнорируем ошибки превью
    }

    // Отправляем уведомление о передаче файла
    for (const tgt of targets) {
      const dc = dcsRef.current.get(tgt.peerId);
      if (!dc || dc.readyState !== "open") continue;
      try {
        dc.send(JSON.stringify({ t: "file-sending", name: file.name }));
      } catch {
        // Игнорируем ошибки
      }
    }

    const meta = JSON.stringify({ t: "file-meta", id: fileId, name: file.name, size: file.size, mime: file.type });
    const buf = await file.arrayBuffer();
    const chunkSize = 16 * 1024;
    const openTargets = targets.filter((tgt) => {
      const dc = dcsRef.current.get(tgt.peerId);
      return dc && dc.readyState === "open";
    });
    if (openTargets.length === 0) {
      setError(t("fileTransferNoChannel"));
      return;
    }

    const totalBytesAll = buf.byteLength * openTargets.length;
    let sentBytesAll = 0;
    const aggregateKey = `send:${fileId}`;
    upsertFileTransfer(
      {
        key: aggregateKey,
        direction: "send",
        peerId: openTargets.length === 1 ? openTargets[0].peerId : "room",
        fileId,
        fileName: file.name,
        transferred: 0,
        total: totalBytesAll,
        percent: 0
      },
      { force: true }
    );

    let cancelled = false;
    for (const tgt of openTargets) {
      if (fileTransferCancelRef.current.has(fileId)) {
        cancelled = true;
        break;
      }
      const dc = dcsRef.current.get(tgt.peerId);
      if (!dc || dc.readyState !== "open") continue;
      dc.send(meta);
      for (let off = 0; off < buf.byteLength; off += chunkSize) {
        if (fileTransferCancelRef.current.has(fileId)) {
          cancelled = true;
          break;
        }
        const chunk = buf.slice(off, off + chunkSize);
        // простой backpressure
        while (dc.bufferedAmount > 8 * 1024 * 1024) {
          if (fileTransferCancelRef.current.has(fileId)) {
            cancelled = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        if (cancelled || fileTransferCancelRef.current.has(fileId)) {
          cancelled = true;
          break;
        }
        dc.send(chunk);
        sentBytesAll += chunk.byteLength;
        const percent = totalBytesAll > 0 ? Math.min(100, Math.round((sentBytesAll / totalBytesAll) * 100)) : 100;
        upsertFileTransfer({
          key: aggregateKey,
          direction: "send",
          peerId: openTargets.length === 1 ? openTargets[0].peerId : "room",
          fileId,
          fileName: file.name,
          transferred: sentBytesAll,
          total: totalBytesAll,
          percent
        });
        // Даём React отрисовать статус-бар
        if (percent < 100 && sentBytesAll % (chunkSize * 8) < chunkSize) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (cancelled) break;
    }

    if (cancelled || fileTransferCancelRef.current.has(fileId)) {
      fileTransferCancelRef.current.delete(fileId);
      for (const tgt of openTargets) {
        const dc = dcsRef.current.get(tgt.peerId);
        if (!dc || dc.readyState !== "open") continue;
        try {
          dc.send(JSON.stringify({ t: "file-cancel", id: fileId }));
        } catch {
          // игнор
        }
      }
      setFileTransfers((prev) => prev.filter((x) => x.key !== aggregateKey && x.fileId !== fileId));
      fileUrlByIdRef.current.delete(fileId);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // игнор
      }
      return;
    }

    upsertFileTransfer(
      {
        key: aggregateKey,
        direction: "send",
        peerId: openTargets.length === 1 ? openTargets[0].peerId : "room",
        fileId,
        fileName: file.name,
        transferred: totalBytesAll,
        total: totalBytesAll,
        percent: 100
      },
      { force: true }
    );
    removeFileTransfer(aggregateKey);

    const attachment: ChatAttachment = previewDataUrl
      ? isVideoAttachmentMime(file.type, file.name)
        ? { kind: "video", fileId, name: file.name, size: file.size, mime: file.type || undefined, previewDataUrl }
        : file.type && file.type.startsWith("image/")
          ? { kind: "image", fileId, name: file.name, size: file.size, mime: file.type || undefined, previewDataUrl }
          : { kind: "file", fileId, name: file.name, size: file.size, mime: file.type || undefined, previewDataUrl }
      : { kind: "file", fileId, name: file.name, size: file.size, mime: file.type || undefined };
    const m: ChatMessage = {
      id: fileId, // Use fileId as message ID to prevent duplicates
      scope,
      fromPeerId: profile.peerId,
      fromUserName: profile.userName,
      sentAt: Date.now(),
      text: `Файл: ${file.name} (${Math.round(file.size / 1024)} KB)`,
      attachment
    };
    setChats((prev) => {
      // Защита от дублей
      if (prev.some((msg) => msg.id === m.id)) return prev;
      return [...prev, m];
    });
    await window.lokameet.chat.append(m);
    // Дублируем в историю чата: метаданные видны даже если DataChannel упал.
    const env: WsEnvelope = { type: "chat-message", message: m };
    if (call && call.mode === "room") {
      if (call.hostPeerId === profile.peerId) {
        for (const p of call.participants) {
          if (p.peerId === profile.peerId) continue;
          await window.lokameet.net.sendToPeer(p.peerId, env).catch(() => undefined);
        }
      } else {
        await sendToHub(env).catch(() => undefined);
      }
    } else {
      await sendToHub(env).catch(() => undefined);
    }
  }

  function cancelOutgoingFileTransfer(fileId?: string) {
    if (!fileId) return;
    fileTransferCancelRef.current.add(fileId);
    setFileTransfers((prev) => prev.filter((x) => !(x.direction === "send" && x.fileId === fileId)));
    for (const dc of dcsRef.current.values()) {
      if (dc.readyState !== "open") continue;
      try {
        dc.send(JSON.stringify({ t: "file-cancel", id: fileId }));
      } catch {
        // игнор
      }
    }
  }

  async function manualConnect() {
    setError(null);
    const host = manualHost.trim();
    const port = Number(manualPort.trim());
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      setError(t("errBadHostPort"));
      return;
    }
    try {
      void window.lokameet.log.write({ level: "INFO", scope: "renderer/manual", msg: "connect", data: { host, port } });
      const info = await window.lokameet.net.connect(host, port);
      if (info.peerId === profile!.peerId) return;
      const peer: PeerInfo = {
        peerId: info.peerId,
        userName: info.userName || "Peer",
        status: (info.status as any) || "online",
        statusText: info.statusText,
        host,
        port,
        lastSeenAt: Date.now()
      };
      setManualPeers((prev) => {
        const next = prev.filter((p) => p.peerId !== peer.peerId);
        return [peer, ...next];
      });
    } catch (e: any) {
      setError(`Не удалось подключиться: ${String(e?.message ?? e)}`);
      void window.lokameet.log.write({ level: "ERROR", scope: "renderer/manual", msg: "connect failed", data: { host, port, error: String(e?.message ?? e) } });
    }
  }

  const showRemoteScreenShareView = Boolean(
    call && isScreenShareCall(call) && remoteScreenShare && !isSharing && !screenShareViewCollapsed
  );
  const canReturnToScreenShare = Boolean(
    call && isScreenShareCall(call) && remoteScreenShare && !isSharing && screenShareViewCollapsed
  );
  const remoteScreenRawStream = showRemoteScreenShareView
    ? (remoteTracks.find((r) => r.peerId === remoteScreenShare?.peerId)?.stream ?? null)
    : null;
  const remoteScreenTrackSig = remoteScreenRawStream
    ? remoteScreenRawStream
        .getTracks()
        .map((t) => `${t.id}:${t.readyState}:${t.muted}:${t.enabled}`)
        .join("|")
    : "";
  const remoteScreenStream = useMemo(() => {
    if (!remoteScreenRawStream || !remoteScreenShare) return null;
    return createScreenShareViewStream(
      remoteScreenRawStream,
      remoteScreenShare.screenAudioTrackId,
      remoteScreenShare.screenVideoTrackId
    );
  }, [
    remoteScreenRawStream,
    remoteScreenShare?.peerId,
    remoteScreenShare?.screenAudioTrackId,
    remoteScreenShare?.screenVideoTrackId,
    remoteScreenTrackSig
  ]);
  const remotePresenterCameraStream = useMemo(() => {
    if (!remoteScreenRawStream || !remoteScreenShare) return null;
    const cam = findPresenterCameraTrack(remoteScreenRawStream, remoteScreenShare.screenVideoTrackId);
    return cam ? new MediaStream([cam]) : null;
  }, [
    remoteScreenRawStream,
    remoteScreenShare?.peerId,
    remoteScreenShare?.screenVideoTrackId,
    remoteScreenTrackSig
  ]);
  const localPresenterCameraStream = useMemo(() => {
    if (!isSharing || !mediaCfg.videoEnabled) return null;
    const local = localStreamRef.current;
    const screenId = shareTrackRef.current?.id;
    const cam = local?.getVideoTracks().find(
      (t) =>
        t !== shareTrackRef.current &&
        t.readyState === "live" &&
        t.enabled &&
        !isScreenVideoTrack(t, screenId)
    );
    return cam ? new MediaStream([cam]) : null;
  }, [isSharing, mediaCfg.videoEnabled, localStreamVer]);

  if (!bootReady || !profile) {
    const pct = bootProgress;
    const label = t(bootLabel, { defaultValue: t("loading") });
    return (
      <div className="bootSplash" role="status" aria-live="polite" aria-busy="true">
        <div className="bootSplashInner">
          <div className="bootBrand">{t("appName")}</div>
          <div className="bootLabel">{label}</div>
          <div className="bootBarTrack" aria-hidden="true">
            <div className="bootBarFill" style={{ width: `${pct}%` }} />
          </div>
          <div className="bootPct">{pct}%</div>
        </div>
      </div>
    );
  }

  const screenSharingPeerId = isSharing ? profile.peerId : remoteScreenShare?.peerId ?? null;
  const peerIsRecording = (peerId: string) =>
    peerId === profile.peerId ? recordingActive : remoteRecordings.some((item) => item.peerId === peerId);
  const conferenceParticipants =
    call?.mode === "room"
      ? (() => {
          const others = call.participants.filter((p) => p.peerId !== profile.peerId);
          const self =
            call.participants.find((p) => p.peerId === profile.peerId) ?? {
              peerId: profile.peerId,
              userName: profile.userName
            };
          return [self, ...others];
        })()
      : [];

  return (
    <div className={`app${isSettingsWindow ? " is-settings-window" : ""}`}>
      {nameDialogOpen && (
        <Modal title={t("promptYourName")} onClose={closeNameDialog}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input className="btn grow" value={pendingName} onChange={(e) => setPendingName(e.target.value)} placeholder="User" />
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 70 }}>
              {t("status")}
            </div>
            <Select
              className="grow"
              value={pendingStatus}
              onChange={(v) => setPendingStatus(v as AvailabilityStatus)}
              options={[
                { value: "online", label: t("status_online") },
                { value: "away", label: t("status_away") },
                { value: "dnd", label: t("status_dnd") },
                { value: "offline", label: t("status_offline") }
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button
              className="btn btnPrimary"
              onClick={() => {
                const v = pendingName.trim();
                if (!v) return;
                autoAwayAppliedRef.current = false;
                lastActivityRef.current = Date.now();
                window.lokameet.app
                  .updateProfile({ userName: v, hasChosenName: true, status: pendingStatus })
                  .then((p) => setProfile(p))
                  .catch((e) => setError(String(e?.message ?? e)))
                  .finally(() => {
                    setNameDialogExitsApp(false);
                    setNameDialogOpen(false);
                  });
              }}
            >
              OK
            </button>
            <button className="btn" onClick={closeNameDialog}>
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}

      {roomDialogOpen && (
        <Modal title={t("promptConfName")} onClose={() => setRoomDialogOpen(false)}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input className="btn grow" value={roomNameDraft} onChange={(e) => setRoomNameDraft(e.target.value)} placeholder="Room" />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {t("conferenceMaxHint", { max: MAX_CONFERENCE_PARTICIPANTS })}
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            <input className="btn grow" value={roomPassDraft} onChange={(e) => setRoomPassDraft(e.target.value)} placeholder={t("promptPassword")} />
            <button
              className="btn btnPrimary"
              onClick={() => {
                setRoomDialogOpen(false);
                void confirmCreateRoom();
              }}
            >
              OK
            </button>
          </div>
        </Modal>
      )}

      {roomJoinPassOpen && roomJoinTarget && (
        <Modal
          title={roomJoinFromInvite ? t("inviteJoinTitle") : t("promptPasswordEnter")}
          onClose={() => {
            setRoomJoinPassOpen(false);
            setRoomJoinTarget(null);
            setRoomJoinFromInvite(null);
          }}
        >
          {roomJoinFromInvite && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{roomJoinTarget.roomName}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {t("inviteJoinFrom", { name: roomJoinFromInvite.fromUserName })}
              </div>
            </div>
          )}
          {(roomJoinTarget.hasPassword || roomJoinFromInvite) && (
            <div className="row" style={{ flexWrap: "wrap", marginBottom: roomJoinTarget.hasPassword ? 0 : 10 }}>
              {roomJoinTarget.hasPassword ? (
                <input
                  className="btn grow"
                  type="password"
                  value={roomJoinPassDraft}
                  onChange={(e) => setRoomJoinPassDraft(e.target.value)}
                  placeholder={t("promptPasswordEnter")}
                  autoFocus
                />
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>
                  {t("inviteJoinNoPassword")}
                </div>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
            <button
              className="btn"
              onClick={() => {
                setRoomJoinPassOpen(false);
                setRoomJoinTarget(null);
                setRoomJoinFromInvite(null);
              }}
            >
              {t("close")}
            </button>
            <button className="btn btnPrimary grow" onClick={() => void confirmJoinRoom()}>
              {t("join")}
            </button>
          </div>
        </Modal>
      )}

      {screenShareDialogOpen && (
        <Modal
          title={t("screenShareTitle")}
          onClose={() => {
            setScreenShareDialogOpen(false);
          }}
        >
          <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <button
              className={`btn ${screenShareTab === "screen" ? "btnPrimary" : ""}`}
              onClick={() => {
                setScreenShareTab("screen");
                setSelectedScreenSource(null);
              }}
            >
              {t("screenShareFullScreen")}
            </button>
            <button
              className={`btn ${screenShareTab === "window" ? "btnPrimary" : ""}`}
              onClick={() => {
                setScreenShareTab("window");
                setSelectedScreenSource(null);
              }}
            >
              {t("screenShareWindow")}
            </button>
            <button
              className={`btn ${screenShareTab === "app" ? "btnPrimary" : ""}`}
              onClick={() => {
                setScreenShareTab("app");
                setSelectedScreenSource(null);
              }}
            >
              {t("screenShareApp")}
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={screenShareWithAudio}
                onChange={(e) => setScreenShareWithAudio(e.target.checked)}
              />
              <span>{t("screenShareWithAudio")}</span>
            </label>
          </div>

          <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {screenShareTab === "window" ? (
              <div style={{ padding: "12px 0" }}>
                <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
                  {t("screenShareWindowHint")}
                </div>
                <button
                  className="btn btnPrimary"
                  onClick={() => {
                    setScreenShareDialogOpen(false);
                    void startScreenShareWithSource(null, screenShareWithAudio);
                  }}
                >
                  {t("screenSharePickWindow")}
                </button>
              </div>
            ) : (
              <>
                {(screenShareTab === "screen" ? categorizedScreenSources.screens : categorizedScreenSources.apps).length === 0 ? (
                  <div className="muted">{t("screenShareNoSources")}</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                    {(screenShareTab === "screen" ? categorizedScreenSources.screens : categorizedScreenSources.apps).map((source, index) => (
                      <div
                        key={source.id}
                        onClick={() => setSelectedScreenSource(source.id)}
                        style={{
                          border: selectedScreenSource === source.id ? "2px solid #4a9eff" : "2px solid transparent",
                          borderRadius: 8,
                          padding: 8,
                          cursor: "pointer",
                          backgroundColor: selectedScreenSource === source.id ? "rgba(74, 158, 255, 0.1)" : "transparent"
                        }}
                      >
                        {source.thumbnail ? (
                          <img
                            src={source.thumbnail}
                            alt={source.name}
                            style={{ width: "100%", height: "auto", borderRadius: 4, marginBottom: 8 }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : null}
                        <div style={{ fontSize: 12, textAlign: "center", wordBreak: "break-word" }}>
                          {source.name || `Source ${index + 1}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {screenShareTab !== "window" && (
            <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
              <button
                className="btn btnPrimary"
                disabled={!selectedScreenSource}
                onClick={() => {
                  if (!selectedScreenSource) return;
                  setScreenShareDialogOpen(false);
                  void startScreenShareWithSource(selectedScreenSource, screenShareWithAudio);
                }}
              >
                {t("screenShareStart")}
              </button>
              <button className="btn" onClick={() => setScreenShareDialogOpen(false)}>
                {t("close")}
              </button>
            </div>
          )}
        </Modal>
      )}

      <div
        className="app-sidebar-wrap"
        style={{ width: Math.max(360, Math.min(420, sidebarWidth || 380)) }}
      >
        <div className="sidebar">
        <div className="panel">
          <div className="panelHeader profilePanelHeader">
            <div className="profileIdentity">
              <div className="profileIdentityName">
                {profile.userName}
                <PeerShareMarks
                  sharing={screenSharingPeerId === profile.peerId}
                  recording={peerIsRecording(profile.peerId)}
                  shareTitle={t("screenShareIndicator")}
                  recTitle={t("recordingLocal")}
                />
              </div>
              <div className="profileIdentityMeta muted">
                <span className={`badge ${statusBadgeClass(profile.status)}`}>{statusLabel(profile.status)}</span>
                <span>{profile.peerId.slice(0, 8)}</span>
              </div>
            </div>
            <div className="row profileHeaderControls">
              <button className="btn" onClick={() => void updateName()}>
                {t("name")}
              </button>
              <button className="btn" onClick={() => void chooseAvatar()} title={t("chooseAvatar")}>
                {t("avatar")}
              </button>
              {profile.avatarHash && (
                <button className="btn" onClick={() => void removeAvatar()} title={t("removeAvatar")}>
                  ×
                </button>
              )}
              <Select
                className="themeSelect"
                value={profile.theme}
                onChange={(theme) => void setTheme(theme as UserProfile["theme"])}
                aria-label={t("theme")}
                options={[
                  { value: "dark", label: t("theme_dark") },
                  { value: "light", label: t("theme_light") },
                  { value: "warm-dark", label: t("theme_warm-dark") },
                  { value: "soft-light", label: t("theme_soft-light") },
                  { value: "ocean-blue", label: t("theme_ocean-blue") },
                  { value: "ocean-dusk", label: t("theme_ocean-dusk") },
                  { value: "ipd-slate", label: t("theme_ipd-slate") },
                  { value: "ipd-lagoon", label: t("theme_ipd-lagoon") },
                  { value: "ipd-midnight", label: t("theme_ipd-midnight") }
                ]}
              />
              <button
                className="btn"
                onClick={() => {
                  void window.lokameet.settings.open().catch(() => setSettingsOpen(true));
                }}
                title={t("settings")}
              >
                ⚙
              </button>
              <button className="btn" onClick={() => void toggleLanguage()}>
                {profile.language.toUpperCase()}
              </button>
            </div>
          </div>
          <div className="panelBody">
            <div className="row">
              {call ? (
                <span
                  className={`btn grow badge ${statusBadgeClass(call.mode === "room" ? "in_conference" : "in_call")}`}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "default" }}
                >
                  {t(call.mode === "room" ? "status_in_conference" : "status_in_call")}
                </span>
              ) : (
                <Select
                  className="grow"
                  value={profile.status}
                  onChange={(v) => void updateStatus(v as AvailabilityStatus)}
                  options={[
                    { value: "online", label: t("status_online") },
                    { value: "away", label: t("status_away") },
                    { value: "dnd", label: t("status_dnd") },
                    { value: "offline", label: t("status_offline") }
                  ]}
                />
              )}
              <button className="btn btnPrimary" onClick={() => void createRoom()}>
                {t("createConference")}
              </button>
            </div>
            <div className="panelSectionDivider" aria-hidden="true" />
            <div className="sidebarMediaRow">
              <Select
                disabled={videoDevices.length === 0}
                value={selectedVideoDeviceId}
                onChange={(v) => void switchCamera(v)}
                options={
                  videoDevices.length === 0
                    ? [{ value: "", label: t("video") }]
                    : videoDevices.map((d) => ({
                        value: d.deviceId,
                        label: d.label || `Camera ${d.deviceId.slice(0, 6)}`
                      }))
                }
              />
              <Select
                value={mediaCfg.videoQuality}
                onChange={(v) => void applyVideoQuality(v as VideoQuality)}
                style={{ flex: "0 0 auto", minWidth: 86 }}
                options={VIDEO_QUALITY_OPTIONS.map((q) => ({ value: q.value, label: t(q.labelKey) }))}
              />
              <button
                className={`btn btnToggle ${mediaCfg.videoEnabled ? "is-on" : "is-off"}`}
                onClick={async () => {
                  const next = !mediaCfg.videoEnabled;
                  setMediaCfg((c) => ({ ...c, videoEnabled: next }));
                  if (!next) {
                    const local = localStreamRef.current;
                    const stillSharing = Boolean(shareTrackRef.current);
                    if (local && stillSharing) {
                      const screenId = shareTrackRef.current?.id ?? "";
                      for (const pc of pcsRef.current.values()) {
                        detachSecondaryVideoTrack(pc, screenId);
                      }
                      for (const t of [...local.getVideoTracks()]) {
                        if (t === shareTrackRef.current) continue;
                        local.removeTrack(t);
                        try {
                          t.stop();
                        } catch {
                          // игнор
                        }
                      }
                      stopRawCamera();
                    } else if (local && !stillSharing) {
                      for (const pc of pcsRef.current.values()) {
                        replaceVideoTrack(pc, null);
                      }
                      for (const t of [...local.getVideoTracks()]) {
                        local.removeTrack(t);
                        if (isRawCameraTrack(t)) {
                          try {
                            t.stop();
                          } catch {
                            // игнор
                          }
                        }
                      }
                      if (settingsTab !== "camera" || !settingsOpen) stopRawCamera();
                    }
                    await restoreMicAfterCameraChange();
                    setLocalStreamVer((v) => v + 1);
                    syncLocalVideoPreview({ videoEnabled: false });
                    return;
                  }
                  try {
                    let local = localStreamRef.current;
                    if (!local) {
                      local = await ensureLocalMedia();
                    }
                    let camTrack =
                      local.getVideoTracks().find((t) => t !== shareTrackRef.current && t.readyState === "live") ?? null;
                    if (!camTrack) {
                      const liveRaw =
                        cameraRawStreamRef.current?.getVideoTracks().find((t) => t.readyState === "live") ?? null;
                      if (liveRaw) {
                        camTrack = await prepareCameraTrack(liveRaw);
                      } else {
                        const vc = getVideoConstraints(mediaCfg.videoQuality);
                        if (selectedVideoDeviceId) (vc as any).deviceId = { ideal: selectedVideoDeviceId };
                        const cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
                        camTrack = await prepareCameraTrack(cam.getVideoTracks()[0] ?? null);
                      }
                    } else {
                      camTrack.enabled = true;
                    }
                    if (camTrack) {
                      await publishLocalCameraTrack(camTrack, local);
                    }
                    await restoreMicAfterCameraChange();
                    syncLocalVideoPreview({ videoEnabled: true });
                  } catch (err) {
                    setError(t("errCameraEnable", { msg: String((err as Error)?.message ?? err) }));
                    setMediaCfg((c) => ({ ...c, videoEnabled: false }));
                    syncLocalVideoPreview({ videoEnabled: false });
                  }
                }}
              >
                {mediaCfg.videoEnabled ? t("camOn") : t("camOff")}
              </button>
            </div>
            <div className="sidebarMediaToggles">
              <button
                className={`btn btnToggle ${mediaCfg.audioEnabled ? "is-on" : "is-off"}`}
                onClick={() => {
                  const next = !mediaCfg.audioEnabled;
                  setMediaCfg((c) => ({ ...c, audioEnabled: next }));
                  const local = localStreamRef.current;
                  const screenAudioId = shareScreenAudioTrackRef.current?.id;
                  const isScreenAudio = (track: MediaStreamTrack) =>
                    local ? isScreenBroadcastAudioTrack(track, local, screenAudioId) : false;
                  if (!next) {
                    // Только микрофон — не трогаем screen audio
                    if (local) {
                      const mic = getMicAudioTrack(local, screenAudioId);
                      if (mic) mic.enabled = false;
                    }
                    for (const pc of pcsRef.current.values()) {
                      replaceMicAudioTrack(pc, null, isScreenAudio);
                    }
                    return;
                  }
                  void (async () => {
                    await ensureAudioTrackPresent();
                    const stream = localStreamRef.current;
                    if (!stream) return;
                    const mic = getMicAudioTrack(stream, shareScreenAudioTrackRef.current?.id);
                    if (mic) {
                      mic.enabled = true;
                      const check = (track: MediaStreamTrack) =>
                        isScreenBroadcastAudioTrack(track, stream, shareScreenAudioTrackRef.current?.id);
                      for (const pc of pcsRef.current.values()) {
                        replaceMicAudioTrack(pc, mic, check, stream);
                      }
                    }
                  })();
                }}
              >
                {mediaCfg.audioEnabled ? t("micOn") : t("micOff")}
              </button>
              <button 
                className={`btn btnToggle ${isSharing ? "is-on" : "is-off"}`} 
                disabled={!call || !isScreenShareCall(call)} 
                title={!call || !isScreenShareCall(call) ? t("screenShareInCallOnly") : undefined}
                onClick={() => {
                  // Используем void для асинхронных операций, чтобы не блокировать UI
                  if (isSharing) {
                    void (async () => {
                      try {
                        await stopScreenShare();
                      } catch (err) {
                        console.error("Error stopping screen share:", err);
                        const errorMsg = err instanceof Error ? err.message : String(err);
                        setError(t("errScreenShareStop", { msg: errorMsg }));
                      }
                    })();
                  } else {
                    void (async () => {
                      try {
                        await startScreenShare();
                      } catch (err) {
                        console.error("Error starting screen share:", err);
                        const errorMsg = err instanceof Error ? err.message : String(err);
                        setError(t("errScreenShareLaunch", { msg: errorMsg }));
                        // Сбрасываем состояние на случай ошибки
                        try {
                          isSharingRef.current = false;
                          setIsSharing(false);
                          setScreenShareDialogOpen(false);
                        } catch {
                          // Игнорируем ошибки сброса состояния
                        }
                        // Пытаемся логировать, но не падаем если это не работает
                        try {
                          if (window.lokameet?.log?.write) {
                            void window.lokameet.log.write({ level: "ERROR", scope: "renderer/screen", msg: "Error in screen share button click", data: { error: errorMsg } });
                          }
                        } catch {
                          // Игнорируем ошибки логирования
                        }
                      }
                    })();
                  }
                }}
              >
                {isSharing ? t("screenOn") : t("screenOff")}
              </button>
              <button
                className={`btn btnToggle ${recordingActive ? "is-on is-recording" : "is-off"}`}
                disabled={!call}
                onClick={() => void toggleCallRecording()}
                title={!call ? t("recordInCallOnly") : recordingActive ? t("stopRecord") : t("startRecord")}
              >
                {recordingActive ? t("stopRecord") : t("startRecord")}
              </button>
            </div>
          </div>
        </div>

        {incomingRoomInvite && (
          <div
            className="panel"
            style={{
              borderColor: incomingRoomInviteBlink ? "rgba(52,211,153,0.85)" : "rgba(52,211,153,0.35)",
              transition: "border-color 0.3s"
            }}
          >
            <div className="panelHeader">
              <div>{t("incomingRoomInvite")}</div>
              <span className="badge">#{incomingRoomInvite.fromPeerId.slice(0, 6)}</span>
            </div>
            <div className="panelBody">
              <div style={{ fontWeight: 700 }}>{incomingRoomInvite.fromUserName}</div>
              <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                {t("incomingRoomInviteBody", { room: incomingRoomInvite.room.roomName })}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btnPrimary grow" onClick={() => void acceptRoomInvite()}>
                  {t("accept")}
                </button>
                <button className="btn btnDanger grow" onClick={() => void rejectRoomInvite()}>
                  {t("reject")}
                </button>
              </div>
            </div>
          </div>
        )}

        {inviteRejectedNotice && (
          <div className="panel" style={{ borderColor: "rgba(248,113,113,0.35)" }}>
            <div className="panelHeader">
              <div>{t("inviteRejectedTitle")}</div>
              <button className="btn" onClick={() => setInviteRejectedNotice(null)}>
                {t("close")}
              </button>
            </div>
            <div className="panelBody">
              <div className="muted">
                {t("inviteRejectedBody", { name: inviteRejectedNotice.userName, room: inviteRejectedNotice.roomName })}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="panel" style={{ borderColor: "rgba(248,113,113,0.35)" }}>
            <div className="panelHeader">
              <div>{t("error")}</div>
              <button className="btn" onClick={() => setError(null)}>
                {t("close")}
              </button>
            </div>
            <div className="panelBody">
              <div className="muted">{error}</div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panelHeader">
            <div>{t("usersInLan")}</div>
            <span className="badge">{(profile?.hasChosenName ? 1 : 0) + peers.length}</span>
          </div>
          <div className="panelBody">
            <div className="list">
              {profile?.hasChosenName && (
                <div key={profile.peerId} className="item" style={{ cursor: "default" }}>
                  <div className="itemTitle">
                    <div className="truncate" style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }} title={profile.userName}>
                      {avatarUrls[profile.peerId] ? (
                        <span className={`avatarStatusRing avatarStatusRing--${profile.status}`} title={statusLabel(profile.status)}>
                          <ProfileAvatar className="listAvatar" src={avatarUrls[profile.peerId]} name={profile.userName} position={profile.avatarPosition} onClick={() => setAvatarViewer({ peerId: profile.peerId, name: profile.userName })} />
                        </span>
                      ) : (
                        <span className={`avatarStatusRing avatarStatusRing--${profile.status}`} title={statusLabel(profile.status)}>
                          <span className="listAvatar listAvatarPlaceholder" aria-hidden="true" />
                        </span>
                      )}
                      <span className="truncate">
                        {profile.userName} {t("you")}
                      </span>
                      <PeerShareMarks
                        sharing={screenSharingPeerId === profile.peerId}
                        recording={peerIsRecording(profile.peerId)}
                        shareTitle={t("screenShareIndicator")}
                        recTitle={t("recordingLocal")}
                      />
                    </div>
                    <span className={`badge ${statusBadgeClass(profile.status)}`}>{statusLabel(profile.status)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {localIps.length > 0 ? `${localIps[0]}:${signalingPort}` : `port: ${signalingPort}`}
                  </div>
                </div>
              )}
              {peers
                .slice()
                .sort((a, b) => {
                  const aRing = incomingCall?.peerId === a.peerId ? 0 : 1;
                  const bRing = incomingCall?.peerId === b.peerId ? 0 : 1;
                  return aRing - bRing;
                })
                .map((p) => {
                const inConference = isConferenceCall(call);
                const alreadyInRoom = inConference && call.participants.some((x) => x.peerId === p.peerId);
                const canInvite = inConference && p.status === "online" && !alreadyInRoom;
                const invitePending = pendingInvitePeerIds.has(p.peerId);
                const callPending = pendingCallPeerIds.has(p.peerId);
                const peerPending = invitePending;
                const actionIndicator = peerActionIndicators.get(p.peerId);
                const actionIsFlashing = flashingPeerActionIds.has(p.peerId);
                const hasIncomingCall = incomingCall?.peerId === p.peerId;
                return (
                <div
                  key={p.peerId}
                  className={`item${actionIndicator ? ` itemActionIndicator itemActionIndicator--${actionIndicator}${actionIsFlashing ? " is-flashing" : ""}` : peerPending ? " itemInvitePending" : ""}${hasIncomingCall ? " itemIncomingCall" : ""}`}
                  style={
                    hasIncomingCall
                      ? {
                          borderColor: incomingCallBlink ? "rgba(96,165,250,0.9)" : "rgba(96,165,250,0.4)",
                          transition: "border-color 0.3s"
                        }
                      : undefined
                  }
                  onClick={() => selectPeerForChat(p)}
                >
                  <div className="itemTitle">
                    <div
                      className={`truncate${peerPending ? " itemInvitePendingName" : ""}`}
                      style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}
                      title={
                        invitePending
                          ? t("invitePendingHint")
                          : callPending
                            ? t("callPendingHint")
                            : p.userName
                      }
                    >
                      {avatarUrls[p.peerId] ? (
                        <span className={`avatarStatusRing avatarStatusRing--${p.status}`} title={statusLabel(p.status)}>
                          <ProfileAvatar className="listAvatar" src={avatarUrls[p.peerId]} name={p.userName} position={p.avatarPosition} onClick={() => setAvatarViewer({ peerId: p.peerId, name: p.userName })} />
                        </span>
                      ) : (
                        <span className={`avatarStatusRing avatarStatusRing--${p.status}`} title={statusLabel(p.status)}>
                          <span className="listAvatar listAvatarPlaceholder" aria-hidden="true" />
                        </span>
                      )}
                      <span className="truncate">{p.userName}</span>
                      <PeerShareMarks
                        sharing={screenSharingPeerId === p.peerId}
                        recording={peerIsRecording(p.peerId)}
                        shareTitle={t("screenShareIndicator")}
                        recTitle={t("recordingBy", { name: p.userName })}
                      />
                      {unreadPeerIds.has(p.peerId) && <span className="unreadMessageDot" title={t("newMessage")} aria-label={t("newMessage")} />}
                    </div>
                    <span className={`badge ${statusBadgeClass(p.status)}`}>{statusLabel(p.status)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {p.host}:{p.port}
                  </div>
                  {hasIncomingCall ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn btnPrimary grow" onClick={(e) => (e.stopPropagation(), void acceptIncoming())}>
                        {t("accept")}
                      </button>
                      <button className="btn btnDanger grow" onClick={(e) => (e.stopPropagation(), void rejectIncoming())}>
                        {t("reject")}
                      </button>
                    </div>
                  ) : !inConference && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn grow" onClick={(e) => (e.stopPropagation(), selectPeerForChat(p))}>
                        {t("write")}
                      </button>
                      <button className="btn btnPrimary grow" onClick={(e) => (e.stopPropagation(), void startDirectCall(p))}>
                        {t("call")}
                      </button>
                    </div>
                  )}
                  {canInvite && (
                    <div className="row itemHoverActions" style={{ marginTop: 8 }}>
                      <button
                        className="btn btnPrimary grow"
                        onClick={(e) => (e.stopPropagation(), void invitePeerToConference(p))}
                      >
                        {t("inviteToConference")}
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
              {peers.length === 0 && <div className="muted">{t("noUsers")}</div>}
            </div>
          </div>
        </div>

        {call?.mode === "room" && (
          <div className="panel">
            <div className="panelHeader">
              <div>{t("participants")}</div>
              <span className="badge">{conferenceParticipants.length}</span>
            </div>
            <div className="panelBody">
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }} title={call.roomName}>
                {call.roomName}
              </div>
              <div className="list">
                {conferenceParticipants.map((p) => {
                  const isSelf = p.peerId === profile.peerId;
                  return (
                    <div key={p.peerId} className="item" style={{ cursor: "default" }}>
                      <div className="itemTitle">
                        <div className="truncate" style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }} title={p.userName}>
                          <span className="truncate">
                            {p.userName}
                            {isSelf ? ` ${t("you")}` : ""}
                          </span>
                          <PeerShareMarks
                            sharing={screenSharingPeerId === p.peerId}
                            recording={peerIsRecording(p.peerId)}
                            shareTitle={t("screenShareIndicator")}
                            recTitle={isSelf ? t("recordingLocal") : t("recordingBy", { name: p.userName })}
                          />
                        </div>
                        {isSelf ? (
                          <span className={`badge ${statusBadgeClass(profile.status)}`}>{statusLabel(profile.status)}</span>
                        ) : (
                          (() => {
                            const peer = peers.find((x) => x.peerId === p.peerId);
                            return peer ? (
                              <span className={`badge ${statusBadgeClass(peer.status)}`}>{statusLabel(peer.status)}</span>
                            ) : (
                              <span className={`badge ${statusBadgeClass("in_conference")}`}>{statusLabel("in_conference")}</span>
                            );
                          })()
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panelHeader">
            <div>{t("conferences")}</div>
            <span className="badge">{rooms.length}</span>
          </div>
          <div className="panelBody">
            <div className="list">
              {rooms.map((r) => {
                const roomFull = !canJoinConference(r).ok;
                return (
                <div key={r.roomId} className="item" onClick={() => (setSelectedRoom(r), setSelectedPeer(null))}>
                  <div className="itemTitle">
                    <div className="truncate" style={{ fontWeight: 700 }} title={r.roomName}>
                      {r.roomName}
                    </div>
                    <span className="badge">
                      {r.participantsApprox}/{r.maxParticipants} {r.hasPassword ? "🔒" : ""}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    host {r.host}:{r.port}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn btnPrimary grow"
                      disabled={roomFull}
                      title={roomFull ? t("conferenceFull", { max: MAX_CONFERENCE_PARTICIPANTS }) : undefined}
                      onClick={(e) => (e.stopPropagation(), void joinRoom(r))}
                    >
                      {t("join")}
                    </button>
                  </div>
                </div>
              );})}
              {rooms.length === 0 && <div className="muted">{t("noConferences")}</div>}
            </div>
          </div>
        </div>
        </div>
      </div>

      <PanelResizer
        axis="horizontal"
          onDrag={(delta) => setSidebarWidth((w) => Math.max(300, Math.min(420, (w || 340) + delta)))}
      />

      <div className="main-wrap">
        <div className="main-center" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {(recordingActive || remoteRecordings.length > 0) && (
          <div className="recordingBanner" role="status">
            <span className="recordingDot" />
            {recordingActive
              ? t("recordingLocal")
              : t("recordingBy", { name: remoteRecordings.map((item) => item.userName).join(", ") })}
          </div>
        )}
        {showRemoteScreenShareView && remoteScreenShare ? (
          remoteScreenStream ? (
          <ScreenShareViewer
            stream={remoteScreenStream}
            cameraStream={remotePresenterCameraStream}
            broadcasterName={remoteScreenShare.userName}
            controlsHidden={screenViewControlsHidden}
            broadcastMuted={screenBroadcastMuted}
            volume={remoteScreenShareVolume / 100}
            onVolumeChange={(v) => setRemoteScreenShareVolume(Math.round(Math.max(0, Math.min(1, v)) * 100))}
            onToggleBroadcastMute={() => setScreenBroadcastMuted((v) => !v)}
            onHideControls={() => setScreenViewControlsHidden(true)}
            onShowControls={() => setScreenViewControlsHidden(false)}
            onExitToTiles={() => {
              setScreenShareViewCollapsed(true);
              setScreenViewControlsHidden(false);
            }}
          />
          ) : (
            <div className="screenShareView">
              <div className="muted">{t("loading")}</div>
            </div>
          )
        ) : null}
        {canReturnToScreenShare && (
          <button
            type="button"
            className="screenShareReturnBtn"
            title={t("screenShareReturnToView")}
            onClick={() => setScreenShareViewCollapsed(false)}
          >
            {t("screenShareReturnToView")}
          </button>
        )}
        <div
          className="videoGrid"
          data-tile-aspect={tileAspect}
          style={
            showRemoteScreenShareView
              ? {
                  position: "absolute",
                  width: 1,
                  height: 1,
                  overflow: "hidden",
                  opacity: 0,
                  pointerEvents: "none",
                  left: 0,
                  top: 0
                }
              : ({
                  ["--tile-cols" as string]: String(tileGridColumns(1 + remoteTracks.length)),
                  ["--tile-gap" as string]: `${tileGap}px`,
                  ["--tile-radius" as string]: `${tileRadius}px`,
                  ["--tile-fit" as string]: tileObjectFit,
                  ["--tile-aspect" as string]: tileAspectCss(tileAspect),
                  alignContent: tileAspect === "auto" ? "stretch" : "center"
                } as React.CSSProperties)
          }
        >
          <div
            ref={localTileRef}
            className={`tile${isSharing ? " tileScreenSharing" : ""}`}
            style={speakingIndicator ? speakingVars(speakerLevelByPeerId["self"] ?? 0) : speakingVars(0)}
          >
            <video ref={localVideoRef} muted playsInline />
            {isSharing && <PresenterCameraPip stream={localPresenterCameraStream} draggable />}
            {isSharing && (
              <ScreenShareLocalSidebar
                containerRef={localTileRef}
                onStop={() => {
                  void stopScreenShare().catch((err) => {
                    console.error("Error stopping screen share:", err);
                    setError(String(err?.message ?? err));
                  });
                }}
              />
            )}
            {!mediaCfg.videoEnabled && !isSharing && (
              avatarUrls[profile.peerId] ? (
                <div className="tileAvatarFallback">
                  <ProfileAvatar src={avatarUrls[profile.peerId]} name={profile.userName} position={profile.avatarPosition} onClick={() => setAvatarViewer({ peerId: profile.peerId, name: profile.userName })} />
                </div>
              ) : (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", borderRadius: "inherit" }}>
                  <span style={{ fontSize: 48 }}>📹</span>
                </div>
              )
            )}
            {!mediaCfg.audioEnabled && (
              <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.8)", borderRadius: 10, padding: "4px 8px" }}>
                <span style={{ fontSize: 14 }}>🔇</span>
              </div>
            )}
            <div className="tileLabel">
              <span className="tileSpeakMark" aria-hidden="true" />
              {t("youPrefix", { name: profile.userName })}
              {recordingActive && <span className="recordingTileMark" title={t("recordingLocal")}>REC</span>}
              {screenSharingPeerId === profile.peerId && <ScreenSharingDot title={t("screenShareIndicator")} />}
            </div>
          </div>
          {remoteTracks.map((r) => {
            const stream = r.stream;
            const liveVideoTracks = stream.getVideoTracks().filter((t) => t.enabled && t.readyState === "live" && !t.muted);
            const hasVideo = liveVideoTracks.length > 0;
            const hasAudio = stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
            const videoKey = liveVideoTracks.map((t) => t.id).join(",") || "novideo";
            return (
              <div
                key={r.peerId}
                className="tile"
                style={speakingIndicator ? speakingVars(speakerLevelByPeerId[r.peerId] ?? 0) : speakingVars(0)}
              >
                <RemotePeerMedia
                  key={`${r.peerId}-${videoKey}`}
                  stream={stream}
                  muted={false}
                  volume={remoteMicVolume / 100}
                  sinkId={selectedAudioOutputId || undefined}
                  excludeScreenAudioTrackId={
                    remoteScreenShare?.peerId === r.peerId ? remoteScreenShare.screenAudioTrackId : undefined
                  }
                />
                {!hasVideo && (
                  avatarUrls[r.peerId] ? (
                    <div className="tileAvatarFallback">
                      <ProfileAvatar src={avatarUrls[r.peerId]} name={r.userName} position={avatarPositionFor(r.peerId)} onClick={() => setAvatarViewer({ peerId: r.peerId, name: r.userName })} />
                    </div>
                  ) : (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", borderRadius: "inherit" }}>
                      <span style={{ fontSize: 48 }}>📹</span>
                    </div>
                  )
                )}
                {!hasAudio && (
                  <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.8)", borderRadius: 10, padding: "4px 8px" }}>
                    <span style={{ fontSize: 14 }}>🔇</span>
                  </div>
                )}
                <div className="tileLabel">
                  <span className="tileSpeakMark" aria-hidden="true" />
                  {r.userName}
                  {remoteRecordings.some((item) => item.peerId === r.peerId) && (
                    <span className="recordingTileMark" title={t("recordingBy", { name: r.userName })}>REC</span>
                  )}
                  {screenSharingPeerId === r.peerId && <ScreenSharingDot title={t("screenShareIndicator")} />}
                </div>
              </div>
            );
          })}

          {!call && remoteTracks.length === 0 && !showRemoteScreenShareView && (
            <div className="muted" style={{ padding: 12 }}>
              {t("pickHint")}
            </div>
          )}
        </div>
        </div>

        <PanelResizer
          axis="horizontal"
          onDrag={(delta) => setChatHeight((h) => Math.max(360, Math.min(440, (h || 380) - delta)))}
        />

        <div
          className="chat-wrap"
          style={{ width: Math.max(360, Math.min(440, chatHeight || 380)) }}
        >
        <div className="chat">
          <div className="panelHeader">
            <div>
              {call?.mode === "direct" && (
                <>
                  {t("chatWith")}
                  <b>{call.peerName}</b>
                </>
              )}
              {call?.mode === "room" && (
                <>
                  {t("conferenceWith")}
                  <b>{call.roomName}</b> <span className="muted">({call.participants.length})</span>
                </>
              )}
              {!call && selectedPeer && (
                <>
                  {t("chatWith")}
                  <b>{selectedPeer.userName}</b>
                </>
              )}
              {!call && selectedRoom && (
                <>
                  {t("conferenceWith")}
                  <b>{selectedRoom.roomName}</b>
                </>
              )}
              {!call && !selectedPeer && !selectedRoom && <span className="muted">{t("chat")}</span>}
            </div>
            <div className="row">
                {call && callStartedAt && (
                  <span className="badge" title={t("callDuration")}>
                    {formatDurationMs(nowTick - callStartedAt)}
                  </span>
                )}
              <input
                className="btn"
                style={{ width: 180 }}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("search")}
              />
              <button
                className="btn btnDanger"
                onClick={() => setExitConfirmKind(call ? "leave" : "quit")}
                title={call ? t("leave") : t("exitApp")}
              >
                {t("exit")}
              </button>
            </div>
          </div>

          <div
            className="chatLog"
            ref={chatLogRef}
            style={{ ["--chatSmileSize" as any]: `${chatSmileSizePx}px`, fontSize: `${chatFontSize}px` }}
          >
            {visibleMessages.map((m) => (
              <div
                key={m.id}
                className={`msg ${m.kind === "system" ? "msgSystem" : m.fromPeerId === profile.peerId ? "msgOwn" : ""} ${m.kind === "system" ? "" : unreadMessageIds.has(m.id) ? "msgUnread" : "msgRead"}`}
              >
                {m.kind === "system" ? (
                  <div className="msgText">
                    <span>
                      {m.fromUserName} {stripChatStatusEmoji(m.text)}
                    </span>
                    <span className="msgSystemTime">{formatTime(m.sentAt, showSeconds)}</span>
                  </div>
                ) : (
                  <>
                <div className="msgMeta">
                  <span className="msgAuthor">
                    {avatarUrls[m.fromPeerId] && <ProfileAvatar className="chatAvatar" src={avatarUrls[m.fromPeerId]} name={m.fromUserName} position={avatarPositionFor(m.fromPeerId)} onClick={() => setAvatarViewer({ peerId: m.fromPeerId, name: m.fromUserName })} />}
                    <b>{m.fromUserName}</b>
                  </span>
                  <span>{formatTime(m.sentAt, showSeconds)}</span>
                </div>
                {m.attachment?.kind === "smile" ? (
                  <div className="msgText" style={{ paddingTop: 2 }}>
                    <img className="smileImg" src={`./smiles/${encodeURIComponent(m.attachment.file)}`} alt={m.attachment.file} />
                  </div>
                ) : (
                  <div className="msgText">{renderTextWithSmiles(m.text, smilesSet)}</div>
                )}
                {(m.attachment?.kind === "file" || m.attachment?.kind === "image" || m.attachment?.kind === "video") && (() => {
                  const att = m.attachment!;
                  const previewUrl =
                    "previewDataUrl" in att && att.previewDataUrl
                      ? att.previewDataUrl
                      : undefined;
                  const fileUrl = fileUrlByIdRef.current.get(att.fileId) ?? (att.kind === "image" ? previewUrl : undefined);
                  return (
                  <div style={{ marginTop: 6 }}>
                    {previewUrl && (
                      <div className={`chatMediaPreview${att.kind === "video" ? " chatMediaPreviewVideo" : ""}`}>
                        <img
                          src={previewUrl}
                          alt={att.name}
                          onClick={() => {
                            if (fileUrl) window.open(fileUrl, "_blank");
                          }}
                        />
                        {att.kind === "video" && <span className="chatMediaPreviewPlay" aria-hidden>▶</span>}
                      </div>
                    )}
                    <a
                      className="btn"
                      href={fileUrl ?? "#"}
                      download={att.name}
                      onClick={(e) => {
                        const url = fileUrlByIdRef.current.get(att.fileId);
                        if (!url && att.kind !== "image") e.preventDefault();
                      }}
                    >
                      {t("download")}: {att.name}
                    </a>
                  </div>
                  );
                })()}
                  </>
                )}
              </div>
            ))}
            {scope && scopedMessages.length === 0 && <div className="muted">{t("noMessages")}</div>}
            {!scope && <div className="muted">{t("pickChat")}</div>}
            <div ref={chatEndRef} />
          </div>

          {scope && ((typingPeers.size > 0) || fileTransfers.length > 0) && (() => {
            // Фильтруем статусы по scope (для комнат показываем только участников текущей комнаты)
            const filteredTypingPeers = Array.from(typingPeers).filter(peerId => {
              if (scope.type === "direct") {
                return scope.peerId === peerId;
              } else if (scope.type === "room") {
                return call?.mode === "room" && call.roomId === scope.roomId && call.participants.some(p => p.peerId === peerId);
              }
              return false;
            });
            const filteredTransfers = fileTransfers.filter((tr) => {
              if (tr.direction === "send") {
                if (scope.type === "direct") return true;
                if (scope.type === "room") return call?.mode === "room" && call.roomId === scope.roomId;
                return false;
              }
              if (scope.type === "direct") {
                return scope.peerId === tr.peerId;
              } else if (scope.type === "room") {
                return call?.mode === "room" && call.roomId === scope.roomId && (tr.peerId === "room" || call.participants.some(p => p.peerId === tr.peerId));
              }
              return false;
            });
            if (filteredTypingPeers.length === 0 && filteredTransfers.length === 0) return null;

            const peerLabel = (peerId: string) => {
              if (peerId === "room") return t("conference");
              if (scope.type === "direct") {
                return call?.mode === "direct" ? call.peerName : peers.find(p => p.peerId === peerId)?.userName ?? t("peerFallback");
              }
              if (scope.type === "room" && call?.mode === "room") {
                return call.participants.find(p => p.peerId === peerId)?.userName ?? t("participantFallback");
              }
              return peers.find(p => p.peerId === peerId)?.userName ?? t("peerFallback");
            };

            const formatBytes = (n: number) => {
              if (!n || n <= 0) return "0 KB";
              if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
              return `${(n / (1024 * 1024)).toFixed(1)} MB`;
            };

            return (
              <div className="chatTransferStatus">
                {filteredTypingPeers.map((peerId) => (
                  <div key={`typing-${peerId}`} className="chatTransferTyping">
                    {peerLabel(peerId)} {t("typing")}
                  </div>
                ))}
                {filteredTransfers.map((tr) => (
                  <div key={tr.key} className="chatTransferItem">
                    <div className="chatTransferMeta">
                      <span>
                        {tr.direction === "send"
                          ? t("fileSending", { name: tr.fileName })
                          : t("fileReceiving", { name: tr.fileName, peer: peerLabel(tr.peerId) })}
                      </span>
                      <span className="chatTransferMetaRight">
                        <span className="chatTransferPercent">{tr.percent}%</span>
                        {tr.direction === "send" && tr.fileId && tr.percent < 100 && (
                          <button
                            type="button"
                            className="btn btnDanger chatTransferCancel"
                            onClick={() => cancelOutgoingFileTransfer(tr.fileId)}
                          >
                            {t("fileTransferCancel")}
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="chatTransferBar" role="progressbar" aria-valuenow={tr.percent} aria-valuemin={0} aria-valuemax={100}>
                      <div className="chatTransferBarFill" style={{ width: `${tr.percent}%` }} />
                    </div>
                    {tr.total > 0 && (
                      <div className="chatTransferBytes">
                        {formatBytes(tr.transferred)} / {formatBytes(tr.total)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          <ChatComposer 
            disabled={!scope} 
            onSend={(tx) => void sendChat(tx)} 
            onSendFile={(f) => void sendFile(f)} 
            smilesFiles={smilesFiles}
            onTyping={() => {
              // Отправляем уведомление о наборе текста через DataChannel
              if (!scope) return;
              const targets: string[] = [];
              if (scope.type === "direct") {
                targets.push(scope.peerId);
              } else if (scope.type === "room" && call?.mode === "room") {
                for (const p of call.participants) {
                  if (p.peerId !== profile?.peerId) targets.push(p.peerId);
                }
              }
              for (const peerId of targets) {
                const dc = dcsRef.current.get(peerId);
                if (dc && dc.readyState === "open") {
                  try {
                    dc.send(JSON.stringify({ t: "typing" }));
                  } catch {
                    // Игнорируем ошибки
                  }
                }
              }
            }}
          />
        </div>
        </div>
      </div>

      {avatarViewer && avatarUrls[avatarViewer.peerId] && (
        <Modal title={avatarViewer.name} onClose={() => setAvatarViewer(null)}>
          <div className="avatarViewer">
            <div className="avatarViewerImage">
              <img
                className="avatarViewerImageInner"
                src={avatarUrls[avatarViewer.peerId]}
                alt={t("avatarAlt", { name: avatarViewer.name })}
                style={{
                  objectPosition: `${avatarPositionFor(avatarViewer.peerId)?.x ?? 50}% ${avatarPositionFor(avatarViewer.peerId)?.y ?? 50}%`,
                  transform: `scale(${Math.max(1, Math.min(3, (avatarPositionFor(avatarViewer.peerId)?.zoom ?? 100) / 100))})`,
                  transformOrigin: `${avatarPositionFor(avatarViewer.peerId)?.x ?? 50}% ${avatarPositionFor(avatarViewer.peerId)?.y ?? 50}%`
                }}
                draggable={false}
              />
            </div>
            {avatarViewer.peerId === profile?.peerId && (
              <div className="avatarPositionControls">
                <label>
                  {t("avatarPosX")}
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={profile.avatarPosition?.x ?? 50}
                    onChange={(event) => void setAvatarPosition("x", Number(event.target.value))}
                  />
                </label>
                <label>
                  {t("avatarPosY")}
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={profile.avatarPosition?.y ?? 50}
                    onChange={(event) => void setAvatarPosition("y", Number(event.target.value))}
                  />
                </label>
                <label>
                  {t("avatarZoom")}
                  <input
                    type="range"
                    min="100"
                    max="300"
                    value={profile.avatarPosition?.zoom ?? 100}
                    onChange={(event) => void setAvatarPosition("zoom", Number(event.target.value))}
                  />
                  <span className="muted">{profile.avatarPosition?.zoom ?? 100}%</span>
                </label>
              </div>
            )}
          </div>
        </Modal>
      )}

      {exitConfirmKind && (
        <Modal
          title={exitConfirmKind === "leave" ? t("leaveCallConfirmTitle") : t("exitConfirmTitle")}
          onClose={() => setExitConfirmKind(null)}
        >
          <div className="muted" style={{ marginBottom: 16 }}>
            {exitConfirmKind === "leave" ? t("leaveCallConfirmBody") : t("exitConfirmBody")}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
            <button className="btn" onClick={() => setExitConfirmKind(null)}>
              {t("cancel")}
            </button>
            <button
              className="btn btnDanger"
              onClick={() => {
                const kind = exitConfirmKind;
                setExitConfirmKind(null);
                if (kind === "leave") void leaveCall();
                else quitApp();
              }}
            >
              {exitConfirmKind === "leave" ? t("leaveCallConfirmAction") : t("exitApp")}
            </button>
          </div>
        </Modal>
      )}

      {settingsOpen && (
        <Modal
          title={t("settings")}
          native={isSettingsWindow}
          onClose={() => {
            if (isSettingsWindow) {
              void window.lokameet.settings.close();
              return;
            }
            setSettingsOpen(false);
          }}
          size="settings"
        >
          <div className="settingsProjectLink">
            <span>{t("projectLink")}</span>
            <button
              type="button"
              className="settingsProjectLinkButton"
              onClick={() => void window.lokameet.app.openExternal("https://github.com/mistrwest/LokaMeet").catch(() => undefined)}
            >
              github.com/mistrwest/LokaMeet
            </button>
          </div>
          <div className="settingsTabs">
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "media" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "media" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("media")}
            >
              {t("settingsMedia")}
            </button>
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "camera" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "camera" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("camera")}
            >
              {t("settingsCamera")}
            </button>
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "audio" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "audio" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("audio")}
            >
              {t("settingsAudio")}
            </button>
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "ui" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "ui" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("ui")}
            >
              {t("settingsUi")}
            </button>
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "connection" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "connection" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("connection")}
            >
              {t("settingsConnection")}
            </button>
            <button
              className="btn"
              style={{
                borderRadius: "4px 4px 0 0",
                borderBottom: settingsTab === "help" ? "2px solid var(--primary)" : "2px solid transparent",
                background: settingsTab === "help" ? "rgba(255,255,255,0.1)" : undefined
              }}
              onClick={() => setSettingsTab("help")}
            >
              {t("help")}
            </button>
          </div>
          <div className={`settingsTabBody${settingsTab === "camera" ? " is-camera" : ""}`}>
          
          {settingsTab === "media" && (
          <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("microphone")}
            </div>
            <div style={{ flex: "1 1 240px", maxWidth: 520, display: "flex", flexDirection: "column", gap: 6 }}>
              <Select
                value={selectedAudioInputId}
                onChange={(v) => void switchMicrophone(v)}
                options={[
                  { value: "", label: t("deviceDefault") },
                  ...audioInputDevices.map((d) => ({
                    value: d.deviceId,
                    label: d.label || `Mic ${d.deviceId.slice(0, 6)}`
                  }))
                ]}
              />
              <div style={{ height: 8, borderRadius: 999, border: "1px solid var(--border)", background: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.round(micLevel * 100)}%`,
                    background: micLevel > 0.7 ? "rgba(248,113,113,0.9)" : micLevel > 0.35 ? "rgba(251,191,36,0.9)" : "rgba(52,211,153,0.9)",
                    transition: "width 80ms linear"
                  }}
                />
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {t("micLevel")}: {Math.round(micLevel * 100)}%
              </div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("audioOutput")}
            </div>
            <Select
              value={selectedAudioOutputId}
              onChange={(v) => setSelectedAudioOutputId(v)}
              style={{ flex: "1 1 240px", maxWidth: 520 }}
              options={[
                { value: "", label: t("deviceDefault") },
                ...audioOutputDevices.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Speaker ${d.deviceId.slice(0, 6)}`
                }))
              ]}
            />
          </div>
          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("settingsRecordings")}</div>
          <div className="muted settingsHint">{t("recordingFolderHint")}</div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("recordingFormat")}
            </div>
            <Select
              value={recordingFormat}
              onChange={(v) => setRecordingFormat(v === "avi" ? "avi" : "mp4")}
              options={[
                { value: "mp4", label: t("recordingFormatMp4") },
                { value: "avi", label: t("recordingFormatAvi") }
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("recordingQuality")}
            </div>
            <Select
              value={recordingQuality}
              onChange={(v) =>
                setRecordingQuality(
                  v === "480p" || v === "720p" || v === "1440p" || v === "1080p" ? v : "1080p"
                )
              }
              options={[
                { value: "480p", label: "480p" },
                { value: "720p", label: "720p" },
                { value: "1080p", label: "1080p" },
                { value: "1440p", label: "1440p" }
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("recordingFps")}
            </div>
            <Select
              value={String(recordingFps)}
              onChange={(v) => setRecordingFps(v === "15" ? 15 : v === "24" ? 24 : 30)}
              options={[
                { value: "15", label: "15" },
                { value: "24", label: "24" },
                { value: "30", label: "30" }
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("recordingBitrate")}
            </div>
            <Select
              value={recordingBitrate}
              onChange={(v) =>
                setRecordingBitrate(
                  v === "low" || v === "medium" || v === "max" || v === "high" ? v : "high"
                )
              }
              options={[
                { value: "low", label: t("recordingBitrateLow") },
                { value: "medium", label: t("recordingBitrateMedium") },
                { value: "high", label: t("recordingBitrateHigh") },
                { value: "max", label: t("recordingBitrateMax") }
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("recordingFolder")}
            </div>
            <div style={{ display: "flex", gap: 8, flex: "1 1 240px", minWidth: 0 }}>
              <input className="btn grow" value={recordingDir} readOnly placeholder={t("recordingFolderPlaceholder")} />
              <button className="btn" onClick={() => void chooseRecordingFolder()}>
                {t("chooseRecordingFolder")}
              </button>
              <button
                className="btn"
                disabled={!lastRecordingPath && !recordingDir}
                title={lastRecordingPath || recordingDir || undefined}
                onClick={() => {
                  const folder = parentDirOf(lastRecordingPath) || recordingDir;
                  if (!folder) return;
                  void window.lokameet.app.openPath(folder);
                }}
              >
                {t("openRecordingFolder")}
              </button>
            </div>
          </div>
          </>
          )}

          {settingsTab === "camera" && (
          <>
          <div className="settingsCameraSticky">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraDevice")}
            </div>
            <Select
              value={selectedVideoDeviceId}
              onChange={(v) => void switchCamera(v)}
              style={{ flex: "1 1 240px", maxWidth: 520 }}
              options={[
                { value: "", label: t("deviceDefault") },
                ...videoDevices.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Camera ${d.deviceId.slice(0, 6)}`
                }))
              ]}
            />
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("videoQuality")}
            </div>
            <Select
              value={mediaCfg.videoQuality}
              onChange={(v) => void applyVideoQuality(v as VideoQuality)}
              options={VIDEO_QUALITY_OPTIONS.map((q) => ({ value: q.value, label: t(q.labelKey) }))}
            />
          </div>

          <div className="row" style={{ marginTop: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraPreview")}
            </div>
            <div style={{ flex: "1 1 240px" }}>
              <div
                className={`tile cameraSettingsPreviewWrap${previewDragging ? " is-dragging" : ""}`}
                style={{
                  aspectRatio: tileAspect === "auto" ? "16 / 9" : tileAspectCss(tileAspect),
                  ["--tile-fit" as string]: tileObjectFit,
                  ["--tile-radius" as string]: `${tileRadius}px`
                } as React.CSSProperties}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  previewDragRef.current = {
                    x: e.clientX,
                    y: e.clientY,
                    panX: cameraFx.cropPanX,
                    panY: cameraFx.cropPanY,
                    width: rect.width,
                    height: rect.height
                  };
                  setPreviewDragging(true);
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const drag = previewDragRef.current;
                  if (!drag) return;
                  const panX = Math.max(-1, Math.min(1, drag.panX - ((e.clientX - drag.x) / Math.max(1, drag.width)) * 2));
                  const panY = Math.max(-1, Math.min(1, drag.panY - ((e.clientY - drag.y) / Math.max(1, drag.height)) * 2));
                  setCameraFx((c) => (c.cropPanX === panX && c.cropPanY === panY ? c : { ...c, cropPanX: panX, cropPanY: panY }));
                }}
                onPointerUp={() => {
                  previewDragRef.current = null;
                  setPreviewDragging(false);
                }}
                onPointerCancel={() => {
                  previewDragRef.current = null;
                  setPreviewDragging(false);
                }}
              >
                <video ref={cameraPreviewRef} className="cameraSettingsPreview" playsInline muted autoPlay />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {t("cameraPreviewHint")}
              </div>
            </div>
          </div>
          </div>

          <div className="settingsCameraScroll">
          <div className="settingsGroupTitle">{t("cameraFraming")}</div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraCropZoom")}
            </div>
            <input
              type="range"
              min={100}
              max={250}
              step={5}
              value={Math.round(cameraFx.cropZoom * 100)}
              onChange={(e) => setCameraFx((c) => ({ ...c, cropZoom: Number(e.target.value) / 100 }))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {Math.round(cameraFx.cropZoom * 100)}%
            </span>
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraCropPanX")}
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(-cameraFx.cropPanX * 100)}
              onChange={(e) => setCameraFx((c) => ({ ...c, cropPanX: -Number(e.target.value) / 100 }))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {Math.round(-cameraFx.cropPanX * 100)}
            </span>
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraCropPanY")}
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(cameraFx.cropPanY * 100)}
              onChange={(e) => setCameraFx((c) => ({ ...c, cropPanY: Number(e.target.value) / 100 }))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {Math.round(cameraFx.cropPanY * 100)}
            </span>
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("cameraBlurAmount")}
            </div>
            <input
              type="range"
              min={10}
              max={100}
              value={cameraFx.blurAmount}
              onChange={(e) => setCameraFx((c) => ({ ...c, blurAmount: Number(e.target.value) }))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {cameraFx.blurAmount}%
            </span>
          </div>
          <div className="muted settingsHint">{t("cameraCropZoomHint")}</div>

          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("cameraManual")}</div>
          <div className="muted settingsHint">{t("cameraManualHint")}</div>
          {!cameraHasManualControls(cameraCaps) && (
            <div className="muted" style={{ fontSize: 12 }}>
              {t("cameraManualUnsupported")}
            </div>
          )}

          {cameraCaps?.focusMode && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraFocusMode")}
              </div>
              <Select
                value={cameraControls.focusMode}
                onChange={(v) => setCameraControls((c) => ({ ...c, focusMode: v === "manual" ? "manual" : "continuous" }))}
                options={[
                  { value: "continuous", label: t("cameraFocusAuto") },
                  { value: "manual", label: t("cameraFocusManual") }
                ]}
              />
            </div>
          )}
          {cameraCaps?.focusDistance && cameraControls.focusMode === "manual" && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraFocusDistance")}
              </div>
              <input
                type="range"
                min={cameraCaps.focusDistance.min}
                max={cameraCaps.focusDistance.max}
                step={cameraCaps.focusDistance.step ?? (cameraCaps.focusDistance.max - cameraCaps.focusDistance.min) / 100}
                value={cameraControls.focusDistance ?? cameraCaps.focusDistance.min}
                onChange={(e) => setCameraControls((c) => ({ ...c, focusDistance: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.zoom && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraZoom")}
              </div>
              <input
                type="range"
                min={cameraCaps.zoom.min}
                max={cameraCaps.zoom.max}
                step={cameraCaps.zoom.step ?? (cameraCaps.zoom.max - cameraCaps.zoom.min) / 100}
                value={cameraControls.zoom ?? cameraCaps.zoom.min}
                onChange={(e) => setCameraControls((c) => ({ ...c, zoom: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.exposureMode && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraExposureMode")}
              </div>
              <Select
                value={cameraControls.exposureMode}
                onChange={(v) => setCameraControls((c) => ({ ...c, exposureMode: v === "manual" ? "manual" : "continuous" }))}
                options={[
                  { value: "continuous", label: t("cameraExposureAuto") },
                  { value: "manual", label: t("cameraExposureManual") }
                ]}
              />
            </div>
          )}
          {cameraCaps?.exposureCompensation && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraExposureCompensation")}
              </div>
              <input
                type="range"
                min={cameraCaps.exposureCompensation.min}
                max={cameraCaps.exposureCompensation.max}
                step={cameraCaps.exposureCompensation.step ?? 0.1}
                value={cameraControls.exposureCompensation ?? 0}
                onChange={(e) => setCameraControls((c) => ({ ...c, exposureCompensation: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.brightness && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraBrightness")}
              </div>
              <input
                type="range"
                min={cameraCaps.brightness.min}
                max={cameraCaps.brightness.max}
                step={cameraCaps.brightness.step ?? 1}
                value={cameraControls.brightness ?? Math.round((cameraCaps.brightness.min + cameraCaps.brightness.max) / 2)}
                onChange={(e) => setCameraControls((c) => ({ ...c, brightness: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.contrast && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraContrast")}
              </div>
              <input
                type="range"
                min={cameraCaps.contrast.min}
                max={cameraCaps.contrast.max}
                step={cameraCaps.contrast.step ?? 1}
                value={cameraControls.contrast ?? Math.round((cameraCaps.contrast.min + cameraCaps.contrast.max) / 2)}
                onChange={(e) => setCameraControls((c) => ({ ...c, contrast: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.saturation && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraSaturation")}
              </div>
              <input
                type="range"
                min={cameraCaps.saturation.min}
                max={cameraCaps.saturation.max}
                step={cameraCaps.saturation.step ?? 1}
                value={cameraControls.saturation ?? Math.round((cameraCaps.saturation.min + cameraCaps.saturation.max) / 2)}
                onChange={(e) => setCameraControls((c) => ({ ...c, saturation: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.sharpness && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraSharpness")}
              </div>
              <input
                type="range"
                min={cameraCaps.sharpness.min}
                max={cameraCaps.sharpness.max}
                step={cameraCaps.sharpness.step ?? 1}
                value={cameraControls.sharpness ?? Math.round((cameraCaps.sharpness.min + cameraCaps.sharpness.max) / 2)}
                onChange={(e) => setCameraControls((c) => ({ ...c, sharpness: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
            </div>
          )}
          {cameraCaps?.whiteBalanceMode && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraWhiteBalance")}
              </div>
              <Select
                value={cameraControls.whiteBalanceMode}
                onChange={(v) => setCameraControls((c) => ({ ...c, whiteBalanceMode: v === "manual" ? "manual" : "continuous" }))}
                options={[
                  { value: "continuous", label: t("cameraWbAuto") },
                  { value: "manual", label: t("cameraWbManual") }
                ]}
              />
            </div>
          )}
          {cameraCaps?.colorTemperature && cameraControls.whiteBalanceMode === "manual" && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("cameraColorTemperature")}
              </div>
              <input
                type="range"
                min={cameraCaps.colorTemperature.min}
                max={cameraCaps.colorTemperature.max}
                step={cameraCaps.colorTemperature.step ?? 50}
                value={cameraControls.colorTemperature ?? cameraCaps.colorTemperature.min}
                onChange={(e) => setCameraControls((c) => ({ ...c, colorTemperature: Number(e.target.value) }))}
                style={{ flex: "1 1 240px" }}
              />
              <span className="muted" style={{ width: 54, textAlign: "right" }}>
                {Math.round(cameraControls.colorTemperature ?? cameraCaps.colorTemperature.min)}K
              </span>
            </div>
          )}

          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("cameraBackground")}</div>
          <div className="muted settingsHint">{t("cameraBackgroundHint")}</div>
          <div className="cameraBgGrid">
            <button
              type="button"
              className={`cameraBgTile ${cameraFx.backgroundMode === "none" ? "is-active" : ""}`}
              onClick={() => setCameraFx((c) => ({ ...c, backgroundMode: "none" }))}
            >
              <span className="cameraBgTileLabel">{t("cameraBgNone")}</span>
            </button>
            <button
              type="button"
              className={`cameraBgTile ${cameraFx.backgroundMode === "blur" ? "is-active" : ""}`}
              onClick={() => setCameraFx((c) => ({ ...c, backgroundMode: "blur" }))}
            >
              <span className="cameraBgTileLabel">{t("cameraBgBlur")}</span>
            </button>
            {CAMERA_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`cameraBgTile ${cameraFx.backgroundMode === "preset" && cameraFx.presetId === preset.id ? "is-active" : ""}`}
                onClick={() => setCameraFx((c) => ({ ...c, backgroundMode: "preset", presetId: preset.id }))}
                title={t(`cameraBg_${preset.id}`)}
              >
                <img src={cameraBgAssetUrl(preset.file)} alt={t(`cameraBg_${preset.id}`)} />
                <span className="cameraBgTileCaption">{t(`cameraBg_${preset.id}`)}</span>
              </button>
            ))}
            {customCameraBgs.map((bg) => (
              <div
                key={bg.id}
                className={`cameraBgTile ${cameraFx.backgroundMode === "custom" && cameraFx.customId === bg.id ? "is-active" : ""}`}
              >
                <button
                  type="button"
                  className="cameraBgTileHit"
                  onClick={() => setCameraFx((c) => ({ ...c, backgroundMode: "custom", customId: bg.id, customDataUrl: bg.dataUrl }))}
                >
                  <img src={bg.dataUrl} alt={t("cameraBgCustom")} />
                  <span className="cameraBgTileCaption">{t("cameraBgCustom")}</span>
                </button>
                <button
                  type="button"
                  className="cameraBgTileRemove"
                  title={t("cameraBgDelete")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void deleteCustomCameraBackground(bg.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="cameraBgTile cameraBgTileAdd"
              onClick={() => void addCustomCameraBackground()}
            >
              <span className="cameraBgTileLabel">+</span>
              <span className="cameraBgTileCaption">{t("cameraBgAdd")}</span>
            </button>
          </div>
          </div>
          </>
          )}

          {settingsTab === "audio" && (
          <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("micVolume")}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={microphoneVolume}
              onChange={(e) => setMicrophoneVolume(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {microphoneVolume}%
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("remoteMicVolume")}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={remoteMicVolume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setRemoteMicVolume(v);
                setSpeakerVolume(v);
              }}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {remoteMicVolume}%
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("remoteScreenShareVolume")}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={remoteScreenShareVolume}
              onChange={(e) => setRemoteScreenShareVolume(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {remoteScreenShareVolume}%
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("noiseSuppression")}
            </div>
            <label className="row" style={{ gap: 8, flex: "1 1 240px" }}>
              <input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} />
              <span>{t("noiseSuppressionEnable")}</span>
            </label>
          </div>

          {noiseSuppression && (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="muted" style={{ width: 160 }}>
                {t("noiseSensitivity")}
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={noiseSuppressionSensitivity}
                onChange={(e) => setNoiseSuppressionSensitivity(Number(e.target.value))}
                style={{ flex: "1 1 240px" }}
              />
              <span className="muted" style={{ width: 54, textAlign: "right" }}>
                {noiseSuppressionSensitivity}%
              </span>
            </div>
          )}

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("soundNotifications")}
            </div>
            <label className="row" style={{ gap: 8, flex: "1 1 240px" }}>
              <input type="checkbox" checked={soundNotificationsEnabled} onChange={(e) => setSoundNotificationsEnabled(e.target.checked)} />
              <span>{t("soundNotificationsEnable")}</span>
            </label>
          </div>

          {soundNotificationsEnabled && (
            <>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("notificationVolume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={soundNotificationVolume}
                  onChange={(e) => setSoundNotificationVolume(Number(e.target.value))}
                  style={{ flex: "1 1 240px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right" }}>
                  {soundNotificationVolume}%
                </span>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("soundCall")}
                </div>
                <div style={{ display: "flex", gap: 8, flex: "1 1 240px", alignItems: "center" }}>
                  <input
                    className="btn"
                    type="text"
                    value={callSoundFile}
                    onChange={(e) => setCallSoundFile(e.target.value)}
                    placeholder="snds/call.mp3"
                    style={{ flex: "1 1 auto" }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const result = await window.lokameet.app.showOpenDialog({
                          filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a"] }]
                        });
                        if (result) {
                          // Преобразуем абсолютный путь в относительный, если возможно
                          const appPath = await window.lokameet.app.getState().then(() => "").catch(() => "");
                          setCallSoundFile(result);
                        }
                      } catch (e) {
                        setError(t("errPickFile"));
                      }
                    }}
                    title={t("chooseFile")}
                  >
                    📁
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (testSoundAudioRef.current) {
                        testSoundAudioRef.current.pause();
                        testSoundAudioRef.current = null;
                      }
                      try {
                        const fileUrl = getSoundFileUrl(callSoundFile);
                        const audio = new Audio(fileUrl);
                        audio.volume = callSoundVolume / 100;
                        testSoundAudioRef.current = audio;
                        audio.play().catch(() => {
                          setError(t("errPlaySound"));
                        });
                        audio.onended = () => {
                          testSoundAudioRef.current = null;
                        };
                      } catch (e) {
                        setError(t("errPlaySound"));
                      }
                    }}
                    title={t("previewSound")}
                  >
                    ▶️
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", marginLeft: 168 }}>
                <div className="muted" style={{ fontSize: 12, width: 80 }}>
                  {t("volume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={callSoundVolume}
                  onChange={(e) => setCallSoundVolume(Number(e.target.value))}
                  style={{ flex: "1 1 200px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right", fontSize: 12 }}>
                  {callSoundVolume}%
                </span>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("soundCaller")}
                </div>
                <div style={{ display: "flex", gap: 8, flex: "1 1 240px", alignItems: "center" }}>
                  <input
                    className="btn"
                    type="text"
                    value={callerSoundFile}
                    onChange={(e) => setCallerSoundFile(e.target.value)}
                    placeholder="snds/call_1.mp3"
                    style={{ flex: "1 1 auto" }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const result = await window.lokameet.app.showOpenDialog({
                          filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a"] }]
                        });
                        if (result) {
                          setCallerSoundFile(result);
                        }
                      } catch (e) {
                        setError(t("errPickFile"));
                      }
                    }}
                    title={t("chooseFile")}
                  >
                    📁
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (testSoundAudioRef.current) {
                        testSoundAudioRef.current.pause();
                        testSoundAudioRef.current = null;
                      }
                      try {
                        const fileUrl = getSoundFileUrl(callerSoundFile);
                        const audio = new Audio(fileUrl);
                        audio.volume = callerSoundVolume / 100;
                        testSoundAudioRef.current = audio;
                        audio.play().catch(() => {
                          setError(t("errPlaySound"));
                        });
                        audio.onended = () => {
                          testSoundAudioRef.current = null;
                        };
                      } catch (e) {
                        setError(t("errPlaySound"));
                      }
                    }}
                    title={t("previewSound")}
                  >
                    ▶️
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", marginLeft: 168 }}>
                <div className="muted" style={{ fontSize: 12, width: 80 }}>
                  {t("volume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={callerSoundVolume}
                  onChange={(e) => setCallerSoundVolume(Number(e.target.value))}
                  style={{ flex: "1 1 200px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right", fontSize: 12 }}>
                  {callerSoundVolume}%
                </span>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("soundConnect")}
                </div>
                <div style={{ display: "flex", gap: 8, flex: "1 1 240px", alignItems: "center" }}>
                  <input
                    className="btn"
                    type="text"
                    value={connectionSoundFile}
                    onChange={(e) => setConnectionSoundFile(e.target.value)}
                    placeholder="snds/int.mp3"
                    style={{ flex: "1 1 auto" }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const result = await window.lokameet.app.showOpenDialog({
                          filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a"] }]
                        });
                        if (result) {
                          setConnectionSoundFile(result);
                        }
                      } catch (e) {
                        setError(t("errPickFile"));
                      }
                    }}
                    title={t("chooseFile")}
                  >
                    📁
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (testSoundAudioRef.current) {
                        testSoundAudioRef.current.pause();
                        testSoundAudioRef.current = null;
                      }
                      try {
                        const fileUrl = getSoundFileUrl(connectionSoundFile);
                        const audio = new Audio(fileUrl);
                        audio.volume = connectionSoundVolume / 100;
                        testSoundAudioRef.current = audio;
                        audio.play().catch(() => {
                          setError(t("errPlaySound"));
                        });
                        audio.onended = () => {
                          testSoundAudioRef.current = null;
                        };
                      } catch (e) {
                        setError(t("errPlaySound"));
                      }
                    }}
                    title={t("previewSound")}
                  >
                    ▶️
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", marginLeft: 168 }}>
                <div className="muted" style={{ fontSize: 12, width: 80 }}>
                  {t("volume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={connectionSoundVolume}
                  onChange={(e) => setConnectionSoundVolume(Number(e.target.value))}
                  style={{ flex: "1 1 200px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right", fontSize: 12 }}>
                  {connectionSoundVolume}%
                </span>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("soundMessage")}
                </div>
                <div style={{ display: "flex", gap: 8, flex: "1 1 240px", alignItems: "center" }}>
                  <input
                    className="btn"
                    type="text"
                    value={messageSoundFile}
                    onChange={(e) => setMessageSoundFile(e.target.value)}
                    placeholder="snds/sms.mp3"
                    style={{ flex: "1 1 auto" }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const result = await window.lokameet.app.showOpenDialog({
                          filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a"] }]
                        });
                        if (result) {
                          setMessageSoundFile(result);
                        }
                      } catch (e) {
                        setError(t("errPickFile"));
                      }
                    }}
                    title={t("chooseFile")}
                  >
                    📁
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (testSoundAudioRef.current) {
                        testSoundAudioRef.current.pause();
                        testSoundAudioRef.current = null;
                      }
                      try {
                        const fileUrl = getSoundFileUrl(messageSoundFile);
                        const audio = new Audio(fileUrl);
                        audio.volume = messageSoundVolume / 100;
                        testSoundAudioRef.current = audio;
                        audio.play().catch(() => {
                          setError(t("errPlaySound"));
                        });
                        audio.onended = () => {
                          testSoundAudioRef.current = null;
                        };
                      } catch (e) {
                        setError(t("errPlaySound"));
                      }
                    }}
                    title={t("previewSound")}
                  >
                    ▶️
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", marginLeft: 168 }}>
                <div className="muted" style={{ fontSize: 12, width: 80 }}>
                  {t("volume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={messageSoundVolume}
                  onChange={(e) => setMessageSoundVolume(Number(e.target.value))}
                  style={{ flex: "1 1 200px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right", fontSize: 12 }}>
                  {messageSoundVolume}%
                </span>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <div className="muted" style={{ width: 160 }}>
                  {t("soundRecord")}
                </div>
                <div style={{ display: "flex", gap: 8, flex: "1 1 240px", alignItems: "center" }}>
                  <input
                    className="btn"
                    type="text"
                    value={recordingSoundFile}
                    onChange={(e) => setRecordingSoundFile(e.target.value)}
                    placeholder="snds/record.mp3"
                    style={{ flex: "1 1 auto" }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const result = await window.lokameet.app.showOpenDialog({
                          filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a"] }]
                        });
                        if (result) {
                          setRecordingSoundFile(result);
                        }
                      } catch (e) {
                        setError(t("errPickFile"));
                      }
                    }}
                    title={t("chooseFile")}
                  >
                    📁
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (testSoundAudioRef.current) {
                        testSoundAudioRef.current.pause();
                        testSoundAudioRef.current = null;
                      }
                      try {
                        const fileUrl = getSoundFileUrl(recordingSoundFile);
                        const audio = new Audio(fileUrl);
                        audio.volume = recordingSoundVolume / 100;
                        testSoundAudioRef.current = audio;
                        audio.play().catch(() => {
                          setError(t("errPlaySound"));
                        });
                        audio.onended = () => {
                          testSoundAudioRef.current = null;
                        };
                      } catch (e) {
                        setError(t("errPlaySound"));
                      }
                    }}
                    title={t("previewSound")}
                  >
                    ▶️
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", marginLeft: 168 }}>
                <div className="muted" style={{ fontSize: 12, width: 80 }}>
                  {t("volume")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={recordingSoundVolume}
                  onChange={(e) => setRecordingSoundVolume(Number(e.target.value))}
                  style={{ flex: "1 1 200px" }}
                />
                <span className="muted" style={{ width: 54, textAlign: "right", fontSize: 12 }}>
                  {recordingSoundVolume}%
                </span>
              </div>
            </>
          )}
          </>
          )}

          {settingsTab === "ui" && (
          <>
          <div className="settingsGroupTitle">{t("uiLayout")}</div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("chatWidth")}
            </div>
            <input
              type="range"
              min={360}
              max={440}
              value={chatHeight}
              onChange={(e) => {
                const v = Number(e.target.value);
                setChatHeight(v);
              }}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {chatHeight}px
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("sidebarWidth")}
            </div>
            <input
              type="range"
              min={360}
              max={420}
              value={sidebarWidth}
              onChange={(e) => setSidebarWidth(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {sidebarWidth}px
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("fontSize")}
            </div>
            <input
              type="range"
              min={0.85}
              max={1.25}
              step={0.05}
              value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {Math.round((fontScale || 1) * 100)}%
            </span>
          </div>

          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("uiChat")}</div>

          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("smileSize")}
            </div>
            <input
              type="range"
              min={16}
              max={128}
              value={chatSmileSizePx}
              onChange={(e) => setChatSmileSizePx(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {chatSmileSizePx}px
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("chatFontSize")}
            </div>
            <input
              type="range"
              min={10}
              max={24}
              value={chatFontSize}
              onChange={(e) => setChatFontSize(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {chatFontSize}px
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("chatDisplayLimit")}
            </div>
            <Select
              value={String(chatDisplayLimit)}
              onChange={(v) => setChatDisplayLimit(Number(v) || 0)}
              style={{ flex: "1 1 240px" }}
              options={[
                { value: "0", label: t("chatShowAll") },
                { value: "200", label: t("chatLastN", { n: 200 }) },
                { value: "500", label: t("chatLastN", { n: 500 }) },
                { value: "1000", label: t("chatLastN", { n: 1000 }) }
              ]}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {chatDisplayLimit ? `≤${chatDisplayLimit}` : "∞"}
            </span>
          </div>

          <label className="row" style={{ marginTop: 12, gap: 8 }}>
            <input type="checkbox" checked={compactUi} onChange={(e) => setCompactUi(e.target.checked)} />
            <span>{t("compactChat")}</span>
          </label>
          <label className="row" style={{ marginTop: 8, gap: 8 }}>
            <input type="checkbox" checked={chatAutoScroll} onChange={(e) => setChatAutoScroll(e.target.checked)} />
            <span>{t("chatAutoScroll")}</span>
          </label>
          <label className="row" style={{ marginTop: 8, gap: 8 }}>
            <input type="checkbox" checked={autoSwitchToChat} onChange={(e) => setAutoSwitchToChat(e.target.checked)} />
            <span>{t("autoSwitchToChat")}</span>
          </label>

          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("videoTiles")}</div>

          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("tileAspect")}
            </div>
            <Select
              value={tileAspect}
              onChange={(v) => setTileAspect(v as typeof tileAspect)}
              options={[
                { value: "auto", label: t("tileAspectAuto") },
                { value: "16x9", label: "16:9" },
                { value: "4x3", label: "4:3" },
                { value: "1x1", label: "1:1" }
              ]}
            />
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("tileFit")}
            </div>
            <Select
              value={tileObjectFit}
              onChange={(v) => setTileObjectFit(v as typeof tileObjectFit)}
              options={[
                { value: "cover", label: t("tileFitCover") },
                { value: "contain", label: t("tileFitContain") }
              ]}
            />
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("tileRadius")}
            </div>
            <input
              type="range"
              min={4}
              max={28}
              value={tileRadius}
              onChange={(e) => setTileRadius(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {tileRadius}px
            </span>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("tileGap")}
            </div>
            <input
              type="range"
              min={4}
              max={24}
              value={tileGap}
              onChange={(e) => setTileGap(Number(e.target.value))}
              style={{ flex: "1 1 240px" }}
            />
            <span className="muted" style={{ width: 54, textAlign: "right" }}>
              {tileGap}px
            </span>
          </div>

          <label className="row" style={{ marginTop: 12, gap: 8 }}>
            <input type="checkbox" checked={speakingIndicator} onChange={(e) => setSpeakingIndicator(e.target.checked)} />
            <span>{t("speakingIndicator")}</span>
          </label>

          <div className="panelSectionDivider" />
          <div className="settingsGroupTitle">{t("uiGeneral")}</div>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
            <div className="muted" style={{ width: 160 }}>
              {t("options")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "1 1 240px" }}>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={showSeconds} onChange={(e) => setShowSeconds(e.target.checked)} />
                <span>{t("showSeconds")}</span>
              </label>
              <label className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="checkbox"
                  checked={autoAwayMinutes > 0}
                  onChange={(e) => setAutoAwayMinutes(e.target.checked ? 5 : 0)}
                />
                <span>{t("autoAway")}</span>
                {autoAwayMinutes > 0 && (
                  <>
                    <span className="muted" style={{ marginLeft: 4 }}>
                      {t("autoAwayMinutes")}:
                    </span>
                    <input
                      className="btn"
                      type="number"
                      min={1}
                      max={120}
                      value={autoAwayMinutes}
                      onChange={(e) => setAutoAwayMinutes(Math.max(1, Math.min(120, Number(e.target.value) || 5)))}
                      style={{ width: 72, padding: "4px 8px" }}
                    />
                  </>
                )}
              </label>
            </div>
          </div>
          </>
          )}

          {settingsTab === "connection" && (
          <>
          <div className="muted" style={{ marginBottom: 12 }}>
            {t("connectionHint")}
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input
              className="btn"
              style={{ flex: "1 1 160px" }}
              value={manualHost}
              onChange={(e) => setManualHost(e.target.value)}
              placeholder="192.168.0.10"
            />
            <input
              className="btn"
              style={{ width: 110 }}
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              placeholder={t("portPlaceholder")}
            />
            <button className="btn btnPrimary" onClick={() => void manualConnect()}>
              OK
            </button>
          </div>
          {manualPeers.length > 0 && (
            <div className="list" style={{ marginTop: 12 }}>
              {manualPeers.map((p) => (
                <div key={p.peerId} className="item" onClick={() => selectPeerForChat(p)}>
                  <div className="itemTitle">
                    <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span className="truncate">{p.userName}</span>
                      <PeerShareMarks
                        sharing={screenSharingPeerId === p.peerId}
                        recording={peerIsRecording(p.peerId)}
                        shareTitle={t("screenShareIndicator")}
                        recTitle={t("recordingBy", { name: p.userName })}
                      />
                      {unreadPeerIds.has(p.peerId) && <span className="unreadMessageDot" title={t("newMessage")} aria-label={t("newMessage")} />}
                    </div>
                    <span className={`badge ${statusBadgeClass(p.status)}`}>{statusLabel(p.status)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {p.host}:{p.port}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn grow" onClick={(e) => (e.stopPropagation(), selectPeerForChat(p))}>
                      {t("write")}
                    </button>
                    <button className="btn btnPrimary grow" onClick={(e) => (e.stopPropagation(), void startDirectCall(p))}>
                      {t("call")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          </>
          )}

          {settingsTab === "help" && <SettingsHelpPanel language={profile?.language ?? "ru"} version={appVersion} />}
          </div>

          <div className="settingsFooter row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const logInfo = await window.lokameet.log.getInfo();
                  if (logInfo.logDirPath) {
                    await window.lokameet.app.openPath(logInfo.logDirPath);
                  } else {
                    setError(t("errLogsPathMissing"));
                  }
                } catch (e) {
                  setError(t("errOpenLogs"));
                }
              }}
            >
              📁 {t("openLogsFolder")}
            </button>
            <button
              className="btn btnDanger"
              onClick={() => {
                if (confirm(t("clearHistoryConfirm"))) {
                  window.lokameet.chat.clearHistory().then(() => {
                    setChats([]);
                    setError(null);
                  }).catch(() => {
                    setError(t("errClearHistory"));
                  });
                }
              }}
            >
              {t("clearHistory")}
            </button>
            <button
              className="btn btnPrimary"
              onClick={() => {
                const patch: Partial<UserProfile> = {
                  uiChatHeight: chatHeight,
                  uiSidebarWidth: sidebarWidth,
                  uiFontScale: fontScale,
                  uiCompact: compactUi,
                  uiShowSeconds: showSeconds,
                  autoAwayMinutes,
                  defaultVideoQuality: mediaCfg.videoQuality,
                  autoSwitchToChatOnAccept: autoSwitchToChat,
                  videoInputDeviceId: selectedVideoDeviceId,
                  cameraControls,
                  cameraFx: {
                    cropZoom: cameraFx.cropZoom,
                    cropPanX: cameraFx.cropPanX,
                    cropPanY: cameraFx.cropPanY,
                    backgroundMode: cameraFx.backgroundMode,
                    backgroundPreset: cameraFx.presetId,
                    backgroundCustomId: cameraFx.customId ?? undefined,
                    blurAmount: cameraFx.blurAmount
                  },
                  audioInputDeviceId: selectedAudioInputId,
                  audioOutputDeviceId: selectedAudioOutputId,
                  chatAutoScroll,
                  chatSmileSizePx,
                  chatFontSize,
                  chatDisplayLimit,
                  uiSpeakingIndicator: speakingIndicator,
                  uiTileAspect: tileAspect,
                  uiTileObjectFit: tileObjectFit,
                  uiTileRadius: tileRadius,
                  uiTileGap: tileGap,
                  uiLayoutVersion: 2,
                  microphoneVolume,
                  speakerVolume: remoteMicVolume,
                  remoteMicVolume,
                  remoteScreenShareVolume,
                  noiseSuppression,
                  noiseSuppressionSensitivity,
                  soundNotificationsEnabled,
                  soundNotificationVolume,
                  callSoundFile,
                  messageSoundFile,
                  callerSoundFile,
                  connectionSoundFile,
                  recordingSoundFile,
                  callSoundVolume,
                  messageSoundVolume,
                  callerSoundVolume,
                  connectionSoundVolume,
                  recordingSoundVolume,
                  recordingDir,
                  lastRecordingPath,
                  recordingFormat,
                  recordingQuality,
                  recordingFps,
                  recordingBitrate
                };
                window.lokameet.app
                  .updateProfile(patch)
                  .then((p) => {
                    setProfile(p);
                    if (isSettingsWindow) void window.lokameet.settings.close();
                    else setSettingsOpen(false);
                  })
                  .catch(() => undefined);
              }}
            >
              Сохранить
            </button>
          </div>

          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Примечание: часть сетевых настроек (порты/обнаружение) можно расширить при необходимости.
          </div>
        </Modal>
      )}
    </div>
  );
}

function ChatComposer(props: { disabled: boolean; onSend: (text: string) => void; onSendFile: (file: File) => void; smilesFiles: string[]; onTyping?: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [smilesOpen, setSmilesOpen] = useState(false);
  const smilesBtnRef = useRef<HTMLButtonElement | null>(null);
  const smilesRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!smilesOpen) return;
    const onDown = (e: MouseEvent) => {
      const tEl = e.target as Node | null;
      if (!tEl) return;
      if (smilesRef.current?.contains(tEl)) return;
      if (smilesBtnRef.current?.contains(tEl)) return;
      setSmilesOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [smilesOpen]);

  return (
    <div className="chatInput" style={{ position: "relative" }}>
      <input
        ref={fileRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onSendFile(f);
          e.currentTarget.value = "";
        }}
      />
      <button className="btn" disabled={props.disabled} onClick={() => fileRef.current?.click()}>
        {t("file")}
      </button>
      <button
        ref={smilesBtnRef}
        className="btn"
        disabled={props.disabled}
        onClick={() => setSmilesOpen((v) => !v)}
        aria-expanded={smilesOpen}
      >
        {t("stickers")}
      </button>
      {smilesOpen && (
        <div className="smilesPopup" ref={smilesRef}>
          <div className="smilesGrid">
            {props.smilesFiles.map((f) => (
              <button
                key={f}
                className="smileBtn"
                onClick={() => {
                  setText((prev) => (prev ? `${prev} :${f}: ` : `:${f}: `));
                  setSmilesOpen(false);
                  setTimeout(() => inputRef.current?.focus(), 0);
                  setSmilesOpen(false);
                }}
                title={f}
              >
                <img className="smileImg" src={`./smiles/${encodeURIComponent(f)}`} alt={f} />
              </button>
            ))}
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        disabled={props.disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Отправляем уведомление о наборе текста (не чаще раза в секунду)
          if (props.onTyping && e.target.value.trim().length > 0) {
            if (typingTimeoutRef.current) return;
            props.onTyping();
            typingTimeoutRef.current = window.setTimeout(() => {
              typingTimeoutRef.current = null;
            }, 1000);
          }
        }}
        placeholder={props.disabled ? t("pickChatPlaceholder") : t("messagePlaceholder")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const v = text;
            setText("");
            if (typingTimeoutRef.current) {
              clearTimeout(typingTimeoutRef.current);
              typingTimeoutRef.current = null;
            }
            props.onSend(v);
          }
        }}
      />
      <button
        className="btn btnPrimary"
        disabled={props.disabled || !text.trim()}
        onClick={() => {
          const v = text;
          setText("");
          props.onSend(v);
        }}
      >
        {t("send")}
      </button>
    </div>
  );
}

function SettingsHelpPanel(props: { language: "ru" | "en"; version: string }) {
  const ru = props.language !== "en";
  const openLink = (url: string) => {
    void window.lokameet.app.openExternal(url).catch(() => undefined);
  };

  const copy = ru
    ? {
        heroTitle: "LokaMeet",
        heroLead: "Видеосвязь, звонки и чат в локальной сети — без интернета и без облака.",
        aboutTitle: "Для чего программа",
        aboutBody:
          "LokaMeet предназначен для общения внутри одной локальной сети (офис, дом, учебный класс): личные звонки, групповые конференции, текстовый чат и обмен файлами. Медиа идут напрямую между компьютерами (P2P WebRTC), а серверы в интернете не нужны.",
        howTitle: "Как это работает",
        howItems: [
          "При запуске приложение поднимает локальный сигнальный сервер и объявляет себя в LAN через mDNS (Bonjour) и UDP‑broadcast.",
          "В списке «Пользователи в LAN» появляются другие запущенные клиенты в той же сети.",
          "Личный звонок — WebRTC peer‑to‑peer между двумя участниками.",
          "Конференция — mesh‑соединения: хост создаёт комнату, участники подключаются к нему и друг к другу.",
          "Чат и статусы передаются по тому же локальному каналу; история хранится на вашем компьютере."
        ],
        needTitle: "Что нужно для корректной работы",
        needItems: [
          "Все участники в одной локальной сети (один сегмент LAN / Wi‑Fi).",
          "Разрешения Windows на камеру и микрофон для LokaMeet.",
          "В брандмауэре Windows разрешены входящие/исходящие соединения для приложения (или «Частные сети»).",
          "Для автообнаружения желателен mDNS (UDP 5353). Если mDNS блокируется, сработает UDP‑фолбэк (порт 45454).",
          "Антивирус/фильтры не должны резать локальный UDP/WebRTC‑трафик.",
          "Для демонстрации экрана — доступ к захвату экрана в системе."
        ],
        softwareTitle: "Какие программы нужны",
        softwareIntro:
          "Для обычного использования LokaMeet почти ничего дополнительно устанавливать не нужно — это самостоятельное приложение. Ниже — обязательное, желательное и то, что нужно только разработчикам.",
        softwareRequiredTitle: "Обязательно",
        softwareRequired: [
          "Windows и сама программа LokaMeet (установщик или portable‑сборка).",
          "Камера и/или микрофон (и разрешения Windows для LokaMeet).",
          "Общая локальная сеть с другими участниками."
        ],
        softwareOptionalTitle: "Желательно для стабильного автопоиска",
        softwareOptional: [
          "Bonjour Print Services (Apple) — улучшает mDNS‑обнаружение в Windows.",
          "Правила брандмауэра Windows: разрешить LokaMeet в частных сетях."
        ],
        softwareDevTitle: "Только для сборки из исходников",
        softwareDev: ["Node.js (npm)", "Зависимости проекта через npm install (Electron и др. подтянутся сами)."],
        softwareNotNeededTitle: "Не требуется",
        softwareNotNeeded:
          "Интернет, Zoom, браузер, отдельный медиа‑сервер или облачный аккаунт — для работы звонков в LAN не нужны.",
        linksTitle: "Полезные ссылки и программы",
        tip: "Если пользователи не видны друг друга: проверьте сеть, брандмауэр и попробуйте ручное подключение по IP/порту во вкладке «Подключение».",
        changesTitle: "Что нового в 1.1.0",
        changesItems: [
          "Камера: виртуальный фон (размытие, 11 пресетов, свои картинки), кадрирование и зум без перезапуска камеры.",
          "Ручные параметры камеры: фокус, экспозиция, баланс белого, яркость и другие, если устройство их умеет.",
          "Качество исходящего видео: 360p, 480p, 720p, 1080p, 1440p и 4K.",
          "Запись звонков и конференций в MP4 или AVI (разрешение, FPS, битрейт, папка сохранения), в том числе во время демонстрации экрана.",
          "Индикатор записи у участников, системные сообщения в чате и звук старта/остановки.",
          "Демонстрация экрана: камера докладчика поверх трансляции.",
          "Подтверждение выхода из звонка и отмена передачи файла.",
          "Исправлены чёрные пятна вокруг рук и движущихся объектов при пресете фона."
        ]
      }
    : {
        heroTitle: "LokaMeet",
        heroLead: "Video calls and chat on your local network — no internet and no cloud.",
        aboutTitle: "What the app is for",
        aboutBody:
          "LokaMeet is for talking inside one LAN (office, home, classroom): direct calls, group conferences, text chat and file transfer. Media goes peer‑to‑peer via WebRTC; no online servers are required.",
        howTitle: "How it works",
        howItems: [
          "On start the app opens a local signaling server and announces itself on the LAN via mDNS (Bonjour) and UDP broadcast.",
          "Other running clients on the same network appear under “Users in LAN”.",
          "A direct call is a WebRTC peer‑to‑peer session between two people.",
          "A conference is a mesh: the host creates a room; others join and connect to each other.",
          "Chat and status events use the same local channel; history is stored on your PC."
        ],
        needTitle: "What you need for reliable operation",
        needItems: [
          "Everyone on the same local network segment (LAN / Wi‑Fi).",
          "Camera and microphone permissions for LokaMeet in Windows.",
          "Windows Firewall allowing the app on private networks.",
          "mDNS (UDP 5353) helps discovery; if blocked, UDP fallback (port 45454) is used.",
          "Security software must not block local UDP/WebRTC traffic.",
          "Screen capture permission for screen sharing."
        ],
        softwareTitle: "What software do you need",
        softwareIntro:
          "For normal use you barely need anything else — LokaMeet is a standalone app. Below: required, recommended, and developer-only items.",
        softwareRequiredTitle: "Required",
        softwareRequired: [
          "Windows and LokaMeet itself (installer or portable build).",
          "Camera and/or microphone (plus Windows permissions for LokaMeet).",
          "A shared local network with the other participants."
        ],
        softwareOptionalTitle: "Recommended for stable discovery",
        softwareOptional: [
          "Bonjour Print Services (Apple) — improves mDNS discovery on Windows.",
          "Windows Firewall rules allowing LokaMeet on private networks."
        ],
        softwareDevTitle: "Only when building from source",
        softwareDev: ["Node.js (npm)", "Project dependencies via npm install (Electron etc. come with them)."],
        softwareNotNeededTitle: "Not required",
        softwareNotNeeded:
          "Internet, Zoom, a browser, a separate media server, or a cloud account are not needed for LAN calls.",
        linksTitle: "Useful links & software",
        tip: "If peers do not appear: check the network and firewall, then try manual connect by IP/port in the Connection tab.",
        changesTitle: "What's new in 1.1.0",
        changesItems: [
          "Camera: virtual background (blur, 11 presets, custom images), framing and zoom without restarting the camera.",
          "Manual camera controls: focus, exposure, white balance, brightness and more when the device supports them.",
          "Outgoing video quality: 360p, 480p, 720p, 1080p, 1440p and 4K.",
          "Record calls and conferences to MP4 or AVI (resolution, FPS, bitrate, output folder), including during screen share.",
          "Recording indicator for participants, chat system messages, and start/stop sound.",
          "Screen share: presenter’s camera overlay.",
          "Confirm before leaving a call, and cancel an in-progress file transfer.",
          "Fixed black spots around hands and moving objects when a preset background is on."
        ]
      };

  const links = [
    {
      title: ru ? "Bonjour Print Services (Windows)" : "Bonjour Print Services (Windows)",
      desc: ru
        ? "Рекомендуется для надёжного mDNS‑обнаружения пользователей в LAN."
        : "Recommended for reliable mDNS discovery of peers on the LAN.",
      url: "https://support.apple.com/kb/DL999"
    },
    {
      title: ru ? "Брандмауэр Windows" : "Windows Firewall",
      desc: ru
        ? "Откройте параметры и разрешите LokaMeet для частных сетей."
        : "Open settings and allow LokaMeet on private networks.",
      url: "ms-settings:windowsdefendersecuritycenter-firewall"
    },
    {
      title: ru ? "Node.js (только для разработки)" : "Node.js (development only)",
      desc: ru
        ? "Нужен, если собираете LokaMeet из исходников через npm."
        : "Needed only if you build LokaMeet from source with npm.",
      url: "https://nodejs.org/"
    },
    {
      title: "WebRTC",
      desc: ru
        ? "Технология P2P‑аудио/видео, на которой построены звонки LokaMeet."
        : "The P2P audio/video technology behind LokaMeet calls.",
      url: "https://webrtc.org/"
    },
    {
      title: "Electron",
      desc: ru ? "Платформа десктоп‑приложения." : "Desktop app runtime.",
      url: "https://www.electronjs.org/"
    }
  ];

  return (
    <div className="helpPanel">
      <div className="helpHero">
        <div className="helpHeroTitleRow">
          <div className="helpHeroTitle">{copy.heroTitle}</div>
          <span className="appVersionBadge" title={ru ? "Версия сборки" : "Build version"}>
            v{props.version}
          </span>
        </div>
        <p className="helpHeroLead">{copy.heroLead}</p>
      </div>

      <section className="helpSection">
        <h3>{copy.changesTitle}</h3>
        <ul className="helpList">
          {copy.changesItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="helpSection">
        <h3>{copy.aboutTitle}</h3>
        <p>{copy.aboutBody}</p>
      </section>

      <section className="helpSection">
        <h3>{copy.howTitle}</h3>
        <ul className="helpList">
          {copy.howItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="helpSection">
        <h3>{copy.needTitle}</h3>
        <ul className="helpList">
          {copy.needItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="helpSection helpSoftware">
        <h3>{copy.softwareTitle}</h3>
        <p>{copy.softwareIntro}</p>
        <div className="helpSoftGrid">
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareRequiredTitle}</div>
            <ul className="helpList">
              {copy.softwareRequired.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareOptionalTitle}</div>
            <ul className="helpList">
              {copy.softwareOptional.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareDevTitle}</div>
            <ul className="helpList">
              {copy.softwareDev.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="helpSoftNote">{copy.softwareNotNeededTitle}: {copy.softwareNotNeeded}</div>
      </section>

      <section className="helpSection">
        <h3>{copy.linksTitle}</h3>
        <div className="helpLinks">
          {links.map((link) => (
            <button
              key={link.url}
              type="button"
              className="helpLinkCard"
              onClick={() => openLink(link.url)}
              title={link.url}
            >
              <span className="helpLinkTitle">{link.title}</span>
              <span className="helpLinkDesc">{link.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="helpTip">{copy.tip}</div>
    </div>
  );
}

function Modal(props: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  size?: "default" | "settings";
  native?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const isSettings = props.size === "settings";
  const native = Boolean(props.native);
  const defaultW = 720;
  const defaultH = 780;
  const minSizeRef = useRef({
    w: Math.min(defaultW, window.innerWidth - 16),
    h: Math.min(defaultH, Math.floor(window.innerHeight * 0.88), window.innerHeight - 16)
  });
  const [box, setBox] = useState(minSizeRef.current);
  const boxRef = useRef(box);
  boxRef.current = box;
  const posRef = useRef(pos);
  posRef.current = pos;
  const resizeRef = useRef<{
    edge: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  useEffect(() => {
    if (native) return;
    const clampPos = (x: number, y: number, w: number, h: number) => ({
      x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - h - 8, y))
    });

    const onMove = (e: MouseEvent) => {
      const resize = resizeRef.current;
      if (resize) {
        const minW = minSizeRef.current.w;
        const minH = minSizeRef.current.h;
        const maxW = window.innerWidth - 16;
        const maxH = window.innerHeight - 16;
        const dx = e.clientX - resize.startX;
        const dy = e.clientY - resize.startY;
        let w = resize.startW;
        let h = resize.startH;
        let x = resize.startLeft;
        let y = resize.startTop;
        if (resize.edge.includes("e")) w = resize.startW + dx;
        if (resize.edge.includes("s")) h = resize.startH + dy;
        if (resize.edge.includes("w")) {
          w = resize.startW - dx;
          w = Math.max(minW, Math.min(maxW, w));
          x = resize.startLeft + resize.startW - w;
        } else {
          w = Math.max(minW, Math.min(maxW, w));
        }
        if (resize.edge.includes("n")) {
          h = resize.startH - dy;
          h = Math.max(minH, Math.min(maxH, h));
          y = resize.startTop + resize.startH - h;
        } else {
          h = Math.max(minH, Math.min(maxH, h));
        }
        const nextPos = clampPos(x, y, w, h);
        setBox({ w, h });
        setPos(nextPos);
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const w = boxRef.current.w;
      const h = boxRef.current.h;
      setPos(clampPos(e.clientX - d.dx, e.clientY - d.dy, w, h));
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [native]);

  const beginResize = (edge: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const panel = e.currentTarget.parentElement as HTMLElement;
    const rect = panel.getBoundingClientRect();
    resizeRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
      startLeft: rect.left,
      startTop: rect.top
    };
    setPos({ x: rect.left, y: rect.top });
    setBox({ w: rect.width, h: rect.height });
  };

  return (
    <div
      className={`modalOverlay${native ? " is-native" : ""}`}
      onMouseDown={native ? undefined : props.onClose}
    >
      <div
        className={`panel modalPanel${isSettings ? " modalPanelSettings" : ""}${native ? " is-native" : ""}`}
        style={
          native
            ? undefined
            : {
                left: pos ? pos.x : "50%",
                top: pos ? pos.y : "50%",
                transform: pos ? "none" : "translate(-50%, -50%)",
                ...(isSettings ? { width: box.w, height: box.h, maxHeight: box.h } : {})
              }
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className={`panelHeader${native ? " is-nativeDrag" : ""}`}
          style={{ cursor: "move", userSelect: "none" }}
          onMouseDown={
            native
              ? undefined
              : (e) => {
                  if (e.button !== 0) return;
                  const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
                  setPos({ x: rect.left, y: rect.top });
                }
          }
        >
          <div className="truncate" title={props.title}>
            {props.title}
          </div>
          <button className="btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className={`panelBody modalBody${isSettings ? " modalBodySettings" : ""}`}>{props.children}</div>
        {isSettings && !native && (
          <>
            <div className="modalResizeHandle modalResizeHandle-n" onMouseDown={(e) => beginResize("n", e)} />
            <div className="modalResizeHandle modalResizeHandle-s" onMouseDown={(e) => beginResize("s", e)} />
            <div className="modalResizeHandle modalResizeHandle-e" onMouseDown={(e) => beginResize("e", e)} />
            <div className="modalResizeHandle modalResizeHandle-w" onMouseDown={(e) => beginResize("w", e)} />
            <div className="modalResizeHandle modalResizeHandle-ne" onMouseDown={(e) => beginResize("ne", e)} />
            <div className="modalResizeHandle modalResizeHandle-nw" onMouseDown={(e) => beginResize("nw", e)} />
            <div className="modalResizeHandle modalResizeHandle-se" onMouseDown={(e) => beginResize("se", e)} />
            <div className="modalResizeHandle modalResizeHandle-sw" onMouseDown={(e) => beginResize("sw", e)} />
          </>
        )}
      </div>
    </div>
  );
}

function renderTextWithSmiles(text: string, smilesSet: Set<string>) {
  // Формат токена: :filename.gif: или :filename.png:
  const re = /:([^:\s]+?\.(?:gif|png)):/gi;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = re.lastIndex;
    const file = m[1];
    if (start > last) out.push(text.slice(last, start));
    if (file && smilesSet.has(file.toLowerCase())) {
      out.push(
        <img
          key={`${start}-${file}`}
          className="smileImg"
          style={{ verticalAlign: "middle" }}
          src={`./smiles/${encodeURIComponent(file)}`}
          alt={file}
          title={file}
        />
      );
    } else {
      out.push(text.slice(start, end));
    }
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return <span>{out}</span>;
}

