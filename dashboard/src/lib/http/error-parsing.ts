/**
 * Best-effort extraction of a human-readable error message from a fetch
 * Response. Tries the JSON `error`/`message` field, falls back to the raw text
 * (truncated), and finally to the HTTP status. Previously copy-pasted
 * identically across the ops action components.
 */
export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const msg = obj.error || obj.message;
        if (typeof msg === 'string' && msg.length > 0) return msg;
      }
    } catch {
      // fall through to raw text
    }
    return `HTTP ${response.status}: ${text.slice(0, 200)}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
