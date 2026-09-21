import { getProfileDeploymentState } from "../profile-deployment";

describe("getProfileDeploymentState", () => {
  it("keeps only profiles with numeric gateway ports and restores only running profiles", async () => {
    const eqMock = jest.fn().mockReturnThis();
    const notMock = jest.fn().mockResolvedValue({
      data: [
        { name: "alpha", gateway_port: 3001, status: "running" },
        { name: "beta", gateway_port: 3002, status: "stopped" },
        { name: "gamma", gateway_port: null, status: "running" },
      ],
      error: null,
    });
    const selectMock = jest.fn().mockReturnValue({
      eq: eqMock,
      not: notMock,
    });
    const fromMock = jest.fn().mockReturnValue({
      select: selectMock,
    });

    const supabase = {
      from: fromMock,
    } as never;

    await expect(
      getProfileDeploymentState(supabase, "inst-123", "user-123")
    ).resolves.toEqual({
      profileRoutes: [
        { name: "alpha", port: 3001 },
        { name: "beta", port: 3002 },
      ],
      profilesToRestore: [{ name: "alpha", port: 3001 }],
    });
  });
});
