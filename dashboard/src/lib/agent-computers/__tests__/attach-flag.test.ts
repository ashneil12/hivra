// Attach is on for Canary and off in production, from the deployment's own
// environment: production needs no change to keep it off (design 5.6, step 8).
import { isAgentAttachEnabled } from "../attach-flag";

it.each([
  ["the Canary project's URLs", { VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud", NEXT_PUBLIC_APP_URL: "https://canary.hermesos.cloud" }, true],
  ["an explicit canary channel", { HERMES_DEPLOY_CHANNEL: "canary" }, true],
  ["production's URLs", { VERCEL_PROJECT_PRODUCTION_URL: "hivra.cloud", NEXT_PUBLIC_APP_URL: "https://hivra.cloud",
    VERCEL_URL: "hermesos-abc123-hivra.vercel.app" }, false],
  ["an explicit production channel, whatever the URLs say", { HERMES_DEPLOY_CHANNEL: "production", NEXT_PUBLIC_APP_URL: "https://canary.hermesos.cloud" }, false],
  ["an empty environment", {}, false],
  ["a hostname that only contains the word", { NEXT_PUBLIC_APP_URL: "https://canaryish.example.com" }, false],
])("%s", (_label, env, expected) => {
  expect(isAgentAttachEnabled(env)).toBe(expected);
});
