import {
  AccountDirectoryError,
  ClerkAccountDirectory,
  type ClerkDirectoryUser,
  normaliseAddress,
} from "../account-directory";

const ADDRESS = "person@example.com";
const USER_ID = "user_2abcXYZ";

const user = (over: Partial<ClerkDirectoryUser> = {}, status: string | null = "verified"): ClerkDirectoryUser => ({
  id: USER_ID,
  emailAddresses: [{ emailAddress: ADDRESS, verification: status === null ? null : { status } }],
  ...over,
});

/** A fake Clerk client whose user list resolves to `data` (or rejects with `error`). */
function fakeClerk(result: { data?: unknown; error?: unknown }) {
  const getUserList = result.error
    ? jest.fn().mockRejectedValue(result.error)
    : jest
        .fn()
        .mockResolvedValue({ data: result.data, totalCount: Array.isArray(result.data) ? result.data.length : 0 });
  return { client: { users: { getUserList } }, getUserList };
}

describe("ClerkAccountDirectory.hivraUserIdForEmail", () => {
  it("returns the id of the one user holding the address verified, looking up the normalised address", async () => {
    const { client, getUserList } = fakeClerk({ data: [user()] });
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: client, log });

    await expect(directory.hivraUserIdForEmail("  Person@Example.COM ")).resolves.toBe(USER_ID);
    expect(getUserList).toHaveBeenCalledWith({ emailAddress: [ADDRESS], limit: 5 });
    expect(log).not.toHaveBeenCalled();
  });

  it("returns null when no Clerk user has the address", async () => {
    const { client } = fakeClerk({ data: [] });
    await expect(new ClerkAccountDirectory({ clerk: client }).hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
  });

  it("returns null when the one user's address is not verified", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [user({}, "unverified")] }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
  });

  it("an unverified duplicate on another user does not hide the verified owner", async () => {
    const duplicate = user({ id: "user_2unverified" }, "unverified");
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [duplicate, user()] }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBe(USER_ID);
    expect(log).not.toHaveBeenCalled();
  });

  it("the verified owner is found wherever it sits in the list", async () => {
    const duplicate = user({ id: "user_2unverified" }, null);
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [duplicate, user()] }).client });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBe(USER_ID);
  });

  it("returns null with no log when several users hold the address, but none verified", async () => {
    const log = jest.fn();
    const data = [user({ id: "user_2a" }, "unverified"), user({ id: "user_2b" }, "unverified")];
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("counts only the verified holders when two verify and one does not", async () => {
    const log = jest.fn();
    const data = [user({ id: "user_2dup" }, "unverified"), user(), user({ id: "user_2second" })];
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("account_directory.ambiguous", { matches: 2 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("user_2dup");
  });

  it("returns null when the address has no verification record at all", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [user({}, null)] }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
  });

  it("only a status of exactly 'verified' counts", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [user({}, "VERIFIED")] }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
  });

  it("returns null when the one user returned does not actually hold the address", async () => {
    const other = user({
      emailAddresses: [{ emailAddress: "other@example.com", verification: { status: "verified" } }],
    });
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [other] }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
  });

  it("returns null and logs the count only when two or more users match", async () => {
    const second = user({ id: "user_2second" });
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [user(), second] }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("account_directory.ambiguous", { matches: 2 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER_ID);
  });

  it("treats three matches the same as two", async () => {
    const log = jest.fn();
    const data = [user(), user({ id: "user_2b" }), user({ id: "user_2c" })];
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("account_directory.ambiguous", { matches: 3 });
  });

  it("throws, never null, when Clerk fails, and carries only the status", async () => {
    const clerkError = Object.assign(new Error(`Not allowed for ${ADDRESS}`), { status: 429 });
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ error: clerkError }).client, log });

    const failure = directory.hivraUserIdForEmail(ADDRESS);
    await expect(failure).rejects.toBeInstanceOf(AccountDirectoryError);
    await expect(failure).rejects.toMatchObject({ status: 429, message: "The account lookup failed" });
    expect(log).toHaveBeenCalledWith("account_directory.lookup_failed", { status: 429 });
  });

  it("throws when Clerk fails without a status, with no detail from the error", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ error: new Error("socket hang up") }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).rejects.toMatchObject({ status: null });
  });

  it("throws when Clerk returns no list, rather than reading it as no account", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: undefined }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).rejects.toThrow(AccountDirectoryError);
  });

  it("throws when Clerk returns an id that is not a Clerk user id", async () => {
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ data: [user({ id: "../../etc" })] }).client });
    await expect(directory.hivraUserIdForEmail(ADDRESS)).rejects.toThrow(AccountDirectoryError);
  });

  it("refuses anything that is not one plausible address, without calling Clerk", async () => {
    const bad = [
      "",
      "   ",
      "not-an-email",
      "a@b@example.com",
      "a@example.com, b@example.com",
      "Name <a@example.com>",
      "a b@example.com",
      "a@example",
      "@example.com",
      ".a@example.com",
      "a.@example.com",
      "a..b@example.com",
      `${"a".repeat(65)}@example.com`,
      `${"a".repeat(250)}@example.com`,
    ];
    for (const email of bad) {
      const { client, getUserList } = fakeClerk({ data: [user()] });
      await expect(new ClerkAccountDirectory({ clerk: client }).hivraUserIdForEmail(email)).rejects.toThrow(
        AccountDirectoryError,
      );
      expect(getUserList).not.toHaveBeenCalled();
    }
  });

  it("refuses a non-text address without calling Clerk", async () => {
    const { client, getUserList } = fakeClerk({ data: [user()] });
    await expect(
      new ClerkAccountDirectory({ clerk: client }).hivraUserIdForEmail(undefined as unknown as string),
    ).rejects.toThrow(AccountDirectoryError);
    expect(getUserList).not.toHaveBeenCalled();
  });

  it("never puts the address or a secret into a thrown error, even when Clerk's message repeats it", async () => {
    const secret = "sk_test_do_not_leak";
    const clerkError = Object.assign(new Error(`lookup ${ADDRESS} with ${secret} failed`), { status: 500 });
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ error: clerkError }).client });

    const caught = await directory.hivraUserIdForEmail(ADDRESS).catch((err: unknown) => err as Error);
    expect(caught).toBeInstanceOf(AccountDirectoryError);
    expect(String((caught as Error).message)).not.toContain(ADDRESS);
    expect(String((caught as Error).message)).not.toContain(secret);
    expect((caught as Error).stack ?? "").not.toContain(ADDRESS);
    expect((caught as Error).stack ?? "").not.toContain(secret);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  });

  it("never puts the address into a message when the lookup fails, and logs no address", async () => {
    const clerkError = Object.assign(new Error(`no user for private@example.com`), { status: 404 });
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ error: clerkError }).client, log });

    const caught = await directory.hivraUserIdForEmail("  Private@Example.COM ").catch((err: unknown) => err as Error);
    expect(caught).toBeInstanceOf(AccountDirectoryError);
    expect(String((caught as Error).message)).not.toContain("private");
    expect(String((caught as Error).message)).not.toContain("example.com");
    expect(log).toHaveBeenCalledWith("account_directory.lookup_failed", { status: 404 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");
  });

  it("the lookup-failed log line carries the status only, with no address or secret", async () => {
    const secret = "sk_test_log_secret";
    const clerkError = Object.assign(new Error(`lookup ${ADDRESS} with ${secret}`), { status: 500 });
    const log = jest.fn();
    const directory = new ClerkAccountDirectory({ clerk: fakeClerk({ error: clerkError }).client, log });

    await expect(directory.hivraUserIdForEmail(ADDRESS)).rejects.toBeInstanceOf(AccountDirectoryError);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("account_directory.lookup_failed", { status: 500 });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("person");
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain(secret);
  });
});

describe("normaliseAddress", () => {
  it("trims and lowercases a plausible address", () => {
    expect(normaliseAddress(" Ann.Lee+tag@Mail.Example.org ")).toBe("ann.lee+tag@mail.example.org");
  });

  it("refuses a local part that starts or ends with a dot, or doubles a dot", () => {
    for (const address of [".ann@example.com", "ann.@example.com", "ann..lee@example.com", "a...b@example.com"]) {
      expect(() => normaliseAddress(address)).toThrow(AccountDirectoryError);
    }
  });

  it("keeps a single dot inside the local part", () => {
    expect(normaliseAddress("ann.lee@example.com")).toBe("ann.lee@example.com");
  });

  it("accepts a local part of exactly 64 characters", () => {
    const address = `${"a".repeat(64)}@example.com`;
    expect(normaliseAddress(address)).toBe(address);
  });
});
