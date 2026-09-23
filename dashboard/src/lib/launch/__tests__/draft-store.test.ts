/** @jest-environment jsdom */

import {
  LAUNCH_DRAFT_STORAGE_KEY,
  createLaunchDraft,
  readLaunchDraft,
  writeLaunchDraft,
} from "../draft-store";

describe("launch draft storage", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("round-trips only the bounded non-secret launch intent", () => {
    const draft = {
      ...createLaunchDraft(),
      stage: "review" as const,
      resourceKind: "agent" as const,
      profileId: "codex" as const,
      name: "MY_CODEX_AGENT",
      submittedDeployment: {
        mode: "self-managed" as const,
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 7,
      },
    };
    writeLaunchDraft(draft);
    const raw = JSON.parse(window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY) || "{}");
    raw.apiKey = "must-not-survive";
    raw.deployment = { secret: "must-not-survive" };
    raw.submittedDeployment.secret = "must-not-survive";
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(raw));

    expect(readLaunchDraft()).toEqual(draft);
    expect(readLaunchDraft()).not.toHaveProperty("apiKey");
    expect(readLaunchDraft()).not.toHaveProperty("deployment");
    expect(readLaunchDraft()?.submittedDeployment).not.toHaveProperty("secret");
  });

  it("turns an interrupted submission into an uncertain terminal state", () => {
    const draft = { ...createLaunchDraft(), stage: "launch" as const, launchState: "submitting" as const };
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(draft));

    expect(readLaunchDraft()).toMatchObject({
      launchRequestId: draft.launchRequestId,
      stage: "launch",
      launchState: "uncertain",
    });
  });

  it("restores legacy resources without silently adding burst capacity", () => {
    const draft = createLaunchDraft();
    const legacy = { ...draft, resources: { cpu: 2, ram: 4, source: "custom" } };
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy));
    expect(readLaunchDraft()?.resources).toEqual({
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
    writeLaunchDraft(draft);
    expect(readLaunchDraft()).toMatchObject({ browser: false, browserSource: "custom" });

    // Drafts written before the choice existed were launched with the browser.
    const legacy: Record<string, unknown> = { ...draft, launchState: "uncertain" };
    delete legacy.browser;
    delete legacy.browserSource;
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy));
    expect(readLaunchDraft()).toMatchObject({ browser: true, browserSource: "recommended", launchState: "uncertain" });

    // Only Codex has a browser sidecar.
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify({
      ...legacy, resourceKind: "computer", profileId: "ubuntu-desktop", browser: true,
    }));
    expect(readLaunchDraft()?.browser).toBe(false);
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
    writeLaunchDraft(draft);
    expect(readLaunchDraft()).toEqual(draft);

    const raw = JSON.parse(window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY) || "{}");
    for (const invalid of [{ ...raisedFrom, cpu: 99 }, { ...raisedFrom, source: "recommended" }, "1 CPU / 2 GB"]) {
      window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify({ ...raw, browserRaisedFrom: invalid }));
      expect(readLaunchDraft()).toMatchObject({ resources: draft.resources, browserRaisedFrom: null });
    }
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify({
      ...raw, resourceKind: "computer", profileId: "ubuntu-desktop",
    }));
    expect(readLaunchDraft()?.browserRaisedFrom).toBeNull();

    // Drafts saved before this existed have nothing to give back.
    const legacy = { ...raw };
    delete legacy.browserRaisedFrom;
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy));
    expect(readLaunchDraft()).toMatchObject({ resources: draft.resources, browserRaisedFrom: null });
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
    writeLaunchDraft(draft);
    const raw = JSON.parse(window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY) || "{}");
    raw.windowsIsoDownload.directUrl = "https://software.download.prss.microsoft.com/file.iso?secret=signed";
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(raw));
    expect(readLaunchDraft()).toEqual(draft);
    expect(JSON.stringify(readLaunchDraft())).not.toContain("secret=signed");
  });
});
