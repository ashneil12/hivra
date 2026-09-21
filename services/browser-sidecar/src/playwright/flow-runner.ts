import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Page } from "playwright";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionManager } from "./session-manager.js";
import { fetchVerificationCode } from "../imap/client.js";
import { assertNavigationAllowed } from "../navigation-guard.js";

interface FlowStep {
  id?: string;
  type: string;
  args?: Record<string, unknown>;
  on_match?: "return_ok" | "continue";
}

interface FlowDefinition {
  id: string;
  description?: string;
  steps: FlowStep[];
}

export interface FlowOutput {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  failed_step?: string;
}

// Resolves ${env:VAR}, ${args:KEY}, and ${state:KEY} in step args.
// Anything unmatched stays literal — that's deliberate, so a CSS selector with
// a $ in it doesn't get mangled.
function interpolate(value: unknown, env: NodeJS.ProcessEnv, args: Record<string, unknown>, state: Record<string, unknown>): unknown {
  if (typeof value !== "string") {
    if (Array.isArray(value)) return value.map((v) => interpolate(v, env, args, state));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env, args, state);
      return out;
    }
    return value;
  }
  return value.replace(/\$\{(env|args|state):([A-Za-z][A-Za-z0-9_]*)\}/g, (_m, src, key) => {
    if (src === "env") return env[key] ?? "";
    if (src === "args") return String(args[key] ?? "");
    if (src === "state") return String(state[key] ?? "");
    return _m;
  });
}

export class FlowRunner {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly sessions: SessionManager,
  ) {}

  async loadFlow(flow_id: string): Promise<FlowDefinition> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(flow_id)) {
      throw new Error("flow_id must match /^[a-z0-9][a-z0-9_-]{0,63}$/i");
    }
    const path = join(this.config.FLOWS_DIR, `${flow_id}.yaml`);
    const text = await readFile(path, "utf8");
    const def = parseYaml(text) as FlowDefinition;
    if (def.id !== flow_id) throw new Error(`flow file id mismatch: file=${def.id} requested=${flow_id}`);
    if (!Array.isArray(def.steps)) throw new Error("flow has no steps[]");
    return def;
  }

  async run(opts: { session_id: string; flow_id: string; args?: Record<string, unknown> }): Promise<FlowOutput> {
    const session = this.sessions.get(opts.session_id);
    if (!session) return { ok: false, error: "SESSION_NOT_FOUND" };

    const def = await this.loadFlow(opts.flow_id);
    const flowArgs = opts.args ?? {};
    const state: Record<string, unknown> = {};
    const page = session.page;
    const stepLog = this.logger.child({ flow: opts.flow_id, session_id: opts.session_id });

    for (const rawStep of def.steps) {
      const step: FlowStep = {
        ...rawStep,
        args: interpolate(rawStep.args ?? {}, process.env, flowArgs, state) as Record<string, unknown>,
      };
      stepLog.debug({ step_id: step.id, type: step.type }, "step");

      try {
        const result = await this.runStep(step, page, state);
        if (result?.terminate) {
          return { ok: true, output: state };
        }
      } catch (err) {
        return {
          ok: false,
          error: (err as Error).message,
          failed_step: step.id ?? step.type,
        };
      }
    }
    return { ok: true, output: state };
  }

  private async runStep(step: FlowStep, page: Page, state: Record<string, unknown>): Promise<{ terminate?: boolean } | undefined> {
    const a = step.args ?? {};
    switch (step.type) {
      case "goto": {
        // Same SSRF policy as the /goto route — a flow's goto url can be
        // interpolated from caller-supplied ${args:...}, so it must not be
        // pointable at loopback / metadata / sibling docker services.
        assertNavigationAllowed(String(a.url));
        await page.goto(String(a.url));
        return;
      }
      case "click_text": {
        const loc = page.getByText(String(a.text), { exact: a.exact === true });
        await (typeof a.nth === "number" ? loc.nth(a.nth) : loc.first()).click();
        return;
      }
      case "click_selector": {
        await page.locator(String(a.selector)).first().click();
        return;
      }
      case "fill": {
        await page.locator(String(a.selector)).first().fill(String(a.value));
        return;
      }
      case "wait_for": {
        await page.locator(String(a.selector)).first().waitFor({
          state: (a.state as "visible" | "attached" | "hidden" | "detached") ?? "visible",
          timeout: typeof a.timeout_ms === "number" ? a.timeout_ms : undefined,
        });
        return;
      }
      case "assert_visible": {
        const visible = await page.locator(String(a.selector)).first().isVisible();
        if (!visible) throw new Error(`assert_visible failed: ${String(a.selector)} not visible`);
        return;
      }
      case "get_text": {
        const text = await page.locator(String(a.selector)).first().innerText();
        state[String(a.into ?? "text")] = text;
        return;
      }
      case "check_url": {
        const current = page.url();
        const matched = String(current).includes(String(a.contains));
        if (matched && step.on_match === "return_ok") return { terminate: true };
        if (!matched && a.required === true) {
          throw new Error(`check_url required mismatch: current=${current} contains=${String(a.contains)}`);
        }
        return;
      }
      case "imap_wait_code": {
        // The credential read happens inside fetchVerificationCode. We never pass
        // creds through the YAML or step args — they come from env at call time.
        const code = await fetchVerificationCode(this.config, this.logger, {
          subjectPattern: a.subject_pattern ? String(a.subject_pattern) : undefined,
          since: typeof a.since_ms === "number" ? Date.now() - a.since_ms : Date.now() - 5 * 60_000,
        });
        state[String(a.into ?? "code")] = code;
        return;
      }
      case "log": {
        this.logger.info({ flow_state: state, message: a.message }, "flow log");
        return;
      }
      default:
        throw new Error(`unknown step type: ${step.type}`);
    }
  }
}
