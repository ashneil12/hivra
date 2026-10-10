/** @jest-environment jsdom */
import { DEFAULT_DIGITALOCEAN_CHOICE } from "../contracts";
import { createLaunchDraft, launchDraftStorageKey, readLaunchDraft, writeLaunchDraft } from "../draft-store";
import {
  digitalOceanHarnessFor,
  digitalOceanKeySource,
  digitalOceanLaunchRequest,
  digitalOceanModelProblem,
  digitalOceanModelSummary,
  digitalOceanSavedKey,
  digitalOceanSizeLabel,
} from "../digitalocean-launch";
import { launchResultHref, launchResumeModeFor, opensOnAcceptanceFor } from "../launch-adapter";
import type { SavedModelKey } from "../model-access";

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
    const choice = { ...DEFAULT_DIGITALOCEAN_CHOICE };
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
      digitalOcean: {
        ...DEFAULT_DIGITALOCEAN_CHOICE, size: "mars-1vcpu-1gb" as const, modelMode: "digitalocean-inference" as const,
        model: "llama3.3-70b-instruct", firstTask: "Summarize the repo",
      },
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
    expect(read?.digitalOcean).toEqual({
      size: "mars-2vcpu-4gb", modelMode: "digitalocean-inference", model: "llama3.3-70b-instruct", firstTask: "Summarize the repo",
      keySource: null, vaultKeyId: null, sendSavedKey: false, saveKey: false,
    });
    expect(JSON.stringify(read)).not.toContain("must-not-survive");
  });

  // INF-16: every DigitalOcean launch asked for the provider key again.
  describe("with a key saved in the Vault", () => {
    const KEY_ID = "44444444-4444-4444-8444-444444444444";
    const saved: SavedModelKey[] = [
      { id: "55555555-5555-4555-8555-555555555555", provider: "codex", name: "ChatGPT", key_preview: null },
      { id: KEY_ID, provider: "openai", name: "OpenAI", key_preview: "sk-abc...3f2a" },
    ];

    it("offers the saved provider key for the harness, and never a ChatGPT sign-in or another provider's key", () => {
      const choice = { ...DEFAULT_DIGITALOCEAN_CHOICE };
      expect(digitalOceanSavedKey("codex", choice, saved)?.id).toBe(KEY_ID);
      expect(digitalOceanSavedKey("claude-code", choice, saved)).toBeNull();
      // The Vault holds no DigitalOcean model access key.
      expect(digitalOceanSavedKey("codex", { ...choice, modelMode: "digitalocean-inference" }, saved)).toBeNull();
      expect(digitalOceanSavedKey("hermes", choice, saved)).toBeNull();
      expect(digitalOceanKeySource("codex", choice, saved)).toBe("saved");
      expect(digitalOceanKeySource("codex", { ...choice, keySource: "paste" }, saved)).toBe("paste");
      expect(digitalOceanKeySource("codex", choice, [])).toBe("paste");
    });

    it("sends it only once the owner confirms it for this launch", () => {
      const choice = { ...DEFAULT_DIGITALOCEAN_CHOICE };
      expect(digitalOceanModelProblem("codex", choice, "", saved))
        .toBe("Confirm that your saved OpenAI API key can be sent to DigitalOcean for this sandbox.");
      const confirmed = { ...choice, keySource: "saved" as const, vaultKeyId: KEY_ID, sendSavedKey: true };
      expect(digitalOceanModelProblem("codex", confirmed, "", saved)).toBeNull();
      // A confirmation given for a key that has since been replaced doesn't carry over.
      expect(digitalOceanModelProblem("codex", { ...confirmed, vaultKeyId: "66666666-6666-4666-8666-666666666666" }, "", saved))
        .toMatch(/^Confirm that your saved/);
      expect(digitalOceanModelSummary("codex", confirmed, saved)).toBe("Your saved OpenAI API key ••3f2a, sent to DigitalOcean for this sandbox");
      expect(digitalOceanModelSummary("codex", { ...choice, keySource: "paste", saveKey: true }, saved))
        .toBe("Your OpenAI API key, sent to DigitalOcean for this sandbox and saved in your Vault, replacing ••3f2a");

      const draft = {
        ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1",
        capacity: { mode: "digitalocean" as const, targetId: TEAM_ID }, digitalOcean: confirmed,
      };
      const team = { capacity: { sizes: [{ slug: "mars-2vcpu-4gb", vcpus: 2, memoryMb: 4096 }] } } as Parameters<typeof digitalOceanLaunchRequest>[2];
      expect(digitalOceanLaunchRequest(draft, { connectionId: CONNECTION_ID, targetId: TEAM_ID }, team, { vaultKeyId: KEY_ID }).model)
        .toEqual({ mode: "vendor", vaultKeyId: KEY_ID });
    });

    it("keeps the confirmation per launch draft, never a key", () => {
      window.localStorage.clear();
      const draft = {
        ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1",
        capacity: { mode: "digitalocean" as const, targetId: TEAM_ID },
        digitalOcean: { ...DEFAULT_DIGITALOCEAN_CHOICE, keySource: "saved" as const, vaultKeyId: KEY_ID, sendSavedKey: true },
      };
      writeLaunchDraft(draft, "owner");
      const raw = JSON.parse(window.localStorage.getItem(launchDraftStorageKey("owner")) || "{}");
      raw.digitalOcean.vaultKeyId = "not-a-vault-id";
      window.localStorage.setItem(launchDraftStorageKey("owner"), JSON.stringify(raw));
      expect(readLaunchDraft("owner")?.digitalOcean).toMatchObject({ keySource: "saved", vaultKeyId: null, sendSavedKey: true });
      writeLaunchDraft(draft, "owner");
      expect(readLaunchDraft("owner")?.digitalOcean).toMatchObject({ keySource: "saved", vaultKeyId: KEY_ID, sendSavedKey: true });
    });
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
