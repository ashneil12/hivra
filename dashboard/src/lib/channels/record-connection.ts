// Best-effort client signal: tell the dashboard a channel just got connected so
// the activation funnel has a persisted, queryable record independent of live
// box probes (boxes pause/churn — the funnel signal must outlive them).
//
// Never throws — a persistence blip must not break the connect flow, and the
// PostHog channel_connected event still captures the funnel either way.

export type ChannelTargetKind = "hivra" | "hermes";

export async function recordChannelConnection(params: {
  channel: "telegram";
  targetKind: ChannelTargetKind;
  targetId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = params.fetchImpl ?? fetch;
  try {
    await fetcher("/api/telegram/record-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel,
        targetKind: params.targetKind,
        targetId: params.targetId,
      }),
      keepalive: true,
    });
  } catch {
    // Best-effort only.
  }
}
