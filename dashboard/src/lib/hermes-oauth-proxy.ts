export async function readHermesOAuthProxyError(
  response: Response,
  actionLabel: string,
): Promise<string> {
  try {
    const text = await response.text();
    const payload = text
      ? (JSON.parse(text) as { detail?: string; error?: string })
      : null;
    if (payload?.detail) return payload.detail;
    if (payload?.error) return payload.error;
    if (text.trim()) return text.trim();
  } catch {
    // Fall through to generic message
  }

  return `Hermes OAuth ${actionLabel} failed (HTTP ${response.status})`;
}
