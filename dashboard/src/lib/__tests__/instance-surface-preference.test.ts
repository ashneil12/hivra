import {
  getDefaultInstanceSurfacePreference,
  getInstanceSurfaceCookieName,
  getInstanceSurfaceHref,
  getStoredInstanceSurfacePreference,
  readInstanceSurfacePreferenceCookie,
  setStoredInstanceSurfacePreference,
} from "@/lib/instance-surface-preference";

describe("instance surface preference helpers", () => {
  it("builds deterministic cookie names and hrefs for chat and tui surfaces", () => {
    expect(getInstanceSurfaceCookieName("inst_123")).toBe("hermes_surface_inst_123");
    expect(getInstanceSurfaceHref("inst_123", "chat")).toBe("/dashboard/instances/inst_123");
    expect(getInstanceSurfaceHref("inst_123", "tui")).toBe("/dashboard/instances/inst_123/tui");
    expect(getInstanceSurfaceHref("inst_123", "chat", { forceSurface: true })).toBe(
      "/dashboard/instances/inst_123?surface=chat"
    );
  });

  it("reads and writes an instance surface preference across local storage and cookies", () => {
    const storage = {
      getItem: jest.fn(() => "tui"),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };
    const cookieWriter = jest.fn();

    expect(getStoredInstanceSurfacePreference("inst_123", storage)).toBe("tui");

    setStoredInstanceSurfacePreference("inst_123", "chat", {
      storage,
      cookieWriter,
    });

    expect(storage.setItem).toHaveBeenCalledWith("hermes_surface_inst_123", "chat");
    expect(cookieWriter).toHaveBeenCalledWith("hermes_surface_inst_123=chat; path=/; max-age=31536000");
  });

  it("falls back to chat when the stored value is missing or invalid", () => {
    const invalidStorage = {
      getItem: jest.fn(() => "retro-mode"),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };
    const emptyStorage = {
      getItem: jest.fn(() => null),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };

    expect(getStoredInstanceSurfacePreference("inst_123", invalidStorage)).toBe("chat");
    expect(getStoredInstanceSurfacePreference("inst_123", emptyStorage)).toBe("chat");
  });

  it("uses chat as the default unsaved surface for every backend", () => {
    const emptyStorage = {
      getItem: jest.fn(() => null),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };
    const cookieStore = {
      get: jest.fn(() => undefined),
    };

    expect(getDefaultInstanceSurfacePreference("webui")).toBe("chat");
    expect(getDefaultInstanceSurfacePreference("gateway")).toBe("chat");
    expect(getDefaultInstanceSurfacePreference(null)).toBe("chat");
    expect(getStoredInstanceSurfacePreference("inst_123", emptyStorage, getDefaultInstanceSurfacePreference("webui"))).toBe("chat");
    expect(readInstanceSurfacePreferenceCookie(cookieStore, "inst_123", getDefaultInstanceSurfacePreference("webui"))).toBe("chat");
  });
});
