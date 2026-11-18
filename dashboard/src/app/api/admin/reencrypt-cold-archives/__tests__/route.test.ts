/** @jest-environment node */
import { NextRequest } from "next/server";

const runReencryptSweep = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn().mockResolvedValue(null), sanitizeOpsMetadata: (m: unknown) => m }));
jest.mock("@/lib/services/cold-archive-reencrypt", () => ({
  ...jest.requireActual("@/lib/services/cold-archive-reencrypt"),
  runReencryptSweep: (...a: unknown[]) => runReencryptSweep(...a),
}));

import { POST } from "../route";

const RECIPIENT = `age1${"q".repeat(58)}`;
const req = (auth: string | null, body: unknown = {}) =>
  new NextRequest("http://localhost/api/admin/reencrypt-cold-archives", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(body),
  });

describe("POST /api/admin/reencrypt-cold-archives", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    runReencryptSweep.mockReset();
    process.env = {
      ...saved,
      CRON_SECRET: "s3cret",
      HERMES_BACKUP_ENCRYPTION: "on",
      HERMES_BACKUP_AGE_RECIPIENT: RECIPIENT,
      HERMES_BACKUP_REENCRYPT_HOST: "fixturenodea",
    };
    delete process.env.HERMES_BACKUP_REENCRYPT_SWEEP;
  });
  afterAll(() => { process.env = saved; });

  it("rejects missing/wrong bearer", async () => {
    expect((await POST(req(null))).status).toBe(401);
    expect((await POST(req("Bearer nope"))).status).toBe(401);
    expect(runReencryptSweep).not.toHaveBeenCalled();
  });

  it("is disabled by default (switch unset or off)", async () => {
    expect((await POST(req("Bearer s3cret"))).status).toBe(403);
    process.env.HERMES_BACKUP_REENCRYPT_SWEEP = "off";
    expect((await POST(req("Bearer s3cret"))).status).toBe(403);
    expect(runReencryptSweep).not.toHaveBeenCalled();
  });

  it("refuses when the prerequisites are missing", async () => {
    process.env.HERMES_BACKUP_REENCRYPT_SWEEP = "on";
    process.env.HERMES_BACKUP_ENCRYPTION = "off";
    expect((await POST(req("Bearer s3cret"))).status).toBe(409);
    expect(runReencryptSweep).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    process.env.HERMES_BACKUP_REENCRYPT_SWEEP = "dry";
    expect((await POST(req("Bearer s3cret", { limit: 0 }))).status).toBe(400);
    expect((await POST(req("Bearer s3cret", { cursor: "x; rm -rf" }))).status).toBe(400);
  });

  it.each(["dry", "on"])("runs the sweep in %s mode", async (mode) => {
    process.env.HERMES_BACKUP_REENCRYPT_SWEEP = mode;
    runReencryptSweep.mockResolvedValue({ mode, scanned: 0, nextCursor: null, outcomes: [] });
    const res = await POST(req("Bearer s3cret", { limit: 3 }));
    expect(res.status).toBe(200);
    expect(runReencryptSweep.mock.calls[0][1]).toEqual({ mode, recipient: RECIPIENT });
    expect(runReencryptSweep.mock.calls[0][2]).toMatchObject({ hostSlug: "fixturenodea", limit: 3 });
  });
});
