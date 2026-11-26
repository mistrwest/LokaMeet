export function offerCollision(input: { makingOffer: boolean; signalingState: string }): boolean {
  return input.makingOffer || input.signalingState !== "stable";
}

export function shouldIgnoreRemoteOffer(input: { makingOffer: boolean; signalingState: string; polite: boolean }): boolean {
  return offerCollision(input) && !input.polite;
}

export function canApplyAnswer(signalingState: string): boolean {
  return signalingState === "have-local-offer";
}

export function isPolitePeer(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}

export function deskPoint(input: { nx: number; ny: number; ox: number; oy: number; sw: number; sh: number }): { x: number; y: number } {
  const sw = Math.max(1, input.sw);
  const sh = Math.max(1, input.sh);
  const nx = Math.min(1, Math.max(0, input.nx));
  const ny = Math.min(1, Math.max(0, input.ny));
  return {
    x: Math.round(input.ox + nx * (sw - 1)),
    y: Math.round(input.oy + ny * (sh - 1)),
  };
}

export function hostOwnsCursor(input: { now: number; lastInjectAt: number; stillSince: number; delta: number }): { block: boolean; stillSince: number } {
  if (input.now - input.lastInjectAt < 70) return { block: false, stillSince: input.stillSince };
  if (input.delta > 8) return { block: true, stillSince: 0 };
  if (input.stillSince === 0) return { block: true, stillSince: input.now };
  if (input.stillSince > 0 && input.now - input.stillSince < 120) return { block: true, stillSince: input.stillSince };
  return { block: false, stillSince: -1 };
}
