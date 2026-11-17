/**
 * The Clerk-backed account directory the free sandbox bridge asks which Hivra account owns a verified address. Only a
 * verified address held by exactly one Clerk user counts: anything else is `null` (no Hivra account, so the bridge
 * treats the workspace as Free), and a failed lookup throws, which the bridge reads as "unknown" and places nothing.
 *
 * The Clerk client is injected, so tests run this against a fake. Email addresses are never logged or put in an error
 * message: a log line carries counts and statuses only.
 */
import type { AccountDirectory } from "./ports";

/** The part of Clerk's user list this directory reads (the shape of `clerkClient().users.getUserList`). */
export interface ClerkDirectoryClient {
  users: {
    getUserList(params: { emailAddress: string[]; limit?: number }): Promise<{ data: ClerkDirectoryUser[] }>;
  };
}

/** One Clerk user as the directory reads it: its id and its addresses with their verification. */
export interface ClerkDirectoryUser {
  id: string;
  emailAddresses: { emailAddress: string; verification?: { status?: string } | null }[];
}

export interface ClerkAccountDirectoryDeps {
  clerk: ClerkDirectoryClient;
  /** Logs a lookup outcome by event name and counts only, never an address. */
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** A refused or failed lookup. Carries no address: the message is fixed and only the HTTP status (when Clerk gave one). */
export class AccountDirectoryError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AccountDirectoryError";
  }
}

/** Enough to tell two accounts with one address apart; a third match is as good as a second. */
const LOOKUP_LIMIT = 5;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
/** One ASCII address: no spaces, no lists, no display names. */
const EMAIL_SHAPE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** Clerk's user ids. Checked before an id is used anywhere else. */
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;
/** A local part that starts or ends with a dot, or has two dots in a row. */
const LOCAL_PART_DOT = /^\.|\.$|\.\./;

/**
 * Trims and lowercases an address and refuses anything that is not one plausible ASCII address. Refusal throws (it is
 * never read as "no account"), and the message names no part of the input.
 */
export function normaliseAddress(email: unknown): string {
  if (typeof email !== "string") throw new AccountDirectoryError("The address is not a text value");
  const address = email.trim().toLowerCase();
  const local = address.split("@")[0] ?? "";
  if (
    address.length > MAX_EMAIL_LENGTH ||
    !EMAIL_SHAPE.test(address) ||
    local.length > MAX_LOCAL_PART_LENGTH ||
    LOCAL_PART_DOT.test(local)
  ) {
    throw new AccountDirectoryError("The address is not a single plausible email address");
  }
  return address;
}

const statusOf = (err: unknown): number | null => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
};

/**
 * The Hivra user id for a verified address, or `null`. Only users who hold the address as a VERIFIED entry count: an
 * unverified duplicate on another user never hides the verified owner. Zero verified owners gives `null`, exactly one
 * gives its id, and two or more give `null` and log the count only.
 */
export function verifiedUserIdFrom(
  users: ClerkDirectoryUser[],
  address: string,
  log: NonNullable<ClerkAccountDirectoryDeps["log"]> = () => {},
): string | null {
  const owners = users.filter((user) =>
    (user?.emailAddresses ?? []).some(
      (e) =>
        typeof e?.emailAddress === "string" &&
        e.emailAddress.trim().toLowerCase() === address &&
        e.verification?.status === "verified",
    ),
  );
  if (owners.length === 0) return null;
  if (owners.length > 1) {
    log("account_directory.ambiguous", { matches: owners.length });
    return null;
  }
  const [owner] = owners;
  if (typeof owner?.id !== "string" || !CLERK_USER_ID.test(owner.id)) {
    throw new AccountDirectoryError("The account directory returned an id of an unexpected shape");
  }
  return owner.id;
}

/** Looks a verified address up in Clerk and returns the one Hivra user id that owns it. */
export class ClerkAccountDirectory implements AccountDirectory {
  private readonly clerk: ClerkDirectoryClient;
  private readonly log: NonNullable<ClerkAccountDirectoryDeps["log"]>;

  constructor(deps: ClerkAccountDirectoryDeps) {
    this.clerk = deps.clerk;
    this.log = deps.log ?? (() => {});
  }

  /**
   * The Hivra user id for a verified address, or `null` when no single verified user has it. Throws
   * `AccountDirectoryError` for an address that is not one plausible address, or when Clerk cannot answer.
   */
  async hivraUserIdForEmail(email: string): Promise<string | null> {
    const address = normaliseAddress(email);
    const users = await this.lookup(address);
    return verifiedUserIdFrom(users, address, this.log);
  }

  /** Clerk's users for one address. Any failure becomes an `AccountDirectoryError` carrying only the status. */
  private async lookup(address: string): Promise<ClerkDirectoryUser[]> {
    let res: { data: ClerkDirectoryUser[] } | undefined;
    try {
      res = await this.clerk.users.getUserList({ emailAddress: [address], limit: LOOKUP_LIMIT });
    } catch (err) {
      this.log("account_directory.lookup_failed", { status: statusOf(err) });
      throw new AccountDirectoryError("The account lookup failed", statusOf(err));
    }
    if (!res || !Array.isArray(res.data)) {
      this.log("account_directory.lookup_failed", { status: null });
      throw new AccountDirectoryError("The account directory returned an unexpected response");
    }
    return res.data;
  }
}
