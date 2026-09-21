import {
  persistWebUIProfileToSupabase,
  removeWebUIProfileFromSupabase,
} from "../profile-persistence";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const mockedFrom = supabaseAdmin!.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("persistWebUIProfileToSupabase", () => {
  it("upserts the profile row keyed on (instance_id, name)", async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ upsert });

    await persistWebUIProfileToSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "secondary",
      displayName: "Secondary",
      model: "kimi-k2.5",
      provider: "openrouter",
      avatarUrl: null,
      systemPrompt: null,
      status: "running",
    });

    expect(mockedFrom).toHaveBeenCalledWith("profiles");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0];
    expect(row).toMatchObject({
      instance_id: "inst_123",
      user_id: "user_abc",
      name: "secondary",
      display_name: "Secondary",
      model: "kimi-k2.5",
      provider: "openrouter",
      status: "running",
    });
    expect(opts).toEqual({ onConflict: "instance_id,name", ignoreDuplicates: false });
  });

  it("omits system_prompt from the upsert when it is undefined (leave the column untouched)", async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ upsert });

    await persistWebUIProfileToSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "secondary",
      systemPrompt: undefined,
    });

    const [row] = upsert.mock.calls[0];
    expect(row).not.toHaveProperty("system_prompt");
  });

  it("clears system_prompt when explicitly null", async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ upsert });

    await persistWebUIProfileToSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "secondary",
      systemPrompt: null,
    });

    const [row] = upsert.mock.calls[0];
    expect(row).toHaveProperty("system_prompt", null);
  });

  it("skips persistence for the synthesized 'default' profile", async () => {
    await persistWebUIProfileToSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "default",
    });
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("swallows Supabase errors without throwing — write-through is best-effort", async () => {
    const upsert = jest.fn().mockResolvedValue({ error: { message: "constraint violation" } });
    mockedFrom.mockReturnValue({ upsert });

    await expect(
      persistWebUIProfileToSupabase({
        instanceId: "inst_123",
        userId: "user_abc",
        name: "secondary",
      })
    ).resolves.toBeUndefined();
  });

  it("swallows thrown Supabase errors too", async () => {
    mockedFrom.mockReturnValue({
      upsert: jest.fn().mockRejectedValue(new Error("network down")),
    });

    await expect(
      persistWebUIProfileToSupabase({
        instanceId: "inst_123",
        userId: "user_abc",
        name: "secondary",
      })
    ).resolves.toBeUndefined();
  });
});

describe("removeWebUIProfileFromSupabase", () => {
  it("deletes the row scoped by (instance_id, user_id, name)", async () => {
    const eq3 = jest.fn().mockResolvedValue({ error: null });
    const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const del = jest.fn().mockReturnValue({ eq: eq1 });
    mockedFrom.mockReturnValue({ delete: del });

    await removeWebUIProfileFromSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "secondary",
    });

    expect(mockedFrom).toHaveBeenCalledWith("profiles");
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq1).toHaveBeenCalledWith("instance_id", "inst_123");
    expect(eq2).toHaveBeenCalledWith("user_id", "user_abc");
    expect(eq3).toHaveBeenCalledWith("name", "secondary");
  });

  it("never deletes the default profile (it is synthesized at read time)", async () => {
    await removeWebUIProfileFromSupabase({
      instanceId: "inst_123",
      userId: "user_abc",
      name: "default",
    });
    expect(mockedFrom).not.toHaveBeenCalled();
  });
});
