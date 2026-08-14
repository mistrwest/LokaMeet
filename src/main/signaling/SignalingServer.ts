import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { AvatarPosition, WsEnvelope } from "../../shared/types";
import { clampConferenceMaxParticipants } from "../../shared/conference";
import { logInfo, logWarn, logError } from "../log";

type PeerConn = {
  peerId: string;
  userName?: string;
  ws: WebSocket;
  joinedRooms: Set<string>;
};

export type HostedRoom = {
  roomId: string;
  roomName: string;
  password?: string;
  maxParticipants: number;
  participants: Map<string, { peerId: string; userName: string }>;
};

type SelfProfile = {
  peerId: string;
  userName: string;
  status: string;
  statusText?: string;
  avatarHash?: string;
  avatarPosition?: AvatarPosition;
};

type Callbacks = {
  onPort: (port: number) => void;
  /** Исходящие/входящие конверты для renderer (хост тоже получает события комнаты через этот callback). */
  onEnvelope: (env: WsEnvelope, fromPeerId: string) => void;
  onRoomUpdated: (roomId: string, participantsApprox: number) => void;
  onRoomClosed: (roomId: string) => void;
};

/**
 * Локальный WebSocket-сигналинг: hello-handshake, комнаты, релей rtc-signal/chat.
 * Медиа идёт P2P (WebRTC); этот сервер только координирует.
 */
export class SignalingServer {
  private wss: WebSocketServer | null = null;
  private port = 0;
  /** Активные соединения по peerId (основной индекс для sendToPeer). */
  private connsByPeerId = new Map<string, PeerConn>();
  /** Обратный индекс ws → PeerConn для O(1) в onClose/onMessage. */
  private connsByWs = new Map<WebSocket, PeerConn>();
  private roomsHosted = new Map<string, HostedRoom>();
  /** Чтобы не зациклить взаимный обмен hello на одном сокете. */
  private helloReplySent = new WeakSet<WebSocket>();

  constructor(private readonly self: () => SelfProfile, private readonly callbacks: Callbacks) {}

  start(preferredPort?: number) {
    if (this.wss) return;
    this.wss = new WebSocketServer({ port: preferredPort ?? 0 });
    this.wss.on("listening", () => {
      const addr = this.wss?.address();
      if (addr && typeof addr === "object") {
        this.port = addr.port;
        this.callbacks.onPort(this.port);
        logInfo("Signaling server listening", { port: this.port });
      }
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  stop() {
    try {
      this.wss?.close();
      this.wss = null;
      this.connsByPeerId.clear();
      this.connsByWs.clear();
      this.roomsHosted.clear();
    } catch (e) {
      logWarn("Signaling stop error:", e);
    }
  }

  getPort() {
    return this.port;
  }

  broadcastSelfHello() {
    const self = this.self();
    const hello: WsEnvelope = {
      type: "hello",
      peerId: self.peerId,
      userName: self.userName,
      status: self.status as any,
      statusText: self.statusText,
      avatarHash: self.avatarHash,
      avatarPosition: self.avatarPosition
    };
    for (const conn of this.connsByPeerId.values()) {
      try {
        if (conn.ws.readyState !== WebSocket.OPEN) continue;
        conn.ws.send(JSON.stringify(hello));
      } catch {
        // обрыв одного сокета не должен мешать рассылке статуса остальным
      }
    }
  }

  createHostedRoom(input: { roomName: string; password?: string; maxParticipants: number }): HostedRoom {
    const roomId = uuidv4();
    const room: HostedRoom = {
      roomId,
      roomName: input.roomName,
      password: input.password,
      maxParticipants: clampConferenceMaxParticipants(input.maxParticipants),
      participants: new Map()
    };
    const self = this.self();
    room.participants.set(self.peerId, { peerId: self.peerId, userName: self.userName });
    this.roomsHosted.set(roomId, room);
    this.callbacks.onRoomUpdated(roomId, room.participants.size);
    return room;
  }

  closeHostedRoom(roomId: string) {
    const room = this.roomsHosted.get(roomId);
    if (!room) return;
    for (const p of room.participants.values()) {
      if (p.peerId === this.self().peerId) continue;
      this.sendToPeer(p.peerId, { type: "room-peer-left", roomId, peerId: this.self().peerId });
    }
    this.roomsHosted.delete(roomId);
    this.callbacks.onRoomClosed(roomId);
  }

  async connectToPeer(host: string, port: number): Promise<{ peerId: string; userName: string; status: string; statusText?: string; avatarHash?: string; avatarPosition?: { x: number; y: number } }> {
    const url = `ws://${host}:${port}`;
    logInfo("connectToPeer: dialing", { url });
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // игнорируем ошибку закрытия по таймауту
        }
        logWarn("connectToPeer: timeout", { url });
        reject(new Error("connect-timeout"));
      }, 5_000);

      // Ожидаем hello от удалённой стороны, затем переключаемся на общий onMessage
      const onMessage = (data: any) => {
        try {
          const parsed = JSON.parse(data.toString()) as WsEnvelope;
          if (parsed.type === "hello") {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            logInfo("connectToPeer: hello received", { url, peerId: parsed.peerId, userName: parsed.userName });
            resolve({
              peerId: parsed.peerId,
              userName: parsed.userName,
              status: parsed.status as any,
              statusText: parsed.statusText,
              avatarHash: parsed.avatarHash,
              avatarPosition: parsed.avatarPosition
            });
          }
        } catch {
          // битый JSON на этапе handshake — пропускаем
        }
      };

      ws.on("open", () => {
        const self = this.self();
        const hello: WsEnvelope = {
          type: "hello",
          peerId: self.peerId,
          userName: self.userName,
          status: self.status as any,
          statusText: self.statusText,
          avatarHash: self.avatarHash,
          avatarPosition: self.avatarPosition
        };
        ws.send(JSON.stringify(hello));
        this.helloReplySent.add(ws);
      });
      ws.on("message", onMessage);
      ws.on("message", (data) => this.onMessage(ws, data.toString()));
      ws.on("error", (e) => {
        logError("connectToPeer: socket error", { url, error: String((e as any)?.message ?? e) });
        reject(e);
      });
      ws.on("close", () => this.onClose(ws));
    });
  }

  sendToPeer(peerId: string, env: WsEnvelope): boolean {
    const c = this.connsByPeerId.get(peerId);
    if (!c) return false;
    try {
      if (c.ws.readyState !== WebSocket.OPEN) return false;
      c.ws.send(JSON.stringify(env));
      return true;
    } catch (e) {
      logWarn("sendToPeer failed", { peerId, error: String((e as any)?.message ?? e) });
      return false;
    }
  }

  /** Рассылка участникам комнаты; отправитель и локальный хост пропускаются (хост — через onEnvelope). */
  broadcastRoom(roomId: string, env: WsEnvelope) {
    const room = this.roomsHosted.get(roomId);
    if (!room) return;
    const senderPeerId =
      env.type === "chat-message" ? env.message.fromPeerId : env.type === "rtc-signal" ? env.signal.fromPeerId : undefined;
    for (const p of room.participants.values()) {
      if (p.peerId === this.self().peerId) continue;
      // Не эхоим обратно отправителю — у него сообщение уже локально
      if (senderPeerId && p.peerId === senderPeerId) continue;
      this.sendToPeer(p.peerId, env);
    }
  }

  private upsertConn(peerId: string, userName: string | undefined, ws: WebSocket, existingJoined?: Set<string>) {
    const conn: PeerConn = { peerId, userName, ws, joinedRooms: existingJoined ?? new Set() };
    this.connsByPeerId.set(peerId, conn);
    this.connsByWs.set(ws, conn);
  }

  private onConnection(ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(ws, data.toString()));
    ws.on("close", () => this.onClose(ws));
    ws.on("error", (e) => logWarn("WS error", { error: String((e as any)?.message ?? e) }));
  }

  private onClose(ws: WebSocket) {
    const conn = this.connsByWs.get(ws);
    if (!conn) return;
    // Удаляем только если это актуальное соединение пира (не заменённое новым ws)
    if (this.connsByPeerId.get(conn.peerId)?.ws === ws) {
      this.connsByPeerId.delete(conn.peerId);
    }
    this.connsByWs.delete(ws);

    // Убираем пира из hosted-комнат и уведомляем остальных
    for (const [roomId, room] of this.roomsHosted) {
      if (room.participants.has(conn.peerId)) {
        room.participants.delete(conn.peerId);
        this.callbacks.onRoomUpdated(roomId, room.participants.size);
        const leftEnv: WsEnvelope = { type: "room-peer-left", roomId, peerId: conn.peerId };
        this.broadcastRoom(roomId, leftEnv);
        this.callbacks.onEnvelope(leftEnv, conn.peerId);
      }
    }
  }

  private onMessage(ws: WebSocket, raw: string) {
    let env: WsEnvelope;
    try {
      env = JSON.parse(raw) as WsEnvelope;
    } catch {
      return;
    }

    if (env.type === "hello") {
      const existing = this.connsByPeerId.get(env.peerId);
      if (!existing) {
        this.upsertConn(env.peerId, env.userName, ws);
      } else if (existing.ws !== ws) {
        // Заменяем устаревший сокет — иначе «комната закрывается», когда старый ws умирает
        try {
          existing.ws.close();
        } catch {
          // игнорируем
        }
        this.connsByWs.delete(existing.ws);
        this.upsertConn(env.peerId, env.userName, ws, existing.joinedRooms);
      } else {
        existing.userName = env.userName;
      }
      // Отвечаем своим hello один раз на соединение (без бесконечного ping-pong)
      if (!this.helloReplySent.has(ws)) {
        const self = this.self();
        const back: WsEnvelope = {
          type: "hello",
          peerId: self.peerId,
          userName: self.userName,
          status: self.status as any,
          statusText: self.statusText,
          avatarHash: self.avatarHash,
          avatarPosition: self.avatarPosition
        };
        ws.send(JSON.stringify(back));
        this.helloReplySent.add(ws);
      }
      this.callbacks.onEnvelope(env, env.peerId);
      return;
    }

    const fromPeerId = this.connsByWs.get(ws)?.peerId ?? "unknown";

    // Выход из hosted-комнаты
    if (env.type === "room-leave") {
      const room = this.roomsHosted.get(env.roomId);
      if (!room) return;
      if (!room.participants.has(env.peerId)) return;
      room.participants.delete(env.peerId);
      this.callbacks.onRoomUpdated(env.roomId, room.participants.size);
      const leftEnv: WsEnvelope = { type: "room-peer-left", roomId: env.roomId, peerId: env.peerId };
      this.broadcastRoom(env.roomId, leftEnv);
      // Host renderer тоже нужен этот event (broadcast пропускает self)
      this.callbacks.onEnvelope(leftEnv, env.peerId);
      return;
    }

    if (env.type === "room-join") {
      const room = this.roomsHosted.get(env.roomId);
      if (!room) return;
      if (room.password && env.password !== room.password) {
        this.sendToPeer(env.peerId, { type: "direct-call-reject", fromPeerId: this.self().peerId, reason: "bad-password" });
        return;
      }
      if (room.participants.size >= room.maxParticipants) {
        this.sendToPeer(env.peerId, { type: "direct-call-reject", fromPeerId: this.self().peerId, reason: "room-full" });
        return;
      }
      room.participants.set(env.peerId, { peerId: env.peerId, userName: env.userName });
      this.callbacks.onRoomUpdated(env.roomId, room.participants.size);

      // Приветствие входящему: текущий список участников
      const participants = Array.from(room.participants.values());
      this.sendToPeer(env.peerId, {
        type: "room-welcome",
        roomId: env.roomId,
        hostPeerId: this.self().peerId,
        participants,
        maxParticipants: room.maxParticipants
      });

      // Уведомляем остальных (включая хоста через onEnvelope) о новом участнике
      const joinNotification: WsEnvelope = { type: "room-peer-joined", roomId: env.roomId, peerId: env.peerId, userName: env.userName };
      for (const p of room.participants.values()) {
        if (p.peerId === env.peerId) continue;
        this.sendToPeer(p.peerId, joinNotification);
      }
      // Хост создаёт PeerConnection по этому callback
      this.callbacks.onEnvelope(joinNotification, env.peerId);
      return;
    }

    // Релей RTC/chat: если целевой peer не подключён — пакет теряется
    if (env.type === "rtc-signal") {
      this.sendToPeer(env.signal.toPeerId, env);
      this.callbacks.onEnvelope(env, fromPeerId);
      return;
    }
    if (env.type === "chat-message") {
      if (env.message.scope.type === "room") {
        this.broadcastRoom(env.message.scope.roomId, env);
        this.callbacks.onEnvelope(env, fromPeerId);
      } else {
        this.sendToPeer(env.message.scope.peerId, env);
        this.callbacks.onEnvelope(env, fromPeerId);
      }
      return;
    }

    this.callbacks.onEnvelope(env, fromPeerId);
  }
}
