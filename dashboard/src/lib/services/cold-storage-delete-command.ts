import { isColdArchiveUriForInstance } from "@/lib/cold-storage/manifest";
import { isHermesInstanceId } from "@/lib/proxmox/hermes-guest-ssh";

export const COLD_DELETE_STORAGE_RECEIPT = "HERMES_COLD_DELETE_STORAGE_ABSENT";
export const COLD_RETENTION_TRASH_RECEIPT = "HERMES_COLD_RETENTION_STORAGE_TRASHED";

const STORAGE_BOX_PRELUDE = `set -euo pipefail
storage_box() {
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 cold "$1"
}
verify_missing_on_storage_box() {
  local result
  if result=$(storage_box "ls -ld $1" 2>&1) || ! missing_on_storage_box "$1" "$result"; then
    echo "Unable to verify that the instance data is gone from $1" >&2
    return 1
  fi
}
missing_on_storage_box() {
  case "$2" in
    "/usr/bin/ls: cannot access '$1': No such file or directory" | "ls: cannot access '$1': No such file or directory") return 0 ;;
    *) return 1 ;;
  esac
}
`;

export function buildOwnerColdStorageDeleteCommand(instanceId: string): string {
  if (instanceId.length !== 36 || !isHermesInstanceId(instanceId)) {
    throw new Error("Invalid archived instance identity");
  }

  const paths = ["free", "paid", "meta", "restic", "daily/free", "daily/paid", "daily-meta"]
    .map((directory) => `${directory}/${instanceId}`);
  return `${STORAGE_BOX_PRELUDE}
storage_box "ls -ld ." >/dev/null
storage_box "rm -rf ${paths.join(" ")}"
if trash=$(storage_box "ls -1 trash" 2>&1); then
  while IFS= read -r entry; do
    if [[ "$entry" =~ ^${instanceId}-[0-9]{8}T[0-9]{6}Z$ ]]; then
      storage_box "rm -rf trash/$entry"
    fi
  done <<< "$trash"
  trash=$(storage_box "ls -1 trash")
  if grep -Exq '${instanceId}-[0-9]{8}T[0-9]{6}Z' <<< "$trash"; then
    echo "Cold storage trash still contains the instance" >&2
    exit 1
  fi
elif ! missing_on_storage_box trash "$trash"; then
  echo "Unable to verify cold storage trash" >&2
  exit 1
fi

for path in ${paths.join(" ")}; do
  verify_missing_on_storage_box "$path"
done
echo ${COLD_DELETE_STORAGE_RECEIPT}
`;
}

export function buildRetentionArchiveTrashCommand(
  instanceId: string,
  archiveUri: string,
  compactTimestamp: string,
): string {
  if (!isColdArchiveUriForInstance(archiveUri, instanceId) || !/^[0-9]{8}T[0-9]{6}Z$/.test(compactTimestamp)) {
    throw new Error("Invalid cold archive trash identity");
  }

  const archiveDirectory = archiveUri.slice(0, archiveUri.lastIndexOf("/"));
  const archiveFileName = archiveUri.slice(archiveUri.lastIndexOf("/") + 1);
  const trashDirectory = `trash/${instanceId}-${compactTimestamp}`;
  return `${STORAGE_BOX_PRELUDE}
move_to_trash() {
  local source=$1 destination=$2 optional=$3 listing
  if listing=$(storage_box "ls -ld $source" 2>&1); then
    if listing=$(storage_box "ls -ld $destination" 2>&1) || ! missing_on_storage_box "$destination" "$listing"; then
      echo "Unable to verify the trash destination is empty" >&2
      return 1
    fi
    storage_box "mv $source $destination"
  elif missing_on_storage_box "$source" "$listing"; then
    if listing=$(storage_box "ls -ld $destination" 2>&1); then
      return 0
    fi
    if [[ "$optional" = yes ]] && missing_on_storage_box "$destination" "$listing"; then
      return 0
    fi
    echo "Unable to verify whether the archive was moved to trash" >&2
    return 1
  else
    echo "Unable to verify the cold storage source" >&2
    return 1
  fi
}
storage_box "mkdir -p ${trashDirectory}"
move_to_trash ${archiveDirectory} ${trashDirectory}/data no
move_to_trash meta/${instanceId} ${trashDirectory}/meta yes
verify_missing_on_storage_box ${archiveDirectory}
verify_missing_on_storage_box meta/${instanceId}
storage_box "ls -ld ${trashDirectory}/data" >/dev/null
# The receipt is what lets purge mark the row deleted and clear the archive
# pointer — so it must also prove the EXPECTED archive file came along inside
# the moved directory, not merely that a directory exists. A free/<id> that
# lost its archive (partial upload cleanup, manual deletion) still moved
# happily; without this check the row went to deleted while the data it named
# was never there.
storage_box "test -f ${trashDirectory}/data/${archiveFileName}"
echo ${COLD_RETENTION_TRASH_RECEIPT}
`;
}
