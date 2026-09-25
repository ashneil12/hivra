/**
 * Host-side VMID reference ledger shared by every control plane on a host.
 *
 * Several control planes (prod Hermes, Canary Hivra, ...) allocate VMIDs on
 * the same Proxmox hosts, and each one only reserves the VMIDs its OWN
 * database references. When a VM is destroyed out of band while its row keeps
 * the VMID, another plane sees a free slot and reuses it; the stale row's
 * lifecycle crons then act on a foreign VM (a shared host, 2026-09).
 *
 * A plane only gains a VMID reference by allocating one, so publishing its
 * complete DB reference set at allocation time (and recording the VMID it
 * picks) keeps every plane's published list a superset of what it references.
 * Every allocator then treats the other planes' lists as reserved. Stale extra
 * entries only over-reserve until that plane next allocates on the host.
 *
 * Files: /var/lib/hivra/vmid-references/<plane>.<lane>.list, one VMID per line.
 * The plane is the Supabase project ref, so canary and prod never collide; the
 * lane (hermes/hivra) keeps two allocators of one plane, which hold different
 * host locks, from overwriting each other's just-recorded VMID. A plane never
 * reads its own lists: its DB reference set is already the caller's reservation.
 */

export const VMID_REFERENCE_DIRECTORY = "/var/lib/hivra/vmid-references";

const PLANE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type VmidReferenceLedger = {
  /** This control plane's id, or null when it cannot be resolved (read-only). */
  plane: string | null;
  /** The allocator writing the list; each lane serializes on its own host lock. */
  lane: "hermes" | "hivra";
  /** The plane's complete DB reference set for the host, or null when the lookup failed (read-only). */
  references: readonly number[] | null;
};

type EnvLike = Record<string, string | undefined>;

export function resolveVmidReferencePlane(env: EnvLike = process.env): string | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim();
  if (!url) return null;
  try {
    const plane = new URL(url).hostname.split(".")[0]?.toLowerCase() ?? "";
    return PLANE_PATTERN.test(plane) ? plane : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell prelude defining two functions for an allocator to call while it holds
 * its allocation lock:
 *   hivra_vmid_reference_sync    publish this plane's list (only when the DB
 *                                lookup succeeded) and set HIVRA_FOREIGN_VMIDS
 *                                to every other plane's published VMIDs
 *   hivra_vmid_reference_record  append the VMID this allocation selected
 * Ledger I/O failures degrade to the previous inventory-only behaviour and are
 * reported on stderr; they never fail the allocation.
 */
export function buildVmidReferenceLedgerScript(ledger: VmidReferenceLedger | null | undefined): string {
  const plane = ledger?.plane && PLANE_PATTERN.test(ledger.plane) ? ledger.plane : "";
  const references = ledger?.references
    ? [...new Set(ledger.references.filter(vmid => Number.isSafeInteger(vmid) && vmid > 0))].sort((a, b) => a - b)
    : null;
  const lane = ledger?.lane === "hivra" ? "hivra" : "hermes";
  const publish = plane && references ? "1" : "0";
  return `HIVRA_VMID_REFERENCE_DIR=${shellQuote(VMID_REFERENCE_DIRECTORY)}
HIVRA_VMID_REFERENCE_PLANE=${shellQuote(plane)}
HIVRA_VMID_REFERENCE_LANE=${lane}
HIVRA_VMID_REFERENCE_PUBLISH=${publish}
HIVRA_VMID_REFERENCES=${shellQuote((references ?? []).join("\n"))}
HIVRA_FOREIGN_VMIDS=""
hivra_vmid_reference_sync() {
  local own="" tmp="" list name
  install -d -m 0755 "$HIVRA_VMID_REFERENCE_DIR" 2>/dev/null \\
    || { echo "vmid reference ledger unavailable on $(hostname)" >&2; return 0; }
  [ -n "$HIVRA_VMID_REFERENCE_PLANE" ] && own="$HIVRA_VMID_REFERENCE_DIR/$HIVRA_VMID_REFERENCE_PLANE.$HIVRA_VMID_REFERENCE_LANE.list"
  if [ "$HIVRA_VMID_REFERENCE_PUBLISH" = 1 ]; then
    if tmp="$(mktemp "$HIVRA_VMID_REFERENCE_DIR/.$HIVRA_VMID_REFERENCE_PLANE.XXXXXX")" \\
      && { [ -z "$HIVRA_VMID_REFERENCES" ] || printf '%s\\n' "$HIVRA_VMID_REFERENCES"; } > "$tmp" \\
      && chmod 0644 "$tmp" && mv -f "$tmp" "$own"; then
      :
    else
      [ -n "$tmp" ] && rm -f -- "$tmp"
      echo "could not publish vmid references for $HIVRA_VMID_REFERENCE_PLANE" >&2
    fi
  fi
  HIVRA_FOREIGN_VMIDS="$(for list in "$HIVRA_VMID_REFERENCE_DIR"/*.list; do
    [ -f "$list" ] || continue
    name="\${list##*/}"
    [ -n "$HIVRA_VMID_REFERENCE_PLANE" ] && [ "\${name#"$HIVRA_VMID_REFERENCE_PLANE".}" != "$name" ] && continue
    grep -E '^[0-9]+$' "$list" 2>/dev/null || true
  done | sort -un)"
}
hivra_vmid_reference_record() {
  [ "$HIVRA_VMID_REFERENCE_PUBLISH" = 1 ] || return 0
  printf '%s\\n' "$1" >> "$HIVRA_VMID_REFERENCE_DIR/$HIVRA_VMID_REFERENCE_PLANE.$HIVRA_VMID_REFERENCE_LANE.list" 2>/dev/null \\
    || echo "could not record vmid $1 for $HIVRA_VMID_REFERENCE_PLANE" >&2
}
`;
}
