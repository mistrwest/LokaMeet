import type { types as Ms } from "mediasoup";

export interface TransportParams {
  id: string;
  iceParameters: Ms.IceParameters;
  iceCandidates: Ms.IceCandidate[];
  dtlsParameters: Ms.DtlsParameters;
}

export interface ProducerNote {
  peerId: string;
  producerId: string;
  kind: "audio" | "video";
  appData: Record<string, unknown>;
}

const codecs: Ms.RtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
  },
];

interface Slot {
  send?: Ms.WebRtcTransport;
  recv?: Ms.WebRtcTransport;
  producers: Ms.Producer[];
}

export class ConferenceSfu {
  private worker?: Ms.Worker;
  private router?: Ms.Router;
  private peers = new Map<string, Slot>();
  private consumers = new Map<string, Ms.Consumer>();
  private announcedIp = "127.0.0.1";
  onProducer?: (note: ProducerNote) => void;
  onProducerClosed?: (note: { peerId: string; producerId: string }) => void;
  onPeerLeft?: (peerId: string) => void;

  get running(): boolean {
    return Boolean(this.router);
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  async start(announcedIp: string): Promise<void> {
    if (this.router) return;
    this.announcedIp = announcedIp;
    const mediasoup = await import("mediasoup");
    this.worker = await mediasoup.createWorker({
      rtcMinPort: 40000,
      rtcMaxPort: 40199,
      logLevel: "warn",
    });
    this.worker.on("died", () => {
      this.worker = undefined;
      this.router = undefined;
    });
    this.router = await this.worker.createRouter({ mediaCodecs: codecs });
  }

  async stop(): Promise<void> {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.worker?.close();
    this.worker = undefined;
    this.router = undefined;
  }

  private slot(peerId: string): Slot {
    let current = this.peers.get(peerId);
    if (!current) {
      current = { producers: [] };
      this.peers.set(peerId, current);
    }
    return current;
  }

  private transport(peerId: string, transportId: string): Ms.WebRtcTransport {
    const current = this.peers.get(peerId);
    const found = [current?.send, current?.recv].find((item) => item?.id === transportId);
    if (!found) throw new Error("transport not found");
    return found;
  }

  async join(peerId: string): Promise<{
    routerRtpCapabilities: Ms.RtpCapabilities;
    send: TransportParams;
    recv: TransportParams;
    producers: ProducerNote[];
  }> {
    if (!this.router) throw new Error("conference is not running");
    if (this.peers.size >= 15 && !this.peers.has(peerId)) throw new Error("room is full");
    const send = await this.makeTransport(peerId, "send");
    const recv = await this.makeTransport(peerId, "recv");
    return {
      routerRtpCapabilities: this.router.rtpCapabilities,
      send,
      recv,
      producers: this.allProducers().filter((item) => item.peerId !== peerId),
    };
  }

  private async makeTransport(peerId: string, direction: "send" | "recv"): Promise<TransportParams> {
    const transport = await this.router!.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: this.announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 8_000_000,
    });
    const current = this.slot(peerId);
    current[direction]?.close();
    current[direction] = transport;
    await transport.setMaxIncomingBitrate(14_000_000);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connect(peerId: string, transportId: string, dtlsParameters: Ms.DtlsParameters): Promise<void> {
    await this.transport(peerId, transportId).connect({ dtlsParameters });
  }

  async produce(
    peerId: string,
    transportId: string,
    kind: "audio" | "video",
    rtpParameters: Ms.RtpParameters,
    appData: Record<string, unknown>,
  ): Promise<string> {
    const producer = await this.transport(peerId, transportId).produce({ kind, rtpParameters, appData });
    this.slot(peerId).producers.push(producer);
    const note: ProducerNote = { peerId, producerId: producer.id, kind, appData };
    this.onProducer?.(note);
    producer.on("transportclose", () => {
      this.onProducerClosed?.({ peerId, producerId: producer.id });
    });
    return producer.id;
  }

  async consume(
    peerId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Ms.RtpCapabilities,
  ): Promise<{ id: string; producerId: string; kind: string; rtpParameters: Ms.RtpParameters }> {
    if (!this.router?.canConsume({ producerId, rtpCapabilities })) throw new Error("cannot consume");
    const consumer = await this.transport(peerId, transportId).consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => this.consumers.delete(consumer.id));
    consumer.on("producerclose", () => this.consumers.delete(consumer.id));
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  async resume(consumerId: string): Promise<void> {
    await this.consumers.get(consumerId)?.resume();
  }

  async pause(consumerId: string): Promise<void> {
    await this.consumers.get(consumerId)?.pause();
  }

  async layers(consumerId: string, spatialLayer: number): Promise<void> {
    await this.consumers.get(consumerId)?.setPreferredLayers({ spatialLayer });
  }

  muteAudio(peerId: string, on: boolean): void {
    const current = this.peers.get(peerId);
    if (!current) return;
    for (const producer of current.producers) {
      if (producer.kind !== "audio") continue;
      if (on) void producer.pause();
      else void producer.resume();
    }
  }

  closeProducer(peerId: string, producerId: string): void {
    const current = this.peers.get(peerId);
    const producer = current?.producers.find((item) => item.id === producerId);
    producer?.close();
    if (current) current.producers = current.producers.filter((item) => item.id !== producerId);
    this.onProducerClosed?.({ peerId, producerId });
  }

  removePeer(peerId: string): void {
    const current = this.peers.get(peerId);
    if (!current) return;
    for (const producer of current.producers) {
      const producerId = producer.id;
      producer.close();
      this.onProducerClosed?.({ peerId, producerId });
    }
    current.send?.close();
    current.recv?.close();
    this.peers.delete(peerId);
    this.onPeerLeft?.(peerId);
  }

  private allProducers(): ProducerNote[] {
    const notes: ProducerNote[] = [];
    for (const [peerId, slot] of this.peers) {
      for (const producer of slot.producers) {
        if (producer.closed) continue;
        notes.push({
          peerId,
          producerId: producer.id,
          kind: producer.kind,
          appData: (producer.appData ?? {}) as Record<string, unknown>,
        });
      }
    }
    return notes;
  }
}
