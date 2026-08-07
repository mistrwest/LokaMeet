import os from "node:os";
import dgram from "node:dgram";
import { Bonjour, Service } from "bonjour-service";
import { PeerInfo, RoomInfo, UserProfile } from "../../shared/types";
import { clampConferenceMaxParticipants } from "../../shared/conference";
import { logInfo, logWarn } from "../log";

export type DiscoverySnapshot = {
  peers: PeerInfo[];
  rooms: RoomInfo[];
};

type Callbacks = {
  onChange: (snapshot: DiscoverySnapshot) => void;
};

const PEER_SERVICE_TYPE = "lokameet";
const ROOM_SERVICE_TYPE = "lokameet-room";
const UDP_DISCOVERY_PORT = 45454;
const UDP_BEACON_INTERVAL_MS = 2000;

type UdpBeacon = {
  v: 1;
  kind: "peer";
  peerId: string;
  userName: string;
  status: PeerInfo["status"];
  statusText?: string;
  avatarHash?: string;
  avatarPosition?: { x: number; y: number };
  signalingPort: number;
  rooms?: Array<{
    roomId: string;
    roomName: string;
    hasPassword: boolean;
    maxParticipants: number;
    participantsApprox: number;
  }>;
};

function getLocalAddresses(): Array<{ ifName: string; address: string }> {
  const nets = os.networkInterfaces();
  const addrs: Array<{ ifName: string; address: string }> = [];
  for (const name of Object.keys(nets)) {
    const list = nets[name] ?? [];
    for (const n of list) {
      if (n.family !== "IPv4") continue;
      if (n.internal) continue;
      addrs.push({ ifName: name, address: n.address });
    }
  }
  return addrs;
}

function pickHostAddress(): string {
  const all = getLocalAddresses();
  if (all.length === 0) return "127.0.0.1";

  const isVirtual = (ifName: string) => {
    const n = ifName.toLowerCase();
    return (
      n.includes("virtual") ||
      n.includes("vmware") ||
      n.includes("vbox") ||
      n.includes("virtualbox") ||
      n.includes("hyper-v") ||
      n.includes("vethernet") ||
      n.includes("wsl") ||
      n.includes("tunnel") ||
      n.includes("hamachi") ||
      n.includes("tailscale") ||
      n.includes("loopback")
    );
  };

  const scoreIp = (ip: string) => {
    // Приоритет типичным подсетям LAN уменьшает риск выбрать виртуальный адаптер.
    if (ip.startsWith("192.168.")) return 3;
    if (ip.startsWith("10.")) return 2;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 1;
  };

  const candidates = all
    .filter((x) => !isVirtual(x.ifName))
    .sort((a, b) => scoreIp(b.address) - scoreIp(a.address));

  return (candidates[0]?.address ?? all.sort((a, b) => scoreIp(b.address) - scoreIp(a.address))[0]?.address ?? "127.0.0.1");
}

export class LanDiscovery {
  private bonjour: Bonjour | null = null;
  private peerAdvert: Service | null = null;
  private roomAdverts = new Map<string, Service>();
  private publishedRooms = new Map<
    string,
    { roomId: string; roomName: string; hasPassword: boolean; maxParticipants: number; participantsApprox: number }
  >();
  private peersById = new Map<string, PeerInfo>();
  private roomsById = new Map<string, RoomInfo>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private browsePeers: any | null = null;
  private browseRooms: any | null = null;
  private udpSocket: dgram.Socket | null = null;
  private udpTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly profile: () => UserProfile,
    private readonly signalingPort: () => number,
    private readonly callbacks: Callbacks
  ) {}

  start() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    this.startBrowsing();
    // Публикация без рабочего порта сигналинга сделала бы узел недоступным для подключений.
    if (this.signalingPort() > 0) {
      this.publishPeer();
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), 5_000);
    this.startUdpDiscovery();
    logInfo("Discovery started");
  }

  stop() {
    try {
      this.cleanupTimer && clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.udpTimer && clearInterval(this.udpTimer);
      this.udpTimer = null;
      this.udpSocket?.close();
      this.udpSocket = null;
      this.browsePeers?.stop?.();
      this.browseRooms?.stop?.();
      this.browsePeers = null;
      this.browseRooms = null;
      this.peerAdvert?.stop?.();
      for (const s of this.roomAdverts.values()) s.stop?.();
      this.roomAdverts.clear();
      this.bonjour?.destroy?.();
      this.bonjour = null;
      logInfo("Discovery stopped");
    } catch (e) {
      logWarn("Discovery stop error:", e);
    }
  }

  republishPeer() {
    this.peerAdvert?.stop?.();
    this.peerAdvert = null;
    logInfo("Discovery republishPeer");
    if (!this.profile().hasChosenName) {
      logInfo("Discovery skip publish: not authenticated");
      return;
    }
    this.publishPeer();
  }

  unpublishPeer() {
    this.peerAdvert?.stop?.();
    this.peerAdvert = null;
    logInfo("Discovery unpublishPeer");
  }

  publishRoom(room: {
    roomId: string;
    roomName: string;
    hasPassword: boolean;
    maxParticipants: number;
    participantsApprox: number;
  }) {
    if (!this.bonjour) return;
    this.publishedRooms.set(room.roomId, { ...room });
    const host = pickHostAddress();
    const port = this.signalingPort();
    if (!port || port <= 0) return;
    const p = this.profile();
    // Уникальное имя предотвращает слияние разных комнат в кэше mDNS.
    const name = `room:${room.roomName}-${room.roomId.slice(0, 6)}`;
    const txt = {
      roomId: room.roomId,
      roomName: room.roomName,
      hostPeerId: p.peerId,
      hasPassword: room.hasPassword ? "1" : "0",
      maxParticipants: String(room.maxParticipants),
      participantsApprox: String(room.participantsApprox)
    };

    this.roomAdverts.get(room.roomId)?.stop?.();
    logInfo("Discovery publishRoom", { roomId: room.roomId, name, host, port });
    const svc = this.bonjour.publish({
      name,
      type: ROOM_SERVICE_TYPE,
      port,
      txt
    });
    this.roomAdverts.set(room.roomId, svc);
  }

  unpublishRoom(roomId: string) {
    this.roomAdverts.get(roomId)?.stop?.();
    this.roomAdverts.delete(roomId);
    this.publishedRooms.delete(roomId);
  }

  private publishPeer() {
    if (!this.bonjour) return;
    const p = this.profile();
    if (!p.hasChosenName) return;
    const host = pickHostAddress();
    const port = this.signalingPort();
    if (!port || port <= 0) return;

    const txt = {
      peerId: p.peerId,
      userName: p.userName,
      status: p.status,
      statusText: p.statusText ?? "",
      avatarHash: p.avatarHash ?? "",
      avatarPosition: JSON.stringify(p.avatarPosition ?? { x: 50, y: 50 })
    };

    // Идентификатор в имени исключает конфликт пользователей с одинаковыми именами в mDNS.
    const svcName = `peer:${p.userName}-${p.peerId.slice(0, 6)}`;
    logInfo("Discovery publishPeer", { name: svcName, host, port, peerId: p.peerId });
    this.peerAdvert = this.bonjour.publish({
      name: svcName,
      type: PEER_SERVICE_TYPE,
      port,
      txt
    });
  }

  private startBrowsing() {
    if (!this.bonjour) return;
    const bonjour = this.bonjour;
    this.browsePeers = bonjour.find({ type: PEER_SERVICE_TYPE }, (service) => {
      this.onPeerService(service);
    });
    this.browseRooms = bonjour.find({ type: ROOM_SERVICE_TYPE }, (service) => {
      this.onRoomService(service);
    });
  }

  private startUdpDiscovery() {
    if (this.udpSocket) return;
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.udpSocket = sock;

    sock.on("error", (err) => {
      logWarn("UDP discovery socket error", { error: String((err as any)?.message ?? err) });
    });

    sock.on("message", (msg, rinfo) => {
      try {
        const text = msg.toString("utf8");
        const beacon = JSON.parse(text) as UdpBeacon;
        if (!beacon || beacon.kind !== "peer" || beacon.v !== 1) return;
        if (!beacon.peerId || !beacon.signalingPort) return;
        const me = this.profile().peerId;
        if (beacon.peerId === me) return;

        const now = Date.now();
        const peer: PeerInfo = {
          peerId: beacon.peerId,
          userName: beacon.userName,
          status: beacon.status,
          statusText: beacon.statusText,
          avatarHash: beacon.avatarHash,
          avatarPosition: beacon.avatarPosition,
          host: rinfo.address,
          port: beacon.signalingPort,
          lastSeenAt: now
        };
        this.peersById.set(peer.peerId, peer);

        // UDP сохраняет обнаружение комнат в сетях, где mDNS/Bonjour заблокирован.
        if (Array.isArray(beacon.rooms)) {
          for (const r of beacon.rooms) {
            if (!r || !r.roomId || !r.roomName) continue;
            const room: RoomInfo = {
              roomId: r.roomId,
              roomName: r.roomName,
              hostPeerId: beacon.peerId,
              host: rinfo.address,
              port: beacon.signalingPort,
              hasPassword: Boolean(r.hasPassword),
              maxParticipants: clampConferenceMaxParticipants(Number(r.maxParticipants ?? 10) || 10),
              participantsApprox: Number(r.participantsApprox ?? 1) || 1,
              lastSeenAt: now
            };
            this.roomsById.set(room.roomId, room);
          }
        }
        this.emit();
      } catch {
        // Повреждённый пакет не должен останавливать прослушивание обнаружения.
      }
    });

    sock.bind({ port: UDP_DISCOVERY_PORT, exclusive: false }, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // Неподдерживаемая среда не должна мешать работе сокета без broadcast.
      }
      logInfo("UDP discovery listening", { port: UDP_DISCOVERY_PORT });
    });

    this.udpTimer = setInterval(() => this.broadcastUdpBeacon(), UDP_BEACON_INTERVAL_MS);
    this.broadcastUdpBeacon();
  }

  private broadcastUdpBeacon() {
    const port = this.signalingPort();
    if (!this.udpSocket || !port || port <= 0) return;
    const p = this.profile();
    if (!p.hasChosenName) return;
    const beacon: UdpBeacon = {
      v: 1,
      kind: "peer",
      peerId: p.peerId,
      userName: p.userName,
      status: p.status,
      statusText: p.statusText,
      avatarHash: p.avatarHash,
      avatarPosition: p.avatarPosition,
      signalingPort: port,
      rooms: Array.from(this.publishedRooms.values())
    };
    const payload = Buffer.from(JSON.stringify(beacon), "utf8");

    const targets = getLocalBroadcastAddresses();
    for (const t of targets) {
      try {
        this.udpSocket.send(payload, UDP_DISCOVERY_PORT, t);
      } catch {
        // Ошибка отдельной отправки не должна срывать рассылку по другим интерфейсам.
      }
    }
  }

  private onPeerService(service: Service) {
    try {
      const txt: any = service.txt ?? {};
      const peerId = String(txt.peerId ?? "");
      const userName = String(txt.userName ?? service.name ?? "Unknown");
      const status = String(txt.status ?? "online") as PeerInfo["status"];
      const statusText = String(txt.statusText ?? "");
      const avatarHash = String(txt.avatarHash ?? "");
      const avatarPositionText = String(txt.avatarPosition ?? "");
      let avatarPosition: PeerInfo["avatarPosition"];
      try {
        const parsed = JSON.parse(avatarPositionText);
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          avatarPosition = { x: Math.max(0, Math.min(100, parsed.x)), y: Math.max(0, Math.min(100, parsed.y)) };
        }
      } catch {
        // Некорректные координаты аватара не должны отклонять сведения об узле целиком.
      }
      const host = service.referer?.address ?? service.host ?? service.addresses?.[0] ?? "";
      const port = service.port ?? 0;
      if (!peerId || !host || !port) return;
      const now = Date.now();
      const peer: PeerInfo = {
        peerId,
        userName,
        status,
        statusText: statusText || undefined,
        avatarHash: avatarHash || undefined,
        avatarPosition,
        host,
        port,
        lastSeenAt: now
      };
      this.peersById.set(peerId, peer);
      this.emit();
    } catch (e) {
      logWarn("Peer service parse error:", e);
    }
  }

  private onRoomService(service: Service) {
    try {
      const txt: any = service.txt ?? {};
      const roomId = String(txt.roomId ?? "");
      const roomName = String(txt.roomName ?? service.name ?? "Room");
      const hostPeerId = String(txt.hostPeerId ?? "");
      const hasPassword = String(txt.hasPassword ?? "0") === "1";
      const maxParticipants = clampConferenceMaxParticipants(Number(txt.maxParticipants ?? 10));
      const participantsApprox = Number(txt.participantsApprox ?? 1);
      const host = service.referer?.address ?? service.host ?? service.addresses?.[0] ?? "";
      const port = service.port ?? 0;
      if (!roomId || !host || !port) return;
      const now = Date.now();
      const room: RoomInfo = {
        roomId,
        roomName,
        hostPeerId,
        host,
        port,
        hasPassword,
        maxParticipants,
        participantsApprox,
        lastSeenAt: now
      };
      this.roomsById.set(roomId, room);
      this.emit();
    } catch (e) {
      logWarn("Room service parse error:", e);
    }
  }

  private cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peersById) {
      if (now - p.lastSeenAt > 20_000) {
        this.peersById.delete(id);
        changed = true;
      }
    }
    for (const [id, r] of this.roomsById) {
      if (now - r.lastSeenAt > 20_000) {
        this.roomsById.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit() {
    this.callbacks.onChange({
      peers: Array.from(this.peersById.values()).sort((a, b) => a.userName.localeCompare(b.userName)),
      rooms: Array.from(this.roomsById.values()).sort((a, b) => a.roomName.localeCompare(b.roomName))
    });
  }
}

function getLocalBroadcastAddresses(): string[] {
  const nets = os.networkInterfaces();
  const out = new Set<string>();
  out.add("255.255.255.255");
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] ?? []) {
      if (n.family !== "IPv4") continue;
      if (n.internal) continue;
      const netmask = (n as any).netmask as string | undefined;
      if (!n.address || !netmask) continue;
      const b = calcBroadcast(n.address, netmask);
      if (b) out.add(b);
    }
  }
  return Array.from(out);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function calcBroadcast(ip: string, mask: string): string | null {
  const ipN = ipToInt(ip);
  const maskN = ipToInt(mask);
  if (ipN === null || maskN === null) return null;
  const broadcast = (ipN & maskN) | (~maskN >>> 0);
  return intToIp(broadcast >>> 0);
}

