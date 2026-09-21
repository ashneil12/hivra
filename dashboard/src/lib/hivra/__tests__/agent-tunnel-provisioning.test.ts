/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockRead = jest.fn();
const mockUpdate = jest.fn();
const query = { eq: jest.fn().mockReturnThis(), neq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), or: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), maybeSingle: () => mockRead() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({ update: (...args: unknown[]) => mockUpdate(...args) }) } }));
import { hivraAgentTunnelJournal } from "../agent-tunnel-provisioning";

const input = { agentId: "agent-id", userId: "owner", operationId: "operation-id" };
const identity = { tunnelId: "11111111-1111-4111-8111-111111111111", hostname: "box.example.test" };
beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockReturnValue(query);
  mockRead.mockResolvedValue({ data: { id: input.agentId, desired_state: "running" }, error: null });
});

it("binds every intent write to owner, agent and current provision operation", async () => {
  await hivraAgentTunnelJournal(input).beforeCreate(identity);
  for (const [key, value] of Object.entries({ id: input.agentId, user_id: input.userId, operation_id: input.operationId, operation_kind: "provision", desired_state: "running" })) {
    expect(query.eq).toHaveBeenCalledWith(key, value);
  }
  expect(query.neq).toHaveBeenCalledWith("status", "deleted");
  expect(query.is).toHaveBeenCalledWith("cf_hostname", null);
  expect(mockUpdate).toHaveBeenCalledWith({ cf_hostname: identity.hostname });
});

it.each([{ data: null, error: null }, { data: null, error: { code: "50000" } }])("rejects missing/superseded journal evidence %j", async (result) => {
  mockRead.mockResolvedValue(result);
  await expect(hivraAgentTunnelJournal(input).beforeCreate(identity)).rejects.toThrow("intent could not be recorded");
});

it("records a known ID before compensating a concurrent deletion", async () => {
  mockRead.mockResolvedValue({ data: { id: input.agentId, desired_state: "deleted" }, error: null });
  await expect(hivraAgentTunnelJournal(input).created(identity)).rejects.toThrow("canceled");
  expect(mockUpdate).toHaveBeenCalledWith({ cf_tunnel_id: identity.tunnelId });
  expect(query.eq).toHaveBeenCalledWith("cf_hostname", identity.hostname);
  expect(query.in).toHaveBeenCalledWith("desired_state", ["running", "deleted"]);
});

it("clears only the exact recorded intent after verified compensation", async () => {
  await hivraAgentTunnelJournal(input).cleanupConfirmed(identity);
  expect(mockUpdate).toHaveBeenCalledWith({ cf_tunnel_id: null, cf_hostname: null });
  expect(query.eq).toHaveBeenCalledWith("cf_hostname", identity.hostname);
  expect(query.or).toHaveBeenCalledWith(`cf_tunnel_id.is.null,cf_tunnel_id.eq.${identity.tunnelId}`);
});

it("only cancels an unstarted intent for the same operation with no tunnel ID", async () => {
  await hivraAgentTunnelJournal(input).cancelBeforeCreate(identity);
  expect(mockUpdate).toHaveBeenCalledWith({ cf_hostname: null });
  expect(query.is).toHaveBeenCalledWith("cf_tunnel_id", null);
  expect(query.eq).toHaveBeenCalledWith("operation_id", input.operationId);
  expect(query.or).toHaveBeenCalledWith(`cf_hostname.is.null,cf_hostname.eq.${identity.hostname}`);
});
