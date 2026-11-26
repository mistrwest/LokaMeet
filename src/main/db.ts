import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuid } from "uuid";
import type { AvatarFocus, CallRecord, ChatMessage, ChatMeta, Identity, Presence, Profile, Room, Settings } from "../shared/types";
import { colorFromId } from "../shared/types";

export interface DatabaseShape {
  profile: Profile;
  settings: Settings;
  messages: Record<string, ChatMessage[]>;
  unread: Record<string, number>;
  rooms: Room[];
  calls: CallRecord[];
  openChatId: string;
  contacts: Record<string, { id: string; name: string; color: string; avatar?: string; avatarFocus?: AvatarFocus; ts: number }>;
  hiddenChats: string[];
  threads: Record<string, ChatMeta>;
  identities: Identity[];
}

const MAX_MESSAGES = 1000;

export function defaultSettings(recordDir: string): Settings {
  return {
    locale: "ru",
    noiseSuppression: true,
    vad: false,
    vadSensitivity: 55,
    callSound: true,
    messageSound: true,
    retentionDays: 30,
    recordDir,
    shareVolume: 1,
    peerVolume: 1,
    bgMode: "off",
    bgBlur: 12,
    bgPreset: "office",
    bgCustom: "",
    theme: "ink",
    micId: "",
    speakerId: "",
    cameraId: "",
    echoCancellation: true,
    autoGain: true,
    micGain: 1,
    desktopNotify: false,
    notifyJoin: true,
    notifyRecord: true,
    camMirror: true,
    camWidth: 1280,
    camHeight: 720,
    camFps: 30,
    camFacing: "",
    camTune: {},
    fontScale: 1,
    reduceMotion: false,
    notifyVolume: 0.7,
    volumeCall: 0.7,
    volumeMessage: 0.7,
    volumeJoin: 0.7,
    volumeRecord: 0.7,
    toneCall: "default",
    toneMessage: "default",
    toneJoin: "default",
    toneRecord: "default",
    joinMuted: false,
    enterToSend: true,
    layoutList: 400,
    layoutRail: 220,
    layoutChat: 340,
    gameDifficulty: "normal",
    gameHints: true,
    gameInviteSound: true,
    gameInviteVolume: 0.7,
    awayMinutes: 10,
    chatSize: "m",
    chatDense: false,
    chatAvatars: true,
  };
}

export class Database {
  private data: DatabaseShape;
  private file: string;

  constructor(private root: string) {
    this.file = path.join(root, "db.json");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "files"), { recursive: true });
    fs.mkdirSync(path.join(root, "recordings"), { recursive: true });
    const recordDir = path.join(root, "recordings");
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as DatabaseShape;
      parsed.settings = { ...defaultSettings(recordDir), ...parsed.settings };
      parsed.profile.status ??= "online";
      parsed.messages ??= {};
      parsed.unread ??= {};
      parsed.rooms = [];
      parsed.calls ??= [];
      parsed.openChatId ??= "";
      parsed.contacts ??= {};
      parsed.hiddenChats ??= [];
      parsed.threads ??= {};
      parsed.identities ??= [];
      this.data = parsed;
      this.seedIdentities();
      this.backfillThreads();
    } else {
      this.data = {
        profile: { id: uuid(), name: "", status: "online" },
        settings: defaultSettings(recordDir),
        messages: {},
        unread: {},
        rooms: [],
        calls: [],
        openChatId: "",
        contacts: {},
        hiddenChats: [],
        threads: {},
        identities: [],
      };
      this.flush();
    }
  }

  get shape(): DatabaseShape {
    return this.data;
  }

  get color(): string {
    return colorFromId(this.data.profile.id);
  }

  filesDir(): string {
    return path.join(this.root, "files");
  }

  flush(): void {
    const tmp = this.file + ".tmp";
    const persisted = { ...this.data, rooms: [] as Room[] };
    fs.writeFileSync(tmp, JSON.stringify(persisted));
    fs.renameSync(tmp, this.file);
  }

  setProfile(patch: Partial<Profile>): void {
    const next = { ...this.data.profile, ...patch, id: this.data.profile.id };
    if (!next.avatar) {
      delete next.avatar;
      delete next.avatarFocus;
    }
    if (!next.avatarFocus) delete next.avatarFocus;
    this.data.profile = next;
    this.rememberIdentity();
    this.flush();
  }

  private seedIdentities(): void {
    if (this.data.identities.length || !this.data.profile.name) return;
    this.rememberIdentity();
    this.flush();
  }

  rememberIdentity(): void {
    const profile = this.data.profile;
    if (!profile.name) return;
    const entry: Identity = {
      id: profile.id,
      name: profile.name,
      avatar: profile.avatar,
      avatarFocus: profile.avatarFocus,
      status: profile.status || "online",
      lastUsed: Date.now(),
    };
    this.data.identities = [entry, ...this.data.identities.filter((item) => item.id !== profile.id)].slice(0, 12);
  }

  useIdentity(id: string, status?: Presence): Profile | undefined {
    const found = this.data.identities.find((item) => item.id === id);
    if (!found) return undefined;
    const nextStatus = status === "invisible" || status === "busy" || status === "online" ? status : found.status || "online";
    this.data.profile = {
      id: found.id,
      name: found.name,
      avatar: found.avatar,
      avatarFocus: found.avatarFocus,
      status: nextStatus,
    };
    found.status = nextStatus;
    found.lastUsed = Date.now();
    this.flush();
    return this.data.profile;
  }

  enterAs(body: { name: string; avatar?: string; avatarFocus?: AvatarFocus; status: Presence; fresh?: boolean }): Profile {
    const name = body.name.slice(0, 40);
    const fresh = Boolean(body.fresh && this.data.profile.name);
    this.data.profile = {
      id: fresh ? uuid() : this.data.profile.id,
      name,
      avatar: body.avatar || undefined,
      avatarFocus: body.avatar ? body.avatarFocus : undefined,
      status: body.status,
    };
    this.rememberIdentity();
    this.flush();
    return this.data.profile;
  }

  setSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.flush();
  }

  setOpenChat(chatId: string): void {
    this.data.openChatId = chatId;
    if (chatId) this.data.unread[chatId] = 0;
    this.flush();
  }

  addMessage(message: ChatMessage, countUnread: boolean): void {
    const list = this.data.messages[message.chatId] ?? [];
    list.push(message);
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
    this.data.messages[message.chatId] = list;
    if (countUnread && this.data.openChatId !== message.chatId && message.senderId !== this.data.profile.id) {
      this.data.unread[message.chatId] = (this.data.unread[message.chatId] ?? 0) + 1;
    }
    this.data.hiddenChats = this.data.hiddenChats.filter((id) => id !== message.chatId);
    this.noteThread(message);
    this.flush();
  }

  noteThread(message: ChatMessage, title = ""): void {
    const chatId = message.chatId;
    if (!chatId) return;
    const group = chatId.startsWith("room:");
    const prev = this.data.threads[chatId];
    const fromSys = message.kind === "system" && message.text.startsWith("sys:") ? message.text.split("\t")[2] || "" : "";
    const peerId = chatId.startsWith("dm:") ? chatId.slice(3) : undefined;
    const contact = peerId ? this.data.contacts[peerId] : undefined;
    this.data.threads[chatId] = {
      title: title || fromSys || contact?.name || prev?.title || "",
      kind: group ? "group" : "dm",
      color: contact?.color || prev?.color || (group ? "#2f6fed" : "#4c8dff"),
      photo: contact?.avatar || prev?.photo,
      avatarFocus: contact?.avatarFocus || prev?.avatarFocus,
      peerId,
    };
  }

  private backfillThreads(): void {
    for (const [chatId, list] of Object.entries(this.data.messages)) {
      if (this.data.threads[chatId]?.title) continue;
      const lastSys = [...(list ?? [])].reverse().find((item) => item.kind === "system" && item.text.startsWith("sys:"));
      const last = list?.[list.length - 1];
      if (last) this.noteThread(lastSys ?? last);
    }
  }

  touchContact(peer: { id: string; name: string; color: string; avatar?: string; avatarFocus?: AvatarFocus }): void {
    if (!peer.id) return;
    this.data.contacts[peer.id] = {
      id: peer.id,
      name: peer.name,
      color: peer.color,
      avatar: peer.avatar,
      avatarFocus: peer.avatarFocus,
      ts: Date.now(),
    };
    this.flush();
  }

  hideChat(chatId: string): void {
    if (!chatId) return;
    delete this.data.messages[chatId];
    delete this.data.unread[chatId];
    delete this.data.threads[chatId];
    if (!this.data.hiddenChats.includes(chatId)) this.data.hiddenChats.push(chatId);
    if (this.data.openChatId === chatId) this.data.openChatId = "";
    this.flush();
  }

  updateMessage(chatId: string, id: string, patch: Partial<ChatMessage> & { file?: ChatMessage["file"] }): ChatMessage | undefined {
    const list = this.data.messages[chatId] ?? [];
    const message = list.find((item) => item.id === id);
    if (!message) return undefined;
    if (patch.file) message.file = { ...message.file, ...patch.file } as ChatMessage["file"];
    const { file, ...rest } = patch;
    Object.assign(message, rest);
    void file;
    this.flush();
    return message;
  }

  findByTransfer(transferId: string): ChatMessage | undefined {
    for (const list of Object.values(this.data.messages)) {
      const found = list.find((item) => item.file?.transferId === transferId);
      if (found) return found;
    }
    return undefined;
  }

  pendingFor(peerId: string): ChatMessage[] {
    const chatId = `dm:${peerId}`;
    return (this.data.messages[chatId] ?? []).filter((item) => item.status === "pending" && item.senderId === this.data.profile.id);
  }

  markDelivered(chatId: string, id: string): void {
    const message = (this.data.messages[chatId] ?? []).find((item) => item.id === id);
    if (!message) return;
    message.status = "delivered";
    this.flush();
  }

  addCall(call: CallRecord): void {
    this.data.calls.unshift(call);
    this.data.calls = this.data.calls.slice(0, 200);
    this.flush();
  }

  saveRoom(room: Room): void {
    const index = this.data.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) this.data.rooms[index] = room;
    else this.data.rooms.push(room);
    this.flush();
  }

  dropRoom(roomId: string): void {
    this.data.rooms = this.data.rooms.filter((item) => item.id !== roomId);
    this.flush();
  }

  markFilesDeleted(predicate: (filePath: string) => boolean): number {
    let count = 0;
    for (const list of Object.values(this.data.messages)) {
      for (const message of list) {
        if (!message.file?.path || message.file.deleted) continue;
        if (!predicate(message.file.path)) continue;
        message.file.deleted = true;
        message.file.path = undefined;
        count += 1;
      }
    }
    if (count) this.flush();
    return count;
  }
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

export function newSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function newId(): string {
  return uuid();
}
