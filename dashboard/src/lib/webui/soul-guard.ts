/**
 * Shared classification + shell for "is this SOUL.md safe to overwrite?".
 *
 * A box's identity lives in the webui-state volume at
 * `/home/hermes/.hermes/SOUL.md` (the `default` profile) or
 * `.hermes/profiles/<name>/SOUL.md` (isolated profiles). Two code paths write
 * that file and BOTH must refuse to clobber a genuinely-authored identity:
 *
 *   1. the provision-time seeder (`webui-instance-builder.ts`), which seeds the
 *      first-run onboarding ritual (and, later, authored persona souls), and
 *   2. the profile system-prompt writer (`profile-files.ts` +
 *      the legacy inline PATCH path), which pushes a user/UI-supplied prompt.
 *
 * "Authored identity" means: a soul the agent rewrote for itself after the
 * who-am-I ritual, or an authored persona soul a user picked. Destroying it —
 * silently, on an unrelated profile save — is the bug this module guards
 * (PERSONA_ENGINE_DECOUPLE_PLAN.md decision D3).
 *
 * The two "nothing of value here, free to overwrite" states are:
 *   - an EMPTY SOUL.md,
 *   - the agent image's factory-default persona, or
 *   - an un-run onboarding ritual (self-terminating; header says "just came online").
 *
 * `FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN` is the single source of truth for that
 * classification. It is embedded verbatim into remote `grep -qE` shell in every
 * writer, so it MUST stay a plain POSIX ERE with no shell metacharacters that
 * would need escaping inside a double-quoted string (no `"`, `$`, or backtick).
 */

/**
 * ERE matched against the first 3 lines of an existing SOUL.md. A match (or an
 * empty file) means the soul carries no authored identity and is safe to
 * overwrite. Kept identical to the provision-time seed guard in
 * `webui-instance-builder.ts` — do not fork it.
 */
export const FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN =
  "^You are Hermes Agent|^# Hermes Agent Persona|just came online";

/**
 * Stdout markers echoed by the guarded write so the Node caller can tell what
 * the remote shell did without a second round-trip.
 */
export const SOUL_WROTE_MARKER = "__HERMES_SOUL_WROTE__";
export const SOUL_SKIPPED_MARKER = "__HERMES_SOUL_SKIPPED_EXISTING__";

/**
 * JS mirror of the in-shell guard: `true` when `soul` is empty or its first
 * three lines match the factory-default / un-run-ritual head pattern — i.e. it
 * holds no authored identity and is safe to overwrite. Kept in lockstep with
 * {@link buildGuardedSoulWriteExecSh} so tests can assert the boundary without
 * a live box.
 */
export function isFactoryOrRitualSoul(soul: string | null | undefined): boolean {
  if (!soul || soul.trim() === "") return true;
  const head = soul.split("\n").slice(0, 3).join("\n");
  // `m` so `^` anchors to each of the 3 head lines, matching `grep -E` line
  // semantics; the unanchored "just came online" alternative matches anywhere.
  return new RegExp(FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN, "m").test(head);
}

/**
 * Builds the `docker exec` inner shell that writes a base64-DECODED SOUL.md
 * from stdin into `<targetDir>/SOUL.md`, guarded so it never clobbers an
 * authored identity unless `overwrite` is set. Echoes {@link SOUL_WROTE_MARKER}
 * on write or {@link SOUL_SKIPPED_MARKER} on skip so the caller can tell which
 * happened. Shared by every profile SOUL writer so the guard can't drift.
 *
 * The caller owns the pipeline that feeds the decoded prompt to stdin and the
 * container selection, e.g.:
 *   `printf '%s' "$B64" | base64 -d | docker exec -i "$C" ` + this return value
 *
 * The skip branch drains stdin (`cat >/dev/null`) so the upstream `base64 -d`
 * never takes a SIGPIPE — mirrors the provision seeder.
 */
export function buildGuardedSoulWriteExecSh(targetDir: string, overwrite: boolean): string {
  // Positional args to the inner sh: $1 = target dir, $2 = head pattern,
  // $3 = overwrite flag ("1"/"0"). Passing the pattern as an arg (not inline)
  // keeps the single-quoted script free of the regex's shell-sensitive chars.
  const innerScript =
    'target_dir="$1"; head_pattern="$2"; overwrite="$3"; ' +
    'soul_path="$target_dir/SOUL.md"; mkdir -p "$target_dir"; ' +
    'if [ "$overwrite" = "1" ] || [ ! -s "$soul_path" ] || ' +
    'head -3 "$soul_path" 2>/dev/null | grep -qE "$head_pattern"; then ' +
    `cat > "$soul_path"; chown -R 1024:1024 "$target_dir" 2>/dev/null || true; echo ${SOUL_WROTE_MARKER}; ` +
    `else cat >/dev/null; echo ${SOUL_SKIPPED_MARKER}; fi`;
  return (
    `sh -c '${innerScript}' sh ` +
    `${JSON.stringify(targetDir)} ` +
    `${JSON.stringify(FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN)} ` +
    `${overwrite ? "1" : "0"}`
  );
}

/**
 * Parses the stdout of a {@link buildGuardedSoulWriteExecSh} run into a status.
 * A skip marker wins over a write marker (they are mutually exclusive in the
 * shell, but be defensive); absent both, assume the write happened — the ssh
 * layer already asserted the command succeeded.
 */
export function classifySoulWriteStdout(
  stdout: string | null | undefined,
): "written" | "skipped_existing_identity" {
  if (stdout && stdout.includes(SOUL_SKIPPED_MARKER)) {
    return "skipped_existing_identity";
  }
  return "written";
}
