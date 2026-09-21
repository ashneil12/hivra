"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createWorkspaceBrowserBridge, type WorkspacePhase, type WorkspaceSurface } from "@/lib/hivra/workspace-browser-bridge";
import { HivraFiles } from "./HivraFiles";

type Props = { computerId: string; boxOrigin: string; surface: WorkspaceSurface; active: boolean };
export function HivraProviderWorkspace(props: Props) {
  const [opened, setOpened] = useState(props.active);
  if (props.active && !opened) setOpened(true);
  if (!opened) return null;
  return <Workspace {...props} />;
}

function Workspace({ computerId, boxOrigin, surface, active }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [target, setTarget] = useState<{ id: string; url: string } | null>(null);
  const [phase, setPhase] = useState<WorkspacePhase>("checking");
  const [filesOpened, setFilesOpened] = useState(false);
  // Stable access functions outlive session renewal, so HivraFiles does not
  // reload/reset its editor when the short-lived authorization is replaced.
  // eslint-disable-next-line react-hooks/refs -- constructor only stores this callback; frame reads happen in async message/request handlers, never during render.
  const bridge = useMemo(() => createWorkspaceBrowserBridge(computerId, boxOrigin, surface, {
    frame: () => frame.current?.contentWindow ?? null, showFrame: setTarget,
    status: value => { setPhase(value); if (value === "connected") setFilesOpened(true); },
  }), [computerId, boxOrigin, surface]);
  useEffect(() => {
    window.addEventListener("message", bridge.receive);
    const hide = () => bridge.disconnect();
    window.addEventListener("pagehide", hide);
    void bridge.connect();
    return () => { window.removeEventListener("message", bridge.receive); window.removeEventListener("pagehide", hide); bridge.dispose(); };
  }, [bridge]);
  const busy = phase === "checking" || phase === "opening";
  const message = phase === "checking" ? "Checking secure access on your computer…"
    : phase === "opening" ? "Opening secure workspace access…"
      : phase === "connected" ? "Files connected · access expires after four minutes."
        : phase === "mounted" ? "Terminal opened · run a command to use your shell."
          : surface === "files" ? "File access disconnected. Reconnect to continue; unsaved edits stay in this tab."
            : "Terminal access disconnected. Reconnect when you’re ready.";
  return <div hidden={!active} inert={!active} style={{ height: "100%", minHeight: 0 }}>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", fontSize: 12,
        color: "var(--text-secondary)", borderBottom: "1px solid var(--etched-border)" }}>
        <span style={{ flex: 1 }}>{message}</span>
        {!busy && phase === "disconnected" ? <button type="button" onClick={() => void bridge.connect()}>Reconnect {surface === "files" ? "Files" : "Terminal"}</button> : null}
      </div>
      {target ? <iframe key={target.id} ref={frame} src={target.url} title={surface === "files" ? "Secure Files connection" : "Box Terminal"}
        referrerPolicy="no-referrer" allow={surface === "box-terminal" ? "clipboard-read; clipboard-write" : undefined}
        hidden={surface === "files"} style={{ border: 0, width: "100%", flex: 1, minHeight: 0 }} /> : null}
      {surface === "files" && filesOpened ? <HivraFiles boxUrl={boxOrigin} access={bridge.files} /> : null}
    </div>
  </div>;
}
