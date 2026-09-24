/** @jest-environment jsdom */

import { createResourceInventory, INVENTORY_FRESH_MS } from "../resource-inventory";

const hermesBody = (names: string[]) => ({ success: true, data: names.map((name) => ({ id: name, name, status: "running" })) });
const hivraBody = (names: string[]) => ({ success: true, data: { agents: names.map((name) => ({ id: name, name, status: "running" })) } });

function setup() {
  let clock = 1_000_000;
  const hermes = jest.fn<Promise<unknown>, [AbortSignal?]>(async () => hermesBody(["one"]));
  const hivra = jest.fn<Promise<unknown>, [AbortSignal?]>(async () => hivraBody(["two"]));
  const inventory = createResourceInventory({ fetchers: { hermes, hivra }, now: () => clock });
  return { inventory, hermes, hivra, advance: (ms: number) => { clock += ms; } };
}

describe("resource inventory", () => {
  it("joins a read in flight instead of starting another", async () => {
    const { inventory, hermes } = setup();
    await Promise.all([inventory.load("hermes"), inventory.load("hermes"), inventory.load("hermes")]);
    expect(hermes).toHaveBeenCalledTimes(1);
    expect(inventory.getSnapshot().hermes).toMatchObject({ hasBody: true, pending: false, failed: false });
  });

  it("reuses a fresh read, reads a stale one again, and always reads when forced", async () => {
    const { inventory, hivra, advance } = setup();
    await inventory.load("hivra");
    await inventory.load("hivra");
    expect(hivra).toHaveBeenCalledTimes(1);
    await inventory.load("hivra", { force: true });
    expect(hivra).toHaveBeenCalledTimes(2);
    advance(INVENTORY_FRESH_MS);
    await inventory.load("hivra");
    expect(hivra).toHaveBeenCalledTimes(3);
  });

  it("keeps the last good list when a read fails or returns something else", async () => {
    const { inventory, hermes } = setup();
    await inventory.load("hermes");
    const good = inventory.getSnapshot().hermes.body;
    hermes.mockRejectedValueOnce(new Error("offline"));
    await expect(inventory.load("hermes", { force: true })).resolves.toBeUndefined();
    expect(inventory.getSnapshot().hermes).toMatchObject({ body: good, failed: true });
    hermes.mockResolvedValueOnce({ success: false, error: "unavailable" });
    await inventory.load("hermes", { force: true });
    expect(inventory.getSnapshot().hermes).toMatchObject({ body: good, failed: true });
    // A failed read is not reused as fresh.
    await inventory.load("hermes");
    expect(inventory.getSnapshot().hermes).toMatchObject({ failed: false });
  });

  it("drops one account's lists when another signs in, and ignores its late reads", async () => {
    const { inventory, hermes } = setup();
    inventory.setOwner("first");
    await inventory.load("hermes");
    let finish!: (body: unknown) => void;
    let signal!: AbortSignal;
    hermes.mockImplementationOnce((received) => {
      signal = received!;
      return new Promise<unknown>((resolve) => { finish = resolve; });
    });
    const late = inventory.load("hermes", { force: true });

    inventory.setOwner("second");
    expect(signal.aborted).toBe(true);
    expect(inventory.getSnapshot()).toMatchObject({ owner: "second", hermes: { hasBody: false } });
    finish(hermesBody(["someone-else"]));
    await late;
    expect(inventory.getSnapshot().hermes.hasBody).toBe(false);
  });

  it("adopts an owner without dropping what was read before one was known", async () => {
    const { inventory } = setup();
    await inventory.load("hermes");
    inventory.setOwner("first");
    expect(inventory.getSnapshot()).toMatchObject({ owner: "first", hermes: { hasBody: true } });
  });

  it("re-reads only lists already read, and only once stale, when the tab regains focus", async () => {
    const { inventory, hermes, hivra, advance } = setup();
    const unsubscribe = inventory.subscribe(() => undefined);
    try {
      await inventory.load("hermes");
      window.dispatchEvent(new Event("focus"));
      expect(hermes).toHaveBeenCalledTimes(1);
      advance(INVENTORY_FRESH_MS + 1);
      window.dispatchEvent(new Event("focus"));
      expect(hermes).toHaveBeenCalledTimes(2);
      expect(hivra).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
    advance(INVENTORY_FRESH_MS + 1);
    window.dispatchEvent(new Event("focus"));
    expect(hermes).toHaveBeenCalledTimes(2);
  });

  // After a delete, stop or rename made in this browser, a list read moments
  // before is out of date however fresh it is.
  it("does not reuse a list read before a change, and reads one being shown again at once", async () => {
    const { inventory, hivra } = setup();
    await inventory.load("hivra");
    inventory.invalidate("hivra");
    // Nobody is showing it: the next reader reads.
    expect(hivra).toHaveBeenCalledTimes(1);
    await inventory.load("hivra");
    expect(hivra).toHaveBeenCalledTimes(2);
    await inventory.load("hivra");
    expect(hivra).toHaveBeenCalledTimes(2);

    const unsubscribe = inventory.subscribe(() => undefined);
    try {
      hivra.mockResolvedValueOnce(hivraBody([]));
      inventory.invalidate("hivra");
      expect(hivra).toHaveBeenCalledTimes(3);
      await inventory.load("hivra");
      expect(hivra).toHaveBeenCalledTimes(3);
      expect(inventory.getSnapshot().hivra.body).toEqual(hivraBody([]));
    } finally {
      unsubscribe();
    }
  });

  it("replaces a read in flight when a change makes it out of date", async () => {
    const { inventory, hermes } = setup();
    let finishOld!: (body: unknown) => void;
    let oldSignal!: AbortSignal;
    hermes.mockImplementationOnce((received) => {
      oldSignal = received!;
      return new Promise<unknown>((resolve) => { finishOld = resolve; });
    });
    const old = inventory.load("hermes");
    hermes.mockResolvedValueOnce(hermesBody([]));
    inventory.invalidate("hermes");
    expect(oldSignal.aborted).toBe(true);
    finishOld(hermesBody(["deleted"]));
    await old;
    await inventory.load("hermes");
    expect(hermes).toHaveBeenCalledTimes(2);
    expect(inventory.getSnapshot().hermes.body).toEqual(hermesBody([]));
  });

  it("never reads a list nobody has asked for when it changes", () => {
    const { inventory, hivra } = setup();
    const unsubscribe = inventory.subscribe(() => undefined);
    inventory.invalidate("hivra");
    unsubscribe();
    expect(hivra).not.toHaveBeenCalled();
  });

  // Home offers to continue in an agent, so it trusts only a read made since
  // it opened, and shares one already in flight rather than starting another.
  it("marks which reads are newer than a view, counting one in flight", async () => {
    const { inventory, hermes } = setup();
    await inventory.load("hermes");
    const settledMark = inventory.readMark("hermes");
    expect(inventory.getSnapshot().hermes.read).toBe(settledMark);

    await inventory.load("hermes", { revalidate: true });
    expect(hermes).toHaveBeenCalledTimes(2);
    expect(inventory.getSnapshot().hermes.read).toBeGreaterThan(settledMark);

    const inFlight = inventory.load("hermes", { force: true });
    const flightMark = inventory.readMark("hermes");
    await Promise.all([inFlight, inventory.load("hermes", { revalidate: true })]);
    expect(hermes).toHaveBeenCalledTimes(3);
    expect(inventory.getSnapshot().hermes.read).toBeGreaterThan(flightMark);
  });
});
