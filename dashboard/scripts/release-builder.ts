#!/usr/bin/env ts-node
/**
 * Trigger and verify the dedicated HermesOS release builder.
 *
 * Default is no-push: build + smoke on builderbox-1 without publishing tags.
 * Publishing to GHCR requires explicit --push.
 *
 * Usage:
 *   npm run ops:release:builder -- --dry-run
 *   npm run ops:release:builder
 *   npm run ops:release:builder -- --channel canary
 *   npm run ops:release:builder -- --channel prod --push
 *   npm run ops:release:builder -- --channel prod --agent-ref <sha> --webui-ref <sha> --push
 */

import { spawn } from "child_process";

interface Args {
  dryRun: boolean;
  push: boolean;
  channel: "prod" | "canary";
  agentRef: string;
  webuiRef: string;
  host: string;
  command: string;
  sshConfig: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueAfter = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  const channel = valueAfter("--channel", process.env.HERMES_RELEASE_CHANNEL || "prod");
  if (channel !== "prod" && channel !== "canary") {
    throw new Error(`Invalid --channel ${channel}; expected prod or canary`);
  }

  return {
    dryRun: argv.includes("--dry-run"),
    push: argv.includes("--push"),
    channel,
    agentRef: valueAfter("--agent-ref", "main"),
    webuiRef: valueAfter("--webui-ref", "master"),
    host: valueAfter("--host", process.env.HERMES_RELEASE_BUILDER_HOST || "builderbox-1"),
    command: valueAfter("--command", process.env.HERMES_RELEASE_BUILDER_COMMAND || "hermes-build-images"),
    sshConfig: valueAfter(
      "--ssh-config",
      process.env.HERMES_SSH_CONFIG || "/home/hermes/.hermes/home/.ssh/config",
    ),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const remoteArgs = [
    "--channel", args.channel,
    "--agent-ref", args.agentRef,
    "--webui-ref", args.webuiRef,
    ...(args.push ? ["--push"] : []),
  ];
  const remoteCommand = [args.command, ...remoteArgs.map(shellQuote)].join(" ");

  console.log("[release-builder] host:", args.host);
  console.log("[release-builder] ssh config:", args.sshConfig);
  console.log("[release-builder] command:", args.command);
  console.log("[release-builder] channel:", args.channel);
  console.log("[release-builder] agent ref:", args.agentRef);
  console.log("[release-builder] webui ref:", args.webuiRef);
  console.log("[release-builder] push:", args.push ? "yes" : "no");

  if (args.dryRun) {
    console.log("[release-builder] dry-run only. Remote command would be:");
    console.log(`ssh -F ${shellQuote(args.sshConfig)} ${args.host} ${shellQuote(remoteCommand)}`);
    return;
  }

  const sshArgs = ["-F", args.sshConfig, args.host, remoteCommand];
  const exitCode = await run("ssh", sshArgs);
  if (exitCode !== 0) {
    throw new Error(`release builder failed with exit code ${exitCode}`);
  }
  console.log("[release-builder] complete");
}

main().catch((err) => {
  console.error("[release-builder] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
