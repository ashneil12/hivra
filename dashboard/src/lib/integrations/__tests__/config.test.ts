import {
  getIntegrationState,
  getIntegrationStatesFromEnvContent,
  resolveIntegrationRuntimeProfile,
  validateIntegrationCredentials,
} from '../config';

describe('integration config helpers', () => {
  describe('validateIntegrationCredentials', () => {
    it('rejects the canary Telegram shape probe as a real bot token', () => {
      expect(validateIntegrationCredentials('Telegram', { token: '000000:CANARY_SHAPE_PROBE' })).toEqual({
        valid: false,
        missingFields: ['token'],
      });
    });

    it('requires both Slack tokens', () => {
      expect(validateIntegrationCredentials('Slack', { token: 'xoxb-123' })).toEqual({
        valid: false,
        missingFields: ['appToken'],
      });
    });

    it('requires all X credentials', () => {
      expect(validateIntegrationCredentials('X (Twitter)', {
        apiKey: 'key',
        apiSecret: 'secret',
        accessToken: 'access',
      })).toEqual({
        valid: false,
        missingFields: ['accessSecret'],
      });
    });

    it('treats WhatsApp as optional input only', () => {
      expect(validateIntegrationCredentials('WhatsApp', {})).toEqual({
        valid: true,
        missingFields: [],
      });
    });
  });

  describe('getIntegrationState', () => {
    it('marks Telegram configured when its token key is present', () => {
      expect(getIntegrationState('Telegram', ['TELEGRAM_BOT_TOKEN'])).toMatchObject({
        configured: true,
        partial: false,
        missingFields: [],
      });
    });

    it('marks Slack partial when only the bot token is present', () => {
      expect(getIntegrationState('Slack', ['SLACK_BOT_TOKEN'])).toMatchObject({
        configured: false,
        partial: true,
        missingFields: ['appToken'],
      });
    });
  });

  describe('getIntegrationStatesFromEnvContent', () => {
    it('does not mark Telegram configured when a canary shape probe leaked into the env', () => {
      const states = getIntegrationStatesFromEnvContent(`
TELEGRAM_BOT_TOKEN=000000:CANARY_SHAPE_PROBE
      `);

      expect(states['Telegram']).toMatchObject({
        configured: false,
        partial: false,
        presentFields: [],
        missingFields: ['token'],
      });
    });

    it('parses env content into platform states', () => {
      const states = getIntegrationStatesFromEnvContent(`
SLACK_BOT_TOKEN=xoxb-123
X_API_KEY=key
X_API_SECRET=secret
X_ACCESS_TOKEN=access
      `);

      expect(states['Slack']).toMatchObject({
        configured: false,
        partial: true,
        missingFields: ['appToken'],
      });

      expect(states['X (Twitter)']).toMatchObject({
        configured: false,
        partial: true,
        missingFields: ['accessSecret'],
      });
    });
  });

  describe('resolveIntegrationRuntimeProfile', () => {
    it('keeps Telegram scoped to the active profile', () => {
      expect(resolveIntegrationRuntimeProfile('Telegram', 'marcus')).toBe('marcus');
    });
  });
});
