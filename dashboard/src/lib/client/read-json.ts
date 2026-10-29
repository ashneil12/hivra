/** A response's JSON body as a record, or null when the body is not JSON. Never throws. */
export async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
