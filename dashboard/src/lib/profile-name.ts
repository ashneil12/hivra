const SAFE_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/;

export const INVALID_PROFILE_NAME_ERROR = "Invalid profile name format";

export function normalizeProfileName(rawProfile: unknown): string {
  if (typeof rawProfile !== "string") {
    return "default";
  }

  const trimmedProfile = rawProfile.trim();
  if (!trimmedProfile || trimmedProfile === "default") {
    return "default";
  }

  if (!SAFE_PROFILE_NAME.test(trimmedProfile)) {
    throw new Error(INVALID_PROFILE_NAME_ERROR);
  }

  return trimmedProfile;
}
