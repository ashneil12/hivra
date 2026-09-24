/** @jest-environment jsdom */

import {
  LAUNCH_DRAFT_STORAGE_KEY,
  clearLaunchDraft,
  createLaunchDraft,
  isUnfinishedLaunchDraft,
  launchDraftStorageKey,
  readLaunchDraft,
  writeLaunchDraft,
} from "../draft-store";

const OWNER = "user_owner";
const KEY = launchDraftStorageKey(OWNER);
const read = () => readLaunchDraft(OWNER);
const write = (draft: Parameters<typeof writeLaunchDraft>[0]) => writeLaunchDraft(draft, OWNER);

describe("launch draft storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("round-trips only the bounded non-secret launch intent", () => {
    const draft = {
      ...createLaunchDraft(),
      stage: "review" as const,
      resourceKind: "agent" as const,
      profileId: "codex" as const,
      name: "Codex 1",
      submittedDeployment: {
        mode: "self-managed" as const,
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 7,
      },
    };
    write(draft);
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    raw.apiKey = "must-not-survive";
    raw.deployment = { secret: "must-not-survive" };
    raw.submittedDeployment.secret = "must-not-survive";
    window.localStorage.setItem(KEY, JSON.stringify(raw));

    expect(read()).toEqual(draft);
    expect(read()).not.toHaveProperty("apiKey");
    expect(read()).not.toHaveProperty("deployment");
    expect(read()?.submittedDeployment).not.toHaveProperty("secret");
  });

  it("turns an interrupted submission into an uncertain terminal state", () => {
    const draft = { ...createLaunchDraft(), stage: "launch" as const, launchState: "submitting" as const };
    window.localStorage.setItem(KEY, JSON.stringify(draft));

    expect(read()).toMatchObject({
      launchRequestId: draft.launchRequestId,
      stage: "launch",
      launchState: "uncertain",
    });
  });

  it("restores legacy resources without silently adding burst capacity", () => {
    const draft = createLaunchDraft();
    const legacy = { ...draft, resources: { cpu: 2, ram: 4, source: "custom" } };
    window.localStorage.setItem(KEY, JSON.stringify(legacy));
    expect(read()?.resources).toEqual({
      cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "custom",
    });
  });

  it("round-trips the Codex browser choice and restores older Codex drafts with the browser on", () => {
    const draft = {
      ...createLaunchDraft(),
      resourceKind: "agent" as const,
      profileId: "codex" as const,
      browser: false,
      browserSource: "custom" as const,
    };
    write(draft);
    expect(read()).toMatchObject({ browser: false, browserSource: "custom" });

    // Drafts written before the choice existed were launched with the browser.
    const legacy: Record<string, unknown> = { ...draft, launchState: "uncertain" };
    delete legacy.browser;
    delete legacy.browserSource;
    window.localStorage.setItem(KEY, JSON.stringify(legacy));
    expect(read()).toMatchObject({ browser: true, browserSource: "recommended", launchState: "uncertain" });

    // Only Codex has a browser sidecar.
    window.localStorage.setItem(KEY, JSON.stringify({
      ...legacy, resourceKind: "computer", profileId: "ubuntu-desktop", browser: true,
    }));
    expect(read()?.browser).toBe(false);
  });

  it("keeps the size a browser raise replaced only when it is an owner's own Codex size", () => {
    const raisedFrom = { cpu: 1, ram: 2, maximumCpu: 1, maximumRam: 2, source: "custom" as const };
    const draft = {
      ...createLaunchDraft(),
      resourceKind: "agent" as const,
      profileId: "codex" as const,
      browser: true,
      browserSource: "custom" as const,
      resources: { cpu: 1.5, ram: 3, maximumCpu: 1.5, maximumRam: 3, source: "custom" as const },
      browserRaisedFrom: raisedFrom,
    };
    write(draft);
    expect(read()).toEqual(draft);

    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    for (const invalid of [{ ...raisedFrom, cpu: 99 }, { ...raisedFrom, source: "recommended" }, "1 CPU / 2 GB"]) {
      window.localStorage.setItem(KEY, JSON.stringify({ ...raw, browserRaisedFrom: invalid }));
      expect(read()).toMatchObject({ resources: draft.resources, browserRaisedFrom: null });
    }
    window.localStorage.setItem(KEY, JSON.stringify({
      ...raw, resourceKind: "computer", profileId: "ubuntu-desktop",
    }));
    expect(read()?.browserRaisedFrom).toBeNull();

    // Drafts saved before this existed have nothing to give back.
    const legacy = { ...raw };
    delete legacy.browserRaisedFrom;
    window.localStorage.setItem(KEY, JSON.stringify(legacy));
    expect(read()).toMatchObject({ resources: draft.resources, browserRaisedFrom: null });
  });

  it("persists resumable ISO task metadata without persisting a signed URL", () => {
    const draft = {
      ...createLaunchDraft(),
      windowsIsoDownload: {
        taskId: "33333333-3333-4333-8333-333333333333",
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 7,
        source: "windows-server-evaluation" as const,
        storage: "local",
        filename: "SERVER_EVAL_x64FRE_en-us.iso",
        state: "running" as const,
      },
    };
    write(draft);
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    raw.windowsIsoDownload.directUrl = "https://software.download.prss.microsoft.com/file.iso?secret=signed";
    window.localStorage.setItem(KEY, JSON.stringify(raw));
    expect(read()).toEqual(draft);
    expect(JSON.stringify(read())).not.toContain("secret=signed");
  });

  it("keeps drafts per owner across tabs and never shows one owner's draft to another", () => {
    const draft = { ...createLaunchDraft(), stage: "plan" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };
    write(draft);

    expect(window.localStorage.getItem(KEY)).not.toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(readLaunchDraft("user_someone_else")).toBeNull();
    // An unknown owner reads and writes nothing.
    expect(readLaunchDraft(null)).toBeNull();
    writeLaunchDraft({ ...draft, name: "Other" }, null);
    expect(read()?.name).toBe("Codex 1");

    clearLaunchDraft(OWNER);
    expect(read()).toBeNull();
  });

  it("moves a draft this tab saved before drafts moved to localStorage", () => {
    const draft = { ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(draft));

    expect(read()).toEqual(draft);
    expect(window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) || "{}")).toMatchObject({ launchRequestId: draft.launchRequestId });
  });

  it("restores drafts saved with the separate type, profile and capacity stages", () => {
    const base = { ...createLaunchDraft(), resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };
    for (const [legacy, stage] of [["type", "choose"], ["profile", "choose"], ["capacity", "plan"], ["unknown", "choose"]] as const) {
      window.localStorage.setItem(KEY, JSON.stringify({ ...base, stage: legacy }));
      expect(read()?.stage).toBe(stage);
    }
  });

  it("keeps names within the 60 characters every launch route accepts", () => {
    write({ ...createLaunchDraft(), name: "x".repeat(80) });
    expect(read()?.name).toHaveLength(60);
  });

  it.each(["claude-code", "hermes", "openclaw", "agent-zero", "aeon"] as const)("restores a %s draft", profileId => {
    const draft = { ...createLaunchDraft(), stage: "plan" as const, resourceKind: "agent" as const, profileId, name: "Agent 1" };
    write(draft);
    expect(read()).toEqual(draft);
  });

  it("keeps the model choice, but never a key typed for it", () => {
    const draft = {
      ...createLaunchDraft(),
      stage: "review" as const,
      resourceKind: "agent" as const,
      profileId: "hermes" as const,
      name: "Hermes 1",
      sendMemoryKey: true,
      modelAccess: {
        mode: "api-key" as const, source: "custom" as const, provider: "custom_llm", model: "llama3.2",
        keySource: "saved" as const, vaultKeyId: "44444444-4444-4444-8444-444444444444", sendSavedKey: true, saveKey: false,
        walletType: "hermesos" as const, baseUrl: "https://llm.example.test/v1",
      },
    };
    write(draft);
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    raw.modelAccess.apiKey = "must-not-survive";
    raw.modelAccess.key = "must-not-survive";
    window.localStorage.setItem(KEY, JSON.stringify(raw));

    expect(read()).toEqual(draft);
    expect(JSON.stringify(read())).not.toContain("must-not-survive");
  });

  it("saves a pasted key to the Vault only when this draft explicitly chose to", () => {
    const base = { ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };
    write(base);
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    // A draft saved before this choice existed, or with any non-true value, never saves.
    delete raw.modelAccess.saveKey;
    window.localStorage.setItem(KEY, JSON.stringify(raw));
    expect(read()?.modelAccess.saveKey).toBe(false);
    raw.modelAccess.saveKey = "yes";
    window.localStorage.setItem(KEY, JSON.stringify(raw));
    expect(read()?.modelAccess.saveKey).toBe(false);
    write({ ...base, modelAccess: { ...base.modelAccess, saveKey: true } });
    expect(read()?.modelAccess.saveKey).toBe(true);
  });

  it("drops a model choice that could carry a credential or reach outside the dashboard", () => {
    const draft = { ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };
    window.localStorage.setItem(KEY, JSON.stringify({
      ...draft,
      modelAccess: {
        mode: "api-key", provider: "venice; rm -rf", model: "bad model", vaultKeyId: "not-a-uuid", sendSavedKey: "yes",
        baseUrl: "https://user:secret@llm.example.test/v1",
      },
      // Consent to send a memory key is Hermes' only.
      sendMemoryKey: true,
      errorAction: { kind: "open", label: "Open", href: "https://evil.example.test/" },
    }));

    expect(read()).toMatchObject({
      modelAccess: { mode: "api-key", provider: "venice", model: "", vaultKeyId: null, sendSavedKey: false, baseUrl: "" },
      sendMemoryKey: false,
      errorAction: null,
    });
  });

  it("keeps a next step only when it opens a dashboard page or the card check", () => {
    const draft = { ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "hermes" as const, name: "Hermes 1" };
    write({ ...draft, errorAction: { kind: "open", label: "Open your agent", href: "/dashboard/instances/77777777-7777-4777-8777-777777777777" } });
    expect(read()?.errorAction).toEqual({ kind: "open", label: "Open your agent", href: "/dashboard/instances/77777777-7777-4777-8777-777777777777" });
    write({ ...draft, errorAction: { kind: "verify-card" } });
    expect(read()?.errorAction).toEqual({ kind: "verify-card" });
  });

  it("treats only a chosen, not yet launched draft as unfinished", () => {
    const chosen = { ...createLaunchDraft(), stage: "plan" as const, resourceKind: "agent" as const, profileId: "codex" as const };
    expect(isUnfinishedLaunchDraft(chosen)).toBe(true);
    expect(isUnfinishedLaunchDraft({ ...chosen, stage: "launch", launchState: "failed" })).toBe(true);
    expect(isUnfinishedLaunchDraft(createLaunchDraft())).toBe(false);
    expect(isUnfinishedLaunchDraft({ ...chosen, launchState: "uncertain" })).toBe(false);
    expect(isUnfinishedLaunchDraft({ ...chosen, launchState: "accepted" })).toBe(false);
    expect(isUnfinishedLaunchDraft(null)).toBe(false);
  });
});
