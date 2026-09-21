/**
 * Silence a noisy console method for the duration of a test.
 *
 * `jest.spyOn(console, "error").mockImplementation(() => {})` appears in a
 * large share of route tests; this packages the spy plus its restore.
 */
export interface ConsoleSpy {
  spy: jest.SpyInstance;
  restore: () => void;
}

export function silenceConsole(method: "error" | "warn" | "log" | "info" = "error"): ConsoleSpy {
  const spy = jest.spyOn(console, method).mockImplementation(() => {});
  return { spy, restore: () => spy.mockRestore() };
}
