// Reads Chromium's own report of its sandbox (chrome://sandbox) so CI and the
// fleet audit can prove the sandbox is really on, rather than inferring it from
// the absence of --no-sandbox.

export type SandboxVerdict = "adequate" | "not_adequate" | "unknown";

export interface SandboxReport {
  verdict: SandboxVerdict;
  // Chromium's per-layer rows, e.g. { "PID namespaces": "Yes", "Seccomp-BPF sandbox": "Yes" }.
  layers: Record<string, string>;
}

// Rows Chromium prints on chrome://sandbox (Linux). Each must read "Yes" for an
// adequate sandbox, apart from the informational ones we only record.
const REQUIRED_LAYERS = ["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"] as const;

export function parseSandboxPage(text: string): SandboxReport {
  const layers: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    // innerText renders the table either as "Label\tValue" on one line or as
    // the label and value on consecutive lines.
    const [label, inlineValue] = lines[index].split("\t").map((cell) => cell.trim());
    if (!/^(Layer 1 Sandbox|SUID Sandbox|Namespace Sandbox|PID namespaces|Network namespaces|Seccomp-BPF sandbox.*|Yama LSM Enforcing)$/.test(label)) {
      continue;
    }
    const value = inlineValue ?? lines[index + 1];
    if (value !== undefined) layers[label] = value;
  }
  let verdict: SandboxVerdict = "unknown";
  if (/not adequately sandboxed/i.test(text)) verdict = "not_adequate";
  else if (/You are adequately sandboxed/i.test(text)) verdict = "adequate";
  // Trust the layer rows over the summary sentence if they disagree.
  if (verdict === "adequate" && REQUIRED_LAYERS.some((layer) => layers[layer] !== "Yes")) {
    verdict = "not_adequate";
  }
  return { verdict, layers };
}
