import seccompProfile from "./seccomp-chromium.json";

// Container settings that let the browser sidecar's Chromium run with its own
// sandbox ON. The sidecar browses untrusted sites and never passes
// --no-sandbox (services/browser-sidecar/src/browser/chromium.ts), so without
// these settings its browser refuses to start and /health turns 503.
//
// Docker's default seccomp profile blocks the unprivileged user, PID and
// network namespaces Chromium's sandbox is built on. seccomp-chromium.json is
// Docker's default plus exactly that rule; it is a byte copy of
// services/browser-sidecar/docker/seccomp-chromium.json (a test keeps them
// equal). The deploy script writes it next to docker-compose.yml, because
// compose reads a seccomp profile from a file on the VM.

export const BROWSER_SIDECAR_SECCOMP_FILE = "browser-sidecar-seccomp.json";

export function browserSidecarSeccompProfileJson(): string {
  return `${JSON.stringify(seccompProfile, null, 2)}\n`;
}

export function browserSidecarSecurityOpts(instanceDir: string): string[] {
  return [
    `seccomp=${instanceDir}/${BROWSER_SIDECAR_SECCOMP_FILE}`,
    // The entrypoint only ever drops privileges; nothing may regain them.
    "no-new-privileges:true",
  ];
}
