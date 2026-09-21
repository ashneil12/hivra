export const WEBUI_DASHBOARD_APPEARANCE_MESSAGE_TYPE = "hermes-dashboard:appearance";
// Posted into the chat iframe to inject a prompt as a user message (the welcome
// starter strip and the Workflows-of-the-week shelf both use it). Handled box-
// side by apps/desktop (desktop-controller.tsx); must stay in lockstep with
// DASHBOARD_SEND_MESSAGE_TYPE there. An older/un-rolled box silently ignores it,
// so posting is always safe.
// TODO(paioclaw-riplist): the box-side apps/desktop handler for this message
// type must be rolled to the fleet for the Workflows shelf (and any other
// prompt-injection surface) to actually submit the prompt as a first message.
export const WEBUI_DASHBOARD_SEND_MESSAGE_TYPE = "hermes-dashboard:send-message";

export type WebUIAppearanceTheme = "dark" | "hermesos-light";
export type WebUIAppearanceSkin = "hivra" | "hermesos";
type WebUIAppearanceColorScheme = "dark" | "light";

export interface WebUIAppearance {
  theme: WebUIAppearanceTheme;
  skin: WebUIAppearanceSkin;
  colorScheme: WebUIAppearanceColorScheme;
}

export function normalizeWebUIAppearanceTheme(value?: string | null): WebUIAppearanceTheme | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dark" || normalized === "hermesos-light") {
    return normalized;
  }
  return null;
}

export function normalizeWebUIAppearanceSkin(value?: string | null): WebUIAppearanceSkin | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "hivra" || normalized === "hermesos") {
    return normalized;
  }
  return null;
}

export function resolveWebUIAppearanceFromDashboardTheme(
  resolvedTheme?: string | null,
): WebUIAppearance | null {
  if (resolvedTheme === "light") {
    return {
      theme: "hermesos-light",
      skin: "hivra",
      colorScheme: "light",
    };
  }

  if (resolvedTheme === "dark") {
    return {
      theme: "dark",
      skin: "hivra",
      colorScheme: "dark",
    };
  }

  return null;
}

export function appendWebUIAppearanceSearchParams(
  rawUrl: string,
  appearance?: WebUIAppearance | null,
): string {
  if (!appearance) return rawUrl;

  const url = new URL(rawUrl);
  url.searchParams.set("theme", appearance.theme);
  url.searchParams.set("skin", appearance.skin);
  return url.toString();
}
