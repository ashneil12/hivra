import { parseChangelog } from "../changelog";

const SAMPLE = `# Hermes Deploy — Changelog

> Last updated: 2026-06-10

---

## [2026-06-10] Public Changelog Page

### Feature

A small change.

### Detail

Another paragraph.

---

## [2026-05-29] Earlier Entry

Body text for the earlier entry.

- Bullet one
- Bullet two

---
`;

describe("parseChangelog", () => {
  it("extracts the Last updated marker", () => {
    const parsed = parseChangelog(SAMPLE);
    expect(parsed.lastUpdated).toBe("2026-06-10");
  });

  it("returns entries newest-first, in source order", () => {
    const parsed = parseChangelog(SAMPLE);
    expect(parsed.entries.map((e) => e.date)).toEqual(["2026-06-10", "2026-05-29"]);
  });

  it("captures the title without the bracketed date", () => {
    const [first, second] = parseChangelog(SAMPLE).entries;
    expect(first.title).toBe("Public Changelog Page");
    expect(second.title).toBe("Earlier Entry");
  });

  it("strips the trailing --- section separator from each body", () => {
    const parsed = parseChangelog(SAMPLE);
    for (const entry of parsed.entries) {
      expect(entry.body.trimEnd().endsWith("---")).toBe(false);
    }
  });

  it("preserves inline markdown inside the body", () => {
    const [first, second] = parseChangelog(SAMPLE).entries;
    expect(first.body).toContain("### Feature");
    expect(first.body).toContain("A small change.");
    expect(second.body).toContain("- Bullet one");
  });

  it("handles a file with no Last updated marker", () => {
    const parsed = parseChangelog("## [2026-01-01] Only Entry\n\nbody\n");
    expect(parsed.lastUpdated).toBeNull();
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].date).toBe("2026-01-01");
  });

  it("returns an empty entry list when the file has no date headings", () => {
    const parsed = parseChangelog("# Changelog\n\n> Last updated: 2026-01-01\n");
    expect(parsed.entries).toEqual([]);
  });

  it("tolerates CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const parsed = parseChangelog(crlf);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].title).toBe("Public Changelog Page");
  });
});
