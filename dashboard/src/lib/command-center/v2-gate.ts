type EmailLike = {
  emailAddress?: string | null;
};

export type CommandCenterV2GateUser = {
  id?: string | null;
  primaryEmailAddress?: EmailLike | null;
  emailAddresses?: EmailLike[] | null;
};

function normalizeIdentity(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

function configuredAllowlist() {
  return (process.env.COMMAND_CENTER_V2_ALLOWLIST || "")
    .split(/[,\s]+/)
    .map(normalizeIdentity)
    .filter(Boolean);
}

function userEmails(user: CommandCenterV2GateUser | null | undefined) {
  const emails = new Set<string>();
  const primary = normalizeIdentity(user?.primaryEmailAddress?.emailAddress);
  if (primary) emails.add(primary);

  for (const entry of user?.emailAddresses || []) {
    const email = normalizeIdentity(entry.emailAddress);
    if (email) emails.add(email);
  }

  return emails;
}

export function isCommandCenterV2EnabledForUser(
  user: CommandCenterV2GateUser | null | undefined
) {
  const userId = normalizeIdentity(user?.id);
  const emails = userEmails(user);

  const allowlist = new Set(configuredAllowlist());
  if (userId && allowlist.has(userId)) return true;
  for (const email of emails) {
    if (allowlist.has(email)) return true;
  }

  return false;
}
