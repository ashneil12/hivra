import { NextRequest } from "next/server";
import { createHmac } from "crypto";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { buildColdStorageInstallScriptOrExit } from "@/lib/cold-storage-ssh";
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
const RESTIC_BACKUP_SCRIPT_B64 = "IyEvdXNyL2Jpbi9lbnYgYmFzaAojIGJhY2t1cC12bS1yZXN0aWMuc2gg4oCUIGdyYW51bGFyIHBlci1pbnN0YW5jZSBkYXRhIGJhY2t1cCBmb3IgSGVybWVzT1MgdGVuYW50cy4KIwojIFJ1biBmcm9tIGEgUFZFIGhvc3QuIEFyZ3M6IDx2bWlkPiA8aW5zdGFuY2UtaWQ+IDx0aWVyPiBbZ3Vlc3QtaXBdIFstLWFwcGx5XQojCiMgVW5saWtlIGJhY2t1cC12bS1kYWlseS5zaCAod2hvbGUtVk0gdnpkdW1wKSwgdGhpcyBiYWNrcyB1cCBvbmx5IHRoZSB0ZW5hbnQncwojICpkYXRhKiB2b2x1bWVzIHdpdGggZmlsZS1sZXZlbCBncmFudWxhcml0eSwgc28gYSBzaW5nbGUgY2hhdC9maWxlIGlzIHJlc3RvcmFibGU6CiMgICAtIHdlYnVpLXN0YXRlICAgICAoL2hvbWUvaGVybWVzLy5oZXJtZXMpICBtaW51cyByZWdlbmVyYWJsZSBjYWNoZXMKIyAgIC0gd2VidWktd29ya3NwYWNlICgvd29ya3NwYWNlKQojIEl0IGRvZXMgTk9UIHNuYXBzaG90IHRoZSB3aG9sZSBkaXNrLCBzbyBpdCBuZWVkcyBubyBob3N0IFJBTSBoZWFkcm9vbSBhbmQgaXMKIyBpbW11bmUgdG8gdGhlIGxpdmUtdnpkdW1wIE9PTS9wcmVmbGlnaHQgZnJhZ2lsaXR5LgojCiMgRmxvdzogdGhlIGhvc3QgcmVhZHMgdGhlIGd1ZXN0J3MgRG9ja2VyIHZvbHVtZXMgdmlhIGBzdWRvIHJzeW5jYCBpbnRvIGEgcGVyLWluc3RhbmNlCiMgbWlycm9yLCB0aGVuIGByZXN0aWNgIGRlZHVwcytlbmNyeXB0cyB0aGUgbWlycm9yIHRvIHRoZSBIZXR6bmVyIFN0b3JhZ2UgQm94LgojIFRoZSBTdG9yYWdlIEJveCBTU0gga2V5IGxpdmVzIE9OTFkgb24gdGhlIFBWRSBob3N0IChpbnN0YWxsZWQgYnkgdGhlIGNhbGxlcikgYW5kIGlzCiMgbmV2ZXIgcGxhY2VkIG9uIGEgZ3Vlc3QgVk0g4oCUIHRlbmFudCBpc29sYXRpb24gaXMgcHJlc2VydmVkLgojCiMgcmVzdGljIHJlcG86IHNmdHA6Y29sZDpyZXN0aWMvPGluc3RhbmNlLWlkPiAgKG9uZSByZXBvIHBlciBpbnN0YW5jZSkKIyBSRVNUSUNfUEFTU1dPUkQgbXVzdCBiZSBwcm92aWRlZCBpbiB0aGUgZW52aXJvbm1lbnQgYnkgdGhlIGNhbGxlciAodGhlIGNyb24gcm91dGUKIyBkZXJpdmVzIGl0IHBlci1pbnN0YW5jZTogSE1BQyhIRVJNRVNfUkVTVElDX01BU1RFUl9LRVksIGluc3RhbmNlX2lkKSkuCiMKIyBEZWZhdWx0IGlzIGRyeS1ydW4uIFBhc3MgLS1hcHBseSB0byBleGVjdXRlLgoKc2V0IC1ldW8gcGlwZWZhaWwKCiMgPj4+IFZNSUQtYm91bmQgZ3Vlc3QgU1NIOiBpZGVudGljYWwgaW4gYmFja3VwLXZtLXJlc3RpYy5zaCwgYXJjaGl2ZS12bS1jb2xkLnNoIGFuZCByZXN0b3JlLXZtLWNvbGQuc2ggPj4+CiMgQmFzaCBtaXJyb3Igb2YgYnVpbGRIZXJtZXNWbWlkQm91bmRHdWVzdFNzaFByZWx1ZGUgKGRhc2hib2FyZC9zcmMvbGliL3Byb3htb3gvaGVybWVzLWd1ZXN0LXNzaC50cykuCiMgQSBndWVzdCBJUCBpcyBub3QgYW4gaWRlbnRpdHk6IGEgc3RhbGUgbmVpZ2hib3VyIGVudHJ5IG9yIGEgcmVjeWNsZWQgSVAgY2FuIHJvdXRlIGFuIFNTSCBjb25uZWN0aW9uIHRvCiMgYW5vdGhlciB0ZW5hbnQuIGF0dGVzdF9ndWVzdF9zc2hfcGluIHJ1bnMgYmVmb3JlIHRoZSBmaXJzdCBjb25uZWN0aW9uLiBJdCBjaGVja3MgdGhhdCBWTUlEIGlzIGEgcnVubmluZwojIFZNIGNvbmZpZ3VyZWQgd2l0aCBHVUVTVF9JUCwgdGhhdCBpdCBpcyBub3QgYSBIaXZyYSBjb21wdXRlciwgYW5kIHRoYXQgaXQgaGFzIGEgUUVNVSBHdWVzdCBBZ2VudCBjaGFubmVsLgojIEl0IHRoZW4gcmVhZHMgdGhlIGd1ZXN0J3MgRWQyNTUxOSBTU0ggaG9zdCBrZXkgdGhyb3VnaCB0aGUgYWdlbnQgKHRoZSBWTUlEJ3MgdmlydGlvIGNoYW5uZWwsIG5vdCB0aGUKIyBuZXR3b3JrKSBhbmQgcGlucyBldmVyeSBsYXRlciBjb25uZWN0aW9uIHRvIHRoYXQga2V5IGluIGEgcHJpdmF0ZSBrbm93bl9ob3N0cyBmaWxlLgojIElucHV0czogVk1JRCwgR1VFU1RfSVAsIFZNX1NTSF9LRVkuIE91dHB1dDogR1VFU1RfU1NIX1BJTl9PUFRTIChzc2ggb3B0aW9ucywgbm8gdGltZW91dCBvciBsb2cgbGV2ZWwpLgojIE9uIGZhaWx1cmUgaXQgcHJpbnRzIGEgIlZNSUQtYm91bmQgU1NIIHJlZnVzZWQ6IiBsaW5lIGFuZCByZXR1cm5zIDE7IHRoZSBjYWxsZXIgZXhpdHMgYmVmb3JlIGNvbnRhY3RpbmcgdGhlIGd1ZXN0LgpHVUVTVF9TU0hfSURFTlRJVFlfRElSPSIiCkdVRVNUX1NTSF9QSU5fT1BUUz0oKQpndWVzdF9zc2hfcmVmdXNlKCkgewogIHByaW50ZiAnVk1JRC1ib3VuZCBTU0ggcmVmdXNlZDogJXM7IG5vdGhpbmcgd2FzIHNlbnQgdG8gdGhlIGd1ZXN0XG4nICIkMSIgPiYyCn0KY2xlYW51cF9oaXZyYV9ndWVzdF9zc2hfaWRlbnRpdHkoKSB7CiAgY2FzZSAiJHtHVUVTVF9TU0hfSURFTlRJVFlfRElSOi19IiBpbgogICAgL3J1bi9oaXZyYS1ndWVzdC1zc2gtaWRlbnRpdHkuKikgcm0gLXJmIC0tICIkR1VFU1RfU1NIX0lERU5USVRZX0RJUiIgOzsKICAgICIiKSA7OwogICAgKikgcHJpbnRmICdyZWZ1c2luZyB0byByZW1vdmUgdW5leHBlY3RlZCBndWVzdCBpZGVudGl0eSBkaXJlY3RvcnlcbicgPiYyOyByZXR1cm4gMSA7OwogIGVzYWMKfQphdHRlc3RfZ3Vlc3Rfc3NoX3BpbigpIHsKICAjIGVycmV4aXQgaXMgc3VzcGVuZGVkIGluc2lkZSB0aGlzIGZ1bmN0aW9uIHdoZW4gaXQgcnVucyBhcyBhbiBpZi98fCBjb25kaXRpb24sCiAgIyBzbyBldmVyeSBjaGVjayByZXR1cm5zIGV4cGxpY2l0bHkuCiAgbG9jYWwgYXR0ZW1wdHM9IiQxIiBjb25maWcgY29uZl9pcCB0YWdzIGFnZW50IGF0dGVtcHQgdXA9MCBrZXlfanNvbiBrZXlfbGluZQogIGNhc2UgIiR7R1VFU1RfSVA6LX0iIGluCiAgICAiInwqWyEwLTkuXSopIGd1ZXN0X3NzaF9yZWZ1c2UgInRoZSBndWVzdCBpcCBpcyBub3QgYW4gSVB2NCBhZGRyZXNzIjsgcmV0dXJuIDEgOzsKICBlc2FjCiAgWyAtZiAiJHtWTV9TU0hfS0VZOi19IiBdIHx8IHsgZ3Vlc3Rfc3NoX3JlZnVzZSAidGhpcyBob3N0IGhhcyBubyBndWVzdCBTU0gga2V5IGF0ICR7Vk1fU1NIX0tFWTotKHVuc2V0KX0iOyByZXR1cm4gMTsgfQogIGNhc2UgIiR7Vk1JRDotfSIgaW4KICAgICIifCpbITAtOV0qKSBndWVzdF9zc2hfcmVmdXNlICJ0aGUgdm1pZCBpcyBub3QgYSBudW1iZXIiOyByZXR1cm4gMSA7OwogIGVzYWMKICBjb25maWc9IiQocW0gY29uZmlnICIkVk1JRCIgPC9kZXYvbnVsbCAyPi9kZXYvbnVsbCkiIFwKICAgIHx8IHsgZ3Vlc3Rfc3NoX3JlZnVzZSAiVk0gJFZNSUQgZG9lcyBub3QgZXhpc3Qgb24gdGhpcyBob3N0IjsgcmV0dXJuIDE7IH0KICBbICIkKHFtIHN0YXR1cyAiJFZNSUQiIDwvZGV2L251bGwgMj4vZGV2L251bGwgfCBhd2sgJ3twcmludCAkMn0nKSIgPSBydW5uaW5nIF0gXAogICAgfHwgeyBndWVzdF9zc2hfcmVmdXNlICJWTSAkVk1JRCBpcyBub3QgcnVubmluZyI7IHJldHVybiAxOyB9CiAgY29uZl9pcD0iJChwcmludGYgJyVzXG4nICIkY29uZmlnIiB8IGF3ayAnCiAgICAvXmlwY29uZmlnMDovICYmICFzZWVuIHsKICAgICAgc2VlbiA9IDEKICAgICAgbGluZSA9ICQwCiAgICAgIHN1YigvXmlwY29uZmlnMDpbIFx0XSovLCAiIiwgbGluZSkKICAgICAgbiA9IHNwbGl0KGxpbmUsIHBhcnRzLCAiLCIpCiAgICAgIGZvciAoaSA9IDE7IGkgPD0gbjsgaSsrKSB7CiAgICAgICAgaWYgKHN1YnN0cihwYXJ0c1tpXSwgMSwgMykgPT0gImlwPSIpIHsKICAgICAgICAgIHZhbHVlID0gc3Vic3RyKHBhcnRzW2ldLCA0KQogICAgICAgICAgaWYgKHZhbHVlIH4gL15bMC05Ll0rXC9bMC05XSskLykgeyBzdWIoL1wvWzAtOV0rJC8sICIiLCB2YWx1ZSk7IHByaW50IHZhbHVlIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0nKSIKICBbICIkY29uZl9pcCIgPSAiJEdVRVNUX0lQIiBdIFwKICAgIHx8IHsgZ3Vlc3Rfc3NoX3JlZnVzZSAiVk0gJFZNSUQgaXMgY29uZmlndXJlZCB3aXRoIGlwICR7Y29uZl9pcDotbm9uZX0sIG5vdCAkR1VFU1RfSVAiOyByZXR1cm4gMTsgfQogIHRhZ3M9IiQocHJpbnRmICclc1xuJyAiJGNvbmZpZyIgfCBhd2sgJy9edGFnczovICYmICFzZWVuIHsgc2VlbiA9IDE7IGxpbmUgPSAkMDsgc3ViKC9edGFnczpbIFx0XSovLCAiIiwgbGluZSk7IGdzdWIoL1s7LCBdKy8sICI7IiwgbGluZSk7IHByaW50IGxpbmUgfScpIgogIGNhc2UgIjskdGFnczsiIGluCiAgICAqIjtoaXZyYS1iaW5kLSIqKSBndWVzdF9zc2hfcmVmdXNlICJWTSAkVk1JRCBpcyBhIEhpdnJhIGNvbXB1dGVyLCBub3QgYSBIZXJtZXMgaW5zdGFuY2UgVk0iOyByZXR1cm4gMSA7OwogIGVzYWMKICBhZ2VudD0iJChwcmludGYgJyVzXG4nICIkY29uZmlnIiB8IGF3ayAnL15hZ2VudDovICYmICFzZWVuIHsgc2VlbiA9IDE7IGxpbmUgPSAkMDsgc3ViKC9eYWdlbnQ6WyBcdF0qLywgIiIsIGxpbmUpOyBwcmludCBsaW5lIH0nKSIKICBjYXNlICIsJGFnZW50LCIgaW4KICAgICosMSwqfCosb24sKnwqLHllcywqfCosdHJ1ZSwqfCosZW5hYmxlZD0xLCp8KixlbmFibGVkPW9uLCp8KixlbmFibGVkPXllcywqfCosZW5hYmxlZD10cnVlLCopIDs7CiAgICAqKSBndWVzdF9zc2hfcmVmdXNlICJWTSAkVk1JRCBoYXMgbm8gUUVNVSBHdWVzdCBBZ2VudCBjaGFubmVsLCBzbyBpdHMgU1NIIGhvc3Qga2V5IGNhbid0IGJlIGF0dGVzdGVkIjsgcmV0dXJuIDEgOzsKICBlc2FjCiAgZm9yIGF0dGVtcHQgaW4gJChzZXEgMSAiJGF0dGVtcHRzIik7IGRvCiAgICBpZiB0aW1lb3V0IDUgcW0gZ3Vlc3QgY21kICIkVk1JRCIgcGluZyA8L2Rldi9udWxsID4vZGV2L251bGwgMj4mMTsgdGhlbiB1cD0xOyBicmVhazsgZmkKICAgIGlmIFsgIiRhdHRlbXB0IiAtbHQgIiRhdHRlbXB0cyIgXTsgdGhlbiBzbGVlcCA1OyBmaQogIGRvbmUKICBbICIkdXAiID0gMSBdIHx8IHsgZ3Vlc3Rfc3NoX3JlZnVzZSAiUUVNVSBHdWVzdCBBZ2VudCBpbiBWTSAkVk1JRCBkaWQgbm90IGFuc3dlciwgc28gaXRzIFNTSCBob3N0IGtleSBjYW4ndCBiZSBhdHRlc3RlZCI7IHJldHVybiAxOyB9CiAga2V5X2pzb249IiQocW0gZ3Vlc3QgZXhlYyAiJFZNSUQiIC0tIC9iaW4vY2F0IC9ldGMvc3NoL3NzaF9ob3N0X2VkMjU1MTlfa2V5LnB1YiA8L2Rldi9udWxsIDI+L2Rldi9udWxsKSIgXAogICAgfHwgeyBndWVzdF9zc2hfcmVmdXNlICJWTSAkVk1JRCBTU0ggaG9zdCBrZXkgY291bGQgbm90IGJlIHJlYWQgdGhyb3VnaCBRRU1VIEd1ZXN0IEFnZW50IjsgcmV0dXJuIDE7IH0KICBrZXlfbGluZT0iJChwcmludGYgJyVzJyAiJGtleV9qc29uIiB8IC91c3IvYmluL3B5dGhvbjMgLWMgJwppbXBvcnQgYmFzZTY0LGJpbmFzY2lpLGpzb24sc3lzCnRyeToKICAgIGRvY3VtZW50PWpzb24ubG9hZChzeXMuc3RkaW4pCiAgICBmaWVsZHM9ZG9jdW1lbnQuZ2V0KCJvdXQtZGF0YSIsICIiKS5zdHJpcCgpLnNwbGl0KCkKICAgIHJhdz1iYXNlNjQuYjY0ZGVjb2RlKGZpZWxkc1sxXSwgdmFsaWRhdGU9VHJ1ZSkKICAgIGV4cGVjdGVkPWIiXHgwMFx4MDBceDAwXHgwYnNzaC1lZDI1NTE5XHgwMFx4MDBceDAwXHgyMCIKICAgIGlmIGRvY3VtZW50LmdldCgiZXhpdGVkIikgIT0gMSBvciBkb2N1bWVudC5nZXQoImV4aXRjb2RlIikgIT0gMCBvciBsZW4oZmllbGRzKSA8IDIgb3IgZmllbGRzWzBdICE9ICJzc2gtZWQyNTUxOSIgb3IgbGVuKHJhdykgIT0gNTEgb3Igbm90IHJhdy5zdGFydHN3aXRoKGV4cGVjdGVkKToKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCJpbnZhbGlkIFZNSUQtYm91bmQgU1NIIGhvc3Qga2V5IikKZXhjZXB0IChBdHRyaWJ1dGVFcnJvcixJbmRleEVycm9yLEtleUVycm9yLFR5cGVFcnJvcixWYWx1ZUVycm9yLGJpbmFzY2lpLkVycm9yLGpzb24uSlNPTkRlY29kZUVycm9yKToKICAgIHJhaXNlIFN5c3RlbUV4aXQoMSkKcHJpbnQoInNzaC1lZDI1NTE5ICIrZmllbGRzWzFdKQonKSIgfHwgeyBndWVzdF9zc2hfcmVmdXNlICJWTSAkVk1JRCBkaWQgbm90IGF0dGVzdCBhIHZhbGlkIEVkMjU1MTkgU1NIIGhvc3Qga2V5IjsgcmV0dXJuIDE7IH0KICBHVUVTVF9TU0hfSURFTlRJVFlfRElSPSIkKG1rdGVtcCAtZCAvcnVuL2hpdnJhLWd1ZXN0LXNzaC1pZGVudGl0eS5YWFhYWFhYWCkiIFwKICAgIHx8IHsgZ3Vlc3Rfc3NoX3JlZnVzZSAibm8gcHJpdmF0ZSBkaXJlY3RvcnkgZm9yIHRoZSBhdHRlc3RlZCBTU0ggaG9zdCBrZXkiOyByZXR1cm4gMTsgfQogIGNobW9kIDA3MDAgIiRHVUVTVF9TU0hfSURFTlRJVFlfRElSIgogIEdVRVNUX1NTSF9LTk9XTl9IT1NUUz0iJEdVRVNUX1NTSF9JREVOVElUWV9ESVIva25vd25faG9zdHMiCiAgR1VFU1RfU1NIX0hPU1RfQUxJQVM9ImhpdnJhLXZtaWQtJFZNSUQiCiAgcHJpbnRmICclcyAlc1xuJyAiJEdVRVNUX1NTSF9IT1NUX0FMSUFTIiAiJGtleV9saW5lIiA+ICIkR1VFU1RfU1NIX0tOT1dOX0hPU1RTIgogIGNobW9kIDA2MDAgIiRHVUVTVF9TU0hfS05PV05fSE9TVFMiCiAgR1VFU1RfU1NIX1BJTl9PUFRTPSgtaSAiJFZNX1NTSF9LRVkiIC1vIEJhdGNoTW9kZT15ZXMgLW8gSWRlbnRpdGllc09ubHk9eWVzCiAgICAtbyBTdHJpY3RIb3N0S2V5Q2hlY2tpbmc9eWVzIC1vIEhvc3RLZXlBbGdvcml0aG1zPXNzaC1lZDI1NTE5IC1vIFVwZGF0ZUhvc3RLZXlzPW5vCiAgICAtbyBHbG9iYWxLbm93bkhvc3RzRmlsZT0vZGV2L251bGwgLW8gVXNlcktub3duSG9zdHNGaWxlPSIkR1VFU1RfU1NIX0tOT1dOX0hPU1RTIgogICAgLW8gSG9zdEtleUFsaWFzPSIkR1VFU1RfU1NIX0hPU1RfQUxJQVMiKQogIHJldHVybiAwCn0KIyA8PDwgVk1JRC1ib3VuZCBndWVzdCBTU0ggPDw8CgpWTUlEPSIkezE6LX0iCklOU1RBTkNFX0lEPSIkezI6LX0iClRJRVI9IiR7MzotfSIKCkdVRVNUX0lQPSIiCk1PREU9Ii0tZHJ5LXJ1biIKc2hpZnQgMyAyPi9kZXYvbnVsbCB8fCB0cnVlCmZvciBhIGluICIkQCI7IGRvCiAgY2FzZSAiJGEiIGluCiAgICAtLWFwcGx5KSBNT0RFPSItLWFwcGx5IiA7OwogICAgLS1kcnktcnVuKSBNT0RFPSItLWRyeS1ydW4iIDs7CiAgICAiIikgOzsKICAgICopIEdVRVNUX0lQPSIkYSIgOzsKICBlc2FjCmRvbmUKCmlmIFsgLXogIiRWTUlEIiBdIHx8IFsgLXogIiRJTlNUQU5DRV9JRCIgXSB8fCBbIC16ICIkVElFUiIgXTsgdGhlbgogIGVjaG8gInVzYWdlOiAkMCA8dm1pZD4gPGluc3RhbmNlLWlkPiA8dGllcj4gW2d1ZXN0LWlwXSBbLS1hcHBseV0iID4mMgogIGV4aXQgMQpmaQoKIyBLZWVwIGEgdW5pdmVyc2FsIHJlc3RvcmUgc2FmZXR5IG5ldCwgaW5jbHVkaW5nIHRoZSBiYXNlIGNyZWRpdCB0aWVyLiBVbmtub3duCiMgdGllcnMgYXJlIHN0aWxsIHJlZnVzZWQgc28gYSBjYWxsZXIgdHlwbyBjYW5ub3Qgc2lsZW50bHkgc2VsZWN0IGEgcG9saWN5LgpjYXNlICIkVElFUiIgaW4KICBvcGVyYXRvcnxmbGVldHxjb21tYW5kfHdzX2Nsb3VkX3Byb3x3c19jbG91ZF9wb3dlcnxjcmVkaXRfYmFzZXxjcmVkaXRfcHJvfGNyZWRpdF9wb3dlcnxwYWlkfHByb3xwb3dlcikgOiA7OwogICopIGVjaG8gInJlZnVzaW5nIHJlc3RpYyBiYWNrdXAgZm9yIHVuc3VwcG9ydGVkIHRpZXI6ICRUSUVSIiA+JjI7IGV4aXQgMiA7Owplc2FjCgojIERlZmVuc2UtaW4tZGVwdGg6IHZhbGlkYXRlIGluc3RhbmNlIGlkIHNoYXBlICh0aGUgY2FsbGVyIGFsc28gdmFsaWRhdGVzKS4KaWYgISBbWyAiJElOU1RBTkNFX0lEIiA9fiBeWzAtOWEtZi1dezM2fSQgXV07IHRoZW4KICBlY2hvICJ1bnNhZmUgaW5zdGFuY2UgaWQ6ICRJTlNUQU5DRV9JRCIgPiYyOyBleGl0IDEKZmkKClZNX1NTSF9LRVk9IiR7SEVSTUVTX1ZNX09SQ0hFU1RSQVRPUl9LRVk6LS9ldGMvaGl2cmEva2V5cy92bS1vcmNoZXN0cmF0b3J9IgpNSVJST1JfUk9PVD0iJHtIRVJNRVNfUkVTVElDX01JUlJPUl9ST09UOi0vdmFyL2xpYi9oZXJtZXMtcmVzdGljLXNyY30iClNSQz0iJE1JUlJPUl9ST09ULyRJTlNUQU5DRV9JRCIKUkVQTz0iJHtIRVJNRVNfUkVTVElDX1JFUE9fT1ZFUlJJREU6LXNmdHA6Y29sZDpyZXN0aWMvJElOU1RBTkNFX0lEfSIKZXhwb3J0IFJFU1RJQ19DQUNIRV9ESVI9IiR7UkVTVElDX0NBQ0hFX0RJUjotL3Zhci9saWIvaGVybWVzLXJlc3RpYy1jYWNoZX0iCktFRVBfREFJTFk9IiR7SEVSTUVTX1JFU1RJQ19LRUVQX0RBSUxZOi03fSIKS0VFUF9XRUVLTFk9IiR7SEVSTUVTX1JFU1RJQ19LRUVQX1dFRUtMWTotNH0iCktFRVBfTU9OVEhMWT0iJHtIRVJNRVNfUkVTVElDX0tFRVBfTU9OVEhMWTotM30iCgojIENhY2hlIC8gcmVnZW5lcmFibGUgZGlycyBleGNsdWRlZCBmcm9tIHdlYnVpLXN0YXRlIChyZWxhdGl2ZSB0byB0aGUgdm9sdW1lIHJvb3QpLgojIEtlZXAgY2hhdHMvc2Vzc2lvbnMvam91cm5hbHMvcHJvZmlsZXMvY29uZmlnL2FnZW50LW1lbW9yeTsgZHJvcCBtb2RlbCArIHBrZyBjYWNoZXMuCldFQlVJX1NUQVRFX0VYQ0xVREVTPSgKICAiaG9tZS8uY2FjaGUiICJob21lLy5ucG0iICJob21lLy5sb2NhbC9zaGFyZS91diIgImhvbWUvLmxvY2FsL3NoYXJlL3BucG0iCiAgIioqL25vZGVfbW9kdWxlcyIgIioqL19fcHljYWNoZV9fIiAiKiovLnZlbnYiICIqKi8qLnRtcCIKKQpXT1JLU1BBQ0VfRVhDTFVERVM9KAogICIqKi9ub2RlX21vZHVsZXMiICIqKi8udmVudiIgIioqL19fcHljYWNoZV9fIiAiKiovLmdpdC9vYmplY3RzIgogICIqKi90YXJnZXQvZGVidWciICIqKi90YXJnZXQvcmVsZWFzZSIKKQoKIyBEZXJpdmUgdGhlIGd1ZXN0IElQIGZyb20gdGhlIGhvc3QncyBhdXRob3JpdGF0aXZlIHFtIGNvbmZpZyBpZiBub3Qgc3VwcGxpZWQuCmlmIFsgLXogIiRHVUVTVF9JUCIgXTsgdGhlbgogIEdVRVNUX0lQPSIkKHFtIGNvbmZpZyAiJFZNSUQiIDI+L2Rldi9udWxsIHwgc2VkIC1uICdzI15pcGNvbmZpZzA6LipbXjAtOV1pcD1cKFswLTldWzAtOS5dXHs2LFx9XCkuKiNcMSNwJyB8IGhlYWQgLTEpIgpmaQppZiBbIC16ICIkR1VFU1RfSVAiIF07IHRoZW4KICBlY2hvICJSRUZVU0lOR19CQUNLVVBfTk9fR1VFU1RfSVAgdm1pZD0kVk1JRCBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMjsgZXhpdCAzCmZpCgpXRUJVSV9TVEFURV9WT0w9Ii92YXIvbGliL2RvY2tlci92b2x1bWVzL2FnZW50LSR7SU5TVEFOQ0VfSUR9X3dlYnVpLXN0YXRlL19kYXRhIgpXT1JLU1BBQ0VfVk9MPSIvdmFyL2xpYi9kb2NrZXIvdm9sdW1lcy9hZ2VudC0ke0lOU1RBTkNFX0lEfV93ZWJ1aS13b3Jrc3BhY2UvX2RhdGEiCgplY2hvICJSRVNUSUNfQkFDS1VQX0JFR0lOIHZtaWQ9JFZNSUQgaW5zdGFuY2U9JElOU1RBTkNFX0lEIHRpZXI9JFRJRVIgZ3Vlc3RfaXA9JEdVRVNUX0lQIHJlcG89JFJFUE8gbW9kZT0kTU9ERSBob3N0PSQoaG9zdG5hbWUpIgoKaWYgWyAiJE1PREUiICE9ICItLWFwcGx5IiBdOyB0aGVuCiAgZWNobyAiRFJZX1JVTiB3b3VsZCByc3luYyAkV0VCVUlfU1RBVEVfVk9MICsgJFdPUktTUEFDRV9WT0wgZnJvbSAkR1VFU1RfSVAgaW50byAkU1JDLCB0aGVuIHJlc3RpYyBiYWNrdXAgLT4gJFJFUE8iCiAgZWNobyAiRFJZX1JVTiByZXRlbnRpb246IC0ta2VlcC1kYWlseSAkS0VFUF9EQUlMWSAtLWtlZXAtd2Vla2x5ICRLRUVQX1dFRUtMWSAtLWtlZXAtbW9udGhseSAkS0VFUF9NT05USExZIgogIGV4aXQgMApmaQoKIyBBIG1pcnJvciBpcyB0ZW1wb3Jhcnkgc3RhZ2luZyBvbiB0aGUgUFZFIHJvb3QgZGlzay4gUmVmdXNlIHRvIGJlZ2luIGEgbmV3CiMgc3RhZ2luZyBjb3B5IHdoZW4gdGhlIGhvc3QgaXMgYWxyZWFkeSBzaG9ydCBvbiBzcGFjZTsgYSBzdWNjZXNzZnVsIHNuYXBzaG90CiMgcmVtb3ZlcyBpdHMgbWlycm9yIGJlbG93Lgpta2RpciAtcCAiJE1JUlJPUl9ST09UIgpNSU5fSE9TVF9ESVNLX01CPSIke0hFUk1FU19SRVNUSUNfTUlOX0RJU0tfRkxPT1JfTUI6LTgwMDB9IgpBVkFJTF9NQj0iJChkZiAtQk0gLS1vdXRwdXQ9YXZhaWwgIiRNSVJST1JfUk9PVCIgMj4vZGV2L251bGwgfCB0YWlsIC0xIHwgdHIgLWRjICcwLTknKSIKaWYgWyAtbiAiJEFWQUlMX01CIiBdICYmIFsgIiRBVkFJTF9NQiIgLWx0ICIkTUlOX0hPU1RfRElTS19NQiIgXTsgdGhlbgogIGVjaG8gIlJFRlVTSU5HX0JBQ0tVUF9MT1dfSE9TVF9ESVNLIGF2YWlsX21iPSRBVkFJTF9NQiBmbG9vcl9tYj0kTUlOX0hPU1RfRElTS19NQiByb290PSRNSVJST1JfUk9PVCB2bWlkPSRWTUlEIGluc3RhbmNlPSRJTlNUQU5DRV9JRCBob3N0PSQoaG9zdG5hbWUpIiA+JjIKICBleGl0IDkKZmkKCmlmIFsgLXogIiR7UkVTVElDX1BBU1NXT1JEOi19IiBdOyB0aGVuCiAgZWNobyAiUkVGVVNJTkdfQkFDS1VQX05PX1JFU1RJQ19QQVNTV09SRCB2bWlkPSRWTUlEIGluc3RhbmNlPSRJTlNUQU5DRV9JRCIgPiYyOyBleGl0IDQKZmkKaWYgISBjb21tYW5kIC12IHJlc3RpYyA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBlY2hvICJyZXN0aWMgbm90IGluc3RhbGxlZDsgYXR0ZW1wdGluZyBhcHQtZ2V0IGluc3RhbGwiID4mMgogIERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZSBhcHQtZ2V0IGluc3RhbGwgLXkgcmVzdGljID4vZGV2L251bGwgMj4mMSB8fCB7IGVjaG8gIlJFU1RJQ19JTlNUQUxMX0ZBSUxFRCIgPiYyOyBleGl0IDU7IH0KZmkKCiMgU2VyaWFsaXplIHBlci1pbnN0YW5jZSBydW5zIG9uIHRoaXMgaG9zdC4KTE9DSz0iL3Zhci9sb2NrL2hlcm1lcy1yZXN0aWMtJElOU1RBTkNFX0lELmxvY2siCmV4ZWMgOT4iJExPQ0siCmlmICEgZmxvY2sgLW4gOTsgdGhlbgogIGVjaG8gIkFMUkVBRFlfUlVOTklORyBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQiID4mMjsgZXhpdCAwCmZpCgpta2RpciAtcCAiJFNSQy93ZWJ1aS1zdGF0ZSIgIiRTUkMvd2VidWktd29ya3NwYWNlIiAiJFJFU1RJQ19DQUNIRV9ESVIiCgojIEF0dGVzdCB0aGUgZ3Vlc3QncyBTU0ggaG9zdCBrZXkgKFFFTVUgR3Vlc3QgQWdlbnQpIGJlZm9yZSB0aGUgZmlyc3QgcnN5bmMgb3Igc3NoIGNvbm5lY3Rpb24uCnRyYXAgY2xlYW51cF9oaXZyYV9ndWVzdF9zc2hfaWRlbnRpdHkgRVhJVAphdHRlc3RfZ3Vlc3Rfc3NoX3BpbiAxMiB8fCBleGl0IDEwCiMgU1NIIG9wdGlvbnMgYXMgYSBwbGFpbiB3aGl0ZXNwYWNlLWRlbGltaXRlZCBzdHJpbmcgKG5vIHZhbHVlIGNvbnRhaW5zIGEgc3BhY2UpLAojIHNhZmUgZm9yIGJvdGggcnN5bmMgLWUgYW5kIGRpcmVjdCBzc2ggaW52b2NhdGlvbi4KU1NIX09QVFM9IiR7R1VFU1RfU1NIX1BJTl9PUFRTWypdfSAtbyBDb25uZWN0VGltZW91dD0xNSAtbyBTZXJ2ZXJBbGl2ZUludGVydmFsPTE1IC1vIFNlcnZlckFsaXZlQ291bnRNYXg9NCIKCiMgLS0tIHJzeW5jIHRoZSBndWVzdCB2b2x1bWVzIGludG8gdGhlIGhvc3QgbWlycm9yLiBgc3VkbyByc3luY2Agb24gdGhlIGd1ZXN0IHJlYWRzCiMgICAgIHJvb3Qtb3duZWQgRG9ja2VyIHZvbHVtZSBkYXRhOyByZXRyeSB0byByaWRlIG91dCB0cmFuc2llbnQgZ3Vlc3QgcmVib290cyAvIG5ldCBibGlwcy4gLS0tCnJzeW5jX3B1bGwoKSB7CiAgbG9jYWwgcmVtb3RlPSIkMSIgZGVzdD0iJDIiOyBzaGlmdCAyCiAgbG9jYWwgZXhjbHVkZXM9KCIkQCIpCiAgbG9jYWwgYXJncz0oLWEgLS1kZWxldGUgLS1wYXJ0aWFsIC0tdGltZW91dD0xODAgLS1yc3luYy1wYXRoPSJzdWRvIHJzeW5jIiAtZSAic3NoICRTU0hfT1BUUyIpCiAgbG9jYWwgZTsgZm9yIGUgaW4gIiR7ZXhjbHVkZXNbQF19IjsgZG8gYXJncys9KC0tZXhjbHVkZSAiJGUiKTsgZG9uZQogIGxvY2FsIGF0dGVtcHQKICBmb3IgYXR0ZW1wdCBpbiAxIDIgMzsgZG8KICAgIGlmIGlvbmljZSAtYzIgLW43IG5pY2UgLW4xMCByc3luYyAiJHthcmdzW0BdfSIgImhlcm1lc0AkR1VFU1RfSVA6JHJlbW90ZS8iICIkZGVzdC8iOyB0aGVuCiAgICAgIGVjaG8gIlJTWU5DX09LIHNyYz0kcmVtb3RlIGF0dGVtcHQ9JGF0dGVtcHQiCiAgICAgIHJldHVybiAwCiAgICBmaQogICAgZWNobyAiUlNZTkNfUkVUUlkgc3JjPSRyZW1vdGUgYXR0ZW1wdD0kYXR0ZW1wdCIgPiYyCiAgICBzbGVlcCAkKChhdHRlbXB0ICogMTApKQogIGRvbmUKICBlY2hvICJSU1lOQ19GQUlMRUQgc3JjPSRyZW1vdGUiID4mMgogIHJldHVybiAxCn0KCiMgd2VidWktc3RhdGUgaXMgcmVxdWlyZWQ7IHdvcmtzcGFjZSBpcyBiZXN0LWVmZm9ydCAobGFyZ2UsIGFuZCBtYXkgYmUgaHVnZS9hYnNlbnQpLgpyc3luY19wdWxsICIkV0VCVUlfU1RBVEVfVk9MIiAiJFNSQy93ZWJ1aS1zdGF0ZSIgIiR7V0VCVUlfU1RBVEVfRVhDTFVERVNbQF19IiBcCiAgfHwgeyBlY2hvICJSRVNUSUNfQkFDS1VQX0FCT1JUIHJlYXNvbj13ZWJ1aV9zdGF0ZV9yc3luY19mYWlsZWQiID4mMjsgZXhpdCA2OyB9CldPUktTUEFDRV9PSz0xCmlmIHNzaCAkU1NIX09QVFMgImhlcm1lc0AkR1VFU1RfSVAiICJzdWRvIHRlc3QgLWQgJFdPUktTUEFDRV9WT0wiIDI+L2Rldi9udWxsOyB0aGVuCiAgcnN5bmNfcHVsbCAiJFdPUktTUEFDRV9WT0wiICIkU1JDL3dlYnVpLXdvcmtzcGFjZSIgIiR7V09SS1NQQUNFX0VYQ0xVREVTW0BdfSIgfHwgV09SS1NQQUNFX09LPTAKZWxzZQogIGVjaG8gIldPUktTUEFDRV9BQlNFTlQgdm9sPSRXT1JLU1BBQ0VfVk9MIgpmaQoKIyAtLS0gcmVzdGljOiBpbml0LWlmLW5lZWRlZCwgY2xlYXIgc3RhbGUgbG9ja3MsIHNuYXBzaG90LCBwcnVuZSAtLS0KaWYgISByZXN0aWMgLXIgIiRSRVBPIiBjYXQgY29uZmlnID4vZGV2L251bGwgMj4mMTsgdGhlbgogIGVjaG8gIlJFU1RJQ19JTklUIHJlcG89JFJFUE8iCiAgcmVzdGljIC1yICIkUkVQTyIgaW5pdCA+L2Rldi9udWxsIDI+JjEgfHwgeyBlY2hvICJSRVNUSUNfSU5JVF9GQUlMRUQgcmVwbz0kUkVQTyIgPiYyOyBleGl0IDc7IH0KZmkKcmVzdGljIC1yICIkUkVQTyIgdW5sb2NrID4vZGV2L251bGwgMj4mMSB8fCB0cnVlCgpCQUNLVVBfVFM9IiQoZGF0ZSAtdSArJVktJW0tJWRUJUg6JU06JVNaKSIKc2V0ICtlCkJBQ0tVUF9PVVQ9IiQoaW9uaWNlIC1jMiAtbjcgbmljZSAtbjEwIHJlc3RpYyAtciAiJFJFUE8iIGJhY2t1cCBcCiAgLS10YWcgaGVybWVzLWRhaWx5IC0tdGFnICJpbnN0YW5jZTokSU5TVEFOQ0VfSUQiIFwKICAtLWhvc3QgIiRJTlNUQU5DRV9JRCIgXAogICIkU1JDL3dlYnVpLXN0YXRlIiAiJFNSQy93ZWJ1aS13b3Jrc3BhY2UiIDI+JjEpIgpCQUNLVVBfUkM9JD8Kc2V0IC1lCmVjaG8gIiRCQUNLVVBfT1VUIiB8IHRhaWwgLTEyCmlmIFsgIiRCQUNLVVBfUkMiIC1uZSAwIF07IHRoZW4KICBlY2hvICJSRVNUSUNfQkFDS1VQX0ZBSUxFRCByYz0kQkFDS1VQX1JDIGluc3RhbmNlPSRJTlNUQU5DRV9JRCIgPiYyCiAgZXhpdCA4CmZpCgpTTkFQX0lEPSIkKHJlc3RpYyAtciAiJFJFUE8iIHNuYXBzaG90cyAtLWpzb24gLS1sYXRlc3QgMSAyPi9kZXYvbnVsbCB8IHNlZCAtbiAncy8uKiJzaG9ydF9pZCI6IlwoWzAtOWEtZl0qXCkiLiovXDEvcCcgfCB0YWlsIC0xKSIKaWYgWyAteiAiJFNOQVBfSUQiIF07IHRoZW4KICBlY2hvICJSRVNUSUNfU05BUFNIT1RfVkVSSUZZX0ZBSUxFRCBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQ7IHByZXNlcnZpbmcgbWlycm9yPSRTUkMiID4mMgogIGV4aXQgOApmaQoKIyBSZXRlbnRpb246IHBydW5lIG9sZCByZXN0b3JlIHBvaW50cyAoY2hlYXAgdGhhbmtzIHRvIGRlZHVwKS4KcmVzdGljIC1yICIkUkVQTyIgZm9yZ2V0IFwKICAtLWtlZXAtZGFpbHkgIiRLRUVQX0RBSUxZIiAtLWtlZXAtd2Vla2x5ICIkS0VFUF9XRUVLTFkiIC0ta2VlcC1tb250aGx5ICIkS0VFUF9NT05USExZIiBcCiAgLS1wcnVuZSA+L2Rldi9udWxsIDI+JjEgfHwgZWNobyAiUkVTVElDX0ZPUkdFVF9XQVJOIGluc3RhbmNlPSRJTlNUQU5DRV9JRCIgPiYyCgplY2hvICJSRVNUSUNfQkFDS1VQX09LIGluc3RhbmNlPSRJTlNUQU5DRV9JRCBzbmFwc2hvdD0ke1NOQVBfSUQ6LXVua25vd259IHRzPSRCQUNLVVBfVFMgd29ya3NwYWNlX29rPSRXT1JLU1BBQ0VfT0sgcmVwbz0kUkVQTyBob3N0PSQoaG9zdG5hbWUpIgoKIyBUaGUgb2ZmLWhvc3Qgc25hcHNob3QgaXMgbm93IGF1dGhvcml0YXRpdmUuIEtlZXBpbmcgYSBmdWxsIGNvcHkgZm9yIGV2ZXJ5CiMgdGVuYW50IG9uIHRoZSBQVkUgcm9vdCBkaXNrIGdyb3dzIHdpdGhvdXQgYm91bmQgYW5kIGV2ZW50dWFsbHkgYmxvY2tzIGV2ZXJ5CiMgYmFja3VwIG9uIHRoYXQgaG9zdC4gUmVtb3ZlIG9ubHkgdGhlIGV4YWN0LCBVVUlELXZhbGlkYXRlZCBzdGFnaW5nIHBhdGggYWZ0ZXIKIyBzbmFwc2hvdCB2ZXJpZmljYXRpb247IGEgZmFpbGVkIGJhY2t1cCBkZWxpYmVyYXRlbHkgcHJlc2VydmVzIGl0IGZvciBkaWFnbm9zaXMuCmNhc2UgIiRTUkMiIGluCiAgIiRNSVJST1JfUk9PVCIvIiRJTlNUQU5DRV9JRCIpCiAgICBNSVJST1JfS0I9IiQoZHUgLXNrICIkU1JDIiAyPi9kZXYvbnVsbCB8IGN1dCAtZjEpIjsgTUlSUk9SX0tCPSIke01JUlJPUl9LQjotMH0iCiAgICBpZiBybSAtcmYgLS0gIiRTUkMiOyB0aGVuCiAgICAgIGVjaG8gIlJFU1RJQ19NSVJST1JfQ0xFQU5VUF9PSyBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQgZnJlZWRfbWI9JCgoTUlSUk9SX0tCIC8gMTAyNCkpIgogICAgZWxzZQogICAgICBlY2hvICJSRVNUSUNfTUlSUk9SX0NMRUFOVVBfRkFJTEVEIGluc3RhbmNlPSRJTlNUQU5DRV9JRCBtaXJyb3I9JFNSQyIgPiYyCiAgICBmaQogICAgOzsKICAqKQogICAgZWNobyAiUkVTVElDX01JUlJPUl9DTEVBTlVQX1JFRlVTRUQgdW5zYWZlX21pcnJvcl9wYXRoPSRTUkMgaW5zdGFuY2U9JElOU1RBTkNFX0lEIiA+JjIKICAgIDs7CmVzYWMK";

// PostgREST caps an unpaged read, so the keep-set is read page by page, in id order,
// until the table is exhausted. A row past the cap would otherwise look stale and
// lose its mirror. Returns null when a page fails, so the caller skips the trim.
const KEEP_PAGE_SIZE = 1000;
async function listKeepIdRows(host: string): Promise<string[] | null> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabaseAdmin!
      .from("hermes_instances")
      .select("id")
      .is("deleted_at", null)
      .or(`proxmox_node.eq.${host},proxmox_node.is.null`);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query
      .order("id", { ascending: true })
      .limit(KEEP_PAGE_SIZE);
    if (error || !Array.isArray(data)) return null;
    const page = data as Array<{ id: string }>;
    ids.push(...page.map((r) => r.id));
    if (page.length < KEEP_PAGE_SIZE) return ids;
    cursor = page[page.length - 1].id;
  }
}

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

function buildInstallResticScript(): string {
  return `install -d -m 755 /usr/local/sbin
${buildColdStorageInstallScriptOrExit()}
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
      const keepRows = await listKeepIdRows(host);
      if (!keepRows) return;
      // Cross-check the paged list against a fresh exact count. If rows moved while we
      // read, the two disagree; skip the trim rather than remove a mirror that may be live.
      const { count, error: countError } = await supabaseAdmin!
        .from("hermes_instances")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .or(`proxmox_node.eq.${host},proxmox_node.is.null`);
      if (countError || count !== keepRows.length) {
        log.warn("mirror reconcile skipped: keep-set disagrees with a fresh count", {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "daily_instance_backup_mirror_reconcile_skipped",
          proxmox_node: host,
          listed: keepRows.length,
          counted: count,
        });
        return;
      }
      const keepIds = keepRows.filter((id) => SAFE_INSTANCE_ID.test(id));
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
