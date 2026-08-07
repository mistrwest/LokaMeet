import {
  MAX_CONFERENCE_PARTICIPANTS,
  clampConferenceMaxParticipants,
  isConferenceFull
} from "../../shared/conference";
import type { RoomInfo } from "../../shared/types";

/** Хранит данные комнаты отдельно от P2P-звонка, поскольку у конференции есть общий сигнальный узел и список участников. */
export type ConferenceCallState = {
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

export function isConferenceCall(call: { mode: string } | null | undefined): call is ConferenceCallState {
  return call?.mode === "room";
}

export function isDirectCall(call: { mode: string } | null | undefined): call is { mode: "direct" } {
  return call?.mode === "direct";
}

export function createHostConferenceState(input: {
  roomId: string;
  roomName: string;
  hostPeerId: string;
  participants: Array<{ peerId: string; userName: string }>;
  hasPassword?: boolean;
  signalHubHost?: string;
  signalHubPort?: number;
}): ConferenceCallState {
  return {
    mode: "room",
    roomId: input.roomId,
    roomName: input.roomName,
    hostPeerId: input.hostPeerId,
    signalHubPeerId: input.hostPeerId,
    signalHubHost: input.signalHubHost,
    signalHubPort: input.signalHubPort,
    hasPassword: input.hasPassword,
    participants: input.participants
  };
}

export function createJoinConferenceState(input: {
  roomId: string;
  roomName: string;
  hostPeerId: string;
  participants: Array<{ peerId: string; userName: string }>;
  room?: RoomInfo | null;
}): ConferenceCallState {
  return {
    mode: "room",
    roomId: input.roomId,
    roomName: input.roomName,
    hostPeerId: input.hostPeerId,
    signalHubPeerId: input.hostPeerId,
    signalHubHost: input.room?.host,
    signalHubPort: input.room?.port,
    hasPassword: input.room?.hasPassword,
    participants: input.participants
  };
}

export function applyConferenceHubFromRoom(
  state: ConferenceCallState,
  room: RoomInfo | null | undefined
): ConferenceCallState {
  if (!room) return state;
  return {
    ...state,
    signalHubHost: room.host,
    signalHubPort: room.port
  };
}

export function resolveConferenceRoom(
  roomId: string,
  sources: {
    rooms: RoomInfo[];
    selectedRoom: RoomInfo | null;
    lastJoinRoom: RoomInfo | null;
  }
): RoomInfo | null {
  // Резервные источники сохраняют возможность продолжить звонок, пока список обнаружения ещё обновляется.
  return (
    sources.rooms.find((r) => r.roomId === roomId) ??
    (sources.selectedRoom?.roomId === roomId ? sources.selectedRoom : null) ??
    (sources.lastJoinRoom?.roomId === roomId ? sources.lastJoinRoom : null)
  );
}

export function canJoinConference(room: RoomInfo): { ok: true } | { ok: false; reason: "room-full" } {
  if (isConferenceFull(room.participantsApprox, room.maxParticipants)) {
    return { ok: false, reason: "room-full" };
  }
  return { ok: true };
}

export function conferenceRejectMessage(reason?: string, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  if (reason === "room-full") {
    return t
      ? t("conferenceFull", { max: MAX_CONFERENCE_PARTICIPANTS })
      : `Конференция заполнена (максимум ${MAX_CONFERENCE_PARTICIPANTS} участников)`;
  }
  if (reason === "bad-password") {
    return t ? t("conferenceBadPassword") : "Неверный пароль конференции";
  }
  return reason ? (t ? t("conferenceRejected", { reason }) : `Отклонено: ${reason}`) : t ? t("conferenceRejectedGeneric") : "Отклонено";
}

export { MAX_CONFERENCE_PARTICIPANTS, clampConferenceMaxParticipants };
