type IntegrationFieldDefinition = {
  name: string;
  label: string;
  envKey?: string;
  requiredOnConnect?: boolean;
  requiredInEnv?: boolean;
};

export type IntegrationDefinition = {
  id: string;
  fields: IntegrationFieldDefinition[];
  oauthManaged?: boolean;
};

export type IntegrationValidationResult = {
  valid: boolean;
  missingFields: string[];
};

export type IntegrationState = {
  configured: boolean;
  partial: boolean;
  presentFields: string[];
  missingFields: string[];
  requiredFields: string[];
};

const CANARY_SHAPE_PROBE_MARKER = 'CANARY_SHAPE_PROBE';

export const INTEGRATION_DEFINITIONS: IntegrationDefinition[] = [
  {
    id: 'Telegram',
    fields: [
      { name: 'token', label: 'Telegram bot token', envKey: 'TELEGRAM_BOT_TOKEN', requiredOnConnect: true, requiredInEnv: true },
      // Owner id → TELEGRAM_ALLOWED_USERS (locks the bot to the user). Optional
      // at the validation layer for back-compat, but the connect UI always
      // supplies it; the route fail-closes the bot without it.
      { name: 'ownerId', label: 'Your Telegram user id', envKey: 'TELEGRAM_ALLOWED_USERS' },
    ],
  },
  {
    id: 'Discord',
    fields: [
      { name: 'token', label: 'Discord bot token', envKey: 'DISCORD_BOT_TOKEN', requiredOnConnect: true, requiredInEnv: true },
      { name: 'clientId', label: 'Application ID (Client ID)' },
    ],
  },
  {
    id: 'Slack',
    fields: [
      { name: 'token', label: 'Slack bot token', envKey: 'SLACK_BOT_TOKEN', requiredOnConnect: true, requiredInEnv: true },
      { name: 'appToken', label: 'Slack app token', envKey: 'SLACK_APP_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Email',
    fields: [
      { name: 'address', label: 'Email address', envKey: 'EMAIL_ADDRESS', requiredOnConnect: true, requiredInEnv: true },
      { name: 'password', label: 'App password', envKey: 'EMAIL_PASSWORD', requiredOnConnect: true, requiredInEnv: true },
      { name: 'imapHost', label: 'IMAP host', envKey: 'EMAIL_IMAP_HOST', requiredOnConnect: true, requiredInEnv: true },
      { name: 'smtpHost', label: 'SMTP host', envKey: 'EMAIL_SMTP_HOST', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'SMS (Twilio)',
    fields: [
      { name: 'accountSid', label: 'Account SID', envKey: 'TWILIO_ACCOUNT_SID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'authToken', label: 'Auth token', envKey: 'TWILIO_AUTH_TOKEN', requiredOnConnect: true, requiredInEnv: true },
      { name: 'phoneNumber', label: 'Twilio phone number' },
    ],
  },
  {
    id: 'Signal',
    fields: [
      { name: 'account', label: 'Registered phone number', envKey: 'SIGNAL_ACCOUNT', requiredOnConnect: true, requiredInEnv: true },
      { name: 'httpUrl', label: 'Signal CLI REST API URL', envKey: 'SIGNAL_HTTP_URL', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'DingTalk',
    fields: [
      { name: 'clientId', label: 'Client ID', envKey: 'DINGTALK_CLIENT_ID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'clientSecret', label: 'Client secret', envKey: 'DINGTALK_CLIENT_SECRET', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'WhatsApp',
    fields: [
      { name: 'enabled', label: 'WhatsApp enabled', envKey: 'WHATSAPP_ENABLED', requiredInEnv: true },
      { name: 'allowedUsers', label: 'Allowed numbers', envKey: 'WHATSAPP_ALLOWED_USERS' },
    ],
  },
  {
    id: 'X (Twitter)',
    fields: [
      { name: 'apiKey', label: 'API Key', envKey: 'X_API_KEY', requiredOnConnect: true, requiredInEnv: true },
      { name: 'apiSecret', label: 'API Secret', envKey: 'X_API_SECRET', requiredOnConnect: true, requiredInEnv: true },
      { name: 'accessToken', label: 'Access Token', envKey: 'X_ACCESS_TOKEN', requiredOnConnect: true, requiredInEnv: true },
      { name: 'accessSecret', label: 'Access Token Secret', envKey: 'X_ACCESS_TOKEN_SECRET', requiredOnConnect: true, requiredInEnv: true },
    ],
  },

  {
    id: 'Google Workspace',
    oauthManaged: true,
    fields: [],
  },
  {
    id: 'Custom Variables',
    fields: [
      { name: 'customKey', label: 'Variable Name', requiredOnConnect: true },
      { name: 'customValue', label: 'Variable Value', requiredOnConnect: true },
    ],
  },
  {
    id: 'BlueBubbles',
    fields: [
      { name: 'serverUrl', label: 'Server URL', envKey: 'BLUEBUBBLES_SERVER_URL', requiredOnConnect: true, requiredInEnv: true },
      { name: 'password', label: 'Password', envKey: 'BLUEBUBBLES_PASSWORD', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Matrix',
    fields: [
      { name: 'homeserver', label: 'Homeserver URL', envKey: 'MATRIX_HOMESERVER', requiredOnConnect: true, requiredInEnv: true },
      { name: 'userId', label: 'User ID', envKey: 'MATRIX_USER_ID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'accessToken', label: 'Access Token', envKey: 'MATRIX_ACCESS_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Mattermost',
    fields: [
      { name: 'url', label: 'Mattermost URL', envKey: 'MATTERMOST_URL', requiredOnConnect: true, requiredInEnv: true },
      { name: 'token', label: 'Bot Token', envKey: 'MATTERMOST_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'WeCom',
    fields: [
      { name: 'botId', label: 'Bot ID', envKey: 'WECOM_BOT_ID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'secret', label: 'Secret', envKey: 'WECOM_SECRET', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'WeChat',
    fields: [
      { name: 'accountId', label: 'Account ID', envKey: 'WEIXIN_ACCOUNT_ID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'token', label: 'Token', envKey: 'WEIXIN_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Feishu',
    fields: [
      { name: 'appId', label: 'App ID', envKey: 'FEISHU_APP_ID', requiredOnConnect: true, requiredInEnv: true },
      { name: 'appSecret', label: 'App Secret', envKey: 'FEISHU_APP_SECRET', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Home Assistant',
    fields: [
      { name: 'url', label: 'Home Assistant URL', envKey: 'HASS_URL', requiredOnConnect: true, requiredInEnv: true },
      { name: 'token', label: 'Long-Lived Access Token', envKey: 'HASS_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'GitHub',
    fields: [
      { name: 'token', label: 'GitHub Personal Access Token', envKey: 'GITHUB_TOKEN', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Notion',
    fields: [
      { name: 'token', label: 'Notion Integration Token', envKey: 'NOTION_API_KEY', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
  {
    id: 'Linear',
    fields: [
      { name: 'token', label: 'Linear API Key', envKey: 'LINEAR_API_KEY', requiredOnConnect: true, requiredInEnv: true },
    ],
  },
];

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function isCanaryShapeProbeValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes(CANARY_SHAPE_PROBE_MARKER);
}

function hasUsableValue(value: unknown): boolean {
  return hasValue(value) && !isCanaryShapeProbeValue(value);
}

export function getIntegrationDefinition(platform: string): IntegrationDefinition | undefined {
  return INTEGRATION_DEFINITIONS.find(
    (definition) => definition.id.toLowerCase() === platform.toLowerCase()
  );
}

export function validateIntegrationCredentials(
  platform: string,
  credentials: Record<string, unknown> | undefined
): IntegrationValidationResult {
  const definition = getIntegrationDefinition(platform);
  if (!definition) {
    return { valid: false, missingFields: [] };
  }

  const missingFields = definition.fields
    .filter((field) => field.requiredOnConnect && !hasUsableValue(credentials?.[field.name]))
    .map((field) => field.name);

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

export function extractEnvKeys(envContent: string): string[] {
  return envContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
    .filter((line) => !isCanaryShapeProbeValue(line.slice(line.indexOf('=') + 1).trim()))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
    .filter(Boolean);
}

export function getIntegrationState(platform: string, envKeys: Iterable<string>): IntegrationState {
  const definition = getIntegrationDefinition(platform);
  const keySet = envKeys instanceof Set ? envKeys : new Set(envKeys);

  if (!definition) {
    return {
      configured: false,
      partial: false,
      presentFields: [],
      missingFields: [],
      requiredFields: [],
    };
  }

  const envFields = definition.fields.filter((field) => field.envKey);
  const requiredFields = definition.fields.filter((field) => field.requiredInEnv && field.envKey);
  const presentFields = envFields.filter((field) => keySet.has(field.envKey!)).map((field) => field.name);
  const missingFields = requiredFields
    .filter((field) => !keySet.has(field.envKey!))
    .map((field) => field.name);

  const configured = requiredFields.length > 0
    ? missingFields.length === 0
    : presentFields.length > 0;
  const partial = presentFields.length > 0 && !configured;

  return {
    configured,
    partial,
    presentFields,
    missingFields,
    requiredFields: requiredFields.map((field) => field.name),
  };
}

export function getIntegrationStatesFromEnvContent(envContent: string): Record<string, IntegrationState> {
  const envKeys = extractEnvKeys(envContent);

  return INTEGRATION_DEFINITIONS.reduce<Record<string, IntegrationState>>((states, definition) => {
    states[definition.id] = getIntegrationState(definition.id, envKeys);
    return states;
  }, {});
}

export function getConfiguredPlatforms(states: Record<string, IntegrationState>): string[] {
  return Object.entries(states)
    .filter(([, state]) => state.configured)
    .map(([platform]) => platform);
}

export function getIntegrationScopeLabel(profileName?: string | null): string {
  if (profileName && profileName !== 'default') {
    return `Profile: ${profileName}`;
  }

  return 'Default agent';
}

export function resolveIntegrationRuntimeProfile(
  platform: string,
  profileName?: string | null
): string {
  void platform;
  const normalizedProfile = profileName && profileName.trim() ? profileName.trim() : 'default';

  return normalizedProfile;
}

export function getMissingFieldLabels(
  platform: string,
  fieldNames: string[]
): string[] {
  const definition = getIntegrationDefinition(platform);
  if (!definition) return fieldNames;

  return fieldNames.map((name) => definition.fields.find((field) => field.name === name)?.label || name);
}

export function validateCustomVariable(key: string): { valid: boolean; error?: string } {
  if (!key) return { valid: false, error: 'Missing Variable Name' };
  
  const safeKey = String(key).replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeKey || safeKey !== key) {
    return { valid: false, error: 'Invalid Variable Name. Only letters, numbers, and underscores are allowed.' };
  }

  // Prevent overriding critical system orchestration variables
  const restrictedPrefixes = [
    'HERMES_', 
    'API_SERVER_KEY', 
    'AWS_', 
    'STRIPE_', 
    'NEXT_PUBLIC_', 
    'SSH_', 
    'DOCKER_', 
    'MYSQL_', 
    'POSTGRES_', 
    'REDIS_'
  ];
  
  const upperKey = safeKey.toUpperCase();
  const isRestricted = restrictedPrefixes.some(prefix => upperKey.startsWith(prefix)) || 
                      upperKey === 'PORT' || 
                      upperKey === 'HOST';

  if (isRestricted) {
    return { valid: false, error: `The variable name "${safeKey}" is reserved for system use and cannot be modified.` };
  }

  return { valid: true };
}
