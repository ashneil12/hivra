import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  backupEncryptionEnvPrefix,
  buildAgeIdentityPrelude,
  resolveAgeIdentity,
  resolveBackupEncryption,
} from "@/lib/cold-storage/backup-encryption";
import { buildColdStorageInstallScript } from "@/lib/cold-storage-ssh";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import {
  buildHermesVmidBoundGuestSshPrelude,
  buildPinnedGuestSshReadinessWait,
  isHermesInstanceId,
} from "@/lib/proxmox/hermes-guest-ssh";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Per-host vzdump must finish (and be reaped) inside the Vercel function budget.
// maxDuration is 800s; Vercel SIGTERMs at that wall, so the host-script timeout
// must sit safely BELOW it or a long backup gets truncated mid-flight with no
// signal. Leave ~100s of margin for the surrounding handler + response.
const HOST_BACKUP_TIMEOUT_MS = 700_000;

const LOG_SOURCE = "cron:daily-vm-backups";
const ROUTE = "/api/cron/daily-vm-backups";
const SAFE_INSTANCE_ID = /^[0-9a-f-]{36}$/i;
const SAFE_TIER = /^[a-z0-9_:-]+$/i;
const DAILY_BACKUP_SCRIPT_B64 =
  "IyEvdXNyL2Jpbi9lbnYgYmFzaAojIGJhY2t1cC12bS1kYWlseS5zaCDigJQgbm9uLWRlc3RydWN0aXZlIGRhaWx5IFZNIGJhY2t1cCBmb3IgSGVybWVzT1MgcGFpZCB0ZW5hbnRzLgojCiMgUnVuIGZyb20gYSBQVkUgaG9zdC4gQXJnczogPHZtaWQ+IDxpbnN0YW5jZS1pZD4gPHRpZXI+CiMKIyBUaGlzIGlzIHNlcGFyYXRlIGZyb20gYXJjaGl2ZS12bS1jb2xkLnNoOgojIC0gbm8gbGlmZWN5Y2xlIHRyYW5zaXRpb24KIyAtIG5vIHFtIGRlc3Ryb3kKIyAtIG5vIGRhc2hib2FyZCBEQiBtdXRhdGlvbgojIC0gaW50ZW5kZWQgZm9yIGFjdGl2ZSBwYWlkIGluc3RhbmNlcwojCiMgSXQgY3JlYXRlcyBhIFByb3htb3ggc25hcHNob3QtbW9kZSB2emR1bXAgYXJjaGl2ZSwgdXBsb2FkcyBpdCB0byB0aGUgSGV0em5lcgojIFN0b3JhZ2UgQm94LCB3cml0ZXMgdGhlIG1hbmlmZXN0IGxhc3QsIHRoZW4gcmVtb3ZlcyB0aGUgbG9jYWwgdGVtcG9yYXJ5IGR1bXAuCiMKIyBEZWZhdWx0IGlzIGRyeS1ydW4uIFBhc3MgLS1hcHBseSBhcyB0aGUgZm91cnRoIGFyZyB0byBleGVjdXRlLgojCiMgT3B0aW9uYWwgZW5jcnlwdGlvbiBhdCByZXN0IChvZmYgYnkgZGVmYXVsdDsgd2l0aCBpdCBvZmYgbm90aGluZyBiZWxvdyBjaGFuZ2VzKToKIyAgIEhFUk1FU19CQUNLVVBfRU5DUllQVElPTj1vbiAgSEVSTUVTX0JBQ0tVUF9BR0VfUkVDSVBJRU5UPWFnZTEuLi4KIyBUaGUgdnpkdW1wIGFyY2hpdmUgaXMgZW5jcnlwdGVkIHdpdGggYGFnZWAgdG8gdGhhdCBQVUJMSUMgcmVjaXBpZW50IGJlZm9yZSB1cGxvYWQgYW5kIHRoZQojIHBsYWludGV4dCBpcyByZW1vdmVkIGZyb20gc2NyYXRjaC4gVGhlIHJlbW90ZSBuYW1lIGdhaW5zIGFuICIuYWdlIiBzdWZmaXgsIHRoZSBtYW5pZmVzdAojIGdhaW5zICJlbmNyeXB0aW9uIjogImFnZSIgYW5kICJwbGFpbl9zaGEyNTYiLCBhbmQgYmFja3VwX3NoYTI1NiAvIGJhY2t1cF9zaXplX2J5dGVzIGRlc2NyaWJlCiMgdGhlIHVwbG9hZGVkIChlbmNyeXB0ZWQpIGZpbGUuIE5vIHNlY3JldCBrZXkgaXMgZXZlciBuZWVkZWQgb24gdGhpcyBob3N0LiBUaGUgc2NyaXB0IG5ldmVyCiMgaW5zdGFsbHMgYWdlIGl0c2VsZi4KIyBSZWZ1c2FsIGV4aXQgY29kZXMgKGJlZm9yZSB2emR1bXAgcnVucyk6IDcgYWdlIG5vdCBpbnN0YWxsZWQsIDggbWlzc2luZy9pbnZhbGlkIHJlY2lwaWVudC4KIyBFeGl0IDk6IGFnZSBmYWlsZWQgYWZ0ZXIgdnpkdW1wIChub3RoaW5nIHVwbG9hZGVkKS4KCnNldCAtZXVvIHBpcGVmYWlsCgpWTUlEPSIkezE6LX0iCklOU1RBTkNFX0lEPSIkezI6LX0iClRJRVI9IiR7MzotfSIKTU9ERT0iJHs0Oi0tLWRyeS1ydW59IgoKaWYgWyAteiAiJFZNSUQiIF0gfHwgWyAteiAiJElOU1RBTkNFX0lEIiBdIHx8IFsgLXogIiRUSUVSIiBdOyB0aGVuCiAgZWNobyAidXNhZ2U6ICQwIDx2bWlkPiA8aW5zdGFuY2UtaWQ+IDx0aWVyPiBbLS1hcHBseV0iID4mMgogIGV4aXQgMQpmaQoKY2FzZSAiJFRJRVIiIGluCiAgb3BlcmF0b3J8ZmxlZXR8Y29tbWFuZHx3c19jbG91ZF9wcm98d3NfY2xvdWRfcG93ZXJ8Y3JlZGl0X3Byb3xjcmVkaXRfcG93ZXJ8cGFpZHxwcm98cG93ZXIpIFNUT1JBR0VfVElFUj0icGFpZCIgOzsKICAqKSBlY2hvICJyZWZ1c2luZyBkYWlseSBiYWNrdXAgZm9yIHVuc3VwcG9ydGVkIHRpZXI6ICRUSUVSIiA+JjI7IGV4aXQgMiA7Owplc2FjCgppZiBbICIkTU9ERSIgIT0gIi0tYXBwbHkiIF07IHRoZW4KICBlY2hvICJEUllfUlVOIHZtaWQ9JFZNSUQgaW5zdGFuY2U9JElOU1RBTkNFX0lEIHRpZXI9JFRJRVIgc3RvcmFnZV90aWVyPSRTVE9SQUdFX1RJRVIiCiAgZWNobyAid291bGQgcnVuOiB2emR1bXAgJFZNSUQgLS1tb2RlIHNuYXBzaG90IC0tY29tcHJlc3MgenN0ZCAtLWR1bXBkaXIgPHNjcmF0Y2g+IgogIGVjaG8gIndvdWxkIHVwbG9hZDogZGFpbHkvJFNUT1JBR0VfVElFUi8kSU5TVEFOQ0VfSUQvdnpkdW1wLXFlbXUtJFZNSUQtPHRzPi52bWEuenN0IgogIGVjaG8gIndvdWxkIHdyaXRlIG1hbmlmZXN0IGxhc3Q6IGRhaWx5LW1ldGEvJElOU1RBTkNFX0lELzx0cz4uanNvbiIKICBjYXNlICIke0hFUk1FU19CQUNLVVBfRU5DUllQVElPTjotfSIgaW4KICAgIG9ufDF8dHJ1ZXx5ZXMpIGVjaG8gIndvdWxkIGVuY3J5cHQgd2l0aCBhZ2UgYmVmb3JlIHVwbG9hZDsgcmVtb3RlIG5hbWUgZ2V0cyBhbiAuYWdlIHN1ZmZpeCIgOzsKICBlc2FjCiAgZXhpdCAwCmZpCgppZiAhIHFtIGNvbmZpZyAiJFZNSUQiID4vZGV2L251bGwgMj4mMTsgdGhlbgogIGVjaG8gIlskVk1JRF0gbm8gc3VjaCBWTSBvbiAkKGhvc3RuYW1lKSIgPiYyCiAgZXhpdCAzCmZpCgpCQUNLVVBfRU5DUllQVElPTj1vZmYKQkFDS1VQX0FHRV9SRUNJUElFTlQ9IiIKY2FzZSAiJHtIRVJNRVNfQkFDS1VQX0VOQ1JZUFRJT046LX0iIGluCiAgIiJ8b2ZmfDB8ZmFsc2V8bm8pIDs7CiAgb258MXx0cnVlfHllcykKICAgIEJBQ0tVUF9FTkNSWVBUSU9OPW9uCiAgICBCQUNLVVBfQUdFX1JFQ0lQSUVOVD0iJHtIRVJNRVNfQkFDS1VQX0FHRV9SRUNJUElFTlQ6LX0iCiAgICBpZiAhIFtbICIkQkFDS1VQX0FHRV9SRUNJUElFTlQiID1+IF5hZ2UxWzAtOWEtel17NTh9JCBdXTsgdGhlbgogICAgICBlY2hvICJSRUZVU0lOR19CQUNLVVBfQkFEX0FHRV9SRUNJUElFTlQgdm1pZD0kVk1JRDogSEVSTUVTX0JBQ0tVUF9FTkNSWVBUSU9OIGlzIG9uIGJ1dCBIRVJNRVNfQkFDS1VQX0FHRV9SRUNJUElFTlQgaXMgbWlzc2luZyBvciBub3QgYW4gYWdlMS4uLiBwdWJsaWMga2V5OyBub3RoaW5nIHdhcyBiYWNrZWQgdXAiID4mMgogICAgICBleGl0IDgKICAgIGZpCiAgICBpZiAhIGNvbW1hbmQgLXYgYWdlID4vZGV2L251bGwgMj4mMTsgdGhlbgogICAgICBlY2hvICJSRUZVU0lOR19CQUNLVVBfTk9fQUdFIHZtaWQ9JFZNSUQ6IEhFUk1FU19CQUNLVVBfRU5DUllQVElPTiBpcyBvbiBidXQgdGhlIGFnZSBiaW5hcnkgaXMgbm90IGluc3RhbGxlZCBvbiAkKGhvc3RuYW1lKTsgbm90aGluZyB3YXMgYmFja2VkIHVwIiA+JjIKICAgICAgZXhpdCA3CiAgICBmaQogICAgOzsKICAqKQogICAgZWNobyAiUkVGVVNJTkdfQkFDS1VQX0JBRF9BR0VfUkVDSVBJRU5UIHZtaWQ9JFZNSUQ6IHVucmVjb2duaXNlZCBIRVJNRVNfQkFDS1VQX0VOQ1JZUFRJT04gdmFsdWU7IHVzZSBvbiBvciBvZmY7IG5vdGhpbmcgd2FzIGJhY2tlZCB1cCIgPiYyCiAgICBleGl0IDgKICAgIDs7CmVzYWMKCk1JTl9IT1NUX0hFQURST09NX01CPSIke0hFUk1FU19EQUlMWV9CQUNLVVBfTUlOX0hPU1RfSEVBRFJPT01fTUI6LTgxOTJ9IgpNSU5fU0NSQVRDSF9NQj0iJHtIRVJNRVNfREFJTFlfQkFDS1VQX01JTl9TQ1JBVENIX01COi0zMjc2OH0iCgppZiAhIFtbICIkTUlOX0hPU1RfSEVBRFJPT01fTUIiID1+IF5bMC05XSskIF1dOyB0aGVuCiAgZWNobyAiaW52YWxpZCBIRVJNRVNfREFJTFlfQkFDS1VQX01JTl9IT1NUX0hFQURST09NX01CPSRNSU5fSE9TVF9IRUFEUk9PTV9NQiIgPiYyCiAgZXhpdCA1CmZpCmlmICEgW1sgIiRNSU5fU0NSQVRDSF9NQiIgPX4gXlswLTldKyQgXV07IHRoZW4KICBlY2hvICJpbnZhbGlkIEhFUk1FU19EQUlMWV9CQUNLVVBfTUlOX1NDUkFUQ0hfTUI9JE1JTl9TQ1JBVENIX01CIiA+JjIKICBleGl0IDYKZmkKCnJlYWQgLXIgTUVNX1RPVEFMX0tCIE1FTV9BVkFJTEFCTEVfS0IgU1dBUF9UT1RBTF9LQiBTV0FQX0ZSRUVfS0IgPCA8KAogIGF3ayAnCiAgICAvXk1lbVRvdGFsOi8geyBtdD0kMiB9CiAgICAvXk1lbUF2YWlsYWJsZTovIHsgbWE9JDIgfQogICAgL15Td2FwVG90YWw6LyB7IHN0PSQyIH0KICAgIC9eU3dhcEZyZWU6LyB7IHNmPSQyIH0KICAgIEVORCB7IHByaW50IG10KzAsIG1hKzAsIHN0KzAsIHNmKzAgfQogICcgL3Byb2MvbWVtaW5mbwopCk1FTV9UT1RBTF9NQj0kKChNRU1fVE9UQUxfS0IgLyAxMDI0KSkKTUVNX0FWQUlMQUJMRV9NQj0kKChNRU1fQVZBSUxBQkxFX0tCIC8gMTAyNCkpClNXQVBfVE9UQUxfTUI9JCgoU1dBUF9UT1RBTF9LQiAvIDEwMjQpKQpTV0FQX0ZSRUVfTUI9JCgoU1dBUF9GUkVFX0tCIC8gMTAyNCkpClZNX1NUQVRVUz0iJChxbSBzdGF0dXMgIiRWTUlEIiAyPi9kZXYvbnVsbCB8fCB0cnVlKSIKVk1fTUVNT1JZX01CPSIkKHFtIGNvbmZpZyAiJFZNSUQiIDI+L2Rldi9udWxsIHwgYXdrICcvXm1lbW9yeTovIHsgcHJpbnQgJDI7IGV4aXQgfScpIgpWTV9CQUxMT09OX01CPSIkKHFtIGNvbmZpZyAiJFZNSUQiIDI+L2Rldi9udWxsIHwgYXdrICcvXmJhbGxvb246LyB7IHByaW50ICQyOyBleGl0IH0nKSIKVk1fTUVNT1JZX01CPSIke1ZNX01FTU9SWV9NQjotdW5rbm93bn0iClZNX0JBTExPT05fTUI9IiR7Vk1fQkFMTE9PTl9NQjotdW5zZXR9IgpSVU5OSU5HX1ZNX01BWF9NRU1PUllfTUI9MApSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQj0wCndoaWxlIElGUz0gcmVhZCAtciBSVU5OSU5HX1ZNSUQ7IGRvCiAgWyAtbiAiJFJVTk5JTkdfVk1JRCIgXSB8fCBjb250aW51ZQogIFJVTk5JTkdfVk1fTUVNT1JZX01CPSIkKHFtIGNvbmZpZyAiJFJVTk5JTkdfVk1JRCIgMj4vZGV2L251bGwgfCBhd2sgJy9ebWVtb3J5Oi8geyBwcmludCAkMjsgZXhpdCB9JykiCiAgUlVOTklOR19WTV9CQUxMT09OX01CPSIkKHFtIGNvbmZpZyAiJFJVTk5JTkdfVk1JRCIgMj4vZGV2L251bGwgfCBhd2sgJy9eYmFsbG9vbjovIHsgcHJpbnQgJDI7IGV4aXQgfScpIgogIFJVTk5JTkdfVk1fRUZGRUNUSVZFX01FTU9SWV9NQj0iJFJVTk5JTkdfVk1fTUVNT1JZX01CIgogIGlmIFtbICIkUlVOTklOR19WTV9CQUxMT09OX01CIiA9fiBeWzAtOV0rJCBdXSAmJiBbICIkUlVOTklOR19WTV9CQUxMT09OX01CIiAtZ3QgMCBdOyB0aGVuCiAgICBSVU5OSU5HX1ZNX0VGRkVDVElWRV9NRU1PUllfTUI9IiRSVU5OSU5HX1ZNX0JBTExPT05fTUIiCiAgZmkKICBpZiBbWyAiJFJVTk5JTkdfVk1fTUVNT1JZX01CIiA9fiBeWzAtOV0rJCBdXTsgdGhlbgogICAgUlVOTklOR19WTV9NQVhfTUVNT1JZX01CPSQoKFJVTk5JTkdfVk1fTUFYX01FTU9SWV9NQiArIFJVTk5JTkdfVk1fTUVNT1JZX01CKSkKICBmaQogIGlmIFtbICIkUlVOTklOR19WTV9FRkZFQ1RJVkVfTUVNT1JZX01CIiA9fiBeWzAtOV0rJCBdXTsgdGhlbgogICAgUlVOTklOR19WTV9FRkZFQ1RJVkVfVE9UQUxfTUI9JCgoUlVOTklOR19WTV9FRkZFQ1RJVkVfVE9UQUxfTUIgKyBSVU5OSU5HX1ZNX0VGRkVDVElWRV9NRU1PUllfTUIpKQogIGZpCmRvbmUgPCA8KHFtIGxpc3QgfCBhd2sgJ05SID4gMSAmJiAkMyA9PSAicnVubmluZyIgeyBwcmludCAkMSB9JykKSE9TVF9NRU1PUllfTUFSR0lOX01CPSQoKE1FTV9UT1RBTF9NQiAtIFJVTk5JTkdfVk1fRUZGRUNUSVZFX1RPVEFMX01CKSkKCmVjaG8gIk1FTU9SWV9QUkVGTElHSFQgdm1pZD0kVk1JRCBzdGF0dXM9JHtWTV9TVEFUVVM6LXVua25vd259IGhvc3RfbWVtX2F2YWlsYWJsZV9tYj0kTUVNX0FWQUlMQUJMRV9NQiBob3N0X21lbV90b3RhbF9tYj0kTUVNX1RPVEFMX01CIGhvc3Rfc3dhcF9mcmVlX21iPSRTV0FQX0ZSRUVfTUIgaG9zdF9zd2FwX3RvdGFsX21iPSRTV0FQX1RPVEFMX01CIHZtX21lbW9yeV9tYj0kVk1fTUVNT1JZX01CIHZtX2JhbGxvb25fbWI9JFZNX0JBTExPT05fTUIgcnVubmluZ192bV9tYXhfbWVtb3J5X21iPSRSVU5OSU5HX1ZNX01BWF9NRU1PUllfTUIgcnVubmluZ192bV9lZmZlY3RpdmVfbWVtb3J5X21iPSRSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQiBob3N0X21lbW9yeV9tYXJnaW5fbWI9JEhPU1RfTUVNT1JZX01BUkdJTl9NQiBtaW5faG9zdF9oZWFkcm9vbV9tYj0kTUlOX0hPU1RfSEVBRFJPT01fTUIiCmlmIFsgIiRNRU1fQVZBSUxBQkxFX01CIiAtbHQgIiRNSU5fSE9TVF9IRUFEUk9PTV9NQiIgXTsgdGhlbgogIGVjaG8gIlJFRlVTSU5HX0JBQ0tVUF9MT1dfSE9TVF9NRU1PUlkgdm1pZD0kVk1JRCBob3N0X21lbV9hdmFpbGFibGVfbWI9JE1FTV9BVkFJTEFCTEVfTUIgbWluX2hvc3RfaGVhZHJvb21fbWI9JE1JTl9IT1NUX0hFQURST09NX01CIGhvc3Rfc3dhcF9mcmVlX21iPSRTV0FQX0ZSRUVfTUIgdm1fbWVtb3J5X21iPSRWTV9NRU1PUllfTUIgdm1fYmFsbG9vbl9tYj0kVk1fQkFMTE9PTl9NQiBzdGF0dXM9JHtWTV9TVEFUVVM6LXVua25vd259IiA+JjIKICBleGl0IDUKZmkKaWYgWyAiJEhPU1RfTUVNT1JZX01BUkdJTl9NQiIgLWx0ICIkTUlOX0hPU1RfSEVBRFJPT01fTUIiIF07IHRoZW4KICBlY2hvICJSRUZVU0lOR19CQUNLVVBfVU5TQUZFX1ZNX01FTU9SWV9GT09UUFJJTlQgdm1pZD0kVk1JRCBob3N0X21lbV90b3RhbF9tYj0kTUVNX1RPVEFMX01CIHJ1bm5pbmdfdm1fbWF4X21lbW9yeV9tYj0kUlVOTklOR19WTV9NQVhfTUVNT1JZX01CIHJ1bm5pbmdfdm1fZWZmZWN0aXZlX21lbW9yeV9tYj0kUlVOTklOR19WTV9FRkZFQ1RJVkVfVE9UQUxfTUIgaG9zdF9tZW1vcnlfbWFyZ2luX21iPSRIT1NUX01FTU9SWV9NQVJHSU5fTUIgbWluX2hvc3RfaGVhZHJvb21fbWI9JE1JTl9IT1NUX0hFQURST09NX01CIGhvc3RfbWVtX2F2YWlsYWJsZV9tYj0kTUVNX0FWQUlMQUJMRV9NQiBob3N0X3N3YXBfZnJlZV9tYj0kU1dBUF9GUkVFX01CIHZtX21lbW9yeV9tYj0kVk1fTUVNT1JZX01CIHZtX2JhbGxvb25fbWI9JFZNX0JBTExPT05fTUIgc3RhdHVzPSR7Vk1fU1RBVFVTOi11bmtub3dufSIgPiYyCiAgZXhpdCA1CmZpCmRlY2xhcmUgLWEgU0NSQVRDSF9DQU5ESURBVEVTPSgpCmFkZF9zY3JhdGNoX2NhbmRpZGF0ZSgpIHsKICBsb2NhbCByb290PSIkezElL30iCiAgWyAtbiAiJHJvb3QiIF0gfHwgcmV0dXJuIDAKICBsb2NhbCBleGlzdGluZwogIGZvciBleGlzdGluZyBpbiAiJHtTQ1JBVENIX0NBTkRJREFURVNbQF19IjsgZG8KICAgIFsgIiRleGlzdGluZyIgPSAiJHJvb3QiIF0gJiYgcmV0dXJuIDAKICBkb25lCiAgU0NSQVRDSF9DQU5ESURBVEVTKz0oIiRyb290IikKfQoKaWYgWyAtbiAiJHtIRVJNRVNfREFJTFlfQkFDS1VQX1NDUkFUQ0hfUk9PVFM6LX0iIF07IHRoZW4KICBJRlM9Jyw6ICcgcmVhZCAtciAtYSBDT05GSUdVUkVEX1NDUkFUQ0hfUk9PVFMgPDw8ICIkSEVSTUVTX0RBSUxZX0JBQ0tVUF9TQ1JBVENIX1JPT1RTIgogIGZvciByb290IGluICIke0NPTkZJR1VSRURfU0NSQVRDSF9ST09UU1tAXX0iOyBkbwogICAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIkcm9vdCIKICBkb25lCmVsc2UKICBpZiBjb21tYW5kIC12IHB2ZXNtID4vZGV2L251bGwgMj4mMTsgdGhlbgogICAgd2hpbGUgSUZTPSByZWFkIC1yIHN0b3JhZ2VfaWQ7IGRvCiAgICAgIFsgLW4gIiRzdG9yYWdlX2lkIiBdIHx8IGNvbnRpbnVlCiAgICAgIHN0b3JhZ2VfcGF0aD0iJChwdmVzbSBwYXRoICIkc3RvcmFnZV9pZCIgMj4vZGV2L251bGwgfHwgdHJ1ZSkiCiAgICAgIFsgLW4gIiRzdG9yYWdlX3BhdGgiIF0gfHwgY29udGludWUKICAgICAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIkc3RvcmFnZV9wYXRoL2R1bXAiCiAgICAgIGFkZF9zY3JhdGNoX2NhbmRpZGF0ZSAiJHN0b3JhZ2VfcGF0aCIKICAgIGRvbmUgPCA8KHB2ZXNtIHN0YXR1cyAtY29udGVudCBiYWNrdXAgMj4vZGV2L251bGwgfCBhd2sgJ05SID4gMSAmJiAkMyA9PSAiYWN0aXZlIiB7IHByaW50ICQxIH0nKQogIGZpCiAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIvdmFyL2xpYi92ei9kdW1wIgogIGFkZF9zY3JhdGNoX2NhbmRpZGF0ZSAiL3Zhci90bXAiCiAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIvc3J2IgogIGFkZF9zY3JhdGNoX2NhbmRpZGF0ZSAiL3RtcCIKZmkKClNDUkFUQ0hfUk9PVD0iIgpTQ1JBVENIX1JPT1RfQVZBSUxfTUI9MApTQ1JBVENIX1JPT1RfRlM9InVua25vd24iCnNlbGVjdF9zY3JhdGNoX3Jvb3QoKSB7CiAgbG9jYWwgYmVzdD0iIgogIGxvY2FsIGJlc3RfYXZhaWw9MAogIGxvY2FsIGJlc3RfZnM9InVua25vd24iCiAgbG9jYWwgcm9vdCBhdmFpbCBmcwogIGZvciByb290IGluICIke1NDUkFUQ0hfQ0FORElEQVRFU1tAXX0iOyBkbwogICAgbWtkaXIgLXAgIiRyb290IiA+L2Rldi9udWxsIDI+JjEgfHwgdHJ1ZQogICAgaWYgWyAhIC1kICIkcm9vdCIgXSB8fCBbICEgLXcgIiRyb290IiBdOyB0aGVuCiAgICAgIGVjaG8gIlNDUkFUQ0hfQ0FORElEQVRFIHJvb3Q9JHJvb3Qgd3JpdGFibGU9bm8gcmVxdWlyZWRfbWI9JE1JTl9TQ1JBVENIX01CIgogICAgICBjb250aW51ZQogICAgZmkKICAgIGF2YWlsPSIkKGRmIC1QbSAiJHJvb3QiIDI+L2Rldi9udWxsIHwgYXdrICdOUiA9PSAyIHsgcHJpbnQgJDQrMCB9JykiCiAgICBmcz0iJChkZiAtUFQgIiRyb290IiAyPi9kZXYvbnVsbCB8IGF3ayAnTlIgPT0gMiB7IHByaW50ICQyIH0nKSIKICAgIGF2YWlsPSIke2F2YWlsOi0wfSIKICAgIGZzPSIke2ZzOi11bmtub3dufSIKICAgIGVjaG8gIlNDUkFUQ0hfQ0FORElEQVRFIHJvb3Q9JHJvb3QgZnM9JGZzIGF2YWlsX21iPSRhdmFpbCByZXF1aXJlZF9tYj0kTUlOX1NDUkFUQ0hfTUIiCiAgICBpZiBbWyAiJGF2YWlsIiA9fiBeWzAtOV0rJCBdXSAmJiBbICIkYXZhaWwiIC1nZSAiJE1JTl9TQ1JBVENIX01CIiBdICYmIFsgIiRhdmFpbCIgLWd0ICIkYmVzdF9hdmFpbCIgXTsgdGhlbgogICAgICBiZXN0PSIkcm9vdCIKICAgICAgYmVzdF9hdmFpbD0iJGF2YWlsIgogICAgICBiZXN0X2ZzPSIkZnMiCiAgICBmaQogIGRvbmUKICBpZiBbIC16ICIkYmVzdCIgXTsgdGhlbgogICAgZWNobyAiUkVGVVNJTkdfQkFDS1VQX05PX1NDUkFUQ0hfU1BBQ0Ugdm1pZD0kVk1JRCByZXF1aXJlZF9tYj0kTUlOX1NDUkFUQ0hfTUIgY2FuZGlkYXRlcz0ke1NDUkFUQ0hfQ0FORElEQVRFU1sqXTotbm9uZX0iID4mMgogICAgZXhpdCA2CiAgZmkKICBTQ1JBVENIX1JPT1Q9IiRiZXN0IgogIFNDUkFUQ0hfUk9PVF9BVkFJTF9NQj0iJGJlc3RfYXZhaWwiCiAgU0NSQVRDSF9ST09UX0ZTPSIkYmVzdF9mcyIKICBlY2hvICJTQ1JBVENIX1NFTEVDVEVEIHJvb3Q9JFNDUkFUQ0hfUk9PVCBmcz0kU0NSQVRDSF9ST09UX0ZTIGF2YWlsX21iPSRTQ1JBVENIX1JPT1RfQVZBSUxfTUIgcmVxdWlyZWRfbWI9JE1JTl9TQ1JBVENIX01CIgp9CnNlbGVjdF9zY3JhdGNoX3Jvb3QKCmlmIFsgIiR7SEVSTUVTX0RBSUxZX0JBQ0tVUF9QUkVGTElHSFRfT05MWTotMH0iID0gIjEiIF07IHRoZW4KICBlY2hvICJQUkVGTElHSFRfT0sgdm1pZD0kVk1JRCBob3N0X21lbW9yeV9tYXJnaW5fbWI9JEhPU1RfTUVNT1JZX01BUkdJTl9NQiBob3N0X21lbV9hdmFpbGFibGVfbWI9JE1FTV9BVkFJTEFCTEVfTUIgcnVubmluZ192bV9lZmZlY3RpdmVfbWVtb3J5X21iPSRSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQiBydW5uaW5nX3ZtX21heF9tZW1vcnlfbWI9JFJVTk5JTkdfVk1fTUFYX01FTU9SWV9NQiBzY3JhdGNoX3Jvb3Q9JFNDUkFUQ0hfUk9PVCBzY3JhdGNoX2F2YWlsX21iPSRTQ1JBVENIX1JPT1RfQVZBSUxfTUIgc2NyYXRjaF9yZXF1aXJlZF9tYj0kTUlOX1NDUkFUQ0hfTUIiCiAgZXhpdCAwCmZpCgpQVkVfSE9TVD0iJChob3N0bmFtZSkiClRTPSIkKGRhdGUgLXUgKyVZJW0lZFQlSCVNJVNaKSIKU0NSQVRDSD0iJChta3RlbXAgLWQgIiRTQ1JBVENIX1JPT1QvaGVybWVzLWRhaWx5LWJhY2t1cC0kVk1JRC1YWFhYIikiCnRyYXAgJ3JtIC1yZiAiJFNDUkFUQ0giJyBFWElUCgpSRU1PVEVfRElSPSJkYWlseS8kU1RPUkFHRV9USUVSLyRJTlNUQU5DRV9JRCIKUkVNT1RFX0FSQ0hJVkU9IiRSRU1PVEVfRElSL3Z6ZHVtcC1xZW11LSRWTUlELSRUUy52bWEuenN0IgpSRU1PVEVfTUFOSUZFU1Q9ImRhaWx5LW1ldGEvJElOU1RBTkNFX0lELyRUUy5qc29uIgoKIyB2emR1bXAgaW4gc25hcHNob3QgbW9kZSBpcyB0aGUga2V5IGRpc3RpbmN0aW9uIGZyb20gY29sZCBhcmNoaXZlOiBzb3VyY2UgVk0KIyByZW1haW5zIGFjdGl2ZSBhbmQgbm8gYXBwbGljYXRpb24gY29udGFpbmVycyBhcmUgZGVsaWJlcmF0ZWx5IHN0b3BwZWQuCmVjaG8gIuKVkOKVkOKVkCBkYWlseS1iYWNrdXAgVk1JRD0kVk1JRCBQVkU9JFBWRV9IT1NUIGluc3RhbmNlPSRJTlNUQU5DRV9JRCB0cz0kVFMg4pWQ4pWQ4pWQIgp2emR1bXAgIiRWTUlEIiBcCiAgLS1tb2RlIHNuYXBzaG90IFwKICAtLWNvbXByZXNzIHpzdGQgXAogIC0tZHVtcGRpciAiJFNDUkFUQ0giIFwKICAtLXF1aWV0IDEKCkFSQ0hJVkU9IiQoZmluZCAiJFNDUkFUQ0giIC1tYXhkZXB0aCAxIC10eXBlIGYgLW5hbWUgInZ6ZHVtcC1xZW11LSR7Vk1JRH0tKi52bWEuenN0IiB8IGhlYWQgLTEpIgppZiBbIC16ICIkQVJDSElWRSIgXSB8fCBbICEgLXMgIiRBUkNISVZFIiBdOyB0aGVuCiAgZWNobyAidnpkdW1wIGRpZCBub3QgcHJvZHVjZSBhcmNoaXZlIGZvciBWTUlEPSRWTUlEIiA+JjIKICBleGl0IDQKZmkKCkFSQ0hJVkVfU0laRT0iJChzdGF0IC1jICVzICIkQVJDSElWRSIgMj4vZGV2L251bGwgfHwgc3RhdCAtZiAleiAiJEFSQ0hJVkUiKSIKQVJDSElWRV9TSEE9IiQoc2hhMjU2c3VtICIkQVJDSElWRSIgfCBhd2sgJ3twcmludCAkMX0nKSIKCk1BTklGRVNUX0VOQ19GSUVMRFM9IiIKaWYgWyAiJEJBQ0tVUF9FTkNSWVBUSU9OIiA9ICJvbiIgXTsgdGhlbgogIFBMQUlOX1NIQT0iJEFSQ0hJVkVfU0hBIgogIGVjaG8gIkVOQ1JZUFRJTkcgdm1pZD0kVk1JRCB3aXRoIGFnZSAocHVibGljIHJlY2lwaWVudCkiCiAgaWYgISBhZ2UgLXIgIiRCQUNLVVBfQUdFX1JFQ0lQSUVOVCIgLW8gIiRBUkNISVZFLmFnZSIgIiRBUkNISVZFIiB8fCBbICEgLXMgIiRBUkNISVZFLmFnZSIgXTsgdGhlbgogICAgZWNobyAiYWdlIGVuY3J5cHRpb24gZmFpbGVkIGZvciBWTUlEPSRWTUlEOyBub3RoaW5nIHVwbG9hZGVkIiA+JjIKICAgIHJtIC1mICIkQVJDSElWRS5hZ2UiCiAgICBleGl0IDkKICBmaQogICMgVGhlIHBsYWludGV4dCBtdXN0IG5vdCBvdXRsaXZlIHRoZSBlbmNyeXB0ZWQgY29weSBvbiBzY3JhdGNoLgogIHJtIC1mICIkQVJDSElWRSIKICBBUkNISVZFPSIkQVJDSElWRS5hZ2UiCiAgUkVNT1RFX0FSQ0hJVkU9IiRSRU1PVEVfQVJDSElWRS5hZ2UiCiAgQVJDSElWRV9TSVpFPSIkKHN0YXQgLWMgJXMgIiRBUkNISVZFIiAyPi9kZXYvbnVsbCB8fCBzdGF0IC1mICV6ICIkQVJDSElWRSIpIgogIEFSQ0hJVkVfU0hBPSIkKHNoYTI1NnN1bSAiJEFSQ0hJVkUiIHwgYXdrICd7cHJpbnQgJDF9JykiCiAgcHJpbnRmIC12IE1BTklGRVNUX0VOQ19GSUVMRFMgJ1xuICAiZW5jcnlwdGlvbiI6ICJhZ2UiLFxuICAicGxhaW5fc2hhMjU2IjogIiVzIiwnICIkUExBSU5fU0hBIgpmaQoKc3NoIGNvbGQgIm1rZGlyIC1wICRSRU1PVEVfRElSIGRhaWx5LW1ldGEvJElOU1RBTkNFX0lEIiA+L2Rldi9udWxsCnJzeW5jIC1hIC0taW5wbGFjZSAtLXBhcnRpYWwgLWUgc3NoICIkQVJDSElWRSIgImNvbGQ6JFJFTU9URV9BUkNISVZFIgoKTUFOSUZFU1Q9IiRTQ1JBVENIL21hbmlmZXN0LSRUUy5qc29uIgpjYXQgPiAiJE1BTklGRVNUIiA8PEpTT04KewogICJzY2hlbWFfdmVyc2lvbiI6IDIsCiAgImtpbmQiOiAiZGFpbHlfdm1fYmFja3VwIiwKICAiYmFja2VkX3VwX2F0IjogIiQoZGF0ZSAtdSArJVktJW0tJWRUJUg6JU06JVNaKSIsCiAgImluc3RhbmNlX2lkIjogIiRJTlNUQU5DRV9JRCIsCiAgInZtaWQiOiAkVk1JRCwKICAicHZlX2hvc3QiOiAiJFBWRV9IT1NUIiwKICAidGllciI6ICIkU1RPUkFHRV9USUVSIiwKICAiYmFja3VwX3BhdGgiOiAiJFJFTU9URV9BUkNISVZFIiwKICAiYmFja3VwX3NpemVfYnl0ZXMiOiAkQVJDSElWRV9TSVpFLAogICJiYWNrdXBfc2hhMjU2IjogIiRBUkNISVZFX1NIQSIsJE1BTklGRVNUX0VOQ19GSUVMRFMKICAibW9kZSI6ICJ2emR1bXBfc25hcHNob3QiLAogICJzb3VyY2VfZGVzdHJveWVkIjogZmFsc2UsCiAgInJldGVudGlvbiI6IHsKICAgICJkYWlseV9rZWVwIjogNwogIH0KfQpKU09OCnJzeW5jIC1hIC1lIHNzaCAiJE1BTklGRVNUIiAiY29sZDokUkVNT1RFX01BTklGRVNUIgoKIyBLZWVwIGEgcm9sbGluZyA3LWRheSBzZXQgcGVyIHBhaWQgaW5zdGFuY2UuIFRoZSBtYW5pZmVzdCBpcyB0aGUgc291cmNlIG9mIHRydXRoCiMgYW5kIGlzIHdyaXR0ZW4gbGFzdCwgc28gcmV0ZW50aW9uIG9ubHkgcnVucyBhZnRlciB0aGUgbmV3IGJhY2t1cCBpcyBkdXJhYmxlLgpSRVRFTlRJT05fTUVUQT0iJFNDUkFUQ0gvcmV0ZW50aW9uLW1ldGEiCm1rZGlyIC1wICIkUkVURU5USU9OX01FVEEiCnJzeW5jIC1hIC1lIHNzaCAiY29sZDpkYWlseS1tZXRhLyRJTlNUQU5DRV9JRC8iICIkUkVURU5USU9OX01FVEEvIiA+L2Rldi9udWxsIDI+JjEgfHwgdHJ1ZQptYXBmaWxlIC10IFJFVEVOVElPTl9NQU5JRkVTVFMgPCA8KGZpbmQgIiRSRVRFTlRJT05fTUVUQSIgLW1heGRlcHRoIDEgLXR5cGUgZiAtbmFtZSAnKi5qc29uJyB8IHNvcnQpClJFVEVOVElPTl9UT1RBTD0iJHsjUkVURU5USU9OX01BTklGRVNUU1tAXX0iClJFVEVOVElPTl9LRUVQPTcKaWYgWyAiJFJFVEVOVElPTl9UT1RBTCIgLWd0ICIkUkVURU5USU9OX0tFRVAiIF07IHRoZW4KICBSRVRFTlRJT05fREVMRVRFX0NPVU5UPSQoKFJFVEVOVElPTl9UT1RBTCAtIFJFVEVOVElPTl9LRUVQKSkKICBmb3IgT0xEX01BTklGRVNUX0xPQ0FMIGluICIke1JFVEVOVElPTl9NQU5JRkVTVFNbQF06MDokUkVURU5USU9OX0RFTEVURV9DT1VOVH0iOyBkbwogICAgT0xEX01BTklGRVNUX05BTUU9IiQoYmFzZW5hbWUgIiRPTERfTUFOSUZFU1RfTE9DQUwiKSIKICAgIE9MRF9CQUNLVVBfUEFUSD0iJChweXRob24zIC0gIiRPTERfTUFOSUZFU1RfTE9DQUwiICIkSU5TVEFOQ0VfSUQiIDw8J1BZJwppbXBvcnQganNvbiwgcmUsIHN5cwpwYXRoPXN5cy5hcmd2WzFdCmluc3RhbmNlX2lkPXN5cy5hcmd2WzJdCnRyeToKICAgIGRhdGE9anNvbi5sb2FkKG9wZW4ocGF0aCkpCiAgICBiYWNrdXA9c3RyKGRhdGEuZ2V0KCdiYWNrdXBfcGF0aCcsJycpKQpleGNlcHQgRXhjZXB0aW9uOgogICAgc3lzLmV4aXQoMCkKZXhwZWN0ZWQ9ZiJkYWlseS9wYWlkL3tpbnN0YW5jZV9pZH0vIgppZiBub3QgYmFja3VwLnN0YXJ0c3dpdGgoZXhwZWN0ZWQpOgogICAgc3lzLmV4aXQoMCkKaWYgbm90IHJlLm1hdGNoKHIiXmRhaWx5L3BhaWQvWzAtOWEtZi1dezM2fS92emR1bXAtcWVtdS1bMC05XSstWzAtOV17OH1UWzAtOV17Nn1aXC52bWFcLnpzdChcLmFnZSk/JCIsIGJhY2t1cCk6CiAgICBzeXMuZXhpdCgwKQpwcmludChiYWNrdXApClBZCikiCiAgICBpZiBbIC1uICIkT0xEX0JBQ0tVUF9QQVRIIiBdOyB0aGVuCiAgICAgIHNzaCBjb2xkICJybSAtZiAtLSAnJE9MRF9CQUNLVVBfUEFUSCcgJ2RhaWx5LW1ldGEvJElOU1RBTkNFX0lELyRPTERfTUFOSUZFU1RfTkFNRSciID4vZGV2L251bGwKICAgICAgZWNobyAiUkVURU5USU9OX0RFTEVURUQgbWFuaWZlc3Q9ZGFpbHktbWV0YS8kSU5TVEFOQ0VfSUQvJE9MRF9NQU5JRkVTVF9OQU1FIGFyY2hpdmU9JE9MRF9CQUNLVVBfUEFUSCIKICAgIGVsc2UKICAgICAgZWNobyAiUkVURU5USU9OX1NLSVBQRUQgdW5zYWZlX29yX3VucmVhZGFibGVfbWFuaWZlc3Q9JE9MRF9NQU5JRkVTVF9OQU1FIiA+JjIKICAgIGZpCiAgZG9uZQpmaQoKZWNobyAi4pWQ4pWQ4pWQIGRvbmU6ICRJTlNUQU5DRV9JRCDihpIgY29sZDokUkVNT1RFX0FSQ0hJVkUg4pWQ4pWQ4pWQIgplY2hvICJCQUNLVVAgc2hhMjU2PSRBUkNISVZFX1NIQSBzaXplPSRBUkNISVZFX1NJWkUgaWlkPSRJTlNUQU5DRV9JRCB0cz0kVFMgdm1pZD0kVk1JRCBob3N0PSRQVkVfSE9TVCBwYXRoPSRSRU1PVEVfQVJDSElWRSBtYW5pZmVzdD0kUkVNT1RFX01BTklGRVNUIgo=";


type BackupCandidate = {
  id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  status: string | null;
  ipv4_address?: string | null;
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

// Host output goes through the shared redactor, so the same token shapes are masked here as in
// ops_events and the push gate. A PEM-only copy here let provider keys, bot tokens and AWS keys through.
function redactHostOutput(value: string, max = 4000): string {
  return redactSensitiveCommandOutput(value, max);
}

function buildInstallDailyBackupScript(): string {
  // The alias needs the key plus the box host and user from env. When any of
  // them is missing the install is skipped with a warning, as it always was for
  // a missing key. A host that already has the alias from an earlier run keeps
  // it; a host without one fails at the backup script's first `ssh cold`.
  const coldStorage = buildColdStorageInstallScript();
  const storageKeyInstall = coldStorage.ok
    ? coldStorage.script
    : `echo "WARNING: ${coldStorage.reason}; cold Storage Box SSH alias not installed" >&2`;

  return `install -d -m 755 /usr/local/sbin
${storageKeyInstall}
base64 -d > /usr/local/sbin/backup-vm-daily.sh <<'HERMES_DAILY_BACKUP_SCRIPT'
${DAILY_BACKUP_SCRIPT_B64}
HERMES_DAILY_BACKUP_SCRIPT
chmod 755 /usr/local/sbin/backup-vm-daily.sh`;
}

// "" when encryption is off, so every invocation below is unchanged. Only the
// PUBLIC age recipient is ever put on a command line.
function encryptionPrefix(): string {
  return backupEncryptionEnvPrefix(resolveBackupEncryption(process.env));
}

function buildHostPreflightScript(row: BackupCandidate): string {
  return `set -euo pipefail
${buildInstallDailyBackupScript()}
${encryptionPrefix()}HERMES_DAILY_BACKUP_PREFLIGHT_ONLY=1 /usr/local/sbin/backup-vm-daily.sh ${row.proxmox_vmid} ${shellQuote(row.id)} ${shellQuote(row.resource_tier!)} --apply
`;
}

function buildMemoryHeadroomRepairScript(row: BackupCandidate, balloonMb: number): string {
  const guestIp = row.ipv4_address?.trim() ?? "";
  return `set -euo pipefail
${buildInstallDailyBackupScript()}
VMID=${row.proxmox_vmid}
GUEST_IP=${shellQuote(guestIp)}
TARGET_BALLOON_MB=${balloonMb}
echo "REPAIR_BEGIN host=$(hostname) vmid=$VMID target_balloon_mb=$TARGET_BALLOON_MB guest_ip=$GUEST_IP"
echo "BEFORE_QM_STATUS=$(qm status "$VMID" 2>/dev/null || true)"
echo "BEFORE_QM_CONFIG"
qm config "$VMID" 2>/dev/null | grep -E '^(name|memory|balloon|cores):' || true
echo "BEFORE_MEMINFO"
awk '/^MemTotal:|^MemAvailable:|^SwapTotal:|^SwapFree:/ { print }' /proc/meminfo
qm set "$VMID" --balloon "$TARGET_BALLOON_MB"
echo "APPLIED_BALLOON target_balloon_mb=$TARGET_BALLOON_MB"
if [ -n "$GUEST_IP" ] && [ -r /etc/hivra/keys/vm-orchestrator ]; then
  echo "GUEST_CACHE_DROP_BEGIN ip=$GUEST_IP"
  GUEST_KNOWN_HOSTS=/tmp/hermes-daily-backup-guest-known-hosts
  touch "$GUEST_KNOWN_HOSTS"
  chmod 600 "$GUEST_KNOWN_HOSTS"
  ssh -i /etc/hivra/keys/vm-orchestrator     -o BatchMode=yes     -o StrictHostKeyChecking=accept-new     -o UserKnownHostsFile="$GUEST_KNOWN_HOSTS"     -o ConnectTimeout=15     hermes@"$GUEST_IP" 'free -h; sudo -n sync; sudo -n sh -lc "echo 3 > /proc/sys/vm/drop_caches"; free -h'     2>&1 | sed 's/^/GUEST: /' || echo "GUEST_CACHE_DROP_FAILED ip=$GUEST_IP"
else
  echo "GUEST_CACHE_DROP_SKIPPED guest_ip=$GUEST_IP key_present=$(test -r /etc/hivra/keys/vm-orchestrator && echo yes || echo no)"
fi
for i in $(seq 1 18); do
  sleep 5
  avail=$(awk '/^MemAvailable:/ { print int($2/1024) }' /proc/meminfo)
  echo "WAIT_MEMORY seconds=$((i*5)) host_mem_available_mb=$avail"
  [ "$avail" -ge 8192 ] && break
done
echo "AFTER_QM_CONFIG"
qm config "$VMID" 2>/dev/null | grep -E '^(name|memory|balloon|cores):' || true
echo "AFTER_MEMINFO"
awk '/^MemTotal:|^MemAvailable:|^SwapTotal:|^SwapFree:/ { print }' /proc/meminfo
echo "POST_REPAIR_PREFLIGHT"
set +e
HERMES_DAILY_BACKUP_PREFLIGHT_ONLY=1 /usr/local/sbin/backup-vm-daily.sh ${row.proxmox_vmid} ${shellQuote(row.id)} ${shellQuote(row.resource_tier!)} --apply
pref=$?
set -e
echo "POST_REPAIR_PREFLIGHT_EXIT=$pref"
exit "$pref"
`;
}

function buildDetachedApplyScript(row: BackupCandidate): string {
  const vmid = String(row.proxmox_vmid);
  const instanceId = shellQuote(row.id);
  const tier = shellQuote(row.resource_tier!);
  const logPath = `/tmp/hermes-daily-backup-${vmid}-${row.id}.log`;
  return `set -euo pipefail
${buildInstallDailyBackupScript()}
LOG=${shellQuote(logPath)}
if pgrep -f "/usr/local/sbin/backup-vm-daily.sh ${vmid}" >/dev/null 2>&1; then
  echo "ALREADY_RUNNING log=$LOG"
else
  ${encryptionPrefix()}nohup /usr/local/sbin/backup-vm-daily.sh ${vmid} ${instanceId} ${tier} --apply >"$LOG" 2>&1 </dev/null &
  echo "STARTED pid=$! log=$LOG"
fi
`;
}

function buildStatusScript(row: BackupCandidate): string {
  const vmid = String(row.proxmox_vmid);
  const instanceId = shellQuote(row.id);
  const logPath = `/tmp/hermes-daily-backup-${vmid}-${row.id}.log`;
  return `set -uo pipefail
${buildInstallDailyBackupScript()}
INSTANCE_ID=${instanceId}
LOG=${shellQuote(logPath)}
echo "HOST=$(hostname)"
echo "VM_STATUS=$(qm status ${vmid} 2>/dev/null || true)"
echo "MEMINFO"
awk '/^MemTotal:|^MemAvailable:|^SwapTotal:|^SwapFree:/ { print }' /proc/meminfo
echo "VM_CONFIG"
qm config ${vmid} 2>/dev/null | grep -E '^(name|memory|balloon|cores|agent):' || true
echo "FILESYSTEMS"
for path in /tmp /var/tmp /var/lib/vz /var/lib/vz/dump /srv /mnt/pve/*; do
  [ -e "$path" ] || continue
  df -hP "$path" 2>/dev/null | tail -n +2 | while read -r fs size used avail use mount rest; do
    echo "FS path=$path filesystem=$fs size=$size used=$used avail=$avail use=$use mount=$mount"
  done
done | sort -u
echo "PROCESSES"
ps -eo pid,etime,cmd | grep -E '[b]ackup-vm-daily.sh ${vmid}|[v]zdump|[v]ma|[r]sync|[s]sh.*cold|[q]emu.*backup' || true
echo "PVE_TASKS_RECENT"
find /var/log/pve/tasks -type f -mmin -240 2>/dev/null | sort | tail -30 | while read -r task; do echo "TASK_FILE=$task"; tail -80 "$task"; done
echo "VZDUMP_LOGS_RECENT"
find /var/log/vzdump -type f -name '*${vmid}*' -mmin -240 2>/dev/null | sort | tail -10 | while read -r f; do echo "VZDUMP_LOG=$f"; tail -160 "$f"; done
echo "SCRATCH_DIRS"
find /tmp -maxdepth 1 -type d -name 'hermes-daily-backup-${vmid}-*' -printf '%TY-%Tm-%TdT%TH:%TM:%TS %p\n' 2>/dev/null | sort || true
echo "LOG_PATH=$LOG"
if [ -f "$LOG" ]; then
  echo "LOG_TAIL"
  tail -260 "$LOG"
else
  echo "LOG_MISSING"
fi
echo "JOURNAL_RECENT"
(journalctl --since '2 hours ago' --no-pager 2>/dev/null || true) | grep -Ei 'vzdump|qemu.*${vmid}|oom|killed process|backup-vm-daily|zstd' | tail -120 || true
echo "REMOTE_META_LIST"
rsync --list-only -e ssh "cold:daily-meta/$INSTANCE_ID/" 2>&1 || true
echo "REMOTE_ARCHIVE_LIST"
rsync --list-only -e ssh "cold:daily/paid/$INSTANCE_ID/" 2>&1 || true
`;
}

function buildRestoreSmokeScript(row: BackupCandidate): string {
  const restoreGuestSshPrelude = buildHermesVmidBoundGuestSshPrelude({
    sshUser: "hermes",
    agentAttempts: 30,
    connectTimeoutSeconds: 5,
    quiet: true,
    ...(isHermesInstanceId(row.id) ? { expectedInstanceId: row.id } : {}),
  });
  const restoreScript = `#!/usr/bin/env bash
set -euo pipefail
INSTANCE_ID="$1"
SOURCE_VMID="$2"
HERMES_BACKUP_AGE_IDENTITY_FILE="\${HERMES_BACKUP_AGE_IDENTITY_FILE:-}"
WORK="/tmp/hermes-daily-restore-smoke-$INSTANCE_ID"
LOG="$WORK/restore.log"
mkdir -p "$WORK/meta"
exec > >(tee -a "$LOG") 2>&1
# This job owns removal of the age identity file the caller wrote for it.
case "$HERMES_BACKUP_AGE_IDENTITY_FILE" in
  */hermes-age-identity.*) trap 'rm -f -- "$HERMES_BACKUP_AGE_IDENTITY_FILE"' EXIT ;;
esac

echo "RESTORE_SMOKE_BEGIN instance=$INSTANCE_ID source_vmid=$SOURCE_VMID host=$(hostname)"
rsync -a -e ssh "cold:daily-meta/$INSTANCE_ID/" "$WORK/meta/"
LATEST_MANIFEST=$(find "$WORK/meta" -maxdepth 1 -type f -name '*.json' | sort | tail -1)
if [ -z "$LATEST_MANIFEST" ]; then echo "no manifest found"; exit 10; fi
python3 - "$LATEST_MANIFEST" > "$WORK/parsed.env" <<'PY'
import json, sys
m=json.load(open(sys.argv[1]))
print('BACKUP_PATH='+m['backup_path'])
print('BACKUP_SHA='+m['backup_sha256'])
print('BACKUP_SIZE='+str(m['backup_size_bytes']))
print('BACKUP_TS='+m['backup_path'].split('-')[-1].replace('.age','').replace('.vma.zst',''))
import re
plain=str(m.get('plain_sha256',''))
print('BACKUP_ENC='+('age' if m.get('encryption')=='age' or m['backup_path'].endswith('.age') else ''))
print('BACKUP_PLAIN_SHA='+(plain if re.fullmatch(r'[a-f0-9]{64}',plain) else ''))
PY
. "$WORK/parsed.env"
echo "RESTORE_MANIFEST manifest=$LATEST_MANIFEST path=$BACKUP_PATH sha=$BACKUP_SHA size=$BACKUP_SIZE"
ARCHIVE="$WORK/$(basename "$BACKUP_PATH")"
rsync -a --partial --inplace -e ssh "cold:$BACKUP_PATH" "$ARCHIVE"
ACTUAL_SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$BACKUP_SHA" ]; then echo "sha mismatch expected=$BACKUP_SHA actual=$ACTUAL_SHA"; exit 11; fi
echo "RESTORE_ARCHIVE_VERIFIED sha=$ACTUAL_SHA"
if [ "$BACKUP_ENC" = "age" ]; then
  # age-encrypted backup: decrypt with the identity file the caller wrote (0600).
  # Refuse before any VM is created when it cannot be decrypted.
  if ! command -v age >/dev/null 2>&1; then echo "REFUSING_RESTORE_NO_AGE age is not installed on this host"; exit 14; fi
  if [ -z "$HERMES_BACKUP_AGE_IDENTITY_FILE" ] || [ ! -s "$HERMES_BACKUP_AGE_IDENTITY_FILE" ]; then echo "REFUSING_RESTORE_NO_AGE_IDENTITY backup is age-encrypted but HERMES_BACKUP_AGE_IDENTITY is not configured"; exit 14; fi
  PLAIN_ARCHIVE="$WORK/restore-plain.vma.zst"
  if ! age -d -i "$HERMES_BACKUP_AGE_IDENTITY_FILE" -o "$PLAIN_ARCHIVE" "$ARCHIVE" 2>/dev/null; then echo "age decrypt failed"; exit 14; fi
  rm -f "$ARCHIVE"
  ARCHIVE="$PLAIN_ARCHIVE"
  if [ -n "$BACKUP_PLAIN_SHA" ]; then
    PLAIN_ACTUAL=$(sha256sum "$ARCHIVE" | awk '{print $1}')
    if [ "$PLAIN_ACTUAL" != "$BACKUP_PLAIN_SHA" ]; then echo "plain sha mismatch expected=$BACKUP_PLAIN_SHA actual=$PLAIN_ACTUAL"; exit 14; fi
  fi
  echo "RESTORE_ARCHIVE_DECRYPTED"
fi

NEW_VMID=""
for candidate in $(seq 1990 1999); do
  if qm config "$candidate" >/dev/null 2>&1 && qm config "$candidate" 2>/dev/null | grep -q "name: hermes-restore-smoke-$INSTANCE_ID"; then
    qm stop "$candidate" >/dev/null 2>&1 || true
    qm destroy "$candidate" --purge --skiplock >/dev/null 2>&1 || true
  fi
  if ! qm config "$candidate" >/dev/null 2>&1; then NEW_VMID="$candidate"; break; fi
done
if [ -z "$NEW_VMID" ]; then echo "no free smoke VMID in 1990-1999"; exit 12; fi
GUEST_IP=""
for octet in $(seq 240 249); do
  ip="10.250.20.$octet"
  if ! qm config "$SOURCE_VMID" 2>/dev/null | grep -q "$ip" && ! grep -R "ip=$ip/" /etc/pve/qemu-server >/dev/null 2>&1; then
    if ! ping -c1 -W1 "$ip" >/dev/null 2>&1; then GUEST_IP="$ip"; break; fi
  fi
done
if [ -z "$GUEST_IP" ]; then echo "no free smoke IP in 10.250.20.240-249"; exit 13; fi

echo "RESTORE_TARGET vmid=$NEW_VMID ip=$GUEST_IP"
qmrestore "$ARCHIVE" "$NEW_VMID" --storage local-lvm --unique 1
qm set "$NEW_VMID" --name "hermes-restore-smoke-$INSTANCE_ID" --ipconfig0 "ip=$GUEST_IP/24,gw=10.250.20.1" --onboot 0 >/dev/null
qm start "$NEW_VMID" >/dev/null
# The restored VM is reached only over the VMID-bound path: the host checks it
# is the running smoke VM with the smoke IP and this instance's name, then pins
# SSH to the guest host key QEMU Guest Agent attests. The next run's VMID sweep
# above cleans up a smoke VM left behind by a refusal.
VMID="$NEW_VMID"
PRIVATE_IP="$GUEST_IP"
VM_SSH_KEY_PATH=/etc/hivra/keys/vm-orchestrator
${restoreGuestSshPrelude}
${buildPinnedGuestSshReadinessWait({ attempts: 30, sleepSeconds: 5 })}
echo "RESTORE_GUEST_SSH_OK"

"\${GUEST_SSH[@]}" "sudo test -d /opt/hermes/instances/$INSTANCE_ID && sudo docker volume inspect agent-$INSTANCE_ID'_webui-state' >/dev/null && sudo docker volume inspect agent-$INSTANCE_ID'_agent-source' >/dev/null && sudo docker volume inspect agent-$INSTANCE_ID'_webui-workspace' >/dev/null"
echo "RESTORE_STATE_OK instance_dir_and_volumes_present"

"\${GUEST_SSH[@]}" "sudo docker ps --format '{{.Names}} {{.Status}}' | head -20" | sed 's/^/RESTORE_DOCKER /'
"\${GUEST_SSH[@]}" "sudo find /var/lib/docker/volumes/agent-$INSTANCE_ID'_webui-state'/_data -maxdepth 4 -type f | head -20" | sed 's/^/RESTORE_WEBUI_STATE_FILE /'
"\${GUEST_SSH[@]}" "test -d /opt/hermes/instances/$INSTANCE_ID && echo RESTORE_QUESTION 'Can you see the restored Hermes instance state?' ANSWER yes_instance_state_present"

echo "RESTORE_SMOKE_OK vmid=$NEW_VMID ip=$GUEST_IP"
qm shutdown "$NEW_VMID" --timeout 60 >/dev/null 2>&1 || qm stop "$NEW_VMID" >/dev/null 2>&1 || true
qm destroy "$NEW_VMID" --purge --skiplock >/dev/null 2>&1 || true
echo "RESTORE_SMOKE_CLEANED vmid=$NEW_VMID"
`;
  const restoreScriptB64 = Buffer.from(restoreScript, "utf8").toString("base64");
  const logPath = `/tmp/hermes-daily-restore-smoke-${row.id}.out`;
  // Decryption identity for age-encrypted backups, delivered inside this script
  // (SSH stdin) as a 0600 file; the detached smoke job removes it when it ends.
  // Only written when configured; a plain backup never needs it.
  const identity = resolveAgeIdentity(process.env);
  const identityPrelude = identity.present
    ? `${buildAgeIdentityPrelude(identity.identity, { removeOnExit: false })}\n`
    : "";
  const identityCleanupIfNotStarted = identity.present
    ? `  rm -f -- "$__age_id_file"\n`
    : "";
  return `set -euo pipefail
${identityPrelude}${buildInstallDailyBackupScript()}
base64 -d > /usr/local/sbin/restore-daily-smoke.sh <<'HERMES_RESTORE_SMOKE_SCRIPT'
${restoreScriptB64}
HERMES_RESTORE_SMOKE_SCRIPT
chmod 755 /usr/local/sbin/restore-daily-smoke.sh
LOG=${shellQuote(logPath)}
if pgrep -f "/usr/local/sbin/restore-daily-smoke.sh ${row.id}" >/dev/null 2>&1; then
  echo "RESTORE_ALREADY_RUNNING log=$LOG"
${identityCleanupIfNotStarted}else
  nohup /usr/local/sbin/restore-daily-smoke.sh ${shellQuote(row.id)} ${row.proxmox_vmid} >"$LOG" 2>&1 </dev/null &
  echo "RESTORE_STARTED pid=$! log=$LOG"
fi
`;
}

function buildRestoreSmokeStatusScript(row: BackupCandidate): string {
  const logPath = `/tmp/hermes-daily-restore-smoke-${row.id}.out`;
  return `set -euo pipefail
LOG=${shellQuote(logPath)}
echo "RESTORE_PROCESSES"
ps -eo pid,etime,cmd | grep -E '[r]estore-daily-smoke.sh ${row.id}|[q]mrestore|archive.vma.zst' || true
echo "RESTORE_LOG_PATH=$LOG"
if [ -f "$LOG" ]; then tail -220 "$LOG"; else echo RESTORE_LOG_MISSING; fi
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
  if (!cronSecret) {
    log.error("CRON_SECRET not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const enabled = envBool("DAILY_VM_BACKUPS_ENABLED", false);
  const batchSize = Math.max(1, Math.min(25, envInt("DAILY_VM_BACKUPS_BATCH_SIZE", 6)));
  const tiers = envList("DAILY_VM_BACKUPS_TIERS", ["operator", "fleet", "command"]);

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, proxmox_node, proxmox_vmid, resource_tier, lifecycle_state, status, ipv4_address")
    .eq("lifecycle_state", "active")
    .eq("status", "running")
    .is("deleted_at", null)
    .not("proxmox_node", "is", null)
    .not("proxmox_vmid", "is", null)
    .in("resource_tier", tiers)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    log.error("daily backup candidate query failed", error, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "daily_backup_candidates_query_failed",
    });
    return apiError(`candidate query failed: ${error.message}`, 500);
  }

  const candidates = ((data ?? []) as BackupCandidate[]).filter((row) => {
    const reason = validateCandidate(row);
    if (reason) {
      log.warn("skipping invalid daily backup candidate", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: reason,
        instanceId: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        resource_tier: row.resource_tier,
      });
      return false;
    }
    return true;
  });

  const manualAction = req.nextUrl.searchParams.get("action")?.trim() ?? "";

  // HERMES_BACKUP_ENCRYPTION=on with an unusable recipient: refuse every path that
  // would take a backup. Never upload plaintext while the switch is on.
  const encryption = resolveBackupEncryption(process.env);
  const nonBackupActions = ["repair-memory-headroom", "status-one", "restore-smoke-start", "restore-smoke-status"];
  const takesBackup =
    manualAction === "host-preflight" ||
    manualAction === "start-one" ||
    manualAction === "apply-one" ||
    (enabled && !nonBackupActions.includes(manualAction));
  if (takesBackup && encryption.enabled && !encryption.ok) {
    log.error("daily VM backups refused: backup encryption misconfigured", new Error(encryption.error), {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "backup_encryption_misconfigured",
    });
    await reportOpsEvent({
      source: "cron.daily_vm_backups_encryption_misconfigured",
      severity: "error",
      title: "Daily VM backups refused: backup encryption misconfigured",
      message: encryption.error,
      route: ROUTE,
    });
    return apiError(encryption.error, 500);
  }
  if (manualAction === "host-preflight") {
    const row = candidates[0];
    if (!row) return apiSuccess({ ok: true, mode: "host_preflight", candidates: 0 });
    const hostEnv = resolveProxmoxHostEnv(
      { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
      process.env
    );
    const result = await runProxmoxHostScript(buildHostPreflightScript(row), hostEnv, { timeoutMs: 5 * 60 * 1000 });
    if (!result.ok) {
      log.warn("daily VM backup host preflight failed", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "daily_vm_backup_host_preflight_failed",
        instanceId: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        message: result.error ?? result.stderr ?? "unknown error",
      });
      return apiError(
        redactHostOutput(result.error ?? result.stderr ?? "host preflight failed"),
        500,
        undefined,
        {
          mode: "host_preflight",
          candidate: {
            id: row.id,
            proxmox_node: row.proxmox_node,
            proxmox_vmid: row.proxmox_vmid,
            resource_tier: row.resource_tier,
          },
          stdout: redactHostOutput(result.stdout, 12000),
          stderr: redactHostOutput(result.stderr, 12000),
        },
        { source: LOG_SOURCE, route: ROUTE, failureType: "daily_vm_backup_host_preflight_failed", logLevel: "warn" }
      );
    }
    return apiSuccess({
      ok: true,
      mode: "host_preflight",
      candidate: {
        id: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        resource_tier: row.resource_tier,
      },
      stdout: redactHostOutput(result.stdout),
      stderr: redactHostOutput(result.stderr),
    });
  }

  if (manualAction === "repair-memory-headroom") {
    const row = candidates[0];
    if (!row) return apiSuccess({ ok: true, mode: "repair-memory-headroom", candidates: 0 });
    const repairNode = process.env.MEMORY_HEADROOM_REPAIR_NODE?.trim();
    const repairVmid = Number.parseInt(process.env.MEMORY_HEADROOM_REPAIR_VMID ?? "", 10);
    if (!repairNode || !Number.isInteger(repairVmid)) {
      return apiError("memory-headroom repair target is not configured", 503);
    }
    if (row.proxmox_node !== repairNode || row.proxmox_vmid !== repairVmid) {
      return apiError("repair-memory-headroom is restricted to the configured target", 403);
    }
    const requestedBalloonMb = Number.parseInt(req.nextUrl.searchParams.get("balloonMb") ?? "32768", 10);
    const balloonMb = Number.isFinite(requestedBalloonMb)
      ? Math.max(8192, Math.min(49152, requestedBalloonMb))
      : 32768;
    const hostEnv = resolveProxmoxHostEnv(
      { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
      process.env
    );
    const result = await runProxmoxHostScript(buildMemoryHeadroomRepairScript(row, balloonMb), hostEnv, { timeoutMs: 5 * 60 * 1000 });
    const payload = {
      mode: "repair-memory-headroom",
      candidate: {
        id: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        resource_tier: row.resource_tier,
        ipv4_address: row.ipv4_address ?? null,
      },
      balloonMb,
      stdout: redactHostOutput(result.stdout, 12000),
      stderr: redactHostOutput(result.stderr, 12000),
    };
    if (!result.ok) {
      return apiError(
        redactHostOutput(result.error ?? result.stderr ?? "memory headroom repair failed"),
        500,
        undefined,
        payload,
        { source: LOG_SOURCE, route: ROUTE, failureType: "daily_vm_backup_memory_repair_failed", logLevel: "warn" }
      );
    }
    return apiSuccess({ ok: true, ...payload });
  }

  if (manualAction === "start-one" || manualAction === "status-one" || manualAction === "restore-smoke-start" || manualAction === "restore-smoke-status") {
    const row = candidates[0];
    if (!row) return apiSuccess({ ok: true, mode: manualAction, candidates: 0 });
    const hostEnv = resolveProxmoxHostEnv(
      { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
      process.env
    );
    const script =
      manualAction === "start-one"
        ? buildDetachedApplyScript(row)
        : manualAction === "status-one"
          ? buildStatusScript(row)
          : manualAction === "restore-smoke-start"
            ? buildRestoreSmokeScript(row)
            : buildRestoreSmokeStatusScript(row);
    const result = await runProxmoxHostScript(script, hostEnv, { timeoutMs: manualAction.endsWith("start") ? 60_000 : 120_000 });
    if (!result.ok) {
      const payload = {
        mode: manualAction,
        candidate: {
          id: row.id,
          proxmox_node: row.proxmox_node,
          proxmox_vmid: row.proxmox_vmid,
          resource_tier: row.resource_tier,
        },
        stdout: redactHostOutput(result.stdout, 12000),
        stderr: redactHostOutput(result.stderr, 12000),
      };
      return apiError(
        redactHostOutput(result.error ?? result.stderr ?? `${manualAction} failed`),
        500,
        undefined,
        payload,
        { source: LOG_SOURCE, route: ROUTE, failureType: `daily_vm_backup_${manualAction}_failed`, logLevel: "warn" }
      );
    }
    return apiSuccess({
      ok: true,
      mode: manualAction,
      candidate: {
        id: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
        resource_tier: row.resource_tier,
      },
      stdout: redactHostOutput(result.stdout, 12000),
      stderr: redactHostOutput(result.stderr, 12000),
    });
  }

  if (!enabled && manualAction !== "apply-one") {
    log.info("daily VM backups dry-run", {
      source: LOG_SOURCE,
      route: ROUTE,
      candidates: candidates.length,
      batchSize,
      tiers,
    });
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

  if (manualAction === "apply-one" && candidates.length > 1) {
    candidates.splice(1);
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
      // Whole-VM vzdump backups for PAID tenants then stopped fleet-wide, with
      // nothing naming the host at fault — a silent data-loss risk. Inside the
      // try it is one instance's failure, attributed to its host.
      const hostEnv = resolveProxmoxHostEnv(
        { hostId: null, hostSlug: row.proxmox_node!, envPrefix: null, failClosed: true },
        process.env
      );
      const command = [
        "set -euo pipefail",
        buildInstallDailyBackupScript(),
        [
          encryptionPrefix() + "/usr/local/sbin/backup-vm-daily.sh",
          String(row.proxmox_vmid),
          shellQuote(row.id),
          shellQuote(row.resource_tier!),
          "--apply",
        ].join(" "),
      ].join("\n");

      const result = await runProxmoxHostScript(command, hostEnv, { timeoutMs: HOST_BACKUP_TIMEOUT_MS });
      if (!result.ok) {
        results.failed += 1;
        results.perInstance.push({
          id: row.id,
          ok: false,
          host: row.proxmox_node ?? null,
          reason: "host_script_failed",
          message: redactHostOutput(result.error ?? result.stderr ?? "unknown error"),
        });
        log.warn("daily VM backup failed", {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "daily_vm_backup_failed",
          instanceId: row.id,
          proxmox_node: row.proxmox_node,
          proxmox_vmid: row.proxmox_vmid,
          message: result.error ?? result.stderr ?? "unknown error",
        });
        return;
      }
      results.backedUp += 1;
      results.perInstance.push({ id: row.id, ok: true, host: row.proxmox_node ?? null });
      log.info("daily VM backup completed", {
        source: LOG_SOURCE,
        route: ROUTE,
        instanceId: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
      });
    } catch (err) {
      results.failed += 1;
      results.perInstance.push({
        id: row.id,
        ok: false,
        host: row.proxmox_node ?? null,
        reason: "exception",
        message: err instanceof Error ? err.message : String(err),
      });
      log.error("daily VM backup threw", err, {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "daily_vm_backup_threw",
        instanceId: row.id,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
      });
    }
  }

  // allSettled, not all: processCandidate is now fully defensive, but one
  // unexpected throw would otherwise reject the whole batch -> 500 the tick ->
  // skip both the failure ops event and the dead-man heartbeat below, so a
  // crash would also silence the watchdog that is supposed to notice the crash.
  // Record a rejected lane against its host and still finish the sweep.
  const lanes = Array.from(byHost.entries());
  const laneOutcomes = await Promise.allSettled(
    lanes.map(async ([, rows]) => {
      // Avoid disk contention: one vzdump at a time per PVE host.
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
    log.error("daily VM backup host lane threw", outcome.reason, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "daily_vm_backup_host_lane_threw",
      proxmox_node: host,
      laneCandidates: rows.length,
      errorName: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
    });
  });

  // Surface failures: previously a partial/total backup failure returned HTTP
  // 200 with no ops-event, so a silently-broken paid-tenant backup pipeline
  // looked healthy. Emit a warn event when any instance failed so it shows up
  // in the ops feed. Best-effort — never let alerting mask the result.
  if (results.failed > 0) {
    await reportOpsEvent({
      source: "cron.daily_vm_backups_failed",
      severity: "warn",
      title: `Daily VM backups: ${results.failed} of ${results.candidates} failed`,
      message:
        `daily-vm-backups completed with ${results.failed} failed and ${results.backedUp} ` +
        `succeeded out of ${results.candidates} candidate(s). Paid-tenant backups may be ` +
        `missing for the failed instances — check the per-instance reasons and the PVE host.`,
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
  await recordCronHeartbeat("daily-vm-backups");

  return apiSuccess({ ok: results.failed === 0, mode: "applied", ...results });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
