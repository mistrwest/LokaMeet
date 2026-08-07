export type AvailabilityStatus =
  | "online"
  | "away"
  | "dnd"
  | "offline"
  | "in_conference"
  | "in_call";

export type PeerInfo = {
  peerId: string;
  userName: string;
  status: AvailabilityStatus;
  statusText?: string;
  avatarHash?: string;
  avatarPosition?: { x: number; y: number };
  host: string;
  port: number;
  lastSeenAt: number;
};

export type RoomInfo = {
  roomId: string;
  roomName: string;
  hostPeerId: string;
  host: string;
  port: number;
  hasPassword: boolean;
  maxParticipants: number;
  participantsApprox: number;
  lastSeenAt: number;
};

export type UserProfile = {
  peerId: string;
  userName: string;
  status: AvailabilityStatus;
  statusText?: string;
  language: "ru" | "en";
  theme:
    | "light"
    | "dark"
    | "warm-dark"
    | "soft-light"
    | "ocean-blue"
    | "ocean-dusk"
    | "ipad-slate"
    | "ipad-lagoon"
    | "ipad-midnight";
  avatarHash?: string;
  avatarPosition?: { x: number; y: number };
  hasChosenName?: boolean;
  uiChatHeight?: number;
  uiSidebarWidth?: number;
  uiFontScale?: number; // Значение 1.0 сохраняет базовый масштаб интерфейса.
  uiCompact?: boolean;
  uiShowSeconds?: boolean;
  defaultVideoQuality?: "low" | "medium" | "high";
  autoSwitchToChatOnAccept?: boolean;
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  videoInputDeviceId?: string;
  chatAutoScroll?: boolean;
  chatSmileSizePx?: number; // Допустимый диапазон нужен, чтобы смайлы не нарушали вёрстку.
  chatFontSize?: number; // Ограничение диапазона сохраняет читаемость чата.
  chatDisplayLimit?: number; // Ноль отключает ограничение, иначе показываются последние N сообщений.
  uiSpeakingIndicator?: boolean;
  /** Выбор пропорций позволяет предпочесть заполнение сетки или единый размер плиток. */
  uiTileAspect?: "auto" | "16x9" | "4x3" | "1x1";
  /** Режим object-fit задаёт приоритет заполнения плитки или полного изображения. */
  uiTileObjectFit?: "cover" | "contain";
  /** Радиус скругления в пикселях позволяет согласовать плитки с темой интерфейса. */
  uiTileRadius?: number;
  /** Зазор в пикселях сохраняет визуальное разделение участников. */
  uiTileGap?: number;
  /** Версия стандартной раскладки нужна, чтобы безопасно применять будущие миграции настроек. */
  uiLayoutVersion?: number;
  microphoneVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  speakerVolume?: number; // Устаревшее поле сохраняет совместимость и означает громкость микрофона собеседника.
  /** Отдельная громкость микрофона не затрагивает звук демонстрации собеседника. */
  remoteMicVolume?: number;
  /** Отдельная громкость демонстрации не затрагивает микрофон собеседника. */
  remoteScreenShareVolume?: number;
  noiseSuppression?: boolean; // Флаг отделяет настройку алгоритма от состояния микрофона.
  noiseSuppressionSensitivity?: number; // Шкала 0–100 позволяет передавать настройку без преобразования.
  soundNotificationsEnabled?: boolean; // Флаг позволяет отключить сигналы, не теряя выбранные файлы и громкость.
  soundNotificationVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  callSoundFile?: string; // Путь сохраняется отдельно, чтобы пользователь мог выбрать собственный сигнал вызова.
  messageSoundFile?: string; // Путь позволяет независимо настроить сигнал входящего сообщения.
  callerSoundFile?: string; // Отдельный путь различает сигнал у инициатора и получателя звонка.
  connectionSoundFile?: string; // Отдельный путь позволяет настроить звук успешного соединения.
  callSoundVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  messageSoundVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  callerSoundVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  connectionSoundVolume?: number; // Шкала 0–100 соответствует значению регулятора интерфейса.
  /** Ноль отключает авто-статус, чтобы пользователь мог сохранить ручное присутствие. */
  autoAwayMinutes?: number;
};

export type ChatScope =
  | { type: "direct"; peerId: string }
  | { type: "room"; roomId: string };

export type ChatMessage = {
  id: string;
  scope: ChatScope;
  fromPeerId: string;
  fromUserName: string;
  sentAt: number;
  text: string;
  kind?: "system";
  attachment?: ChatAttachment;
};

export type ChatAttachment =
  | {
      kind: "file";
      fileId: string;
      name: string;
      size: number;
      mime?: string;
      previewDataUrl?: string;
    }
  | {
      kind: "image";
      fileId: string;
      name: string;
      size: number;
      mime?: string;
      previewDataUrl?: string;
    }
  | {
      kind: "video";
      fileId: string;
      name: string;
      size: number;
      mime?: string;
      previewDataUrl?: string;
    }
  | {
      kind: "smile";
      file: string;
    };

export type JsonSessionDescription = {
  type: string;
  sdp?: string;
};

export type JsonIceCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type RtcSignal =
  | {
      type: "rtc-offer";
      roomId?: string;
      fromPeerId: string;
      toPeerId: string;
      sdp: JsonSessionDescription;
    }
  | {
      type: "rtc-answer";
      roomId?: string;
      fromPeerId: string;
      toPeerId: string;
      sdp: JsonSessionDescription;
    }
  | {
      type: "rtc-ice";
      roomId?: string;
      fromPeerId: string;
      toPeerId: string;
      candidate: JsonIceCandidate;
    }
  | {
      type: "screen-share-start";
      roomId?: string;
      fromPeerId: string;
      toPeerId: string;
      userName: string;
      screenAudioTrackId?: string;
    }
  | {
      type: "screen-share-stop";
      roomId?: string;
      fromPeerId: string;
      toPeerId: string;
    };

export type WsEnvelope =
  | {
      type: "hello";
      peerId: string;
      userName: string;
      status: AvailabilityStatus;
      statusText?: string;
      avatarHash?: string;
      avatarPosition?: { x: number; y: number };
    }
  | { type: "direct-call-request"; fromPeerId: string; fromUserName: string }
  | { type: "direct-call-accept"; fromPeerId: string }
  | { type: "direct-call-reject"; fromPeerId: string; reason?: string }
  | { type: "room-join"; roomId: string; peerId: string; userName: string; password?: string }
  | {
      type: "room-welcome";
      roomId: string;
      hostPeerId: string;
      participants: Array<{ peerId: string; userName: string }>;
      maxParticipants: number;
    }
  | { type: "room-peer-joined"; roomId: string; peerId: string; userName: string }
  | { type: "room-peer-left"; roomId: string; peerId: string }
  | { type: "room-leave"; roomId: string; peerId: string }
  | {
      type: "room-invite";
      fromPeerId: string;
      fromUserName: string;
      roomId: string;
      roomName: string;
      hostPeerId: string;
      host: string;
      port: number;
      hasPassword: boolean;
      maxParticipants: number;
      participantsApprox: number;
    }
  | {
      type: "room-invite-reject";
      fromPeerId: string;
      fromUserName: string;
      roomId: string;
      roomName: string;
    }
  | { type: "chat-message"; message: ChatMessage }
  | { type: "avatar-request"; peerId: string; avatarHash?: string }
  | { type: "avatar-data"; peerId: string; avatarHash: string; dataUrl: string }
  | ({ type: "rtc-signal" } & { signal: RtcSignal });

