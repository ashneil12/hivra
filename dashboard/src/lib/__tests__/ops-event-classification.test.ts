import { classifyOpsEvent, detectSoftChatError } from '../ops-event-classification';

describe('ops-event-classification', () => {
  it('classifies assistant soft errors from source or metadata', () => {
    expect(classifyOpsEvent({
      source: 'chat-soft-error',
      title: 'Assistant returned an error-like message',
      message: 'Something went wrong',
      metadata: null,
    })).toBe('assistant-soft-error');

    expect(classifyOpsEvent({
      source: 'chat-runtime',
      title: 'Assistant returned an error-like message',
      message: 'Something went wrong',
      metadata: { category: 'assistant-soft-error' },
    })).toBe('assistant-soft-error');
  });

  it('classifies proxy and persistence events conservatively', () => {
    expect(classifyOpsEvent({
      source: 'responses-proxy',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      metadata: null,
    })).toBe('proxy');

    expect(classifyOpsEvent({
      source: 'chat-persistence',
      title: 'Failed to save chat message',
      message: 'Database write failed',
      metadata: null,
    })).toBe('persistence');
  });

  it('detects short technical assistant failures', () => {
    const detection = detectSoftChatError('Error: provider returned 429 rate limit exceeded.');
    expect(detection).not.toBeNull();
    expect(detection?.category).toBe('assistant-soft-error');
    expect(detection?.matchedRules).toEqual(expect.arrayContaining(['error-prefix', 'provider-returned', 'rate-limit']));
  });

  it('detects authentication header failures as authentication soft errors', () => {
    const detection = detectSoftChatError("Error code: 401 - {'error': {'message': 'Missing Authentication header', 'code': 401}}");
    expect(detection).not.toBeNull();
    expect(detection?.matchedRules).toEqual(expect.arrayContaining(['error-prefix', 'authentication']));
  });

  it('detects missing Codex credentials in streamed failures as authentication soft errors', () => {
    const detection = detectSoftChatError(
      'Generation failed: No Codex credentials stored. Run hermes auth to authenticate. Run hermes model to re-authenticate.'
    );
    expect(detection).not.toBeNull();
    expect(detection?.matchedRules).toEqual(expect.arrayContaining(['failed-prefix', 'authentication']));
  });

  it('detects provider token invalidation codes as authentication soft errors', () => {
    const detection = detectSoftChatError(
      'Generation failed: {"code":"auth_mismatch","message":"token_invalidated"}'
    );
    expect(detection).not.toBeNull();
    expect(detection?.matchedRules).toEqual(expect.arrayContaining(['failed-prefix', 'authentication']));
  });

  it('ignores normal explanatory content about errors', () => {
    expect(detectSoftChatError('Here is how to debug timeout errors in your app.')).toBeNull();
    expect(detectSoftChatError('If you see this error, retry the request and inspect the logs.')).toBeNull();
  });

  it('does not classify browser transport TypeErrors as agent soft errors', () => {
    // The page-side broadcast handler used to feed `snapshot.error` into
    // the same classifier that inspects assistant content, so a bare
    // `TypeError: Failed to fetch` from the SW's persist or sidecar SSE
    // got displayed as "Agent returned an error instead of a reply:
    // Failed to fetch" — even when the agent had completed the turn
    // server-side. The classifier should treat these locale-stable
    // transport messages as plumbing, not LLM output.
    expect(detectSoftChatError('Failed to fetch')).toBeNull();
    expect(detectSoftChatError('TypeError: Failed to fetch')).toBeNull();
    expect(detectSoftChatError('Load failed')).toBeNull();
    expect(detectSoftChatError('NetworkError when attempting to fetch resource.')).toBeNull();
    expect(detectSoftChatError('The network connection was lost.')).toBeNull();
    expect(detectSoftChatError('The Internet connection appears to be offline.')).toBeNull();
  });

  it('still classifies real agent failure phrasings even when they share keywords', () => {
    // Sanity guard for the transport short-circuit: an actual LLM-emitted
    // failure that names "fetch" should still be caught — the short-
    // circuit only kills the bare TypeError messages, not anything that
    // happens to contain the word.
    const detection = detectSoftChatError("Sorry, I can't fetch that — provider returned 500 and the request failed.");
    expect(detection).not.toBeNull();
    expect(detection?.matchedRules).toEqual(expect.arrayContaining(['provider-returned']));
  });
});
