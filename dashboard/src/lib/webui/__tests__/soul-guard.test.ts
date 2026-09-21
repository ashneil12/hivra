import {
  FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN,
  SOUL_WROTE_MARKER,
  SOUL_SKIPPED_MARKER,
  isFactoryOrRitualSoul,
  buildGuardedSoulWriteExecSh,
  classifySoulWriteStdout,
} from "../soul-guard";
import { ONBOARDING_RITUAL } from "@/lib/onboarding-ritual";

describe("FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN", () => {
  it("is the exact ERE the provision seeder embeds (guards against drift)", () => {
    expect(FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN).toBe(
      "^You are Hermes Agent|^# Hermes Agent Persona|just came online",
    );
  });

  it("carries no shell-metacharacters that would break a double-quoted grep arg", () => {
    expect(FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN).not.toMatch(/["$`]/);
  });
});

describe("isFactoryOrRitualSoul", () => {
  it("treats an empty or whitespace-only soul as overwritable", () => {
    expect(isFactoryOrRitualSoul("")).toBe(true);
    expect(isFactoryOrRitualSoul("   \n  ")).toBe(true);
    expect(isFactoryOrRitualSoul(null)).toBe(true);
    expect(isFactoryOrRitualSoul(undefined)).toBe(true);
  });

  it("treats the agent image's factory-default persona as overwritable", () => {
    expect(isFactoryOrRitualSoul("You are Hermes Agent, a helpful assistant.")).toBe(true);
    expect(isFactoryOrRitualSoul("# Hermes Agent Persona\n\nYou are helpful.")).toBe(true);
  });

  it("treats the un-run onboarding ritual as overwritable", () => {
    // The shipped ritual header is "# SOUL.md — (unnamed, just came online)".
    expect(isFactoryOrRitualSoul(ONBOARDING_RITUAL)).toBe(true);
  });

  it("preserves a genuinely-authored identity (agent- or user-written soul)", () => {
    expect(isFactoryOrRitualSoul("# Bea\n\nWarm, sharp operator.")).toBe(false);
    expect(isFactoryOrRitualSoul("# Sloane\n\nI run your business.")).toBe(false);
    expect(isFactoryOrRitualSoul("You are a pirate. Arr.")).toBe(false);
  });

  it("only inspects the first three lines, matching `head -3` semantics", () => {
    // A factory marker buried on line 4 must NOT make an authored soul overwritable.
    const soul = "# My Real Identity\nline 2\nline 3\nYou are Hermes Agent";
    expect(isFactoryOrRitualSoul(soul)).toBe(false);
  });
});

describe("buildGuardedSoulWriteExecSh", () => {
  it("guards the write behind the empty-or-factory-or-ritual condition", () => {
    const sh = buildGuardedSoulWriteExecSh("/home/hermes/.hermes", false);
    // Only writes when the file is empty OR its head matches the shared pattern.
    expect(sh).toContain('[ ! -s "$soul_path" ]');
    expect(sh).toContain('head -3 "$soul_path" 2>/dev/null | grep -qE "$head_pattern"');
    expect(sh).toContain(FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN);
    // Writes the SOUL.md and fixes ownership on the write branch.
    expect(sh).toContain('cat > "$soul_path"');
    expect(sh).toContain('chown -R 1024:1024 "$target_dir"');
    // Passes the resolved target dir through as a positional arg.
    expect(sh).toContain(JSON.stringify("/home/hermes/.hermes"));
  });

  it("drains stdin on the skip branch so the upstream base64 pipe never SIGPIPEs", () => {
    const sh = buildGuardedSoulWriteExecSh("/home/hermes/.hermes", false);
    expect(sh).toContain("cat >/dev/null");
  });

  it("echoes distinct markers so the caller can tell write from skip", () => {
    const sh = buildGuardedSoulWriteExecSh("/home/hermes/.hermes", false);
    expect(sh).toContain(`echo ${SOUL_WROTE_MARKER}`);
    expect(sh).toContain(`echo ${SOUL_SKIPPED_MARKER}`);
  });

  it("passes overwrite=0 by default and overwrite=1 when opted in", () => {
    expect(buildGuardedSoulWriteExecSh("/d", false).trimEnd().endsWith(" 0")).toBe(true);
    expect(buildGuardedSoulWriteExecSh("/d", true).trimEnd().endsWith(" 1")).toBe(true);
  });

  it("short-circuits the guard when overwrite is set", () => {
    const sh = buildGuardedSoulWriteExecSh("/d", true);
    expect(sh).toContain('[ "$overwrite" = "1" ]');
  });
});

describe("classifySoulWriteStdout", () => {
  it("reports a skip when the skip marker is present", () => {
    expect(classifySoulWriteStdout(`noise\n${SOUL_SKIPPED_MARKER}\n`)).toBe(
      "skipped_existing_identity",
    );
  });

  it("reports a write when the write marker is present", () => {
    expect(classifySoulWriteStdout(`${SOUL_WROTE_MARKER}\n`)).toBe("written");
  });

  it("defaults to written when neither marker is present (ssh already asserted success)", () => {
    expect(classifySoulWriteStdout("")).toBe("written");
    expect(classifySoulWriteStdout(null)).toBe("written");
    expect(classifySoulWriteStdout(undefined)).toBe("written");
  });
});
