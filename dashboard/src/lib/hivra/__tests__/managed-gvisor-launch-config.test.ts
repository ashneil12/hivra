import { managedGvisorLaunchConfigured } from "../managed-gvisor-launch-config";

const CONFIGURED = {
  HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true",
  HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: "user_managed_fixture",
  HIVRA_MANAGED_GVISOR_CONNECTION_ID: "11111111-1111-4111-8111-111111111111",
  HIVRA_MANAGED_GVISOR_TARGET_ID: "22222222-2222-4222-8222-222222222222",
  HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "1",
} as const;

function env(overrides: Partial<Record<keyof typeof CONFIGURED, string>> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

it("is off by default and off when only the switch is on", () => {
  expect(managedGvisorLaunchConfigured(env())).toBe(false);
  expect(managedGvisorLaunchConfigured(env({ HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true" }))).toBe(false);
});

it("is on only when the switch and complete server authority shape are present", () => {
  expect(managedGvisorLaunchConfigured(env(CONFIGURED))).toBe(true);
});

it("fails closed for malformed authority configuration", () => {
  expect(managedGvisorLaunchConfigured(env({ ...CONFIGURED, HIVRA_MANAGED_GVISOR_TARGET_ID: "not-a-target" }))).toBe(false);
  expect(managedGvisorLaunchConfigured(env({ ...CONFIGURED, HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "0" }))).toBe(false);
});
