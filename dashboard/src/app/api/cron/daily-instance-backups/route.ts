import { NextRequest } from "next/server";
import { createHmac } from "crypto";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { buildReconcileMirrorsScript } from "@/lib/services/restic-mirror-reconcile";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// The per-instance restic host script must finish (and be reaped) inside the
// Vercel function budget. maxDuration is 800s; Vercel SIGTERMs at that wall, so
// the host-script timeout must sit safely BELOW it or a long backup gets
// truncated mid-flight with no signal (previously this was 60*60*1000 = 1h,
// far above the 800s wall). Leave ~100s margin for the surrounding handler +
// response. Mirrors daily-vm-backups' HOST_BACKUP_TIMEOUT_MS.
const HOST_BACKUP_TIMEOUT_MS = 700_000;

const LOG_SOURCE = "cron:daily-instance-backups";
const ROUTE = "/api/cron/daily-instance-backups";
const SAFE_INSTANCE_ID = /^[0-9a-f-]{36}$/i;
const SAFE_TIER = /^[a-z0-9_:-]+$/i;
const SAFE_HOST = /^[a-z0-9_-]+$/i;

// The per-host mirror reconcile (below) only lists dirs + rm's stale ones, so it
// finishes in seconds. Keep it well under the backup budget — it must never eat
// into a lane's time or block the actual backups.
const RECONCILE_TIMEOUT_MS = 120_000;

// Paid tiers eligible for per-instance granular backups (the reassurance feature).
const DEFAULT_TIERS = [
  "operator",
  "fleet",
  "command",
  "ws_cloud_pro",
  "ws_cloud_power",
  "credit_pro",
  "credit_power",
];

// backup-vm-restic.sh, base64-encoded. Shipped to and executed on the PVE host.
const RESTIC_BACKUP_SCRIPT_B64 = "IyEvdXNyL2Jpbi9lbnYgYmFzaAojIGJhY2t1cC12bS1yZXN0aWMuc2gg4oCUIGdyYW51bGFyIHBlci1pbnN0YW5jZSBkYXRhIGJhY2t1cCBmb3IgSGVybWVzT1MgdGVuYW50cy4KIwojIFJ1biBmcm9tIGEgUFZFIGhvc3QuIEFyZ3M6IDx2bWlkPiA8aW5zdGFuY2UtaWQ+IDx0aWVyPiBbZ3Vlc3QtaXBdIFstLWFwcGx5XQojCiMgVW5saWtlIGJhY2t1cC12bS1kYWlseS5zaCAod2hvbGUtVk0gdnpkdW1wKSwgdGhpcyBiYWNrcyB1cCBvbmx5IHRoZSB0ZW5hbnQncwojICpkYXRhKiB2b2x1bWVzIHdpdGggZmlsZS1sZXZlbCBncmFudWxhcml0eSwgc28gYSBzaW5nbGUgY2hhdC9maWxlIGlzIHJlc3RvcmFibGU6CiMgICAtIHdlYnVpLXN0YXRlICAgICAoL2hvbWUvaGVybWVzLy5oZXJtZXMpICBtaW51cyByZWdlbmVyYWJsZSBjYWNoZXMKIyAgIC0gd2VidWktd29ya3NwYWNlICgvd29ya3NwYWNlKQojIEl0IGRvZXMgTk9UIHNuYXBzaG90IHRoZSB3aG9sZSBkaXNrLCBzbyBpdCBuZWVkcyBubyBob3N0IFJBTSBoZWFkcm9vbSBhbmQgaXMKIyBpbW11bmUgdG8gdGhlIGxpdmUtdnpkdW1wIE9PTS9wcmVmbGlnaHQgZnJhZ2lsaXR5LgojCiMgRmxvdzogdGhlIGhvc3QgcmVhZHMgdGhlIGd1ZXN0J3MgRG9ja2VyIHZvbHVtZXMgdmlhIGBzdWRvIHJzeW5jYCBpbnRvIGEgcGVyLWluc3RhbmNlCiMgbWlycm9yLCB0aGVuIGByZXN0aWNgIGRlZHVwcytlbmNyeXB0cyB0aGUgbWlycm9yIHRvIHRoZSBIZXR6bmVyIFN0b3JhZ2UgQm94LgojIFRoZSBTdG9yYWdlIEJveCBTU0gga2V5IGxpdmVzIE9OTFkgb24gdGhlIFBWRSBob3N0IChpbnN0YWxsZWQgYnkgdGhlIGNhbGxlcikgYW5kIGlzCiMgbmV2ZXIgcGxhY2VkIG9uIGEgZ3Vlc3QgVk0g4oCUIHRlbmFudCBpc29sYXRpb24gaXMgcHJlc2VydmVkLgojCiMgcmVzdGljIHJlcG86IHNmdHA6Y29sZDpyZXN0aWMvPGluc3RhbmNlLWlkPiAgKG9uZSByZXBvIHBlciBpbnN0YW5jZSkKIyBSRVNUSUNfUEFTU1dPUkQgbXVzdCBiZSBwcm92aWRlZCBpbiB0aGUgZW52aXJvbm1lbnQgYnkgdGhlIGNhbGxlciAodGhlIGNyb24gcm91dGUKIyBkZXJpdmVzIGl0IHBlci1pbnN0YW5jZTogSE1BQyhIRVJNRVNfUkVTVElDX01BU1RFUl9LRVksIGluc3RhbmNlX2lkKSkuCiMKIyBEZWZhdWx0IGlzIGRyeS1ydW4uIFBhc3MgLS1hcHBseSB0byBleGVjdXRlLgoKc2V0IC1ldW8gcGlwZWZhaWwKClZNSUQ9IiR7MTotfSIKSU5TVEFOQ0VfSUQ9IiR7MjotfSIKVElFUj0iJHszOi19IgoKR1VFU1RfSVA9IiIKTU9ERT0iLS1kcnktcnVuIgpzaGlmdCAzIDI+L2Rldi9udWxsIHx8IHRydWUKZm9yIGEgaW4gIiRAIjsgZG8KICBjYXNlICIkYSIgaW4KICAgIC0tYXBwbHkpIE1PREU9Ii0tYXBwbHkiIDs7CiAgICAtLWRyeS1ydW4pIE1PREU9Ii0tZHJ5LXJ1biIgOzsKICAgICIiKSA7OwogICAgKikgR1VFU1RfSVA9IiRhIiA7OwogIGVzYWMKZG9uZQoKaWYgWyAteiAiJFZNSUQiIF0gfHwgWyAteiAiJElOU1RBTkNFX0lEIiBdIHx8IFsgLXogIiRUSUVSIiBdOyB0aGVuCiAgZWNobyAidXNhZ2U6ICQwIDx2bWlkPiA8aW5zdGFuY2UtaWQ+IDx0aWVyPiBbZ3Vlc3QtaXBdIFstLWFwcGx5XSIgPiYyCiAgZXhpdCAxCmZpCgojIEtlZXAgYSB1bml2ZXJzYWwgcmVzdG9yZSBzYWZldHkgbmV0LCBpbmNsdWRpbmcgdGhlIGJhc2UgY3JlZGl0IHRpZXIuIFVua25vd24KIyB0aWVycyBhcmUgc3RpbGwgcmVmdXNlZCBzbyBhIGNhbGxlciB0eXBvIGNhbm5vdCBzaWxlbnRseSBzZWxlY3QgYSBwb2xpY3kuCmNhc2UgIiRUSUVSIiBpbgogIG9wZXJhdG9yfGZsZWV0fGNvbW1hbmR8d3NfY2xvdWRfcHJvfHdzX2Nsb3VkX3Bvd2VyfGNyZWRpdF9iYXNlfGNyZWRpdF9wcm98Y3JlZGl0X3Bvd2VyfHBhaWR8cHJvfHBvd2VyKSA6IDs7CiAgKikgZWNobyAicmVmdXNpbmcgcmVzdGljIGJhY2t1cCBmb3IgdW5zdXBwb3J0ZWQgdGllcjogJFRJRVIiID4mMjsgZXhpdCAyIDs7CmVzYWMKCiMgRGVmZW5zZS1pbi1kZXB0aDogdmFsaWRhdGUgaW5zdGFuY2UgaWQgc2hhcGUgKHRoZSBjYWxsZXIgYWxzbyB2YWxpZGF0ZXMpLgppZiAhIFtbICIkSU5TVEFOQ0VfSUQiID1+IF5bMC05YS1mLV17MzZ9JCBdXTsgdGhlbgogIGVjaG8gInVuc2FmZSBpbnN0YW5jZSBpZDogJElOU1RBTkNFX0lEIiA+JjI7IGV4aXQgMQpmaQoKVk1fU1NIX0tFWT0iJHtIRVJNRVNfVk1fT1JDSEVTVFJBVE9SX0tFWTotL2V0Yy9oaXZyYS9rZXlzL3ZtLW9yY2hlc3RyYXRvcn0iCk1JUlJPUl9ST09UPSIke0hFUk1FU19SRVNUSUNfTUlSUk9SX1JPT1Q6LS92YXIvbGliL2hlcm1lcy1yZXN0aWMtc3JjfSIKU1JDPSIkTUlSUk9SX1JPT1QvJElOU1RBTkNFX0lEIgpSRVBPPSIke0hFUk1FU19SRVNUSUNfUkVQT19PVkVSUklERTotc2Z0cDpjb2xkOnJlc3RpYy8kSU5TVEFOQ0VfSUR9IgpleHBvcnQgUkVTVElDX0NBQ0hFX0RJUj0iJHtSRVNUSUNfQ0FDSEVfRElSOi0vdmFyL2xpYi9oZXJtZXMtcmVzdGljLWNhY2hlfSIKS0VFUF9EQUlMWT0iJHtIRVJNRVNfUkVTVElDX0tFRVBfREFJTFk6LTd9IgpLRUVQX1dFRUtMWT0iJHtIRVJNRVNfUkVTVElDX0tFRVBfV0VFS0xZOi00fSIKS0VFUF9NT05USExZPSIke0hFUk1FU19SRVNUSUNfS0VFUF9NT05USExZOi0zfSIKCiMgQ2FjaGUgLyByZWdlbmVyYWJsZSBkaXJzIGV4Y2x1ZGVkIGZyb20gd2VidWktc3RhdGUgKHJlbGF0aXZlIHRvIHRoZSB2b2x1bWUgcm9vdCkuCiMgS2VlcCBjaGF0cy9zZXNzaW9ucy9qb3VybmFscy9wcm9maWxlcy9jb25maWcvYWdlbnQtbWVtb3J5OyBkcm9wIG1vZGVsICsgcGtnIGNhY2hlcy4KV0VCVUlfU1RBVEVfRVhDTFVERVM9KAogICJob21lLy5jYWNoZSIgImhvbWUvLm5wbSIgImhvbWUvLmxvY2FsL3NoYXJlL3V2IiAiaG9tZS8ubG9jYWwvc2hhcmUvcG5wbSIKICAiKiovbm9kZV9tb2R1bGVzIiAiKiovX19weWNhY2hlX18iICIqKi8udmVudiIgIioqLyoudG1wIgopCldPUktTUEFDRV9FWENMVURFUz0oCiAgIioqL25vZGVfbW9kdWxlcyIgIioqLy52ZW52IiAiKiovX19weWNhY2hlX18iICIqKi8uZ2l0L29iamVjdHMiCiAgIioqL3RhcmdldC9kZWJ1ZyIgIioqL3RhcmdldC9yZWxlYXNlIgopCgojIFNTSCBvcHRpb25zIGFzIGEgcGxhaW4gd2hpdGVzcGFjZS1kZWxpbWl0ZWQgc3RyaW5nIChubyB2YWx1ZSBjb250YWlucyBhIHNwYWNlKSwKIyBzYWZlIGZvciBib3RoIHJzeW5jIC1lIGFuZCBkaXJlY3Qgc3NoIGludm9jYXRpb24uClNTSF9PUFRTPSItaSAkVk1fU1NIX0tFWSAtbyBCYXRjaE1vZGU9eWVzIC1vIFN0cmljdEhvc3RLZXlDaGVja2luZz1ubyAtbyBVc2VyS25vd25Ib3N0c0ZpbGU9L2Rldi9udWxsIC1vIENvbm5lY3RUaW1lb3V0PTE1IC1vIFNlcnZlckFsaXZlSW50ZXJ2YWw9MTUgLW8gU2VydmVyQWxpdmVDb3VudE1heD00IgoKIyBEZXJpdmUgdGhlIGd1ZXN0IElQIGZyb20gdGhlIGhvc3QncyBhdXRob3JpdGF0aXZlIHFtIGNvbmZpZyBpZiBub3Qgc3VwcGxpZWQuCmlmIFsgLXogIiRHVUVTVF9JUCIgXTsgdGhlbgogIEdVRVNUX0lQPSIkKHFtIGNvbmZpZyAiJFZNSUQiIDI+L2Rldi9udWxsIHwgc2VkIC1uICdzI15pcGNvbmZpZzA6LipbXjAtOV1pcD1cKFswLTldWzAtOS5dXHs2LFx9XCkuKiNcMSNwJyB8IGhlYWQgLTEpIgpmaQppZiBbIC16ICIkR1VFU1RfSVAiIF07IHRoZW4KICBlY2hvICJSRUZVU0lOR19CQUNLVVBfTk9fR1VFU1RfSVAgdm1pZD0kVk1JRCBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMjsgZXhpdCAzCmZpCgpXRUJVSV9TVEFURV9WT0w9Ii92YXIvbGliL2RvY2tlci92b2x1bWVzL2FnZW50LSR7SU5TVEFOQ0VfSUR9X3dlYnVpLXN0YXRlL19kYXRhIgpXT1JLU1BBQ0VfVk9MPSIvdmFyL2xpYi9kb2NrZXIvdm9sdW1lcy9hZ2VudC0ke0lOU1RBTkNFX0lEfV93ZWJ1aS13b3Jrc3BhY2UvX2RhdGEiCgplY2hvICJSRVNUSUNfQkFDS1VQX0JFR0lOIHZtaWQ9JFZNSUQgaW5zdGFuY2U9JElOU1RBTkNFX0lEIHRpZXI9JFRJRVIgZ3Vlc3RfaXA9JEdVRVNUX0lQIHJlcG89JFJFUE8gbW9kZT0kTU9ERSBob3N0PSQoaG9zdG5hbWUpIgoKaWYgWyAiJE1PREUiICE9ICItLWFwcGx5IiBdOyB0aGVuCiAgZWNobyAiRFJZX1JVTiB3b3VsZCByc3luYyAkV0VCVUlfU1RBVEVfVk9MICsgJFdPUktTUEFDRV9WT0wgZnJvbSAkR1VFU1RfSVAgaW50byAkU1JDLCB0aGVuIHJlc3RpYyBiYWNrdXAgLT4gJFJFUE8iCiAgZWNobyAiRFJZX1JVTiByZXRlbnRpb246IC0ta2VlcC1kYWlseSAkS0VFUF9EQUlMWSAtLWtlZXAtd2Vla2x5ICRLRUVQX1dFRUtMWSAtLWtlZXAtbW9udGhseSAkS0VFUF9NT05USExZIgogIGV4aXQgMApmaQoKIyBBIG1pcnJvciBpcyB0ZW1wb3Jhcnkgc3RhZ2luZyBvbiB0aGUgUFZFIHJvb3QgZGlzay4gUmVmdXNlIHRvIGJlZ2luIGEgbmV3CiMgc3RhZ2luZyBjb3B5IHdoZW4gdGhlIGhvc3QgaXMgYWxyZWFkeSBzaG9ydCBvbiBzcGFjZTsgYSBzdWNjZXNzZnVsIHNuYXBzaG90CiMgcmVtb3ZlcyBpdHMgbWlycm9yIGJlbG93Lgpta2RpciAtcCAiJE1JUlJPUl9ST09UIgpNSU5fSE9TVF9ESVNLX01CPSIke0hFUk1FU19SRVNUSUNfTUlOX0RJU0tfRkxPT1JfTUI6LTgwMDB9IgpBVkFJTF9NQj0iJChkZiAtQk0gLS1vdXRwdXQ9YXZhaWwgIiRNSVJST1JfUk9PVCIgMj4vZGV2L251bGwgfCB0YWlsIC0xIHwgdHIgLWRjICcwLTknKSIKaWYgWyAtbiAiJEFWQUlMX01CIiBdICYmIFsgIiRBVkFJTF9NQiIgLWx0ICIkTUlOX0hPU1RfRElTS19NQiIgXTsgdGhlbgogIGVjaG8gIlJFRlVTSU5HX0JBQ0tVUF9MT1dfSE9TVF9ESVNLIGF2YWlsX21iPSRBVkFJTF9NQiBmbG9vcl9tYj0kTUlOX0hPU1RfRElTS19NQiByb290PSRNSVJST1JfUk9PVCB2bWlkPSRWTUlEIGluc3RhbmNlPSRJTlNUQU5DRV9JRCBob3N0PSQoaG9zdG5hbWUpIiA+JjIKICBleGl0IDkKZmkKCmlmIFsgLXogIiR7UkVTVElDX1BBU1NXT1JEOi19IiBdOyB0aGVuCiAgZWNobyAiUkVGVVNJTkdfQkFDS1VQX05PX1JFU1RJQ19QQVNTV09SRCB2bWlkPSRWTUlEIGluc3RhbmNlPSRJTlNUQU5DRV9JRCIgPiYyOyBleGl0IDQKZmkKaWYgISBjb21tYW5kIC12IHJlc3RpYyA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBlY2hvICJyZXN0aWMgbm90IGluc3RhbGxlZDsgYXR0ZW1wdGluZyBhcHQtZ2V0IGluc3RhbGwiID4mMgogIERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZSBhcHQtZ2V0IGluc3RhbGwgLXkgcmVzdGljID4vZGV2L251bGwgMj4mMSB8fCB7IGVjaG8gIlJFU1RJQ19JTlNUQUxMX0ZBSUxFRCIgPiYyOyBleGl0IDU7IH0KZmkKCiMgU2VyaWFsaXplIHBlci1pbnN0YW5jZSBydW5zIG9uIHRoaXMgaG9zdC4KTE9DSz0iL3Zhci9sb2NrL2hlcm1lcy1yZXN0aWMtJElOU1RBTkNFX0lELmxvY2siCmV4ZWMgOT4iJExPQ0siCmlmICEgZmxvY2sgLW4gOTsgdGhlbgogIGVjaG8gIkFMUkVBRFlfUlVOTklORyBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMjsgZXhpdCAwCmZpCgpta2RpciAtcCAiJFNSQy93ZWJ1aS1zdGF0ZSIgIiRTUkMvd2VidWktd29ya3NwYWNlIiAiJFJFU1RJQ19DQUNIRV9ESVIiCgojIC0tLSByc3luYyB0aGUgZ3Vlc3Qgdm9sdW1lcyBpbnRvIHRoZSBob3N0IG1pcnJvci4gYHN1ZG8gcnN5bmNgIG9uIHRoZSBndWVzdCByZWFkcwojICAgICByb290LW93bmVkIERvY2tlciB2b2x1bWUgZGF0YTsgcmV0cnkgdG8gcmlkZSBvdXQgdHJhbnNpZW50IGd1ZXN0IHJlYm9vdHMgLyBuZXQgYmxpcHMuIC0tLQpyc3luY19wdWxsKCkgewogIGxvY2FsIHJlbW90ZT0iJDEiIGRlc3Q9IiQyIjsgc2hpZnQgMgogIGxvY2FsIGV4Y2x1ZGVzPSgiJEAiKQogIGxvY2FsIGFyZ3M9KC1hIC0tZGVsZXRlIC0tcGFydGlhbCAtLXRpbWVvdXQ9MTgwIC0tcnN5bmMtcGF0aD0ic3VkbyByc3luYyIgLWUgInNzaCAkU1NIX09QVFMiKQogIGxvY2FsIGU7IGZvciBlIGluICIke2V4Y2x1ZGVzW0BdfSI7IGRvIGFyZ3MrPSgtLWV4Y2x1ZGUgIiRlIik7IGRvbmUKICBsb2NhbCBhdHRlbXB0CiAgZm9yIGF0dGVtcHQgaW4gMSAyIDM7IGRvCiAgICBpZiBpb25pY2UgLWMyIC1uNyBuaWNlIC1uMTAgcnN5bmMgIiR7YXJnc1tAXX0iICJoZXJtZXNAJEdVRVNUX0lQOiRyZW1vdGUvIiAiJGRlc3QvIjsgdGhlbgogICAgICBlY2hvICJSU1lOQ19PSyBzcmM9JHJlbW90ZSBhdHRlbXB0PSRhdHRlbXB0IgogICAgICByZXR1cm4gMAogICAgZmkKICAgIGVjaG8gIlJTWU5DX1JFVFJZIHNyYz0kcmVtb3RlIGF0dGVtcHQ9JGF0dGVtcHQiID4mMgogICAgc2xlZXAgJCgoYXR0ZW1wdCAqIDEwKSkKICBkb25lCiAgZWNobyAiUlNZTkNfRkFJTEVEIHNyYz0kcmVtb3RlIiA+JjIKICByZXR1cm4gMQp9CgojIHdlYnVpLXN0YXRlIGlzIHJlcXVpcmVkOyB3b3Jrc3BhY2UgaXMgYmVzdC1lZmZvcnQgKGxhcmdlLCBhbmQgbWF5IGJlIGh1Z2UvYWJzZW50KS4KcnN5bmNfcHVsbCAiJFdFQlVJX1NUQVRFX1ZPTCIgIiRTUkMvd2VidWktc3RhdGUiICIke1dFQlVJX1NUQVRFX0VYQ0xVREVTW0BdfSIgXAogIHx8IHsgZWNobyAiUkVTVElDX0JBQ0tVUF9BQk9SVCByZWFzb249d2VidWlfc3RhdGVfcnN5bmNfZmFpbGVkIiA+JjI7IGV4aXQgNjsgfQpXT1JLU1BBQ0VfT0s9MQppZiBzc2ggJFNTSF9PUFRTICJoZXJtZXNAJEdVRVNUX0lQIiAic3VkbyB0ZXN0IC1kICRXT1JLU1BBQ0VfVk9MIiAyPi9kZXYvbnVsbDsgdGhlbgogIHJzeW5jX3B1bGwgIiRXT1JLU1BBQ0VfVk9MIiAiJFNSQy93ZWJ1aS13b3Jrc3BhY2UiICIke1dPUktTUEFDRV9FWENMVURFU1tAXX0iIHx8IFdPUktTUEFDRV9PSz0wCmVsc2UKICBlY2hvICJXT1JLU1BBQ0VfQUJTRU5UIHZvbD0kV09SS1NQQUNFX1ZPTCIKZmkKCiMgLS0tIHJlc3RpYzogaW5pdC1pZi1uZWVkZWQsIGNsZWFyIHN0YWxlIGxvY2tzLCBzbmFwc2hvdCwgcHJ1bmUgLS0tCmlmICEgcmVzdGljIC1yICIkUkVQTyIgY2F0IGNvbmZpZyA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBlY2hvICJSRVNUSUNfSU5JVCByZXBvPSRSRVBPIgogIHJlc3RpYyAtciAiJFJFUE8iIGluaXQgPi9kZXYvbnVsbCAyPiYxIHx8IHsgZWNobyAiUkVTVElDX0lOSVRfRkFJTEVEIHJlcG89JFJFUE8iID4mMjsgZXhpdCA3OyB9CmZpCnJlc3RpYyAtciAiJFJFUE8iIHVubG9jayA+L2Rldi9udWxsIDI+JjEgfHwgdHJ1ZQoKQkFDS1VQX1RTPSIkKGRhdGUgLXUgKyVZLSVtLSVkVCVIOiVNOiVTWikiCnNldCArZQpCQUNLVVBfT1VUPSIkKGlvbmljZSAtYzIgLW43IG5pY2UgLW4xMCByZXN0aWMgLXIgIiRSRVBPIiBiYWNrdXAgXAogIC0tdGFnIGhlcm1lcy1kYWlseSAtLXRhZyAiaW5zdGFuY2U6JElOU1RBTkNFX0lEIiBcCiAgLS1ob3N0ICIkSU5TVEFOQ0VfSUQiIFwKICAiJFNSQy93ZWJ1aS1zdGF0ZSIgIiRTUkMvd2VidWktd29ya3NwYWNlIiAyPiYxKSIKQkFDS1VQX1JDPSQ/CnNldCAtZQplY2hvICIkQkFDS1VQX09VVCIgfCB0YWlsIC0xMgppZiBbICIkQkFDS1VQX1JDIiAtbmUgMCBdOyB0aGVuCiAgZWNobyAiUkVTVElDX0JBQ0tVUF9GQUlMRUQgcmM9JEJBQ0tVUF9SQyBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMgogIGV4aXQgOApmaQoKU05BUF9JRD0iJChyZXN0aWMgLXIgIiRSRVBPIiBzbmFwc2hvdHMgLS1qc29uIC0tbGF0ZXN0IDEgMj4vZGV2L251bGwgfCBzZWQgLW4gJ3MvLioic2hvcnRfaWQiOiJcKFswLTlhLWZdKlwpIi4qL1wxL3AnIHwgdGFpbCAtMSkiCmlmIFsgLXogIiRTTkFQX0lEIiBdOyB0aGVuCiAgZWNobyAiUkVTVElDX1NOQVBTSE9UX1ZFUklGWV9GQUlMRUQgaW5zdGFuY2U9JElOU1RBTkNFX0lEOyBwcmVzZXJ2aW5nIG1pcnJvcj0kU1JDIiA+JjIKICBleGl0IDgKZmkKCiMgUmV0ZW50aW9uOiBwcnVuZSBvbGQgcmVzdG9yZSBwb2ludHMgKGNoZWFwIHRoYW5rcyB0byBkZWR1cCkuCnJlc3RpYyAtciAiJFJFUE8iIGZvcmdldCBcCiAgLS1rZWVwLWRhaWx5ICIkS0VFUF9EQUlMWSIgLS1rZWVwLXdlZWtseSAiJEtFRVBfV0VFS0xZIiAtLWtlZXAtbW9udGhseSAiJEtFRVBfTU9OVEhMWSIgXAogIC0tcHJ1bmUgPi9kZXYvbnVsbCAyPiYxIHx8IGVjaG8gIlJFU1RJQ19GT1JHRVRfV0FSTiBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMgoKZWNobyAiUkVTVElDX0JBQ0tVUF9PSyBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQgc25hcHNob3Q9JHtTTkFQX0lEOi11bmtub3dufSB0cz0kQkFDS1VQX1RTIHdvcmtzcGFjZV9vaz0kV09SS1NQQUNFX09LIHJlcG89JFJFUE8gaG9zdD0kKGhvc3RuYW1lKSIKCiMgVGhlIG9mZi1ob3N0IHNuYXBzaG90IGlzIG5vdyBhdXRob3JpdGF0aXZlLiBLZWVwaW5nIGEgZnVsbCBjb3B5IGZvciBldmVyeQojIHRlbmFudCBvbiB0aGUgUFZFIHJvb3QgZGlzayBncm93cyB3aXRob3V0IGJvdW5kIGFuZCBldmVudHVhbGx5IGJsb2NrcyBldmVyeQojIGJhY2t1cCBvbiB0aGF0IGhvc3QuIFJlbW92ZSBvbmx5IHRoZSBleGFjdCwgVVVJRC12YWxpZGF0ZWQgc3RhZ2luZyBwYXRoIGFmdGVyCiMgc25hcHNob3QgdmVyaWZpY2F0aW9uOyBhIGZhaWxlZCBiYWNrdXAgZGVsaWJlcmF0ZWx5IHByZXNlcnZlcyBpdCBmb3IgZGlhZ25vc2lzLgpjYXNlICIkU1JDIiBpbgogICIkTUlSUk9SX1JPT1QiLyIkSU5TVEFOQ0VfSUQiKQogICAgTUlSUk9SX0tCPSIkKGR1IC1zayAiJFNSQyIgMj4vZGV2L251bGwgfCBjdXQgLWYxKSI7IE1JUlJPUl9LQj0iJHtNSVJST1JfS0I6LTB9IgogICAgaWYgcm0gLXJmIC0tICIkU1JDIjsgdGhlbgogICAgICBlY2hvICJSRVNUSUNfTUlSUk9SX0NMRUFOVVBfT0sgaW5zdGFuY2U9JElOU1RBTkNFX0lEIGZyZWVkX21iPSQoKE1JUlJPUl9LQiAvIDEwMjQpKSIKICAgIGVsc2UKICAgICAgZWNobyAiUkVTVElDX01JUlJPUl9DTEVBTlVQX0ZBSUxFRCBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQgbWlycm9yPSRTUkMiID4mMgogICAgZmkKICAgIDs7CiAgKikKICAgIGVjaG8gIlJFU1RJQ19NSVJST1JfQ0xFQU5VUF9SRUZVU0VEIHVuc2FmZV9taXJyb3JfcGF0aD0kU1JDIGluc3RhbmNlPSRJTlNUQU5DRV9JRCIgPiYyCiAgICA7Owplc2FjCg==";

type BackupCandidate = {
  id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  status: string | null;
  ipv4_address?: string | null;
  last_instance_backup_at?: string | null;
};

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function redactHostOutput(value: string, max = 8000): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .slice(0, max);
}

// Per-instance restic repository password, derived deterministically so it never
// has to be stored per-instance. A Storage Box compromise without this master key
// cannot decrypt any repo; each instance's repo has a distinct key.
function deriveResticPassword(instanceId: string): string {
  const master = process.env.HERMES_RESTIC_MASTER_KEY?.trim();
  if (!master) throw new Error("HERMES_RESTIC_MASTER_KEY not configured");
  return createHmac("sha256", master).update(instanceId).digest("hex");
}

function buildColdStorageInstallScript(): string {
  const storageKeyB64 = process.env.HETZNER_SSH_PRIVATE_KEY_B64?.trim() ?? "";
  if (!storageKeyB64) {
    return `echo "HETZNER_SSH_PRIVATE_KEY_B64 missing; cold storage alias unavailable" >&2; exit 20`;
  }
  return `install -d -m 700 /root/.ssh
base64 -d > /etc/hivra/keys/cold-storage <<'HERMES_COLD_STORAGE_KEY'
${storageKeyB64}
HERMES_COLD_STORAGE_KEY
chmod 600 /etc/hivra/keys/cold-storage
touch /root/.ssh/config
chmod 600 /root/.ssh/config
sed -i '/# BEGIN HERMES COLD STORAGE/,/# END HERMES COLD STORAGE/d' /root/.ssh/config 2>/dev/null || true
cat >> /root/.ssh/config <<'HERMES_COLD_STORAGE_SSH_CONFIG'
# BEGIN HERMES COLD STORAGE
Host cold hermes-cold-storage
  HostName u594993.your-storagebox.de
  User u594993
  Port 23
  IdentityFile /etc/hivra/keys/cold-storage
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
# END HERMES COLD STORAGE
HERMES_COLD_STORAGE_SSH_CONFIG`;
}

function buildInstallResticScript(): string {
  return `install -d -m 755 /usr/local/sbin
${buildColdStorageInstallScript()}
base64 -d > /usr/local/sbin/backup-vm-restic.sh <<'HERMES_RESTIC_BACKUP_SCRIPT'
${RESTIC_BACKUP_SCRIPT_B64}
HERMES_RESTIC_BACKUP_SCRIPT
chmod 755 /usr/local/sbin/backup-vm-restic.sh
command -v restic >/dev/null 2>&1 || (DEBIAN_FRONTEND=noninteractive apt-get install -y restic >/dev/null 2>&1 || true)`;
}

function buildRunScript(row: BackupCandidate, password: string, apply: boolean): string {
  const args = [
    String(row.proxmox_vmid),
    shellQuote(row.id),
    shellQuote(row.resource_tier!),
    apply ? "--apply" : "--dry-run",
  ].join(" ");
  return `set -euo pipefail
${buildInstallResticScript()}
export RESTIC_PASSWORD=${shellQuote(password)}
/usr/local/sbin/backup-vm-restic.sh ${args}
`;
}

function validateCandidate(row: BackupCandidate): string | null {
  if (!SAFE_INSTANCE_ID.test(row.id)) return "unsafe_instance_id";
  if (!row.proxmox_node) return "missing_proxmox_node";
  if (!row.proxmox_vmid || row.proxmox_vmid <= 0) return "missing_proxmox_vmid";
  if (!row.resource_tier || !SAFE_TIER.test(row.resource_tier)) return "unsafe_resource_tier";
  return null;
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);
  if (!process.env.HERMES_RESTIC_MASTER_KEY?.trim()) {
    return apiError("HERMES_RESTIC_MASTER_KEY not configured", 500);
  }

  const enabled = envBool("DAILY_INSTANCE_BACKUPS_ENABLED", false);
  const batchSize = Math.max(1, Math.min(50, envInt("DAILY_INSTANCE_BACKUPS_BATCH_SIZE", 10)));
  const tiers = envList("DAILY_INSTANCE_BACKUPS_TIERS", DEFAULT_TIERS);
  // Rows are "due" if never backed up (NULL cursor) or backed up before this
  // cutoff. ~20h (not 24h) gives slack so a daily run never skips a row just
  // because yesterday's run finished a few hours late.
  const dueAfterHours = Math.max(1, envInt("DAILY_INSTANCE_BACKUPS_DUE_AFTER_HOURS", 20));
  const cutoffIso = new Date(Date.now() - dueAfterHours * 60 * 60 * 1000).toISOString();

  // Converge the whole paid fleet: order by the rotation cursor ascending with
  // NULLS FIRST (never-backed-up rows go first), and filter to rows that are due
  // (cursor NULL or older than the cutoff). On success we stamp
  // last_instance_backup_at = now(), so each run advances to the next-oldest
  // cohort instead of re-rolling the oldest N forever. Mirrors the fleet-sync
  // last_synced_at convergence fix on redeploy-webui-instances.
  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, proxmox_node, proxmox_vmid, resource_tier, lifecycle_state, status, ipv4_address, last_instance_backup_at")
    .eq("lifecycle_state", "active")
    .eq("status", "running")
    .is("deleted_at", null)
    .not("proxmox_node", "is", null)
    .not("proxmox_vmid", "is", null)
    .in("resource_tier", tiers)
    .or(`last_instance_backup_at.is.null,last_instance_backup_at.lt.${cutoffIso}`)
    .order("last_instance_backup_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(batchSize);

  if (error) {
    log.error("daily instance backup candidate query failed", error, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "daily_instance_backup_candidates_query_failed",
    });
    return apiError(`candidate query failed: ${error.message}`, 500);
  }

  const candidates = ((data ?? []) as BackupCandidate[]).filter((row) => {
    const reason = validateCandidate(row);
    if (reason) {
      log.warn("skipping invalid daily instance backup candidate", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: reason,
        instanceId: row.id,
      });
      return false;
    }
    return true;
  });

  const manualAction = req.nextUrl.searchParams.get("action")?.trim() ?? "";

  // Advance the rotation cursor for a *processed* row. The cursor
  // (last_instance_backup_at) is the fleet-convergence rotation key, ordered
  // NULLS-FIRST/oldest-first. Previously it was stamped ONLY on success, so a
  // perpetually-slow/failing instance (e.g. first-time restic init of a huge
  // workspace) never advanced, stayed at the front of the queue, and was
  // re-picked first EVERY run — permanently starving the rest of the paid fleet
  // and defeating the convergence design. We now advance the cursor on every
  // processed row (success OR failure) so a stuck row rotates to the back rather
  // than blocking the fleet; the honest "this backup failed" signal lives in the
  // per-instance results + the ops-event below, not in this rotation cursor.
  // Best-effort: a stamp failure must not fail the run, but it would make the
  // next run re-pick this row, so log it for visibility.
  async function stampBackupCursor(instanceId: string): Promise<void> {
    try {
      const { error: stampError } = await supabaseAdmin!
        .from("hermes_instances")
        .update({ last_instance_backup_at: new Date().toISOString() })
        .eq("id", instanceId);
      if (stampError) {
        log.warn("failed to stamp daily instance backup cursor", {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "daily_instance_backup_cursor_stamp_failed",
          instanceId,
          message: stampError.message,
        });
      }
    } catch (err) {
      log.warn("failed to stamp daily instance backup cursor", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "daily_instance_backup_cursor_stamp_threw",
        instanceId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orphan-mirror space reclaimed this run (for the response + logs). Best-effort
  // throughout: a reconcile failure must NEVER block or fail the actual backups.
  let reconciledRemoved = 0;
  let reconciledFreedMb = 0;

  // Reclaim per-instance rsync mirrors on `host` for instances that are no longer
  // live there (deleted, or migrated to another host). Runs at the top of a host
  // lane, before its backups, so it self-heals host-root disk pressure and gives
  // the disk-headroom guard room again. See buildReconcileMirrorsScript.
  async function reconcileHostMirrors(host: string): Promise<void> {
    if (!SAFE_HOST.test(host)) return;
    try {
      const hostEnv = resolveProxmoxHostEnv(
        { hostId: null, hostSlug: host, envPrefix: null, failClosed: true },
        process.env
      );
      // Keep mirrors for instances still on THIS host, plus node-ambiguous rows
      // (proxmox_node NULL — mid-provision/migration) which must never be trimmed.
      const { data, error } = await supabaseAdmin!
        .from("hermes_instances")
        .select("id")
        .is("deleted_at", null)
        .or(`proxmox_node.eq.${host},proxmox_node.is.null`);
      if (error || !Array.isArray(data)) return;
      const keepIds = (data as Array<{ id: string }>)
        .map((r) => r.id)
        .filter((id) => typeof id === "string" && SAFE_INSTANCE_ID.test(id));
      // Never hand the host an empty keep-set (it would trim every mirror). A host
      // we're backing up always has ≥1 live instance, so 0 means a query hiccup.
      if (keepIds.length === 0) return;
      const result = await runProxmoxHostScript(
        buildReconcileMirrorsScript(keepIds),
        hostEnv,
        { timeoutMs: RECONCILE_TIMEOUT_MS }
      );
      const done = /RECONCILE_DONE\s+host=\S+\s+removed=(\d+)\s+freed_mb=(\d+)/.exec(
        result.stdout ?? ""
      );
      if (done) {
        const removed = Number.parseInt(done[1], 10) || 0;
        const freedMb = Number.parseInt(done[2], 10) || 0;
        reconciledRemoved += removed;
        reconciledFreedMb += freedMb;
        if (removed > 0) {
          log.warn("reclaimed stale restic mirrors", {
            source: LOG_SOURCE,
            route: ROUTE,
            failureType: "daily_instance_backup_mirror_reconcile",
            proxmox_node: host,
            removed,
            freedMb,
          });
        }
      }
    } catch (err) {
      // Env drift / SSH blip during reconcile must not touch the backups.
      log.warn("mirror reconcile failed", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "daily_instance_backup_mirror_reconcile_failed",
        proxmox_node: host,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Run a single candidate synchronously (manual smoke test / on-demand backup).
  if (manualAction === "run-one") {
    const row = candidates[0];
    if (!row) return apiSuccess({ ok: true, mode: "run-one", candidates: 0 });
    const hostEnv = resolveProxmoxHostEnv(
      { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
      process.env
    );
    const result = await runProxmoxHostScript(
      buildRunScript(row, deriveResticPassword(row.id), true),
      hostEnv,
      { timeoutMs: HOST_BACKUP_TIMEOUT_MS }
    );
    const payload = {
      mode: "run-one",
      candidate: { id: row.id, proxmox_node: row.proxmox_node, proxmox_vmid: row.proxmox_vmid, resource_tier: row.resource_tier },
      stdout: redactHostOutput(result.stdout, 12000),
      stderr: redactHostOutput(result.stderr, 12000),
    };
    if (!result.ok) {
      return apiError(result.error ?? result.stderr ?? "run-one failed", 500, undefined, payload, {
        source: LOG_SOURCE, route: ROUTE, failureType: "daily_instance_backup_run_one_failed", logLevel: "warn",
      });
    }
    // Manual backup succeeded — advance the rotation cursor like the batch path.
    await stampBackupCursor(row.id);
    return apiSuccess({ ok: true, ...payload });
  }

  if (!enabled) {
    return apiSuccess({
      ok: true,
      mode: "dry_run",
      candidates: candidates.length,
      batchSize,
      tiers,
      sample: candidates.slice(0, 10).map((row) => ({
        id: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        resource_tier: row.resource_tier,
      })),
    });
  }

  const results = {
    candidates: candidates.length,
    backedUp: 0,
    failed: 0,
    // `host` is carried so the ops event below can NAME the failing PVE host.
    // Without it an env-drifted host is invisible: the only place its identity
    // appears is the thrown Error's message, and the event maps to {id, reason}.
    perInstance: [] as Array<{
      id: string;
      ok: boolean;
      host?: string | null;
      reason?: string;
      message?: string;
    }>,
  };

  const byHost = new Map<string, BackupCandidate[]>();
  for (const row of candidates) {
    const host = row.proxmox_node!;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host)!.push(row);
  }

  async function processCandidate(row: BackupCandidate): Promise<void> {
    try {
      // resolveProxmoxHostEnv is fail-closed and THROWS when a host slug has no
      // matching PROXMOX_<SLUG>_* overrides — i.e. whenever a PVE host's Vercel
      // env drifts. It MUST be inside the try. Outside it, every candidate on
      // that one host became an unhandled rejection, and under Promise.all the
      // first one aborted the ENTIRE fleet batch: the route 500'd, so the
      // failure ops event AND the dead-man heartbeat below were both skipped.
      // Per-instance restic backups then stopped for every OTHER host too, with
      // nothing naming the host at fault. Inside the try it is one instance's
      // failure, attributed to its host, and the sweep carries on.
      const hostEnv = resolveProxmoxHostEnv(
        { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
        process.env
      );
      const result = await runProxmoxHostScript(
        buildRunScript(row, deriveResticPassword(row.id), true),
        hostEnv,
        { timeoutMs: HOST_BACKUP_TIMEOUT_MS }
      );
      if (!result.ok) {
        results.failed += 1;
        results.perInstance.push({
          id: row.id,
          ok: false,
          host: row.proxmox_node ?? null,
          reason: "host_script_failed",
          message: result.error ?? result.stderr ?? "unknown error",
        });
        log.warn("daily instance backup failed", {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "daily_instance_backup_failed",
          instanceId: row.id,
          proxmox_node: row.proxmox_node,
          proxmox_vmid: row.proxmox_vmid,
          message: result.error ?? result.stderr ?? "unknown error",
        });
        // Advance the cursor even on failure so a perpetually-failing row
        // rotates to the back rather than starving the rest of the fleet.
        await stampBackupCursor(row.id);
        return;
      }
      results.backedUp += 1;
      results.perInstance.push({ id: row.id, ok: true, host: row.proxmox_node ?? null });
      // Advance the rotation cursor so the next run moves on to the next-oldest
      // cohort rather than re-backing-up this row. Best-effort.
      await stampBackupCursor(row.id);
    } catch (err) {
      results.failed += 1;
      results.perInstance.push({
        id: row.id,
        ok: false,
        host: row.proxmox_node ?? null,
        reason: "exception",
        message: err instanceof Error ? err.message : String(err),
      });
      log.error("daily instance backup threw", err, {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "daily_instance_backup_threw",
        instanceId: row.id,
        proxmox_node: row.proxmox_node,
      });
      // Advance the cursor even when the backup throws so a row that errors
      // every run doesn't permanently starve the rest of the fleet.
      await stampBackupCursor(row.id);
    }
  }

  // One host's instances run serially (avoid IO/network contention); hosts in parallel.
  //
  // allSettled, not all: processCandidate is now fully defensive, but one
  // unexpected throw would otherwise reject the whole batch -> 500 the tick ->
  // skip both the failure ops event and the dead-man heartbeat below, so a
  // crash would also silence the watchdog that is supposed to notice the crash.
  // Record a rejected lane against its host and still finish the sweep.
  const lanes = Array.from(byHost.entries());
  const laneOutcomes = await Promise.allSettled(
    lanes.map(async ([host, rows]) => {
      // Trim orphan mirrors first so a disk-pressured host frees space BEFORE its
      // backups run (and hit the disk-headroom guard). Best-effort — never blocks.
      await reconcileHostMirrors(host);
      for (const row of rows) await processCandidate(row);
    })
  );
  laneOutcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") return;
    const [host, rows] = lanes[index];
    results.failed += 1;
    results.perInstance.push({
      id: `host:${host}`,
      ok: false,
      host,
      reason: "host_lane_threw",
      message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
    log.error("daily instance backup host lane threw", outcome.reason, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "daily_instance_backup_host_lane_threw",
      proxmox_node: host,
      laneCandidates: rows.length,
      errorName: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
    });
  });

  // Surface failures: previously a partial/total backup failure returned HTTP
  // 200 with no ops-event and no heartbeat, so a silently-broken paid-tenant
  // backup pipeline (master key rotated, Storage Box full) looked healthy. Emit
  // a warn event when any instance failed. Best-effort. Mirrors daily-vm-backups.
  if (results.failed > 0) {
    await reportOpsEvent({
      source: "cron.daily_instance_backups_failed",
      severity: "warn",
      title: `Daily instance backups: ${results.failed} of ${results.candidates} failed`,
      message:
        `daily-instance-backups completed with ${results.failed} failed and ${results.backedUp} ` +
        `succeeded out of ${results.candidates} candidate(s). Paid-tenant granular backups may be ` +
        `missing for the failed instances — check the per-instance reasons, the restic master key, ` +
        `and the Storage Box.`,
      route: ROUTE,
      metadata: {
        candidates: results.candidates,
        backed_up: results.backedUp,
        failed: results.failed,
        // Name the hosts, not just the instances: a fail-closed env drift on one
        // PVE host fails every candidate on it, and `failed_hosts` makes that
        // pattern legible at a glance instead of reading N instance ids.
        failed_hosts: Array.from(
          new Set(results.perInstance.filter((r) => !r.ok).map((r) => r.host).filter(Boolean))
        ),
        failed_instances: results.perInstance
          .filter((r) => !r.ok)
          .map((r) => ({ id: r.id, host: r.host ?? null, reason: r.reason, message: r.message })),
      },
    });
  }

  // Dead-man heartbeat: the sweep ran to completion (per-instance failures are
  // recorded in `results`, not a route-level failure). Best-effort.
  await recordCronHeartbeat("daily-instance-backups");

  return apiSuccess({
    ok: results.failed === 0,
    mode: "applied",
    reconciledMirrors: reconciledRemoved,
    reconciledFreedMb: reconciledFreedMb,
    ...results,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
