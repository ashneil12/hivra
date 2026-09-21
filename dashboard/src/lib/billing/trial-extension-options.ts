const DEFAULT_TRIAL_EXTENSION_DAYS = 14;

export type TrialExtensionOptions = {
  dryRun: boolean;
  extensionDays: number;
  reapplyGrant: boolean;
};

export function parseTrialExtensionOptions(args: string[]): TrialExtensionOptions {
  const extensionArg = args.find((arg) => arg.startsWith("--extension-days="));

  return {
    dryRun: !args.includes("--execute"),
    extensionDays: extensionArg
      ? Number(extensionArg.split("=")[1])
      : DEFAULT_TRIAL_EXTENSION_DAYS,
    reapplyGrant: args.includes("--reapply-grant"),
  };
}

export function assertValidTrialExtensionOptions(options: TrialExtensionOptions) {
  if (!Number.isInteger(options.extensionDays) || options.extensionDays <= 0) {
    throw new Error("--extension-days must be a positive integer");
  }
}
