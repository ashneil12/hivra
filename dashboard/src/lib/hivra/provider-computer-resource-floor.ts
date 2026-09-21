import { resizeFloor } from "./agent-catalog";

/** Provider sizing describes the whole VM. Ubuntu's fixed 4 GiB desktop
 * container additionally needs host/broker headroom; managed pool slices are
 * a separate contract and must not silently lower this provider floor. */
export function providerComputerResourceFloor(runtime: string, browser: boolean) {
  return runtime === "linux-desktop" ? { cpu: 2, ram: 6 } : resizeFloor(runtime, browser);
}
