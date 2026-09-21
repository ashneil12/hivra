"use client";

import { useEffect, useMemo, useState } from "react";
import { inspectChatReadiness, type ChatReadiness } from "@/lib/hivra/chat-readiness";

export function useChatReadiness(id: string, status: string | undefined, url: string | null | undefined, kind: string | undefined, token: string | null | undefined, revision: number) {
  const identity = useMemo(() => ({ id, status, url, kind, token, revision }), [id, status, url, kind, token, revision]);
  const [result, setResult] = useState<{ identity: typeof identity; value: ChatReadiness } | null>(null);
  useEffect(() => {
    let alive = true;
    const { status, url, kind, token } = identity;
    if (status === "running" && url && kind) {
      void inspectChatReadiness(url, kind, token).then(value => {
        if (alive) setResult({ identity, value });
      });
    }
    return () => { alive = false; };
  }, [identity]);
  return result?.identity === identity ? result.value : null;
}
