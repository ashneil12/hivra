import { gunzipSync } from "zlib";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";

/**
 * Decode every base64(+gzip) embedded-file payload in a provisioning snippet,
 * keyed by the destination path it is decoded into on the guest.
 */
function decodeEmbeddedFiles(script: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /printf '%s' '([^']+)' \| (base64 -d \| gunzip|base64 -d) > (\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const [, encoded, pipeline, path] = m;
    const raw = Buffer.from(encoded, "base64");
    out[path] =
      pipeline === "base64 -d | gunzip"
        ? gunzipSync(raw).toString("utf8")
        : raw.toString("utf8");
  }
  return out;
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("buildIdleGatedUpdateProvisioningScript", () => {
  const INST = "inst_idle_42";
  const buildProdGatewayScript = () => {
    let script = "";
    withEnv(
      {
        HERMES_DEPLOY_CHANNEL: "prod",
        NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
        VERCEL_GIT_REPO_SLUG: "hermesdeploy",
        GITHUB_REPOSITORY: "ashneil12/hermesdeploy",
      },
      () => {
        script = buildIdleGatedUpdateProvisioningScript({
          instanceId: INST,
          backend: "gateway",
        });
      }
    );
    return script;
  };

  describe("backend=gateway", () => {
    const script = buildProdGatewayScript();

    it("removes/disables the legacy daily auto-update units", () => {
      expect(script).toContain(
        `systemctl disable --now hermes-auto-update-${INST}.timer`
      );
      expect(script).toContain(
        `rm -f /usr/local/bin/hermes-auto-update-${INST} /etc/systemd/system/hermes-auto-update-${INST}.service /etc/systemd/system/hermes-auto-update-${INST}.timer`
      );
      expect(script).toContain(
        `systemctl reset-failed hermes-auto-update-${INST}.service hermes-auto-update-${INST}.timer`
      );
      // It must NOT re-install or enable the daily timer.
      expect(script).not.toContain(
        `systemctl enable hermes-auto-update-${INST}.timer`
      );
    });

    it("embeds all three idle-gated executables + their systemd units", () => {
      const files = decodeEmbeddedFiles(script);
      for (const kind of ["idle-sampler", "roll", "refresh"]) {
        expect(files).toHaveProperty(`/usr/local/bin/hermes-${kind}-${INST}`);
        expect(
          files[`/etc/systemd/system/hermes-${kind}-${INST}.service`]
        ).toContain("Type=oneshot");
        expect(
          files[`/etc/systemd/system/hermes-${kind}-${INST}.service`]
        ).toContain(`ExecStart=/usr/local/bin/hermes-${kind}-${INST}`);
        expect(
          files[`/etc/systemd/system/hermes-${kind}-${INST}.timer`]
        ).toContain("WantedBy=timers.target");
        expect(
          files[`/etc/systemd/system/hermes-${kind}-${INST}.timer`]
        ).toContain("Persistent=true");
      }
    });

    it("uses the documented OnCalendar cadences for each timer", () => {
      const files = decodeEmbeddedFiles(script);
      expect(
        files[`/etc/systemd/system/hermes-idle-sampler-${INST}.timer`]
      ).toContain("OnCalendar=*:0/3");
      expect(files[`/etc/systemd/system/hermes-roll-${INST}.timer`]).toContain(
        "OnCalendar=*-*-* *:07:00"
      );
      expect(
        files[`/etc/systemd/system/hermes-refresh-${INST}.timer`]
      ).toContain("OnCalendar=*-*-* 00/3:50:00");
    });

    it("templates INST + the default prod repo into the unit bodies", () => {
      const files = decodeEmbeddedFiles(script);
      const sampler = files[`/usr/local/bin/hermes-idle-sampler-${INST}`];
      const roll = files[`/usr/local/bin/hermes-roll-${INST}`];
      const refresh = files[`/usr/local/bin/hermes-refresh-${INST}`];

      expect(sampler).toContain(`INST="${INST}"`);
      expect(sampler).toContain('G="agent-${INST}-gateway"');
      // The fail-safe heredoc must survive verbatim (no TS interpolation).
      expect(sampler).toContain("<<'PY'");
      expect(sampler).toContain('print("BUSY" if (busy > 0 or stale > 0) else "IDLE")');

      expect(roll).toContain(`INST="${INST}"`);
      expect(roll).toContain(
        'REPO="ghcr.io/ashneil12/vanilla-hermes-agent"'
      );
      expect(roll).toContain('IMG="${REPO}:stable"');
      expect(roll).toContain('LKG="${REPO}:hermes-roll-lkg"');
      expect(roll).toContain('D="agent-${INST}-official-dashboard"');
      expect(roll).toContain("IDLE_MIN=45");
      expect(roll).toContain("MIN_ROLL_GAP_H=20");
      expect(roll).toContain('SOURCE_VOLUME="agent-${INST}_agent-source"');
      expect(roll).toContain(
        'SOURCE_STAMP="/home/hermes/.hermes/hermes-agent/.hermes-image-id"'
      );
      expect(roll).toContain(`/usr/local/bin/hermes-refresh-"\${INST}"`);

      expect(refresh).toContain(`INST=${INST}`);
      expect(refresh).toContain(
        "IMG=ghcr.io/ashneil12/vanilla-hermes-agent:stable"
      );
    });

    it("starts a conservative idle clock after the first trustworthy idle observation", () => {
      const files = decodeEmbeddedFiles(script);
      const sampler = files[`/usr/local/bin/hermes-idle-sampler-${INST}`];

      expect(sampler).toContain('elif [ ! -e "$MARK" ]; then');
      expect(sampler).toContain(
        '# No prior BUSY sample exists: start the 45-minute proof window now.'
      );
    });

    it("ignores orphaned legacy sub-profile state in single-gateway mode", () => {
      const files = decodeEmbeddedFiles(script);
      const sampler = files[`/usr/local/bin/hermes-idle-sampler-${INST}`];

      expect(sampler).toContain(
        'files = glob.glob("/home/hermes/.hermes/gateway_state.json")'
      );
      expect(sampler).not.toContain(
        'glob.glob("/home/hermes/.hermes/profiles/*/gateway_state.json")'
      );
    });

    it("defaults canary deployments to the canary agent repo", () => {
      withEnv(
        {
          HERMES_DEPLOY_CHANNEL: undefined,
          NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
          VERCEL_GIT_REPO_SLUG: "hermesdeploy-canary",
          GITHUB_REPOSITORY: "ashneil12/hermesdeploy-canary",
        },
        () => {
          const canaryScript = buildIdleGatedUpdateProvisioningScript({
            instanceId: INST,
            backend: "gateway",
          });
          const files = decodeEmbeddedFiles(canaryScript);
          expect(files[`/usr/local/bin/hermes-roll-${INST}`]).toContain(
            'REPO="ghcr.io/ashneil12/vanilla-hermes-agent-canary"'
          );
          expect(files[`/usr/local/bin/hermes-refresh-${INST}`]).toContain(
            "IMG=ghcr.io/ashneil12/vanilla-hermes-agent-canary:stable"
          );
        }
      );
    });

    it("enables all three timers and daemon-reloads", () => {
      expect(script).toContain("systemctl daemon-reload");
      expect(script).toContain(
        `systemctl enable --now hermes-idle-sampler-${INST}.timer hermes-roll-${INST}.timer hermes-refresh-${INST}.timer`
      );
    });

    it("derives the image repo from an explicit agentImage override", () => {
      const overridden = buildIdleGatedUpdateProvisioningScript({
        instanceId: INST,
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
        backend: "gateway",
      });
      const files = decodeEmbeddedFiles(overridden);
      expect(files[`/usr/local/bin/hermes-roll-${INST}`]).toContain(
        'REPO="ghcr.io/ashneil12/vanilla-hermes-agent"'
      );
      expect(files[`/usr/local/bin/hermes-refresh-${INST}`]).toContain(
        "IMG=ghcr.io/ashneil12/vanilla-hermes-agent:stable"
      );
    });

    it("refresh warns (instead of silently no-op'ing) when the image lacks a bundle", () => {
      const refresh = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-refresh-${INST}`
      ];
      // Happy path is unchanged (cp + chmod), but a bundle-less image now leaves
      // a breadcrumb in the refresh log instead of an && short-circuit no-op.
      expect(refresh).toContain("cp -a /opt/hermes/hermes_cli/$src/. /out/ && chmod -R a+rX /out");
      expect(refresh).toContain("echo WARN-image-missing /opt/hermes/hermes_cli/$src");
    });

    it("does not treat a current container image with stale source as current", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];

      expect(roll).toContain('SOURCE_IMAGE="$(docker exec "$G" cat "$SOURCE_STAMP"');
      expect(roll).toContain(
        '[ "$LATEST" = "$RUNNING" ] && [ "$LATEST" = "$SOURCE_IMAGE" ]'
      );
    });

    it("does not let the restart cooldown block a newly published image", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];

      expect(roll).toContain('LAST_ROLLED_IMAGE="$(head -n 1 "$ROLLMARK"');
      expect(roll).toContain('[ "$LATEST" = "$LAST_ROLLED_IMAGE" ]');
      expect(roll).toContain(
        'new image ${LATEST} differs from last rolled ${LAST_ROLLED_IMAGE:-unknown} - bypassing restart cooldown'
      );
      expect(roll).toContain('printf \'%s\\n\' "$LATEST" > "$ROLLMARK"');
      expect(roll).not.toContain('date +%s > "$ROLLMARK"');
    });

    it("reseeds the persistent agent source before restart and restores it on rollback", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];

      expect(roll).toContain("reseed_agent_source() {");
      expect(roll).toContain(
        '--user root -v "$SOURCE_VOLUME:$SOURCE_RUNTIME_DIR"'
      );
      expect(roll).toContain('cp -a /opt/hermes/. "$target/"');
      expect(roll).toContain('chown -R 1024:1024 "$target"');
      expect(roll).toContain(
        'printf "%s\\n" "$source_image_id" > "$target/.hermes-image-id"'
      );

      const saveIdx = roll.indexOf('docker tag "$RUNNING" "$LKG"');
      const stopIdx = roll.indexOf("docker compose stop official-dashboard gateway");
      const reseedIdx = roll.indexOf('reseed_agent_source "$IMG"');
      const restartMarker =
        "fi\ndocker compose up -d --force-recreate official-dashboard gateway";
      const restartIdx = roll.indexOf(restartMarker, reseedIdx);
      expect(saveIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeGreaterThan(saveIdx);
      expect(reseedIdx).toBeGreaterThan(stopIdx);
      expect(reseedIdx).toBeGreaterThan(saveIdx);
      expect(restartIdx).toBeGreaterThan(reseedIdx);

      const rollbackIdx = roll.indexOf('reseed_agent_source "$LKG"', restartIdx);
      const rollbackRestartIdx = roll.indexOf(
        "docker compose up -d --force-recreate official-dashboard gateway",
        restartIdx + restartMarker.length
      );
      expect(rollbackIdx).toBeGreaterThan(restartIdx);
      expect(rollbackRestartIdx).toBeGreaterThan(rollbackIdx);
    });

    it("relocates copied venv metadata and validates the shipped environment without syncing before restart", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];

      expect(roll).toContain(
        'SOURCE_RUNTIME_DIR="/home/hermes/.hermes/hermes-agent"'
      );
      expect(roll).toContain(
        '-v "$SOURCE_VOLUME:$SOURCE_RUNTIME_DIR"'
      );
      expect(roll).toContain(
        'find "$target/.venv" -type f \\( -path "*/bin/*" -o -name "__editable__*.py" -o -name "*.pth" -o -name "direct_url.json" \\) -print'
      );
      expect(roll).toContain('sed "s|/opt/hermes|$target|g" "$script" > "$tmp"');
      expect(roll).toContain('mv -f "$tmp" "$script"');
      expect(roll).toContain(
        '"$target/.venv/bin/hermes" --version'
      );
      expect(roll).toContain('"$target/.venv/bin/python" -c');
      expect(roll).not.toContain("uv sync");

      const copyIdx = roll.indexOf("cp -a /opt/hermes/. \"$target/\"");
      const rewriteIdx = roll.indexOf('sed "s|/opt/hermes|$target|g"');
      const validationIdx = roll.indexOf('"$target/.venv/bin/hermes" --version');
      const restartIdx = roll.indexOf(
        "docker compose up -d --force-recreate official-dashboard gateway",
        validationIdx
      );
      expect(copyIdx).toBeGreaterThan(-1);
      expect(rewriteIdx).toBeGreaterThan(copyIdx);
      expect(validationIdx).toBeGreaterThan(rewriteIdx);
      expect(restartIdx).toBeGreaterThan(validationIdx);
    });

    it("uses the shipped 3.13 venv directly instead of honoring the unavailable project 3.11 selector", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain(
        '[ -x "$target/.venv/bin/python" ] && [ -x "$target/.venv/bin/hermes" ]'
      );
      expect(roll).toContain("import pathlib,sys,hermes_cli");
      expect(roll).toContain(
        "root in module.parents else 1"
      );
      expect(roll).not.toContain("No interpreter found for Python 3.11");
      expect(roll).not.toContain("--python-downloads");
    });

    it("fails closed unless the executable, relocated import, and source stamp validate before restart", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain(
        "source reseed shipped venv executable validation failed"
      );
      expect(roll).toContain(
        "source reseed relocated hermes_cli import validation failed"
      );
      expect(roll).toContain(
        '[ "$(cat "$target/.hermes-image-id")" = "$source_image_id" ]'
      );
      expect(roll).toContain("source reseed image stamp validation failed");
      const validationIdx = roll.indexOf('"$target/.venv/bin/hermes" --version');
      const firstVerificationIdx = roll.indexOf(
        "assert_relocated_venv",
        roll.indexOf("assert_relocated_venv()") + 1
      );
      const secondVerificationIdx = roll.indexOf(
        "assert_relocated_venv",
        firstVerificationIdx + 1
      );
      expect(firstVerificationIdx).toBeLessThan(validationIdx);
      expect(secondVerificationIdx).toBeGreaterThan(validationIdx);
    });

    it("atomically and idempotently migrates only the generated supervisor uv commands", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      const functionStart = roll.indexOf("migrate_gateway_runtime_contract() {");
      const functionEnd = roll.indexOf(
        "restore_gateway_runtime_contract() {",
        functionStart
      );
      expect(functionStart).toBeGreaterThan(-1);
      expect(functionEnd).toBeGreaterThan(functionStart);

      const fixtureDir = mkdtempSync(join(tmpdir(), "hermes-compose-runtime-"));
      const composePath = join(fixtureDir, "docker-compose.yml");
      const backupPath = join(fixtureDir, ".docker-compose.yml.hermes-roll-lkg");
      const original = [
        "customer-prefix: preserve-me",
        'status_cmd = ["uv", "run", "--extra", "messaging", "hermes", "gateway", "status"]',
        'run_cmd = ["uv", "run", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]',
        "customer-suffix: preserve-me-too",
        "",
      ].join("\n");
      writeFileSync(composePath, original);
      try {
        const functionBody = roll.slice(functionStart, functionEnd);
        const runMigration = () =>
          spawnSync(
            "bash",
            [
              "-c",
              `${functionBody}\nlog() { :; }\nCOMPOSE_PATH="$1"\nCOMPOSE_BACKUP="$2"\nmigrate_gateway_runtime_contract`,
              "hermes-compose-test",
              composePath,
              backupPath,
            ],
            { encoding: "utf8" }
          );

        const first = runMigration();
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        const migrated = readFileSync(composePath, "utf8");
        expect(migrated).toContain(
          'status_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "status"]'
        );
        expect(migrated).toContain(
          'run_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]'
        );
        expect(migrated).not.toContain('["uv", "run", "--extra", "messaging"');
        expect(migrated).toContain("customer-prefix: preserve-me\n");
        expect(migrated).toContain("customer-suffix: preserve-me-too\n");
        expect(readFileSync(backupPath, "utf8")).toBe(original);

        rmSync(backupPath);
        const firstBytes = Buffer.from(migrated);
        const second = runMigration();
        expect(second.stderr).toBe("");
        expect(second.status).toBe(0);
        expect(Buffer.from(readFileSync(composePath))).toEqual(firstBytes);
        expect(() => readFileSync(backupPath)).toThrow();
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    it("fails closed on an unknown supervisor command before stopping services", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain(
        "gateway runtime compose migration mismatch - aborting before service stop + PAUSING auto-roll"
      );
      const migrationIdx = roll.lastIndexOf("migrate_gateway_runtime_contract");
      const preflightIdx = roll.indexOf("docker compose config --quiet");
      const stopIdx = roll.indexOf("docker compose stop official-dashboard gateway");
      expect(migrationIdx).toBeGreaterThan(-1);
      expect(preflightIdx).toBeGreaterThan(migrationIdx);
      expect(stopIdx).toBeGreaterThan(preflightIdx);

      const functionStart = roll.indexOf("migrate_gateway_runtime_contract() {");
      const functionEnd = roll.indexOf(
        "restore_gateway_runtime_contract() {",
        functionStart
      );
      const fixtureDir = mkdtempSync(join(tmpdir(), "hermes-compose-mismatch-"));
      const composePath = join(fixtureDir, "docker-compose.yml");
      const backupPath = join(fixtureDir, ".docker-compose.yml.hermes-roll-lkg");
      const unknown = [
        'status_cmd = ["uv", "run", "--future-flag", "hermes", "gateway", "status"]',
        'run_cmd = ["uv", "run", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]',
        "",
      ].join("\n");
      writeFileSync(composePath, unknown);
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${roll.slice(functionStart, functionEnd)}\nlog() { :; }\nCOMPOSE_PATH="$1"\nCOMPOSE_BACKUP="$2"\nmigrate_gateway_runtime_contract`,
            "hermes-compose-test",
            composePath,
            backupPath,
          ],
          { encoding: "utf8" }
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("status_cmd expected exactly one known form");
        expect(readFileSync(composePath, "utf8")).toBe(unknown);
        expect(() => readFileSync(backupPath)).toThrow();
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    it("requires exclusive access to the shared source before reseeding", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain("assert_no_unmanaged_source_consumers() {");
      expect(roll).toContain('docker ps -q --filter "volume=$SOURCE_VOLUME"');
      expect(roll).toContain(
        "shared agent source has unmanaged running consumers - aborting before service stop + PAUSING auto-roll"
      );
      const exclusivityIdx = roll.lastIndexOf("assert_no_unmanaged_source_consumers");
      const stopIdx = roll.indexOf("docker compose stop official-dashboard gateway");
      const reseedIdx = roll.indexOf('reseed_agent_source "$IMG"');
      expect(exclusivityIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeGreaterThan(exclusivityIdx);
      expect(reseedIdx).toBeGreaterThan(stopIdx);
    });

    it("does not restart services from a partial tree when LKG source restoration fails", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      const targetFailureIdx = roll.indexOf('if ! reseed_agent_source "$IMG"; then');
      const targetFailureEnd = roll.indexOf(
        'docker compose up -d --force-recreate official-dashboard gateway',
        targetFailureIdx
      );
      const targetFailure = roll.slice(targetFailureIdx, targetFailureEnd);

      expect(targetFailure).toContain('if reseed_agent_source "$LKG"; then');
      expect(targetFailure).not.toContain('reseed_agent_source "$LKG" || true');
      expect(targetFailure).toContain(
        "CRITICAL: LKG source restoration failed after target reseed failure; services remain stopped"
      );
    });

    it("allows the documented five-minute cold-start readiness window", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain("for _ in $(seq 1 60); do");
      expect(roll).toContain("sleep 5");
    });

    it("validates compose before stopping a healthy instance", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      const preflightIdx = roll.indexOf("docker compose config --quiet");
      const stopIdx = roll.indexOf("docker compose stop official-dashboard gateway");
      expect(preflightIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeGreaterThan(preflightIdx);
      expect(roll).toContain("compose config invalid - aborting before service stop");
    });

    it("migrates legacy runtime path env before compose validation and restart", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];

      expect(roll).toContain("repair_runtime_env_files() {");
      expect(roll).toContain("HOME=/home/hermes");
      expect(roll).toContain(
        "XDG_STATE_HOME=/home/hermes/.hermes/.local/state"
      );
      expect(roll).toContain(
        "XDG_DATA_HOME=/home/hermes/.hermes/.local/share"
      );
      expect(roll).toContain("XDG_CACHE_HOME=/home/hermes/.hermes/.cache");

      const repairIdx = roll.indexOf("repair_runtime_env_files");
      const preflightIdx = roll.indexOf("docker compose config --quiet");
      const stopIdx = roll.indexOf(
        "docker compose stop official-dashboard gateway"
      );
      expect(repairIdx).toBeGreaterThan(-1);
      expect(preflightIdx).toBeGreaterThan(repairIdx);
      expect(stopIdx).toBeGreaterThan(preflightIdx);
    });

    it("drops empty env keys before compose validation while preserving valid empty values", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      const functionStart = roll.indexOf("repair_runtime_env_file() {");
      const functionEnd = roll.indexOf("repair_runtime_env_files() {", functionStart);
      expect(functionStart).toBeGreaterThan(-1);
      expect(functionEnd).toBeGreaterThan(functionStart);

      const fixtureDir = mkdtempSync(join(tmpdir(), "hermes-runtime-env-"));
      const fixturePath = join(fixtureDir, ".env");
      writeFileSync(fixturePath, "GOOD=1\n=\n=\n=\nEMPTY_OK=\n");
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${roll.slice(functionStart, functionEnd)}\nlog() { :; }\nrepair_runtime_env_file "$1"`,
            "hermes-env-test",
            fixturePath,
          ],
          { encoding: "utf8" }
        );
        expect(result.stderr).toMatch(/invalid env key at line 2 dropped/);
        expect(result.stderr).toMatch(/invalid env key at line 3 dropped/);
        expect(result.stderr).toMatch(/invalid env key at line 4 dropped/);
        expect(result.stderr).not.toContain("GOOD=1");
        expect(result.stderr).not.toContain("EMPTY_OK=");
        expect(result.status).toBe(0);
        const repaired = readFileSync(fixturePath, "utf8");
        expect(repaired).toContain("GOOD=1\n");
        expect(repaired).toContain("EMPTY_OK=\n");
        expect(repaired.split("\n")).not.toContain("=");
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    it("only reports rollback success when compose recreation succeeds", () => {
      const roll = decodeEmbeddedFiles(script)[
        `/usr/local/bin/hermes-roll-${INST}`
      ];
      expect(roll).toContain(
        'if docker compose up -d --force-recreate official-dashboard gateway >>"$LOG" 2>&1; then'
      );
      expect(roll).toContain("CRITICAL: rollback compose recreate failed");
    });

    it("emits shell scripts that pass bash syntax validation", () => {
      const files = decodeEmbeddedFiles(script);
      for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith("/usr/local/bin/")) continue;
        const result = spawnSync("bash", ["-n"], {
          input: content,
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    });
  });

  describe("backend=webui", () => {
    const script = buildIdleGatedUpdateProvisioningScript({
      instanceId: INST,
      backend: "webui",
    });

    it("ONLY removes the daily auto-update — no idle-gated stack", () => {
      expect(script).toContain(
        `systemctl disable --now hermes-auto-update-${INST}.timer`
      );
      expect(script).toContain(
        `rm -f /usr/local/bin/hermes-auto-update-${INST} /etc/systemd/system/hermes-auto-update-${INST}.service /etc/systemd/system/hermes-auto-update-${INST}.timer`
      );
      expect(script).toContain(
        `systemctl reset-failed hermes-auto-update-${INST}.service hermes-auto-update-${INST}.timer`
      );

      // None of the idle-gated units are emitted.
      expect(script).not.toContain("hermes-idle-sampler");
      expect(script).not.toContain("hermes-roll");
      expect(script).not.toContain("hermes-refresh");
      expect(script).not.toContain("systemctl enable --now");
      expect(decodeEmbeddedFiles(script)).toEqual({});
    });
  });
});
