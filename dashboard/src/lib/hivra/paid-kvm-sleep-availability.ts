import { parseSleepMode } from "./agent-sleep-policy";
import { agentSleepUiEnabled } from "./agent-sleep-ui";

export function paidKvmSleepAvailable(): boolean {
  return parseSleepMode(process.env.HIVRA_SLEEP_MODE) === "on" && agentSleepUiEnabled();
}
