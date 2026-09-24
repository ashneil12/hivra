/** @jest-environment node */
import { NextRequest } from "next/server";

// The minute attach worker (design 5.5): bearer only, Canary only, oldest
// first, at most five steps a pass.

jest.mock("@/lib/agent-computers/attach-flag", () => ({ isAgentAttachEnabled: jest.fn() }));
jest.mock("@/lib/agent-computers/attachment-lifecycle-store", () => ({ createAttachmentLifecycleStore: jest.fn() }));
jest.mock("@/lib/agent-computers/attachment-worker", () => ({ progressAttachmentWork: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";
import { progressAttachmentWork } from "@/lib/agent-computers/attachment-worker";
import { log } from "@/lib/logger";
import { GET } from "../route";

const listWork = jest.fn();
const SECRET = "cron-secret-for-tests";
const get = (bearer = SECRET) => GET(new NextRequest("https://canary.hermesos.cloud/api/cron/progress-agent-attachments",
  { headers: { authorization: `Bearer ${bearer}` } }));

beforeEach(() => {
  jest.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
  jest.mocked(isAgentAttachEnabled).mockReturnValue(true);
  jest.mocked(createAttachmentLifecycleStore).mockReturnValue({ listWork } as unknown as ReturnType<typeof createAttachmentLifecycleStore>);
});
afterAll(() => { delete process.env.CRON_SECRET; });

it("refuses to run without its secret, or with the wrong bearer", async () => {
  delete process.env.CRON_SECRET;
  expect((await get()).status).toBe(500);
  process.env.CRON_SECRET = SECRET;
  expect((await get("wrong")).status).toBe(401);
  expect(listWork).not.toHaveBeenCalled();
});

it("does nothing where attach is not offered", async () => {
  jest.mocked(isAgentAttachEnabled).mockReturnValue(false);
  expect((await (await get()).json()).data).toEqual({ enabled: false, results: [] });
  expect(listWork).not.toHaveBeenCalled();
});

it("progresses at most five open steps in the order the database gives, and logs held ones", async () => {
  const work = [1, 2].map((n) => ({ kind: "attach", ownerId: "owner", id: `${n}`.repeat(8) + "-1111-4111-8111-111111111111" }));
  listWork.mockResolvedValue(work);
  jest.mocked(progressAttachmentWork)
    .mockResolvedValueOnce({ kind: "attach", id: work[0].id, state: "advanced", step: "staged" } as never)
    .mockResolvedValueOnce({ kind: "attach", id: work[1].id, state: "held", reason: "computer_not_running" } as never);
  const body = (await (await get()).json()).data;
  expect(listWork).toHaveBeenCalledWith(5);
  expect(jest.mocked(progressAttachmentWork).mock.calls.map(([item]) => item)).toEqual(work);
  expect(body).toMatchObject({ enabled: true, open: 2 });
  expect(log.warn).toHaveBeenCalledWith("attached agent steps held", expect.objectContaining({
    held: [{ kind: "attach", id: work[1].id, reason: "computer_not_running" }] }));
});

it("answers 503 when it cannot read its work", async () => {
  listWork.mockRejectedValue(new Error("down"));
  expect((await get()).status).toBe(503);
});
