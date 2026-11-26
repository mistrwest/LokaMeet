export function remoteVideoIsScreen(input: {
  expectScreen: boolean;
  controlling: boolean;
  remoteVideoCount: number;
  hasCameraTile: boolean;
}): boolean {
  if (input.controlling || input.expectScreen) return true;
  if (input.remoteVideoCount > 0) return true;
  if (input.hasCameraTile) return true;
  return false;
}

export function callDirection(input: {
  way?: "in" | "out";
  phase: string;
  started: number;
}): "in" | "out" | "missed" {
  if (input.phase === "incoming" || (input.phase === "calling" && !input.started)) return "missed";
  if (input.way === "in") return "in";
  if (input.way === "out") return "out";
  if (input.started) return "out";
  return "missed";
}

export function shouldLogCall(phase: string, way?: "in" | "out"): boolean {
  return phase !== "idle" || Boolean(way);
}
