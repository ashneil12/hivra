function normalizeResponseSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

type ResponseLike = Pick<Response, "status"> &
  Partial<Pick<Response, "text" | "json">>;

export async function parseJsonResponse<T>(response: ResponseLike): Promise<T> {
  if (typeof response.text !== "function") {
    if (typeof response.json === "function") {
      return (await response.json()) as T;
    }

    return {} as T;
  }

  const bodyText = await response.text();

  if (!bodyText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    const snippet = normalizeResponseSnippet(bodyText);
    const statusLabel = response.status ? `HTTP ${response.status}` : "HTTP error";
    throw new Error(snippet ? `${statusLabel}: ${snippet}` : `${statusLabel}: Response was not valid JSON`);
  }
}
