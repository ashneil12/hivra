/** @jest-environment jsdom */
import { createLaunchDraft, launchDraftStorageKey, readLaunchDraft, writeLaunchDraft } from "../draft-store";
import { digitalOceanHarnessFor, digitalOceanModelProblem, digitalOceanSizeLabel } from "../digitalocean-launch";
import { launchResultHref, launchResumeModeFor, opensOnAcceptanceFor } from "../launch-adapter";

const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("DigitalOcean as a place a Launch agent runs", () => {
  it("runs only the agents DigitalOcean Managed Agents supports", () => {
    expect(digitalOceanHarnessFor("codex")).toBe("codex");
    expect(digitalOceanHarnessFor("claude-code")).toBe("claude-code");
    expect(digitalOceanHarnessFor("hermes")).toBe("hermes");
    expect(digitalOceanHarnessFor("openclaw")).toBeNull();
    expect(digitalOceanHarnessFor("ubuntu-desktop")).toBeNull();
    expect(digitalOceanHarnessFor(null)).toBeNull();
  });

  it("asks for the key and model each mode needs", () => {
    const choice = { size: "mars-2vcpu-4gb" as const, modelMode: "vendor" as const, model: "" };
    expect(digitalOceanModelProblem("codex", choice, "")).toBe("Paste your OpenAI API key for Codex.");
    expect(digitalOceanModelProblem("codex", choice, "sk-test-openai-key-for-launch-0000")).toBeNull();
    // Hermes has no vendor key there: it always needs Inference, a key and a model.
    expect(digitalOceanModelProblem("hermes", choice, "")).toBe("Paste a DigitalOcean model access key.");
    expect(digitalOceanModelProblem("hermes", choice, "do-model-access-key-for-launch-000")).toBe("Choose the DigitalOcean model it uses.");
    expect(digitalOceanModelProblem("hermes", { ...choice, model: "llama3.3-70b-instruct" }, "do-model-access-key-for-launch-000")).toBeNull();
    expect(digitalOceanSizeLabel({ vcpus: 2, memoryMb: 4096 })).toBe("2 vCPU / 4 GB");
  });

  it("keeps the team and choices in the saved draft, never a key", () => {
    window.localStorage.clear();
    const draft = {
      ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1",
      capacity: { mode: "digitalocean" as const, targetId: TEAM_ID },
      digitalOcean: { size: "mars-1vcpu-1gb" as const, modelMode: "digitalocean-inference" as const, model: "llama3.3-70b-instruct" },
      submittedDeployment: { mode: "digitalocean" as const, connectionId: CONNECTION_ID, targetId: TEAM_ID },
    };
    writeLaunchDraft(draft, "owner");
    const raw = JSON.parse(window.localStorage.getItem(launchDraftStorageKey("owner")) || "{}");
    raw.digitalOcean.apiKey = "must-not-survive";
    raw.digitalOcean.size = "mars-99vcpu";
    window.localStorage.setItem(launchDraftStorageKey("owner"), JSON.stringify(raw));
    const read = readLaunchDraft("owner");
    expect(read?.capacity).toEqual({ mode: "digitalocean", targetId: TEAM_ID });
    expect(read?.submittedDeployment).toEqual({ mode: "digitalocean", connectionId: CONNECTION_ID, targetId: TEAM_ID });
    expect(read?.digitalOcean).toEqual({ size: "mars-2vcpu-4gb", modelMode: "digitalocean-inference", model: "llama3.3-70b-instruct" });
    expect(JSON.stringify(read)).not.toContain("must-not-survive");
  });

  it("resumes by sending the same request again and opens the DigitalOcean agent, for every harness", () => {
    const hermes = { profileId: "hermes" as const, capacity: { mode: "digitalocean" as const, targetId: TEAM_ID } };
    expect(launchResumeModeFor(hermes)).toBe("resend");
    expect(opensOnAcceptanceFor(hermes)).toBe(true);
    expect(launchResultHref({ ...createLaunchDraft(), ...hermes }, "agent-1")).toBe("/dashboard/agent/agent-1");
    // Elsewhere each lane keeps its own rules.
    expect(launchResumeModeFor({ profileId: "hermes", capacity: { mode: "hivra-managed", targetId: null } })).toBe("observe");
    expect(opensOnAcceptanceFor({ profileId: "hermes", capacity: { mode: "hivra-managed", targetId: null } })).toBe(false);
  });
});
