/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  readAgentActivityFromBox,
  readAgentIdleEvidence,
  readAgentSoftwareFromBox,
  readSurfaceWatchdogFromBox,
} from "../agent-cli-meta";
import { agentSoftwareSubject, type AgentSoftwareSubject } from "../agent-cli-status";
import { HIVRA_BACKGROUND_HEADER, HIVRA_BACKGROUND_HEADERS } from "../background-read";

// Hivra's cron and sweep reads of a computer must say they are background reads, so the host wake
// proxy neither counts them as the owner's use (which kept every proxied computer from napping) nor
// wakes a napped computer for them.

const HOST = "box-7f3a.hivra.example";
const ORIGIN = `https://${HOST}`;
const TOKEN = "a".repeat(64);
const BOOT_ID = "95cd11d8e6b99c5b1d212a07568d2d73";
const codex = agentSoftwareSubject({ type: "codex" }) as AgentSoftwareSubject;
const aeon = agentSoftwareSubject({ type: "aeon" }) as AgentSoftwareSubject;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** A computer that answers every read and records each request's headers. */
function recordingBox(agentKind: string) {
  return jest.fn<Promise<Response>, [string, RequestInit?]>(async (url: string) => {
    const route = url.slice(ORIGIN.length);
    if (route === "/api/meta") return json({ agentKind, model: null, surfaceAuth: "post-cookie-v1", bootId: BOOT_ID });
    if (route === "/api/chat/runs") return json({ runs: [] });
    if (route.startsWith("/api/terminal/sessions")) return json({ surface: "agent", sessions: [] });
    if (route === "/api/surface-watchdog") {
      return json({ ok: true, agentKind, updatedAt: "2026-11-15T17:30:05.000Z", surface: { status: "ok", reason: null, restarts: 0 }, events: [] });
    }
    return json({});
  });
}

function expectEveryRequestMarked(fetcher: jest.Mock<Promise<Response>, [string, RequestInit?]>, minimum: number) {
  expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(minimum);
  for (const [, init] of fetcher.mock.calls) {
    expect(new Headers((init as RequestInit).headers).get(HIVRA_BACKGROUND_HEADER)).toBe("1");
  }
  // At least one of them carried the bearer, which is what the proxy would have counted as use.
  expect(fetcher.mock.calls.some(([, init]) => new Headers((init as RequestInit).headers).get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
}

describe("Hivra background reads of a computer", () => {
  it("marks the surface watchdog read (cron hivra-surface-watchdog)", async () => {
    const fetcher = recordingBox("agent-zero");
    const reading = await readSurfaceWatchdogFromBox({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN }, fetcher);
    expect(reading.observation).toBe("reported");
    expectEveryRequestMarked(fetcher, 2);
  });

  it("marks the activity sampler read (cron sample-agent-activity)", async () => {
    const fetcher = recordingBox("aeon");
    expect(await readAgentActivityFromBox({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN, subject: aeon }, fetcher)).not.toBeNull();
    expectEveryRequestMarked(fetcher, 4);
  });

  it("marks the update sweep's idle evidence read (cron update-hivra-agent-clis)", async () => {
    const fetcher = recordingBox("codex");
    expect(await readAgentIdleEvidence({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN }, fetcher)).not.toBeNull();
    expectEveryRequestMarked(fetcher, 2);
  });

  it("marks the agent software read", async () => {
    const fetcher = recordingBox("codex");
    await readAgentSoftwareFromBox({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN, subject: codex }, fetcher);
    expectEveryRequestMarked(fetcher, 2);
  });

  it("uses the header and value the host wake proxy honours", () => {
    expect(HIVRA_BACKGROUND_HEADERS).toEqual({ [HIVRA_BACKGROUND_HEADER]: "1" });
    const proxy = readFileSync(path.join(__dirname, "../../../../provisioner/hivra-wake-proxy.py"), "utf8");
    expect(proxy).toContain(`BACKGROUND_HEADER = "${HIVRA_BACKGROUND_HEADER.toLowerCase()}"`);
    expect(proxy).toMatch(/def background_request\(request\):[\s\S]*?values\[0\]\.strip\(\) == "1"/);
  });
});
