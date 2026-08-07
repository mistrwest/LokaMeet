export const MAX_CONFERENCE_PARTICIPANTS = 10;
export const MIN_CONFERENCE_PARTICIPANTS = 2;

// Централизованное ограничение не даёт разным слоям приложения расходиться в допустимой вместимости.
export function clampConferenceMaxParticipants(max?: number): number {
  const n = Number(max ?? MAX_CONFERENCE_PARTICIPANTS) || MAX_CONFERENCE_PARTICIPANTS;
  return Math.max(MIN_CONFERENCE_PARTICIPANTS, Math.min(MAX_CONFERENCE_PARTICIPANTS, n));
}

export function isConferenceFull(participantsCount: number, maxParticipants?: number): boolean {
  return participantsCount >= clampConferenceMaxParticipants(maxParticipants);
}
