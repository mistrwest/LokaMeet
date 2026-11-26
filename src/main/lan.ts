import os from "os";

export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family as string | number;
      if ((family === "IPv4" || family === 4) && !item.internal) found.push(item.address);
    }
  }
  return found;
}

export function preferredLanIp(): string {
  const found = lanAddresses();
  const priv = found.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip));
  return priv || found[0] || "127.0.0.1";
}

export function broadcastTargets(): string[] {
  const targets = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family as string | number;
      if ((family !== "IPv4" && family !== 4) || item.internal || !item.netmask) continue;
      const ip = item.address.split(".").map(Number);
      const mask = item.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      const bcast = ip.map((part, index) => (part | (~mask[index] & 255)) >>> 0);
      targets.add(bcast.join("."));
    }
  }
  return [...targets];
}
