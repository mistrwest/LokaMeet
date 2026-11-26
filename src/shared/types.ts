export type Locale = "ru" | "en";
export type ThemeId = "ink" | "graphite" | "harbor" | "porcelain" | "sand" | "iris" | "clay" | "grove" | "ember" | "sky" | "dusk" | "azure" | "ice" | "navy";

export type Presence = "online" | "invisible" | "busy" | "away";
export type ShownStatus = "online" | "offline" | "busy" | "away";
export type CallKind = "call" | "conf";

export interface AvatarFocus {
  x: number;
  y: number;
  zoom: number;
}

export interface Profile {
  id: string;
  name: string;
  avatar?: string;
  avatarFocus?: AvatarFocus;
  status: Presence;
}

export interface Identity {
  id: string;
  name: string;
  avatar?: string;
  avatarFocus?: AvatarFocus;
  status: Presence;
  lastUsed: number;
}

export interface Settings {
  locale: Locale;
  noiseSuppression: boolean;
  vad: boolean;
  vadSensitivity: number;
  callSound: boolean;
  messageSound: boolean;
  retentionDays: 0 | 7 | 30 | 90;
  recordDir: string;
  shareVolume: number;
  peerVolume: number;
  bgMode: "off" | "blur" | "image";
  bgBlur: number;
  bgPreset: string;
  bgCustom: string;
  theme: ThemeId;
  micId: string;
  speakerId: string;
  cameraId: string;
  echoCancellation: boolean;
  autoGain: boolean;
  micGain: number;
  desktopNotify: boolean;
  notifyJoin: boolean;
  notifyRecord: boolean;
  camMirror: boolean;
  camWidth: number;
  camHeight: number;
  camFps: number;
  camFacing: "" | "user" | "environment";
  camTune: Record<string, number | string | boolean>;
  fontScale: number;
  reduceMotion: boolean;
  notifyVolume: number;
  volumeCall: number;
  volumeMessage: number;
  volumeJoin: number;
  volumeRecord: number;
  toneCall: string;
  toneMessage: string;
  toneJoin: string;
  toneRecord: string;
  joinMuted: boolean;
  enterToSend: boolean;
  layoutList: number;
  layoutRail: number;
  layoutChat: number;
  gameDifficulty: "easy" | "normal" | "hard";
  gameHints: boolean;
  gameInviteSound: boolean;
  gameInviteVolume: number;
  awayMinutes: number;
  chatSize: "s" | "m" | "l";
  chatDense: boolean;
  chatAvatars: boolean;
}

export type MessageKind = "text" | "image" | "file" | "gif" | "video" | "voice" | "system";

export interface FileInfo {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  path?: string;
  sourcePath?: string;
  preview?: string;
  deleted?: boolean;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string;
  kind: MessageKind;
  text: string;
  replyTo?: { id: string; text: string };
  ts: number;
  editedAt?: number;
  deleted?: boolean;
  status: "pending" | "delivered" | "local" | "failed";
  file?: FileInfo;
}

export type GameId = "chess" | "checkers" | "sea";

export type GameWire =
  | { t: "invite"; matchId: string; game: GameId; mode: "p2p" | "group"; fromName: string }
  | { t: "accept"; matchId: string; name: string }
  | { t: "decline"; matchId: string }
  | { t: "sync"; matchId: string; game: GameId; mode: "p2p" | "group"; white: string; black: string; whiteName: string; blackName: string; seq: number; peers: string[]; chess?: ChessSync; checkers?: CheckersSync; sea?: SeaSync }
  | { t: "move"; matchId: string; seq: number; by: string; chess?: { from: number; to: number; promo: string }; checkers?: { from: number; path: number[] } }
  | { t: "sea"; matchId: string; seq: number; kind: "ready" | "shot" | "result"; seat: "w" | "b"; index?: number; hit?: boolean; sunk?: boolean; win?: boolean }
  | { t: "leave"; matchId: string }
  | { t: "resign"; matchId: string }
  | { t: "resign-offer"; matchId: string }
  | { t: "resign-answer"; matchId: string; accept: boolean }
  | { t: "draw-offer"; matchId: string }
  | { t: "draw-answer"; matchId: string; accept: boolean };

export interface ChessSync {
  board: string;
  turn: "w" | "b";
  castle: string;
  ep: number;
  half: number;
  winner: "" | "w" | "b" | "draw";
  note: "" | "check" | "mate" | "stalemate";
}

export interface CheckersSync {
  board: string;
  turn: "w" | "b";
  winner: "" | "w" | "b" | "draw";
  quiet: number;
}

export interface SeaSync {
  phase: "place" | "battle" | "done";
  turn: "w" | "b";
  ready: { w: boolean; b: boolean };
  winner: "" | "w" | "b";
  shots: { w: number[]; b: number[] };
}

export interface CallRecord {
  id: string;
  title: string;
  peerId?: string;
  roomId?: string;
  direction: "in" | "out" | "missed";
  video: boolean;
  ts: number;
  duration: number;
}

export interface Room {
  id: string;
  name: string;
  salt: string;
  passwordHash: string;
  createdBy: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  ip: string;
  port: number;
  avatar?: string;
  avatarFocus?: AvatarFocus;
  inCall: boolean;
  callKind?: CallKind;
  recording?: boolean;
  sharing?: boolean;
  online: boolean;
  status: ShownStatus;
  firstSeen: number;
  lastSeen: number;
}

export interface ConfInfo {
  hostId: string;
  count: number;
}

export interface RoomInfo extends Room {
  members: string[];
  onlineCount: number;
  conference?: ConfInfo;
  joined: boolean;
}

export interface ChatMeta {
  title: string;
  kind: "dm" | "group";
  color: string;
  photo?: string;
  avatarFocus?: AvatarFocus;
  peerId?: string;
}

export interface Snapshot {
  profile: Profile;
  settings: Settings;
  peers: PeerInfo[];
  messages: Record<string, ChatMessage[]>;
  unread: Record<string, number>;
  rooms: RoomInfo[];
  calls: CallRecord[];
  selfColor: string;
  openChatId: string;
  hiddenChats: string[];
  contacts: Record<string, { id: string; name: string; color: string; avatar?: string; avatarFocus?: AvatarFocus; ts: number }>;
  threads: Record<string, ChatMeta>;
  identities: Identity[];
}

export interface Hello {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  avatarFocus?: AvatarFocus;
  status?: ShownStatus;
  inCall?: boolean;
  callKind?: CallKind;
  recording?: boolean;
  sharing?: boolean;
}

export type SignalPayload =
  | { t: "offer"; sdp: string; purpose?: "file" | "desk" }
  | { t: "answer"; sdp: string; purpose?: "file" | "desk" }
  | { t: "ice"; candidate: RTCIceCandidateInit | null; purpose?: "file" | "desk" }
  | { t: "please-offer"; purpose?: "file" | "desk" }
  | { t: "conf-invite"; roomId: string; name: string; password: string; hostId: string; from: string }
  | { t: "call-invite"; callId: string; video: boolean; name: string }
  | { t: "call-answer"; callId: string; accept: boolean }
  | { t: "call-end"; callId: string }
  | { t: "recording"; on: boolean; started?: number }
  | { t: "screen"; on: boolean; streamId?: string }
  | { t: "mute"; on: boolean; target?: string }
  | { t: "mic"; on: boolean }
  | { t: "control-ask"; name?: string }
  | { t: "control-answer"; accept: boolean; width?: number; height?: number; grant?: string }
  | { t: "control-end" }
  | { t: "control-input"; kind: "move" | "down" | "up" | "wheel" | "key"; x?: number; y?: number; nx?: number; ny?: number; w?: number; h?: number; button?: number; delta?: number; key?: string; down?: boolean; grant?: string }
  | { t: "file-offer"; message: ChatMessage }
  | { t: "file-cancel"; transferId: string }
  | { t: "game"; game: GameWire };

export function dmChat(peerId: string): string {
  return `dm:${peerId}`;
}

export function roomChat(roomId: string): string {
  return `room:${roomId}`;
}

export function colorFromId(id: string): string {
  const palette = ["#4c8dff", "#2fbf9b", "#f0a202", "#ef5b78", "#8b7cf6", "#22b8cf", "#f97316", "#7cb342"];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 33) + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function previewText(message: ChatMessage): string {
  if (message.deleted) return "…";
  const caption = (message.text || "").replace(/\s+/g, " ").trim();
  if (message.kind === "image") return caption || "🖼 Фото";
  if (message.kind === "gif") return caption ? `GIF · ${caption}` : "GIF";
  if (message.kind === "video") return caption || `🎬 ${message.file?.name || "Видео"}`;
  if (message.kind === "voice") return "🎤 Голосовое";
  if (message.kind === "file") return message.file?.name || caption || "Файл";
  return caption;
}
