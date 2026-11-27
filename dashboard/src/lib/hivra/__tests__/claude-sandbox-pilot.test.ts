import { claudeSandboxPilot } from "../claude-sandbox-pilot";

const env = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary",
  VERCEL_GIT_REPO_OWNER: "ashneil12",
  VERCEL_GIT_REPO_SLUG: "hivra",
  HIVRA_CLAUDE_SANDBOX_PILOT_ENABLED: "1",
  HIVRA_CLAUDE_SANDBOX_PILOT_OWNER: "user_example",
  HIVRA_CLAUDE_SANDBOX_PILOT_TARGET: "22222222-2222-4222-8222-222222222222",
  HIVRA_CLAUDE_SANDBOX_PILOT_IMAGE: `sha256:${"b".repeat(64)}`,
  HIVRA_CLAUDE_SANDBOX_PILOT_ADAPTER_SHA: "a".repeat(64),
  HIVRA_CLAUDE_SANDBOX_PILOT_ORIGIN: "https://sandbox.example.test",
  HIVRA_CLAUDE_SANDBOX_PILOT_GRANT_KEY: "c".repeat(64),
};

it("requires the single enrolled owner on canonical Git Canary and a complete valid binding", () => {
  const owner = env.HIVRA_CLAUDE_SANDBOX_PILOT_OWNER;
  expect(claudeSandboxPilot(owner, env)).toMatchObject({
    owner,
    target: env.HIVRA_CLAUDE_SANDBOX_PILOT_TARGET,
    image: env.HIVRA_CLAUDE_SANDBOX_PILOT_IMAGE,
  });
  expect(claudeSandboxPilot("user_other_example", env)).toBeNull();
  expect(claudeSandboxPilot(null, env)).toBeNull();
  expect(claudeSandboxPilot(owner, { ...env, VERCEL_GIT_COMMIT_REF: "main" })).toBeNull();
  expect(claudeSandboxPilot(owner, { ...env, HIVRA_CLAUDE_SANDBOX_PILOT_ENABLED: undefined })).toBeNull();
  expect(claudeSandboxPilot(owner, { ...env, HIVRA_CLAUDE_SANDBOX_PILOT_ORIGIN: "not-a-url" })).toBeNull();
  expect(claudeSandboxPilot(owner, { ...env, HIVRA_CLAUDE_SANDBOX_PILOT_ORIGIN: "https://canary.hermesos.cloud" })).toBeNull();
  expect(claudeSandboxPilot(owner, { ...env, HIVRA_CLAUDE_SANDBOX_PILOT_IMAGE: "claude:latest" })).toBeNull();
});
