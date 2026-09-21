import { getIntegrationDefinition } from './config';

const RESTART_COMMAND = '/opt/hermes/.venv/bin/hermes gateway restart';

const PLATFORM_TAILS: Record<string, string> = {
  Telegram: `After the token is stored and the gateway is restarted, verify the Telegram adapter. Then tell me to open Telegram, send /start to the bot, and bring the Pairing Code back here if Hermes asks for one. When I give you the code, use your run_command tool to execute: /opt/hermes/.venv/bin/hermes pairing approve telegram [CODE]`,
  WhatsApp: `WhatsApp requires device linking. Once env vars are stored and verified, offer to run /opt/hermes/.venv/bin/hermes whatsapp via run_command so I can scan the QR code from WhatsApp's Linked Devices screen.`,
  Discord: `Once verified, remind me if I still need to add the bot to my Discord server. State the next practical step without claiming success you have not verified.`,
  Slack: `Once verified, explain any remaining workspace install or permission steps without overstating the connection status.`,
  'Home Assistant': `Once verified, ask whether I want you to test the connection by checking device status.`,
  GitHub: `Once verified, run gh auth status via run_command to confirm the token works, or gh auth login --with-token if needed. Then tell me what GitHub actions are ready.`,
  Notion: `Once verified, test the connection by listing accessible pages or databases. Remind me you can only access pages explicitly connected to the integration.`,
  Linear: `Once verified, test by fetching the current user or listing recent issues through the Linear API.`,
  'X (Twitter)': `Once verified, test the connection by fetching the authenticated user's profile before offering posting or timeline actions.`,
};

function sanitizePromptValue(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\0]/g, '');
}

function formatPromptEnvValue(value: unknown): string {
  return `'${sanitizePromptValue(value).replace(/'/g, "\\'")}'`;
}

function buildEnvAssignments(platform: string, credentials?: Record<string, string>): string[] {
  if (platform === 'Custom Variables') {
    const key = credentials?.customKey?.trim();
    return key ? [`${key}=${formatPromptEnvValue(credentials?.customValue)}`] : [];
  }

  const definition = getIntegrationDefinition(platform);
  if (!definition || !credentials) return [];

  return definition.fields
    .filter((field) => field.envKey && credentials[field.name]?.trim())
    .map((field) => `${field.envKey}=${formatPromptEnvValue(credentials[field.name])}`);
}

function listExpectedEnvKeys(platform: string): string {
  if (platform === 'Custom Variables') return 'the custom variable name and value';

  const definition = getIntegrationDefinition(platform);
  const keys = definition?.fields
    .map((field) => field.envKey)
    .filter((key): key is string => Boolean(key)) ?? [];

  return keys.length > 0 ? keys.join(', ') : 'the required environment values';
}

export function buildIntegrationPrompt(platform: string, credentials?: Record<string, string>) {
  if (platform === 'Google Workspace') {
    return `Hey, I want to finish setting up Google Workspace.

Please verify that ~/.hermes/google_token.json exists in your environment. If it exists, test Gmail, Calendar, or Drive access before saying the integration is ready. If it is missing, tell me exactly what failed.`;
  }

  const assignments = buildEnvAssignments(platform, credentials);
  const expectedEnvKeys = listExpectedEnvKeys(platform);
  const assignmentBlock = assignments.length > 0
    ? assignments.join('\n')
    : `# I still need to provide: ${expectedEnvKeys}`;
  const tail = PLATFORM_TAILS[platform]
    || `Once verified, tell me the next practical step for ${platform}.`;
  return `Hey, I want to set up ${platform}.

Credential value(s):

\`\`\`env
${assignmentBlock}
\`\`\`

Please follow your normal ${platform} setup guidance for this environment. Treat the value(s) above as secret credentials: save them to the correct runtime env and secrets vault, do not print them again, and scrub this setup handoff from session history after the credential(s) are secured.

Use ${RESTART_COMMAND} if the gateway needs a restart after saving the env value(s). Verify the runtime state before saying the setup is connected.

${tail}`;
}
