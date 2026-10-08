// Registry credentials on tenant boxes.
//
// Every image a Hermes-lane box pulls (ghcr.io/ashneil12/vanilla-hermes-agent,
// hermes-webui, operatoros-agent, hermes-browser-sidecar and their -canary
// twins) is a public package, so a box never needs to log in to a registry.
// The provisioning and update scripts therefore carry no registry token.
//
// Older scripts ran `docker login ghcr.io -u __token__` as root with the
// platform GHCR_TOKEN and never logged out, which left that token
// base64-encoded in root's Docker config on every box they touched. This block
// removes that stored platform credential the next time a box is provisioned
// or updated:
//
//   * only a ghcr.io entry stored for the `__token__` user is the platform's.
//     An owner who logged in to ghcr.io with their own account on their own box
//     keeps that login, and the block does not touch the file at all;
//   * `docker logout ghcr.io` drops only the ghcr.io entry and keeps any other
//     registry login the owner made;
//   * if the platform credential is still in the file afterwards (the logout
//     failed), the file is deleted, because the platform token must not stay
//     on the box;
//   * a config left with no logins at all is deleted.
//
// It looks in every place the Docker CLI could have written the file under the
// delivery paths we use (cloud-init, root SSH, `sudo bash -s`): $DOCKER_CONFIG,
// $HOME/.docker and /root/.docker. It never fails the surrounding script.
//
// Revoke the old token only after this has run on every box. GHCR answers
// "denied" to a stored credential that no longer works, even for a public
// image, and the on-box roll and refresh timers pull as root with root's Docker
// config. A box that still holds the old login when the token is revoked stops
// getting updates (the timers only log "pull failed") until a dashboard update,
// redeploy or recovery reaches it and runs this block.
const PLATFORM_REGISTRY_HOST = "ghcr.io";

// Docker stores a login as base64("<user>:<password>"). Every value the older
// `-u __token__` logins wrote starts with these characters, whatever the token:
// base64("__token__:") without its last character, which also depends on the
// first byte of the token.
const PLATFORM_LOGIN_AUTH_PREFIX = "X190b2tlbl9fO";

export function buildPlatformRegistryCredentialScrubScript(): string {
  const platformLogin = `*'"${PLATFORM_REGISTRY_HOST}":{"auth":"${PLATFORM_LOGIN_AUTH_PREFIX}'*`;
  return `# Remove the platform ${PLATFORM_REGISTRY_HOST} login (user __token__) older bootstraps left in
# root's Docker config. Hermes images are public; an owner's own logins stay.
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
      ${platformLogin}) ;;
      *) continue ;;
    esac
    DOCKER_CONFIG="$dir" docker logout ${PLATFORM_REGISTRY_HOST} >/dev/null 2>&1 || true
    case "$(hermes_docker_cfg_compact "$cfg")" in
      ${platformLogin}|'{"auths":{}}'|'') rm -f "$cfg" || true ;;
    esac
    case "$(hermes_docker_cfg_compact "$cfg")" in
      ${platformLogin}) echo "[hermes] WARNING: could not remove the platform ${PLATFORM_REGISTRY_HOST} login from $dir" >&2 ;;
      *) echo "[hermes] removed the platform ${PLATFORM_REGISTRY_HOST} login from $dir" ;;
    esac
  done
  return 0
}
hermes_scrub_registry_credential || true
`;
}
