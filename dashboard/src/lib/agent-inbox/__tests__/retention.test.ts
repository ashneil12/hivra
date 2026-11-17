import type { SupabaseClient } from "@supabase/supabase-js";

import { CLOSED_PROMPT_RETENTION_DAYS, inboxPromptRetentionCutoff, runInboxPromptRetention } from "../retention";

type Row = Record<string, unknown>;

const NOW = new Date("2026-11-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function row(id: string, overrides: Row = {}): Row {
  return {
    id,
    summary: "delete files",
    command: "rm -rf dist",
    answer_choice: null,
    answer_text: null,
    expires_at: daysAgo(8),
    ...overrides,
  };
}

function fakeClient(rows: Row[], fail = false) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      if (table !== "agent_inbox_prompts") throw new Error(`unexpected table ${table}`);
      const filters: ((r: Row) => boolean)[] = [];
      let mode: "select" | "delete" = "select";
      const api = {
        select: () => api,
        delete: () => { mode = "delete"; return api; },
        lt: (column: string, value: string) => { filters.push((r) => String(r[column]) < value); return api; },
        then: (resolve: (value: { count: number | null; error: { message: string } | null }) => unknown) => {
          calls.push(mode);
          if (fail) return Promise.resolve({ count: null, error: { message: "boom" } }).then(resolve);
          const hit = rows.filter((r) => filters.every((test) => test(r)));
          if (mode === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return Promise.resolve({ count: hit.length, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("runInboxPromptRetention", () => {
  it("uses a seven day window", () => {
    expect(CLOSED_PROMPT_RETENTION_DAYS).toBe(7);
    expect(inboxPromptRetentionCutoff(NOW).toISOString()).toBe("2026-11-10T12:00:00.000Z");
  });

  it("deletes requests that closed more than a week ago, whatever the answer was", async () => {
    const rows = [
      row("expired-unanswered"),
      row("answered-once", { answer_choice: "once" }),
      row("refused-with-a-note", { answer_choice: "deny", answer_text: "not that folder" }),
      row("allowed-for-the-chat", { answer_choice: "session" }),
      row("closed-six-days-ago", { expires_at: daysAgo(6) }),
      row("recent-chat-permission", { answer_choice: "session", expires_at: daysAgo(2) }),
      row("still-open", { expires_at: new Date(NOW.getTime() + 60_000).toISOString() }),
    ];
    const { client, calls } = fakeClient(rows);

    const summary = await runInboxPromptRetention(client, { now: NOW });

    expect(summary).toEqual({ dryRun: false, retentionDays: 7, cutoff: "2026-11-10T12:00:00.000Z", deleted: 4 });
    expect(calls).toEqual(["delete"]);
    expect(rows.map((r) => r.id)).toEqual(["closed-six-days-ago", "recent-chat-permission", "still-open"]);
  });

  it("only counts on a dry run", async () => {
    const rows = [row("old"), row("old-chat-permission", { answer_choice: "session" }), row("new", { expires_at: daysAgo(1) })];
    const { client, calls } = fakeClient(rows);

    const summary = await runInboxPromptRetention(client, { now: NOW, dryRun: true });

    expect(summary).toMatchObject({ dryRun: true, deleted: 2 });
    expect(calls).toEqual(["select"]);
    expect(rows).toHaveLength(3);
  });

  it("reports a database error instead of a count", async () => {
    await expect(runInboxPromptRetention(fakeClient([row("old")], true).client, { now: NOW }))
      .rejects.toThrow("agent inbox retention could not delete closed requests: boom");
    await expect(runInboxPromptRetention(fakeClient([row("old")], true).client, { now: NOW, dryRun: true }))
      .rejects.toThrow("agent inbox retention could not count closed requests: boom");
  });
});
