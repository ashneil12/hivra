import { loadEnvConfig } from "@next/env";

// SCRIPTURE_ANCHOR: daily-sweep | Lamentations 3:23 | Verse: They are new every morning; great is your faithfulness.
loadEnvConfig(process.cwd());

type Severity = "info" | "warn" | "error" | "fatal";
type OutputFormat = "markdown" | "json";

interface Args {
  hours?: number;
  since?: string;
  limit: number;
  includeArchived: boolean;
  severity?: Severity;
  source?: string;
  format: OutputFormat;
}

function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`\`${label}\` must be a positive number`);
  }
  return parsed;
}

function parseSeverity(value: string): Severity {
  if (value === "info" || value === "warn" || value === "error" || value === "fatal") {
    return value;
  }
  throw new Error("`--severity` must be one of: info, warn, error, fatal");
}

function parseFormat(value: string): OutputFormat {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error("`--format` must be either `markdown` or `json`");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    hours: 24,
    limit: 200,
    includeArchived: false,
    format: "markdown",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--include-archived") {
      args.includeArchived = true;
      continue;
    }

    if (arg === "--json") {
      args.format = "json";
      continue;
    }

    if (arg === "--hours") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--hours`");
      }
      args.hours = parsePositiveNumber(rawValue, "--hours");
      delete args.since;
      index += 1;
      continue;
    }

    if (arg === "--since") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--since`");
      }
      args.since = rawValue;
      delete args.hours;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--limit`");
      }
      args.limit = parsePositiveNumber(rawValue, "--limit");
      index += 1;
      continue;
    }

    if (arg === "--severity") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--severity`");
      }
      args.severity = parseSeverity(rawValue);
      index += 1;
      continue;
    }

    if (arg === "--source") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--source`");
      }
      args.source = rawValue;
      index += 1;
      continue;
    }

    if (arg === "--format") {
      const rawValue = argv[index + 1];
      if (!rawValue) {
        throw new Error("Missing value for `--format`");
      }
      args.format = parseFormat(rawValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { fetchOpsSweepReport, formatOpsSweepMarkdownReport } = await import("../src/lib/recovery/ops-sweep");
  const report = await fetchOpsSweepReport(args);

  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatOpsSweepMarkdownReport(report));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Ops sweep failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
