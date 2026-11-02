import { networkInterfaces } from "node:os";

/** Virtual adapters (Docker/WSL/Hyper-V/VMs) have private addresses a phone cannot reach. */
const VIRTUAL_ADAPTER = /vEthernet|WSL|Docker|Hyper-V|VirtualBox|VMware|Loopback|br-|veth/i;

/** Home Wi-Fi is almost always 192.168.x; 172.16–31.x is typically a virtual network. */
function lanRank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return Number.POSITIVE_INFINITY;
}

/** The laptop's Wi-Fi/Ethernet IPv4 address, the one a phone on the same network can reach. */
export function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        Number.isFinite(lanRank(address.address))
      ) {
        candidates.push(address.address);
      }
    }
  }
  return candidates.sort((a, b) => lanRank(a) - lanRank(b))[0] ?? null;
}
