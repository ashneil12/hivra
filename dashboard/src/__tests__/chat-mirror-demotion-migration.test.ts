import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "supabase/migrations/20260503180000_demote_chat_mirror_content.sql"
);

describe("chat mirror demotion migration", () => {
  it("documents deprecated chat-content mirror tables and blocks new mirror inserts", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);

    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

    expect(sql).toContain("COMMENT ON TABLE public.hermes_messages");
    expect(sql).toContain("message_count");
    expect(sql).toContain("to_regclass('public.chat_session_mirror')");
    expect(sql).toContain("prevent_deprecated_chat_content_mirror_write");
    expect(sql).toContain("BEFORE INSERT ON public.hermes_messages");
    expect(sql).toContain("prevent_deprecated_chat_session_mirror_insert");
  });
});
