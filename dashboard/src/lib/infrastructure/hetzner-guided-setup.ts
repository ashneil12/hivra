/**
 * The one server base Hivra's agent setup supports on Hetzner today. The guest
 * installer (provider-guest-bundle) and the prepared-create gate in
 * hetzner-cloud.ts both require it, so the create dialog lists only matching
 * sizes and images instead of offering a choice setup would later refuse.
 * Browser-safe: no provider token, key or network access.
 */
export const HETZNER_GUIDED_SETUP_BASE = {
  architecture: "x86",
  osFlavor: "ubuntu",
  osVersion: "22.04",
  label: "Ubuntu 22.04 on x86",
} as const;

export function isHetznerGuidedSetupServerType(serverType: {
  architecture: string | null;
}): boolean {
  return serverType.architecture === HETZNER_GUIDED_SETUP_BASE.architecture;
}

export function isHetznerGuidedSetupImage(image: {
  architecture: string | null;
  osFlavor: string | null;
  osVersion: string | null;
  deprecated?: boolean;
}): boolean {
  return image.deprecated !== true
    && image.architecture === HETZNER_GUIDED_SETUP_BASE.architecture
    && image.osFlavor === HETZNER_GUIDED_SETUP_BASE.osFlavor
    && image.osVersion === HETZNER_GUIDED_SETUP_BASE.osVersion;
}
