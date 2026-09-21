/** @jest-environment jsdom */
import { readCachedProfileSummaries } from '../useProfiles';

describe('useProfiles profile summary cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads only safe profile summary fields from local storage', () => {
    localStorage.setItem('hermes_profile_summary_cache:inst_123', JSON.stringify({
      savedAt: '2026-04-26T12:00:00.000Z',
      profiles: [{
        id: 'profile-default',
        name: 'default',
        display_name: 'Atlas',
        avatar_url: 'https://example.com/avatar.png',
        model: 'gpt-5',
        provider: 'openai',
        status: 'running',
        gateway_port: 8000,
        created_at: '2026-04-26T12:00:00.000Z',
        system_prompt: 'do not cache this',
        apiKey: 'secret-key',
      }],
    }));

    expect(readCachedProfileSummaries('inst_123')).toEqual([{
      id: 'profile-default',
      name: 'default',
      display_name: 'Atlas',
      avatar_url: 'https://example.com/avatar.png',
      model: 'gpt-5',
      provider: 'openai',
      status: 'running',
      gateway_port: 8000,
      created_at: '2026-04-26T12:00:00.000Z',
    }]);
  });

  it('ignores malformed cached profiles instead of trusting local storage shape', () => {
    localStorage.setItem('hermes_profile_summary_cache:inst_123', JSON.stringify({
      savedAt: '2026-04-26T12:00:00.000Z',
      profiles: [{
        id: '',
        name: '',
        status: 'running',
      }],
    }));

    expect(readCachedProfileSummaries('inst_123')).toBeUndefined();
  });
});
