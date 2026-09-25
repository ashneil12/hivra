// Registry credentials on tenant boxes.
//
// Every image a Hermes-lane box pulls (ghcr.io/ashneil12/vanilla-hermes-agent,
// hermes-webui, operatoros-agent, hermes-browser-sidecar and their -canary
// twins) is a public package, so a box never needs to log in to a registry.
// The provisioning and update scripts therefore carry no registry token.
//
// Older scripts ran `docker login ghcr.io` as root with the platform
// GHCR_TOKEN and never logged out, which left that token base64-encoded in
// root's Docker config on every box they touched. This block removes that
// stored ghcr.io credential the next time a box is provisioned or updated:
//
//   * `docker logout ghcr.io` drops only the ghcr.io entry and keeps any other
//     registry login the owner made on their own box;
//   * if a plaintext ghcr.io credential is still in the file afterwards (the
//     logout failed), the file is deleted, because the platform token must not
//     stay on the box;
//   * a config left with no logins at all is deleted.
//
// It looks in every place the Docker CLI could have written the file under the
// delivery paths we use (cloud-init, root SSH, `sudo bash -s`): $DOCKER_CONFIG,
// $HOME/.docker and /root/.docker. It never fails the surrounding script.
const PLATFORM_REGISTRY_HOST = "ghcr.io";

export function buildPlatformRegistryCredentialScrubScript(): string {
  const storedLogin = `*'${PLATFORM_REGISTRY_HOST}":{"auth":'*`;
  return `# Remove the ${PLATFORM_REGISTRY_HOST} login older bootstraps left in root's Docker config.
# Hermes images are public; no box keeps a registry credential.
hermes_docker_cfg_compact() {
  tr -d ' \\t\\r\\n' 2>/dev/null < "$1" || true
}
hermes_scrub_registry_credential() {
  local dir cfg
  for dir in "\${DOCKER_CONFIG:-}" "\${HOME:+\${HOME}/.docker}" /root/.docker; do
    [ -n "$dir" ] || continue
    cfg="$dir/config.json"
    [ -f "$cfg" ] || continue
    case "$(hermes_docker_cfg_compact "$cfg")" in
      ${storedLogin}) ;;
      *) continue ;;
    esac
    DOCKER_CONFIG="$dir" docker logout ${PLATFORM_REGISTRY_HOST} >/dev/null 2>&1 || true
    case "$(hermes_docker_cfg_compact "$cfg")" in
      ${storedLogin}|'{"auths":{}}'|'') rm -f "$cfg" || true ;;
    esac
    case "$(hermes_docker_cfg_compact "$cfg")" in
      ${storedLogin}) echo "[hermes] WARNING: could not remove the stored ${PLATFORM_REGISTRY_HOST} login from $dir" >&2 ;;
      *) echo "[hermes] removed the stored ${PLATFORM_REGISTRY_HOST} login from $dir" ;;
    esac
  done
  return 0
}
hermes_scrub_registry_credential || true
`;
}
