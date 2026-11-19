// Hivra's own background reads of an agent's computer (cron watchdogs,
// samplers, update sweeps) carry this header. A computer behind the host wake
// proxy (provisioner/hivra-wake-proxy.py) then never counts the read as the
// owner's use (it does not move last_authed_at, the sleep sweep's idle signal)
// and never wakes a napped computer for it. Reads done for a user action, such
// as the user's own chat, stay unmarked.

export const HIVRA_BACKGROUND_HEADER = "X-Hivra-Background";

export const HIVRA_BACKGROUND_HEADERS: Readonly<Record<string, string>> = Object.freeze({ [HIVRA_BACKGROUND_HEADER]: "1" });
