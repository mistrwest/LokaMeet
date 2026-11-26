import dgram from "dgram";
import fs from "fs";
import net from "net";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { Bonjour } from "bonjour-service";
import { Database, hashPassword, newId, newSalt } from "./db";
import { broadcastTargets, preferredLanIp } from "./lan";
import { ConferenceSfu } from "./sfu";
import { appLog } from "./log";
import { colorFromId, dmChat, roomChat, type AvatarFocus, type CallKind, type ChatMessage, type Hello, type Presence, type Room, type ShownStatus, type SignalPayload, type Snapshot } from "../shared/types";

interface Announcement {
  v: 2;
  id: string;
  name: string;
  port: number;
  inCall: boolean;
  callKind?: CallKind;
  recording?: boolean;
  sharing?: boolean;
  status?: ShownStatus;
  rooms: Room[];
  conf?: { roomId: string; hostId: string; count: number };
}

interface KnownPeer {
  id: string;
  name: string;
  ip: string;
  port: number;
  avatar?: string;
  avatarFocus?: AvatarFocus;
  inCall: boolean;
  callKind?: CallKind;
  recording?: boolean;
  sharing?: boolean;
  status: ShownStatus;
  firstSeen: number;
  lastSeen: number;
  rooms: Room[];
  conf?: { roomId: string; hostId: string; count: number };
}

interface Link {
  ws: WebSocket;
  peerId: string;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type Envelope = Record<string, unknown> & { t: string };

const DISCOVERY_PORT = 47722;
const OFFLINE_MS = 8000;
const ROOM_OWNER_MS = 20000;

export class Hub {
  readonly db: Database;
  private udp?: dgram.Socket;
  private wss?: WebSocketServer;
  private bonjour?: Bonjour;
  private port = Number(process.env.LOKAMEET_PORT || 47721);
  private peers = new Map<string, KnownPeer>();
  private links = new Map<string, Link>();
  private waiters = new Map<string, Waiter>();
  private writers = new Map<string, fs.WriteStream>();
  private sfu = new ConferenceSfu();
  private hosted?: { roomId: string };
  private inCall = false;
  private recording = false;
  private sharing = false;
  private callKind: CallKind | "" = "";
  private displayMedia?: { sourceId: string; withAudio: boolean };
  private closedRooms = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private dialing = new Set<string>();

  constructor(
    private root: string,
    private emit: (event: unknown) => void,
  ) {
    this.db = new Database(root);
    this.sfu.onProducer = (note) => this.fanConf({ t: "producer", ...note }, note.peerId);
    this.sfu.onProducerClosed = (note) => this.fanConf({ t: "producer-closed", ...note }, "");
    this.sfu.onPeerLeft = (peerId) => this.fanConf({ t: "conf-peer-left", peerId }, peerId);
  }

  async start(): Promise<void> {
    this.port = await listenPort(this.port);
    this.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((resolve) => {
      this.udp!.on("listening", () => {
        this.udp!.setBroadcast(true);
        resolve();
      });
      this.udp!.bind(DISCOVERY_PORT);
    });
    this.udp.on("message", (buf, remote) => this.onDiscovery(buf, remote.address));
    this.wss = new WebSocketServer({ port: this.port, maxPayload: 8 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.onIncoming(ws));
    try {
      this.bonjour = new Bonjour();
      this.bonjour.publish({ name: `LokaMeet-${this.db.shape.profile.id.slice(0, 8)}`, type: "lokameet", port: this.port, txt: { id: this.db.shape.profile.id } });
      this.bonjour.find({ type: "lokameet" }, (service) => {
        const id = service.txt?.id;
        const address = service.addresses?.find((item) => item.includes("."));
        if (!id || !address || id === this.db.shape.profile.id || !service.port) return;
        this.notePeer({ id, name: service.name || "LokaMeet", ip: address, port: service.port, inCall: false, lastSeen: Date.now(), rooms: [] });
      });
    } catch (error) {
      appLog("error", "net", "LAN discovery failed", { error: String(error) });
    }
    this.timer = setInterval(() => this.beat(), 2000);
    this.beat();
    this.cleanup(false);
    appLog("info", "app", "Services started", { "signal port": this.port, "UDP discovery": DISCOVERY_PORT });
    appLog("info", "app", "Ready", { "user id": this.db.shape.profile.id });
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.hosted) await this.confEnd();
      await this.closeOwnedRooms();
    } catch {
      /* the process is leaving; still close the sockets below */
    }
    for (const link of this.links.values()) {
      try { link.ws.close(); } catch { /* already closed */ }
    }
    this.udp?.close();
    this.wss?.close();
    this.bonjour?.destroy();
    void this.sfu.stop();
    for (const writer of this.writers.values()) writer.end();
  }

  takeDisplayMedia(): { sourceId: string; withAudio: boolean } | undefined {
    const armed = this.displayMedia;
    this.displayMedia = undefined;
    return armed;
  }

  async handle(cmd: string, data: unknown): Promise<unknown> {
    const body = (data ?? {}) as Record<string, any>;
    switch (cmd) {
      case "snapshot":
        return this.snapshot();
      case "setProfile": {
        const next: { name?: string; avatar?: string; avatarFocus?: AvatarFocus; status?: Presence } = {};
        if (typeof body.name === "string") next.name = body.name.slice(0, 40);
        if (typeof body.avatar === "string") next.avatar = body.avatar || undefined;
        if (body.avatarFocus && typeof body.avatarFocus === "object") next.avatarFocus = readFocus(body.avatarFocus);
        if (body.avatar === "") next.avatarFocus = undefined;
        if (body.status === "online" || body.status === "invisible" || body.status === "busy" || body.status === "away") next.status = body.status;
        this.db.setProfile(next);
        this.broadcastHello();
        this.push();
        return this.snapshot();
      }
      case "pickIdentity": {
        const status = body.status === "invisible" || body.status === "busy" || body.status === "online" ? body.status : undefined;
        this.db.useIdentity(String(body.id ?? ""), status);
        this.broadcastHello();
        this.push();
        return this.snapshot();
      }
      case "enterAs": {
        const status = body.status === "invisible" || body.status === "busy" ? body.status : "online";
        this.db.enterAs({
          name: String(body.name ?? ""),
          avatar: typeof body.avatar === "string" ? body.avatar : undefined,
          avatarFocus: body.avatarFocus && typeof body.avatarFocus === "object" ? readFocus(body.avatarFocus) : undefined,
          status,
          fresh: Boolean(body.fresh),
        });
        this.broadcastHello();
        this.push();
        return this.snapshot();
      }
      case "setSettings":
        this.db.setSettings(body);
        this.push();
        return this.db.shape.settings;
      case "setOpenChat":
        this.db.setOpenChat(String(body.chatId ?? ""));
        this.push();
        return true;
      case "sendChat":
        return this.sendChat(body.message as ChatMessage);
      case "editChat":
        return this.editChat(String(body.chatId ?? ""), String(body.id ?? ""), String(body.text ?? ""));
      case "deleteChat":
        return this.deleteChat(String(body.chatId ?? ""), String(body.id ?? ""));
      case "hideChat":
        this.db.hideChat(String(body.chatId ?? ""));
        this.push();
        return true;
      case "systemChat":
        this.postSystem(String(body.chatId ?? ""), String(body.text ?? ""), Boolean(body.local));
        return true;
      case "createRoom":
        return this.createRoom(String(body.name ?? ""), String(body.password ?? ""));
      case "joinRoom":
        return this.joinRoom(String(body.roomId), String(body.password ?? ""));
      case "leaveRoom":
        await this.leaveRoom(String(body.roomId));
        return true;
      case "manualConnect":
        this.connect(String(body.ip), Number(body.port), "manual");
        return true;
      case "signal":
        this.send(String(body.peerId), { t: "signal", payload: body.payload });
        return true;
      case "setBusy":
        if ("inCall" in body) {
          this.inCall = Boolean(body.inCall);
          this.callKind = this.inCall ? (body.mode === "conf" ? "conf" : "call") : "";
          if (!this.inCall) {
            this.recording = false;
            this.sharing = false;
          }
        }
        if ("recording" in body) this.recording = Boolean(body.recording);
        if ("sharing" in body) this.sharing = Boolean(body.sharing);
        this.broadcastHello();
        this.push();
        return true;
      case "logCall":
        this.db.addCall(body as import("../shared/types").CallRecord);
        this.push();
        return true;
      case "sfu":
        return this.routeSfu(body.op as string, body.data, body.hostId as string | undefined);
      case "confStart":
        return this.confStart(String(body.roomId));
      case "confEnd":
        if (body.hostId && String(body.hostId) !== this.db.shape.profile.id) {
          await this.request(String(body.hostId), "conf-end", {});
        } else {
          await this.confEnd();
        }
        return true;
      case "confNotify":
        this.notifyConference(String(body.roomId ?? ""), Boolean(body.on), body.hostId ? String(body.hostId) : undefined, Number(body.started) || undefined);
        return true;
      case "fileChunk":
        return this.fileChunk(String(body.transferId), body.chunk as number[], Boolean(body.end));
      case "fileCancel":
        this.fileCancel(String(body.transferId));
        return true;
      case "cleanup":
        return this.cleanup(Boolean(body.all));
      case "armDisplayMedia":
        this.displayMedia = { sourceId: String(body.sourceId), withAudio: Boolean(body.withAudio) };
        return true;
      case "pickRecordDir":
        return body.dir ? (this.db.setSettings({ recordDir: String(body.dir) }), this.push(), true) : false;
      case "saveRecording":
        return this.saveRecording(String(body.name), Buffer.from(body.bytes as number[]));
      case "openPath":
        return body.path;
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  }

  private async routeSfu(op: string, data: unknown, hostId?: string): Promise<unknown> {
    if (hostId && hostId !== this.db.shape.profile.id) {
      return this.request(hostId, op, data);
    }
    return this.localSfu(op, (data ?? {}) as Record<string, any>);
  }

  private async localSfu(op: string, data: Record<string, any>): Promise<unknown> {
    if (op === "join") return clone(await this.sfu.join(String(data.peerId)));
    if (op === "connect") {
      await this.sfu.connect(String(data.peerId), String(data.transportId), data.dtlsParameters);
      return true;
    }
    if (op === "produce") {
      const id = await this.sfu.produce(String(data.peerId), String(data.transportId), data.kind, data.rtpParameters, data.appData ?? {});
      return { id };
    }
    if (op === "consume") return clone(await this.sfu.consume(String(data.peerId), String(data.transportId), String(data.producerId), data.rtpCapabilities));
    if (op === "resume") {
      await this.sfu.resume(String(data.consumerId));
      return true;
    }
    if (op === "pause") {
      await this.sfu.pause(String(data.consumerId));
      return true;
    }
    if (op === "layers") {
      await this.sfu.layers(String(data.consumerId), Number(data.spatialLayer));
      return true;
    }
    if (op === "closeProducer") {
      this.sfu.closeProducer(String(data.peerId), String(data.producerId));
      return true;
    }
    if (op === "leave") {
      this.sfu.removePeer(String(data.peerId));
      return true;
    }
    if (op === "muteAudio") {
      this.sfu.muteAudio(String(data.peerId), Boolean(data.on));
      return true;
    }
    throw new Error(`unknown sfu op ${op}`);
  }

  private async confStart(roomId: string): Promise<unknown> {
    const room = this.db.shape.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error("room not joined");
    await this.sfu.start(preferredLanIp());
    this.hosted = { roomId };
    this.inCall = true;
    const joined = await this.localSfu("join", { peerId: this.db.shape.profile.id });
    this.push();
    return joined;
  }

  private async confEnd(): Promise<void> {
    const roomId = this.hosted?.roomId;
    const room = roomId ? this.db.shape.rooms.find((item) => item.id === roomId) : undefined;
    if (roomId && room) this.postSystem(roomChat(roomId), `sys:end-conf\t${this.db.shape.profile.name || "LokaMeet"}\t${room.name}`);
    this.hosted = undefined;
    this.inCall = false;
    this.callKind = "";
    if (roomId) await this.broadcast({ t: "conf-end", roomId }, false);
    await this.sfu.stop();
    if (roomId) {
      const room = this.db.shape.rooms.find((item) => item.id === roomId);
      if (room?.createdBy === this.db.shape.profile.id) {
        this.closedRooms.add(roomId);
        await this.broadcast({ t: "room-closed", roomId }, false);
        this.db.dropRoom(roomId);
        this.emit({ t: "room-closed", roomId });
      }
    }
    this.push();
  }

  private async closeOwnedRooms(): Promise<void> {
    const me = this.db.shape.profile.id;
    for (const room of [...this.db.shape.rooms]) {
      if (room.createdBy !== me || this.closedRooms.has(room.id)) continue;
      this.closedRooms.add(room.id);
      await this.broadcast({ t: "room-closed", roomId: room.id }, false);
    }
  }

  private broadcast(frame: Envelope, alsoSelf: boolean): Promise<void> {
    if (alsoSelf) this.emit(frame);
    return Promise.all([...this.links.values()].map((link) => this.sendAndWait(link.ws, frame))).then(() => undefined);
  }

  private sendAndWait(ws: WebSocket, frame: Envelope): Promise<void> {
    return new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 300);
      try {
        ws.send(JSON.stringify(frame), () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private notifyConference(roomId: string, on: boolean, hostId?: string, started?: number): void {
    const frame: Envelope = { t: "conf-recording", roomId, peerId: this.db.shape.profile.id, on, started, relay: true };
    if (this.hosted?.roomId === roomId) this.fanConf({ ...frame, relay: false }, this.db.shape.profile.id);
    else if (hostId) this.send(hostId, frame);
  }

  private fanConf(message: Envelope, skipPeerId: string): void {
    const ids = new Set(this.sfu.peerIds());
    for (const peerId of ids) {
      if (peerId === skipPeerId) continue;
      if (peerId === this.db.shape.profile.id) this.emit(message);
      else this.send(peerId, message);
    }
  }

  private createRoom(name: string, password: string): Room {
    const salt = password ? newSalt() : "";
    const room: Room = {
      id: newId(),
      name: name.trim().slice(0, 32) || "Комната",
      salt,
      passwordHash: password ? hashPassword(password, salt) : "",
      createdBy: this.db.shape.profile.id,
    };
    this.db.saveRoom(room);
    this.push();
    return room;
  }

  private joinRoom(roomId: string, password: string): Room {
    const room = this.visibleRooms().find((item) => item.id === roomId);
    if (!room) throw new Error("room not found");
    if (room.passwordHash && hashPassword(password, room.salt) !== room.passwordHash) throw new Error("bad password");
    const already = this.db.shape.rooms.some((item) => item.id === room.id);
    this.db.saveRoom({ id: room.id, name: room.name, salt: room.salt, passwordHash: room.passwordHash, createdBy: room.createdBy });
    if (!already) this.postSystem(roomChat(room.id), `sys:join-room\t${this.db.shape.profile.name || "LokaMeet"}\t${room.name}`);
    else this.push();
    return room;
  }

  private postSystem(chatId: string, text: string, local = false): void {
    if (!chatId || !text) return;
    const message: ChatMessage = {
      id: newId(),
      chatId,
      senderId: "system",
      kind: "system",
      text,
      ts: Date.now(),
      status: "local",
    };
    this.db.addMessage(message, false);
    const targets = new Set<string>();
    if (chatId.startsWith("dm:")) targets.add(chatId.slice(3));
    if (chatId.startsWith("room:")) {
      const roomId = chatId.slice(5);
      for (const peer of this.peers.values()) {
        if (peer.rooms.some((room) => room.id === roomId)) targets.add(peer.id);
      }
      if (this.hosted?.roomId === roomId) {
        for (const peerId of this.sfu.peerIds()) {
          if (peerId !== this.db.shape.profile.id) targets.add(peerId);
        }
      }
    }
    if (!local) {
      const frame = chatId.startsWith("room:") ? "room" : "chat";
      for (const peerId of targets) this.send(peerId, { t: frame, message });
    }
    this.push();
    this.emit({ t: "incoming-message", chatId, system: true, text });
  }

  private sendChat(message: ChatMessage): ChatMessage {
    const mine: ChatMessage = {
      ...message,
      senderId: this.db.shape.profile.id,
      ts: Date.now(),
      status: message.chatId.startsWith("room:") ? "local" : "pending",
    };
    this.db.addMessage(mine, false);
    const wire = this.voiceWire(mine);
    if (mine.chatId.startsWith("dm:")) {
      const peerId = mine.chatId.slice(3);
      this.send(peerId, { t: "chat", ...wire });
    } else {
      const roomId = mine.chatId.slice(5);
      for (const peer of this.peers.values()) {
        if (!peer.rooms.some((room) => room.id === roomId)) continue;
        this.send(peer.id, { t: "room", ...wire });
      }
    }
    this.push();
    return mine;
  }

  private targetsOf(chatId: string): string[] {
    if (chatId.startsWith("dm:")) return [chatId.slice(3)];
    if (!chatId.startsWith("room:")) return [];
    const roomId = chatId.slice(5);
    const ids: string[] = [];
    for (const peer of this.peers.values()) {
      if (peer.rooms.some((room) => room.id === roomId)) ids.push(peer.id);
    }
    return ids;
  }

  private editChat(chatId: string, id: string, text: string): ChatMessage | undefined {
    const message = (this.db.shape.messages[chatId] ?? []).find((item) => item.id === id);
    const me = this.db.shape.profile.id;
    if (!message || message.senderId !== me || message.deleted) return undefined;
    if (message.kind === "system" || message.kind === "voice") return undefined;
    const nextText = text.slice(0, 4000);
    if (message.kind === "text" && !nextText.trim()) return message;
    if (nextText === message.text) return message;
    const editedAt = Date.now();
    const updated = this.db.updateMessage(chatId, id, { text: nextText, editedAt });
    const frame = { t: "chat-edit", chatId, id, senderId: me, text: nextText, editedAt };
    for (const peerId of this.targetsOf(chatId)) this.send(peerId, frame);
    this.push();
    return updated;
  }

  private deleteChat(chatId: string, id: string): boolean {
    const message = (this.db.shape.messages[chatId] ?? []).find((item) => item.id === id);
    const me = this.db.shape.profile.id;
    if (!message || message.senderId !== me || message.deleted || message.kind === "system") return false;
    this.db.updateMessage(chatId, id, {
      deleted: true,
      text: "",
      file: message.file ? { ...message.file, deleted: true } : undefined,
    });
    const frame = { t: "chat-delete", chatId, id, senderId: me };
    for (const peerId of this.targetsOf(chatId)) this.send(peerId, frame);
    this.push();
    return true;
  }

  private fileChunk(transferId: string, chunk: Buffer | Uint8Array | number[], end: boolean): { path?: string } {
    const message = this.db.findByTransfer(transferId);
    if (!message?.file) throw new Error("transfer not found");
    const target = message.file.path || path.join(this.db.filesDir(), `${transferId}-${safeName(message.file.name)}`);
    let writer = this.writers.get(transferId);
    if (!writer) {
      writer = fs.createWriteStream(target, { flags: "a" });
      this.writers.set(transferId, writer);
    }
    if (chunk && (chunk as ArrayLike<number>).length) writer.write(Buffer.from(chunk as Uint8Array));
    if (end) {
      writer.end();
      this.writers.delete(transferId);
      this.db.updateMessage(message.chatId, message.id, { status: "delivered", file: { ...message.file, path: target } });
      this.push();
      return { path: target };
    }
    if (!message.file.path) {
      message.file.path = target;
      this.db.updateMessage(message.chatId, message.id, { file: { ...message.file, path: target } });
    }
    return { path: target };
  }

  private fileCancel(transferId: string): void {
    const writer = this.writers.get(transferId);
    writer?.end();
    this.writers.delete(transferId);
    const message = this.db.findByTransfer(transferId);
    if (message?.file?.path && fs.existsSync(message.file.path)) fs.unlinkSync(message.file.path);
    if (message?.file) {
      this.db.updateMessage(message.chatId, message.id, { file: { ...message.file, deleted: true, path: undefined } });
      this.push();
    }
  }

  private saveRecording(name: string, bytes: unknown): string {
    const data = asBuffer(bytes);
    if (!data.byteLength) throw new Error("empty recording");
    const dir = this.db.shape.settings.recordDir || path.join(this.root, "recordings");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, safeName(name));
    fs.writeFileSync(target, data);
    return target;
  }

  private cleanup(all: boolean): { removed: number } {
    const days = this.db.shape.settings.retentionDays;
    const dir = this.db.filesDir();
    const now = Date.now();
    let removed = 0;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const expired = all || (days > 0 && now - stat.mtimeMs > days * 86_400_000);
      if (!expired) continue;
      fs.unlinkSync(full);
      removed += 1;
    }
    const marked = this.db.markFilesDeleted((filePath) => !fs.existsSync(filePath));
    if (removed || marked) this.push();
    return { removed: Math.max(removed, marked) };
  }

  private async leaveRoom(roomId: string): Promise<void> {
    const room = this.db.shape.rooms.find((item) => item.id === roomId);
    const mine = room?.createdBy === this.db.shape.profile.id;
    if (mine) {
      this.closedRooms.add(roomId);
      for (const link of this.links.values()) this.sendRaw(link.ws, { t: "room-closed", roomId });
      if (this.hosted?.roomId === roomId) await this.confEnd();
    }
    this.db.dropRoom(roomId);
    this.push();
  }

  private sanitizeRooms(_peerId: string, rooms: Room[]): Room[] {
    return rooms.filter((room) => !this.closedRooms.has(room.id));
  }

  private roomOpen(room: Room): boolean {
    if (this.closedRooms.has(room.id)) return false;
    if (room.createdBy === this.db.shape.profile.id) return true;
    const owner = this.peers.get(room.createdBy);
    return Boolean(owner && Date.now() - owner.lastSeen <= ROOM_OWNER_MS);
  }

  private pruneRooms(): void {
    const now = Date.now();
    for (const room of [...this.db.shape.rooms]) {
      if (room.createdBy === this.db.shape.profile.id) continue;
      const owner = this.peers.get(room.createdBy);
      if (owner && now - owner.lastSeen <= ROOM_OWNER_MS) continue;
      this.closedRooms.add(room.id);
      this.db.dropRoom(room.id);
      this.emit({ t: "room-closed", roomId: room.id });
    }
  }

  private beat(): void {
    this.pruneRooms();
    const packet: Announcement = {
      v: 2,
      id: this.db.shape.profile.id,
      name: this.db.shape.profile.name || "LokaMeet",
      port: this.port,
      inCall: this.inCall || Boolean(this.hosted),
      callKind: this.inCall || this.hosted ? (this.hosted ? "conf" : this.callKind || "call") : undefined,
      recording: this.recording,
      sharing: this.sharing,
      status: visibleStatus(this.db.shape.profile.status),
      rooms: this.db.shape.rooms,
      conf: this.hosted
        ? { roomId: this.hosted.roomId, hostId: this.db.shape.profile.id, count: this.sfu.peerIds().length }
        : undefined,
    };
    const buf = Buffer.from(JSON.stringify(packet));
    for (const target of broadcastTargets()) {
      this.udp?.send(buf, DISCOVERY_PORT, target);
    }
    for (const peer of this.peers.values()) {
      if (this.db.shape.profile.id < peer.id && !this.links.has(peer.id)) this.connect(peer.ip, peer.port, peer.id);
    }
    this.push();
  }

  private onDiscovery(buf: Buffer, ip: string): void {
    let packet: Announcement;
    try {
      packet = JSON.parse(buf.toString("utf8")) as Announcement;
    } catch {
      return;
    }
    if (packet?.v !== 2 || !packet.id || packet.id === this.db.shape.profile.id) return;
    this.notePeer({
      id: packet.id,
      name: packet.name || "LokaMeet",
      ip,
      port: packet.port,
      inCall: Boolean(packet.inCall),
      callKind: packet.inCall ? (packet.callKind === "conf" ? "conf" : "call") : undefined,
      recording: Boolean(packet.recording),
      sharing: Boolean(packet.sharing),
      status: packet.status === "busy" || packet.status === "offline" || packet.status === "away" ? packet.status : "online",
      lastSeen: Date.now(),
      rooms: this.sanitizeRooms(packet.id, Array.isArray(packet.rooms) ? packet.rooms : []),
      conf: packet.conf,
    });
  }

  private notePeer(peer: Omit<KnownPeer, "firstSeen" | "status" | "callKind" | "avatarFocus"> & { status?: ShownStatus; firstSeen?: number; callKind?: CallKind; avatarFocus?: AvatarFocus }): void {
    const prev = this.peers.get(peer.id);
    const now = Date.now();
    const cleared = peer.avatar === "";
    this.peers.set(peer.id, {
      ...prev,
      ...peer,
      avatar: cleared ? undefined : peer.avatar ?? prev?.avatar,
      avatarFocus: cleared ? undefined : peer.avatarFocus ?? prev?.avatarFocus,
      callKind: peer.inCall ? peer.callKind ?? prev?.callKind ?? "call" : undefined,
      status: peer.status ?? prev?.status ?? "online",
      firstSeen: prev?.firstSeen ?? peer.firstSeen ?? now,
      lastSeen: now,
      rooms: peer.rooms ?? prev?.rooms ?? [],
    });
    this.db.touchContact({
      id: peer.id,
      name: peer.name,
      color: colorFromId(peer.id),
      avatar: this.peers.get(peer.id)?.avatar,
      avatarFocus: this.peers.get(peer.id)?.avatarFocus,
    });
    if (this.db.shape.profile.id < peer.id && !this.links.has(peer.id)) this.connect(peer.ip, peer.port, peer.id);
  }

  private connect(ip: string, port: number, peerHint: string): void {
    if (this.stopped || !ip || !port) return;
    const key = peerHint && peerHint !== "manual" ? peerHint : `${ip}:${port}`;
    if (this.dialing.has(key) || (peerHint && peerHint !== "manual" && this.links.has(peerHint))) return;
    this.dialing.add(key);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${ip}:${port}`);
    } catch {
      this.dialing.delete(key);
      return;
    }
    (ws as WebSocket & { _ip?: string })._ip = ip;
    ws.on("open", () => this.sendRaw(ws, { t: "hello", hello: this.hello() }));
    ws.on("message", (data) => this.onFrame(ws, data.toString(), "out", peerHint));
    ws.on("close", () => {
      this.dialing.delete(key);
      this.dropLink(ws);
    });
    ws.on("error", () => ws.close());
  }

  private onIncoming(ws: WebSocket): void {
    ws.on("message", (data) => this.onFrame(ws, data.toString(), "in", ""));
    ws.on("close", () => this.dropLink(ws));
    ws.on("error", () => ws.close());
  }

  private onFrame(ws: WebSocket, raw: string, dir: "in" | "out", peerHint: string): void {
    let frame: Envelope;
    try {
      frame = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (frame.t === "hello") {
      const hello = frame.hello as Hello;
      if (!hello?.id || hello.id === this.db.shape.profile.id) return;
      this.adopt(hello.id, ws, dir);
      const known = this.peers.get(hello.id);
      const sockIp = (ws as WebSocket & { _ip?: string })._ip;
      this.notePeer({
        id: hello.id,
        name: hello.name,
        ip: known?.ip || sockIp || "0.0.0.0",
        port: known?.port || this.port,
        avatar: hello.avatar ?? "",
        avatarFocus: hello.avatarFocus,
        status: hello.status === "busy" || hello.status === "offline" || hello.status === "away" ? hello.status : hello.status === "online" ? "online" : known?.status,
        inCall: Boolean(hello.inCall),
        callKind: hello.inCall ? (hello.callKind === "conf" ? "conf" : "call") : undefined,
        recording: Boolean(hello.recording),
        sharing: Boolean(hello.sharing),
        lastSeen: Date.now(),
        rooms: known?.rooms || [],
        conf: known?.conf,
      });
      if (dir === "in") this.sendRaw(ws, { t: "hello", hello: this.hello() });
      this.flush(hello.id);
      this.push();
      return;
    }
    const peerId = this.peerOf(ws) || (peerHint !== "manual" ? peerHint : "");
    if (!peerId) return;
    if (frame.t === "chat" || frame.t === "room") {
      const message = frame.message as ChatMessage;
      if (!message?.id || !message.chatId) return;
      const stored: ChatMessage = { ...message, status: "local" };
      if (stored.chatId.startsWith("dm:")) stored.chatId = dmChat(peerId);
      this.keepVoice(stored, frame.voiceB64);
      const exists = (this.db.shape.messages[stored.chatId] ?? []).some((item) => item.id === stored.id);
      if (!exists) this.db.addMessage(stored, stored.kind !== "system");
      this.send(peerId, { t: "ack", chatId: message.chatId, id: message.id });
      this.push();
      this.emit({ t: "incoming-message", chatId: stored.chatId, system: message.kind === "system", text: message.text, kind: message.kind, from: message.senderId, fileName: message.file?.name || "" });
      return;
    }
    if (frame.t === "chat-edit" || frame.t === "chat-delete") {
      const remoteChat = String(frame.chatId || "");
      const id = String(frame.id || "");
      const localChat = remoteChat.startsWith("dm:") ? dmChat(peerId) : remoteChat;
      if (frame.t === "chat-edit") {
        this.db.updateMessage(localChat, id, { text: String(frame.text ?? "").slice(0, 4000), editedAt: Number(frame.editedAt) || Date.now() });
      } else {
        const message = (this.db.shape.messages[localChat] ?? []).find((item) => item.id === id);
        if (message && !message.deleted) {
          this.db.updateMessage(localChat, id, {
            deleted: true,
            text: "",
            file: message.file ? { ...message.file, deleted: true } : undefined,
          });
        }
      }
      this.push();
      return;
    }
    if (frame.t === "ack") {
      this.db.markDelivered(String(frame.chatId), String(frame.id));
      this.push();
      return;
    }
    if (frame.t === "signal") {
      this.emit({ t: "signal", peerId, payload: frame.payload as SignalPayload });
      return;
    }
    if (frame.t === "room-closed") {
      const roomId = String(frame.roomId || "");
      if (!roomId) return;
      this.closedRooms.add(roomId);
      this.db.dropRoom(roomId);
      for (const peer of this.peers.values()) peer.rooms = peer.rooms.filter((room) => room.id !== roomId);
      if (this.hosted?.roomId === roomId) void this.confEnd();
      this.emit({ t: "room-closed", roomId });
      this.push();
      return;
    }
    if (frame.t === "req") {
      void this.answerReq(peerId, frame);
      return;
    }
    if (frame.t === "res") {
      const waiter = this.waiters.get(String(frame.id));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(String(frame.id));
      if (frame.ok) waiter.resolve(frame.data);
      else waiter.reject(new Error(String(frame.error || "request failed")));
      return;
    }
    if (frame.t === "producer" || frame.t === "producer-closed" || frame.t === "conf-end" || frame.t === "conf-recording" || frame.t === "conf-peer-left") {
      if (frame.t === "conf-end") this.noteConfEnded(String(frame.roomId || ""));
      this.emit({ ...frame, from: peerId });
      if (frame.t === "conf-recording" && frame.relay && this.hosted) {
        this.fanConf({ t: "conf-recording", roomId: frame.roomId, peerId, on: frame.on, started: frame.started }, peerId);
      }
    }
  }

  private async answerReq(peerId: string, frame: Envelope): Promise<void> {
    try {
      if (String(frame.op) === "conf-end") {
        await this.confEnd();
        this.send(peerId, { t: "res", id: frame.id, ok: true, data: true });
        return;
      }
      const data = await this.localSfu(String(frame.op), { ...(frame.data as object), peerId: (frame.data as any)?.peerId || peerId });
      this.send(peerId, { t: "res", id: frame.id, ok: true, data });
    } catch (error) {
      this.send(peerId, { t: "res", id: frame.id, ok: false, error: error instanceof Error ? error.message : "error" });
    }
  }

  private adopt(peerId: string, ws: WebSocket, dir: "in" | "out"): void {
    const existing = this.links.get(peerId);
    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      const iAmSmaller = this.db.shape.profile.id < peerId;
      const keepNew = (dir === "out" && iAmSmaller) || (dir === "in" && !iAmSmaller);
      if (!keepNew) {
        ws.close();
        return;
      }
      existing.ws.close();
    }
    this.links.set(peerId, { ws, peerId });
  }

  private dropLink(ws: WebSocket): void {
    for (const [peerId, link] of this.links) {
      if (link.ws !== ws) continue;
      this.links.delete(peerId);
      if (!this.stopped) this.hostGone(peerId);
    }
  }

  private hostGone(peerId: string): void {
    const peer = this.peers.get(peerId);
    const conf = peer?.conf;
    if (!conf || conf.hostId !== peerId) return;
    peer.conf = undefined;
    peer.inCall = false;
    peer.callKind = undefined;
    this.noteConfEnded(conf.roomId);
    this.emit({ t: "conf-end", roomId: conf.roomId });
  }

  private noteConfEnded(roomId: string): void {
    if (!roomId) return;
    for (const peer of this.peers.values()) {
      if (peer.conf?.roomId !== roomId) continue;
      peer.conf = undefined;
      peer.inCall = false;
      peer.callKind = undefined;
    }
    if (this.callKind === "conf") {
      this.inCall = false;
      this.callKind = "";
    }
    this.push();
  }

  private peerOf(ws: WebSocket): string {
    for (const [peerId, link] of this.links) if (link.ws === ws) return peerId;
    return "";
  }

  private flush(peerId: string): void {
    for (const message of this.db.pendingFor(peerId)) {
      this.send(peerId, { t: "chat", message });
      if (message.file?.sourcePath) this.emit({ t: "resend-file", peerId, message });
    }
  }

  private send(peerId: string, frame: Envelope): void {
    const link = this.links.get(peerId);
    if (!link || link.ws.readyState !== WebSocket.OPEN) return;
    this.sendRaw(link.ws, frame);
  }

  private sendRaw(ws: WebSocket, frame: Envelope): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private request(peerId: string, op: string, data: unknown): Promise<unknown> {
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("timeout"));
      }, 12000);
      this.waiters.set(id, { resolve, reject, timer });
      this.send(peerId, { t: "req", id, op, data });
    });
  }

  private broadcastHello(): void {
    for (const link of this.links.values()) this.sendRaw(link.ws, { t: "hello", hello: this.hello() });
  }

  private hello(): Hello {
    const live = this.inCall || Boolean(this.hosted);
    return {
      id: this.db.shape.profile.id,
      name: this.db.shape.profile.name || "LokaMeet",
      color: colorFromId(this.db.shape.profile.id),
      avatar: this.db.shape.profile.avatar ?? "",
      avatarFocus: this.db.shape.profile.avatarFocus,
      status: visibleStatus(this.db.shape.profile.status),
      inCall: live,
      callKind: live ? (this.hosted ? "conf" : this.callKind || "call") : undefined,
      recording: this.recording,
      sharing: this.sharing,
    };
  }

  private visibleRooms(): Room[] {
    const map = new Map<string, Room>();
    for (const room of this.db.shape.rooms) map.set(room.id, room);
    for (const peer of this.peers.values()) {
      for (const room of peer.rooms) if (!map.has(room.id)) map.set(room.id, room);
    }
    return [...map.values()].filter((room) => this.roomOpen(room));
  }

  private listedPeers(): Snapshot["peers"] {
    const now = Date.now();
    const map = new Map<string, Snapshot["peers"][number]>();
    for (const peer of this.peers.values()) {
      const fresh = now - peer.lastSeen <= OFFLINE_MS;
      const status: ShownStatus = !fresh ? "offline" : peer.status || "online";
      map.set(peer.id, {
        id: peer.id,
        name: peer.name,
        color: colorFromId(peer.id),
        ip: peer.ip,
        port: peer.port,
        avatar: peer.avatar,
        avatarFocus: peer.avatarFocus,
        inCall: peer.inCall,
        callKind: peer.inCall ? peer.callKind ?? "call" : undefined,
        recording: Boolean(peer.recording),
        sharing: Boolean(peer.sharing),
        online: fresh && status !== "offline",
        status,
        firstSeen: peer.firstSeen,
        lastSeen: peer.lastSeen,
      });
    }
    return [...map.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  }

  private snapshot(): Snapshot {
    const joined = new Set(this.db.shape.rooms.map((room) => room.id));
    return {
      profile: this.db.shape.profile,
      settings: this.db.shape.settings,
      selfColor: this.db.color,
      openChatId: this.db.shape.openChatId,
      hiddenChats: this.db.shape.hiddenChats,
      contacts: this.db.shape.contacts,
      threads: this.db.shape.threads,
      identities: this.db.shape.identities,
      messages: this.db.shape.messages,
      unread: this.db.shape.unread,
      calls: this.db.shape.calls,
      peers: this.listedPeers(),
      rooms: this.visibleRooms().map((room) => {
        const members = [...this.peers.values()].filter((peer) => peer.rooms.some((item) => item.id === room.id)).map((peer) => peer.id);
        if (joined.has(room.id)) members.push(this.db.shape.profile.id);
        const host = [...this.peers.values()].find((peer) => peer.conf?.roomId === room.id);
        const own = this.hosted?.roomId === room.id ? { hostId: this.db.shape.profile.id, count: this.sfu.peerIds().length } : undefined;
        return {
          ...room,
          members,
          onlineCount: new Set(members).size,
          conference: own || host?.conf,
          joined: joined.has(room.id),
        };
      }),
    };
  }

  private push(): void {
    this.emit({ t: "snapshot", snapshot: this.snapshot() });
  }

  private voiceWire(message: ChatMessage): { message: ChatMessage; voiceB64?: string } {
    const file = message.file ? { ...message.file, sourcePath: undefined, path: undefined } : undefined;
    const clean = { ...message, file };
    const source = message.kind === "voice" ? message.file?.sourcePath : "";
    if (!source || !message.file || message.file.size > 6_000_000) return { message: clean };
    try {
      const bytes = fs.readFileSync(source);
      if (!bytes.length || bytes.length > 6_000_000) return { message: clean };
      return { message: clean, voiceB64: bytes.toString("base64") };
    } catch {
      return { message: clean };
    }
  }

  private keepVoice(message: ChatMessage, voiceB64: unknown): void {
    if (!message.file) return;
    message.file = { ...message.file, sourcePath: undefined };
    if (message.kind !== "voice" || typeof voiceB64 !== "string" || !voiceB64) return;
    try {
      const bytes = Buffer.from(voiceB64, "base64");
      if (!bytes.length) return;
      const target = path.join(this.db.filesDir(), `${message.file.transferId || message.id}-${safeName(message.file.name || "voice.webm")}`);
      fs.writeFileSync(target, bytes);
      message.file = { ...message.file, path: target, sourcePath: undefined };
    } catch {
      /* the bubble stays, without a playable file */
    }
  }
}

function readFocus(value: unknown): AvatarFocus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as AvatarFocus;
  const zoom = Number(raw.zoom);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(zoom) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x: Math.min(100, Math.max(0, x)),
    y: Math.min(100, Math.max(0, y)),
    zoom: Math.min(4, Math.max(1, zoom)),
  };
}

function visibleStatus(status: Presence | undefined): ShownStatus {
  if (status === "invisible") return "offline";
  if (status === "busy") return "busy";
  if (status === "away") return "away";
  return "online";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asBuffer(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (bytes && typeof bytes === "object" && ArrayBuffer.isView(bytes as ArrayBufferView)) return Buffer.from(bytes as Uint8Array);
  return Buffer.alloc(0);
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "file";
}

function listenPort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number) => {
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => server.close(() => resolve(port)));
      server.listen(port, "0.0.0.0");
    };
    tryPort(preferred);
  });
}

export function chatOfPeer(peerId: string): string {
  return dmChat(peerId);
}
