import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
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
  "IyEvdXNyL2Jpbi9lbnYgYmFzaAojIGJhY2t1cC12bS1kYWlseS5zaCDigJQgbm9uLWRlc3RydWN0aXZlIGRhaWx5IFZNIGJhY2t1cCBmb3IgSGVybWVzT1MgcGFpZCB0ZW5hbnRzLgojCiMgUnVuIGZyb20gYSBQVkUgaG9zdC4gQXJnczogPHZtaWQ+IDxpbnN0YW5jZS1pZD4gPHRpZXI+CiMKIyBUaGlzIGlzIHNlcGFyYXRlIGZyb20gYXJjaGl2ZS12bS1jb2xkLnNoOgojIC0gbm8gbGlmZWN5Y2xlIHRyYW5zaXRpb24KIyAtIG5vIHFtIGRlc3Ryb3kKIyAtIG5vIGRhc2hib2FyZCBEQiBtdXRhdGlvbgojIC0gaW50ZW5kZWQgZm9yIGFjdGl2ZSBwYWlkIGluc3RhbmNlcwojCiMgSXQgY3JlYXRlcyBhIFByb3htb3ggc25hcHNob3QtbW9kZSB2emR1bXAgYXJjaGl2ZSwgdXBsb2FkcyBpdCB0byB0aGUgSGV0em5lcgojIFN0b3JhZ2UgQm94LCB3cml0ZXMgdGhlIG1hbmlmZXN0IGxhc3QsIHRoZW4gcmVtb3ZlcyB0aGUgbG9jYWwgdGVtcG9yYXJ5IGR1bXAuCiMKIyBEZWZhdWx0IGlzIGRyeS1ydW4uIFBhc3MgLS1hcHBseSBhcyB0aGUgZm91cnRoIGFyZyB0byBleGVjdXRlLgoKc2V0IC1ldW8gcGlwZWZhaWwKClZNSUQ9IiR7MTotfSIKSU5TVEFOQ0VfSUQ9IiR7MjotfSIKVElFUj0iJHszOi19IgpNT0RFPSIkezQ6LS0tZHJ5LXJ1bn0iCgppZiBbIC16ICIkVk1JRCIgXSB8fCBbIC16ICIkSU5TVEFOQ0VfSUQiIF0gfHwgWyAteiAiJFRJRVIiIF07IHRoZW4KICBlY2hvICJ1c2FnZTogJDAgPHZtaWQ+IDxpbnN0YW5jZS1pZD4gPHRpZXI+IFstLWFwcGx5XSIgPiYyCiAgZXhpdCAxCmZpCgpjYXNlICIkVElFUiIgaW4KICBvcGVyYXRvcnxmbGVldHxjb21tYW5kfHdzX2Nsb3VkX3Byb3x3c19jbG91ZF9wb3dlcnxjcmVkaXRfcHJvfGNyZWRpdF9wb3dlcnxwYWlkfHByb3xwb3dlcikgU1RPUkFHRV9USUVSPSJwYWlkIiA7OwogICopIGVjaG8gInJlZnVzaW5nIGRhaWx5IGJhY2t1cCBmb3IgdW5zdXBwb3J0ZWQgdGllcjogJFRJRVIiID4mMjsgZXhpdCAyIDs7CmVzYWMKCmlmIFsgIiRNT0RFIiAhPSAiLS1hcHBseSIgXTsgdGhlbgogIGVjaG8gIkRSWV9SVU4gdm1pZD0kVk1JRCBpbnN0YW5jZT0kSU5TVEFOQ0VfSUQgdGllcj0kVElFUiBzdG9yYWdlX3RpZXI9JFNUT1JBR0VfVElFUiIKICBlY2hvICJ3b3VsZCBydW46IHZ6ZHVtcCAkVk1JRCAtLW1vZGUgc25hcHNob3QgLS1jb21wcmVzcyB6c3RkIC0tZHVtcGRpciA8c2NyYXRjaD4iCiAgZWNobyAid291bGQgdXBsb2FkOiBkYWlseS8kU1RPUkFHRV9USUVSLyRJTlNUQU5DRV9JRC92emR1bXAtcWVtdS0kVk1JRC08dHM+LnZtYS56c3QiCiAgZWNobyAid291bGQgd3JpdGUgbWFuaWZlc3QgbGFzdDogZGFpbHktbWV0YS8kSU5TVEFOQ0VfSUQvPHRzPi5qc29uIgogIGV4aXQgMApmaQoKaWYgISBxbSBjb25maWcgIiRWTUlEIiA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBlY2hvICJbJFZNSURdIG5vIHN1Y2ggVk0gb24gJChob3N0bmFtZSkiID4mMgogIGV4aXQgMwpmaQoKTUlOX0hPU1RfSEVBRFJPT01fTUI9IiR7SEVSTUVTX0RBSUxZX0JBQ0tVUF9NSU5fSE9TVF9IRUFEUk9PTV9NQjotODE5Mn0iCk1JTl9TQ1JBVENIX01CPSIke0hFUk1FU19EQUlMWV9CQUNLVVBfTUlOX1NDUkFUQ0hfTUI6LTMyNzY4fSIKCmlmICEgW1sgIiRNSU5fSE9TVF9IRUFEUk9PTV9NQiIgPX4gXlswLTldKyQgXV07IHRoZW4KICBlY2hvICJpbnZhbGlkIEhFUk1FU19EQUlMWV9CQUNLVVBfTUlOX0hPU1RfSEVBRFJPT01fTUI9JE1JTl9IT1NUX0hFQURST09NX01CIiA+JjIKICBleGl0IDUKZmkKaWYgISBbWyAiJE1JTl9TQ1JBVENIX01CIiA9fiBeWzAtOV0rJCBdXTsgdGhlbgogIGVjaG8gImludmFsaWQgSEVSTUVTX0RBSUxZX0JBQ0tVUF9NSU5fU0NSQVRDSF9NQj0kTUlOX1NDUkFUQ0hfTUIiID4mMgogIGV4aXQgNgpmaQoKcmVhZCAtciBNRU1fVE9UQUxfS0IgTUVNX0FWQUlMQUJMRV9LQiBTV0FQX1RPVEFMX0tCIFNXQVBfRlJFRV9LQiA8IDwoCiAgYXdrICcKICAgIC9eTWVtVG90YWw6LyB7IG10PSQyIH0KICAgIC9eTWVtQXZhaWxhYmxlOi8geyBtYT0kMiB9CiAgICAvXlN3YXBUb3RhbDovIHsgc3Q9JDIgfQogICAgL15Td2FwRnJlZTovIHsgc2Y9JDIgfQogICAgRU5EIHsgcHJpbnQgbXQrMCwgbWErMCwgc3QrMCwgc2YrMCB9CiAgJyAvcHJvYy9tZW1pbmZvCikKTUVNX1RPVEFMX01CPSQoKE1FTV9UT1RBTF9LQiAvIDEwMjQpKQpNRU1fQVZBSUxBQkxFX01CPSQoKE1FTV9BVkFJTEFCTEVfS0IgLyAxMDI0KSkKU1dBUF9UT1RBTF9NQj0kKChTV0FQX1RPVEFMX0tCIC8gMTAyNCkpClNXQVBfRlJFRV9NQj0kKChTV0FQX0ZSRUVfS0IgLyAxMDI0KSkKVk1fU1RBVFVTPSIkKHFtIHN0YXR1cyAiJFZNSUQiIDI+L2Rldi9udWxsIHx8IHRydWUpIgpWTV9NRU1PUllfTUI9IiQocW0gY29uZmlnICIkVk1JRCIgMj4vZGV2L251bGwgfCBhd2sgJy9ebWVtb3J5Oi8geyBwcmludCAkMjsgZXhpdCB9JykiClZNX0JBTExPT05fTUI9IiQocW0gY29uZmlnICIkVk1JRCIgMj4vZGV2L251bGwgfCBhd2sgJy9eYmFsbG9vbjovIHsgcHJpbnQgJDI7IGV4aXQgfScpIgpWTV9NRU1PUllfTUI9IiR7Vk1fTUVNT1JZX01COi11bmtub3dufSIKVk1fQkFMTE9PTl9NQj0iJHtWTV9CQUxMT09OX01COi11bnNldH0iClJVTk5JTkdfVk1fTUFYX01FTU9SWV9NQj0wClJVTk5JTkdfVk1fRUZGRUNUSVZFX1RPVEFMX01CPTAKd2hpbGUgSUZTPSByZWFkIC1yIFJVTk5JTkdfVk1JRDsgZG8KICBbIC1uICIkUlVOTklOR19WTUlEIiBdIHx8IGNvbnRpbnVlCiAgUlVOTklOR19WTV9NRU1PUllfTUI9IiQocW0gY29uZmlnICIkUlVOTklOR19WTUlEIiAyPi9kZXYvbnVsbCB8IGF3ayAnL15tZW1vcnk6LyB7IHByaW50ICQyOyBleGl0IH0nKSIKICBSVU5OSU5HX1ZNX0JBTExPT05fTUI9IiQocW0gY29uZmlnICIkUlVOTklOR19WTUlEIiAyPi9kZXYvbnVsbCB8IGF3ayAnL15iYWxsb29uOi8geyBwcmludCAkMjsgZXhpdCB9JykiCiAgUlVOTklOR19WTV9FRkZFQ1RJVkVfTUVNT1JZX01CPSIkUlVOTklOR19WTV9NRU1PUllfTUIiCiAgaWYgW1sgIiRSVU5OSU5HX1ZNX0JBTExPT05fTUIiID1+IF5bMC05XSskIF1dICYmIFsgIiRSVU5OSU5HX1ZNX0JBTExPT05fTUIiIC1ndCAwIF07IHRoZW4KICAgIFJVTk5JTkdfVk1fRUZGRUNUSVZFX01FTU9SWV9NQj0iJFJVTk5JTkdfVk1fQkFMTE9PTl9NQiIKICBmaQogIGlmIFtbICIkUlVOTklOR19WTV9NRU1PUllfTUIiID1+IF5bMC05XSskIF1dOyB0aGVuCiAgICBSVU5OSU5HX1ZNX01BWF9NRU1PUllfTUI9JCgoUlVOTklOR19WTV9NQVhfTUVNT1JZX01CICsgUlVOTklOR19WTV9NRU1PUllfTUIpKQogIGZpCiAgaWYgW1sgIiRSVU5OSU5HX1ZNX0VGRkVDVElWRV9NRU1PUllfTUIiID1+IF5bMC05XSskIF1dOyB0aGVuCiAgICBSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQj0kKChSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQiArIFJVTk5JTkdfVk1fRUZGRUNUSVZFX01FTU9SWV9NQikpCiAgZmkKZG9uZSA8IDwocW0gbGlzdCB8IGF3ayAnTlIgPiAxICYmICQzID09ICJydW5uaW5nIiB7IHByaW50ICQxIH0nKQpIT1NUX01FTU9SWV9NQVJHSU5fTUI9JCgoTUVNX1RPVEFMX01CIC0gUlVOTklOR19WTV9FRkZFQ1RJVkVfVE9UQUxfTUIpKQoKZWNobyAiTUVNT1JZX1BSRUZMSUdIVCB2bWlkPSRWTUlEIHN0YXR1cz0ke1ZNX1NUQVRVUzotdW5rbm93bn0gaG9zdF9tZW1fYXZhaWxhYmxlX21iPSRNRU1fQVZBSUxBQkxFX01CIGhvc3RfbWVtX3RvdGFsX21iPSRNRU1fVE9UQUxfTUIgaG9zdF9zd2FwX2ZyZWVfbWI9JFNXQVBfRlJFRV9NQiBob3N0X3N3YXBfdG90YWxfbWI9JFNXQVBfVE9UQUxfTUIgdm1fbWVtb3J5X21iPSRWTV9NRU1PUllfTUIgdm1fYmFsbG9vbl9tYj0kVk1fQkFMTE9PTl9NQiBydW5uaW5nX3ZtX21heF9tZW1vcnlfbWI9JFJVTk5JTkdfVk1fTUFYX01FTU9SWV9NQiBydW5uaW5nX3ZtX2VmZmVjdGl2ZV9tZW1vcnlfbWI9JFJVTk5JTkdfVk1fRUZGRUNUSVZFX1RPVEFMX01CIGhvc3RfbWVtb3J5X21hcmdpbl9tYj0kSE9TVF9NRU1PUllfTUFSR0lOX01CIG1pbl9ob3N0X2hlYWRyb29tX21iPSRNSU5fSE9TVF9IRUFEUk9PTV9NQiIKaWYgWyAiJE1FTV9BVkFJTEFCTEVfTUIiIC1sdCAiJE1JTl9IT1NUX0hFQURST09NX01CIiBdOyB0aGVuCiAgZWNobyAiUkVGVVNJTkdfQkFDS1VQX0xPV19IT1NUX01FTU9SWSB2bWlkPSRWTUlEIGhvc3RfbWVtX2F2YWlsYWJsZV9tYj0kTUVNX0FWQUlMQUJMRV9NQiBtaW5faG9zdF9oZWFkcm9vbV9tYj0kTUlOX0hPU1RfSEVBRFJPT01fTUIgaG9zdF9zd2FwX2ZyZWVfbWI9JFNXQVBfRlJFRV9NQiB2bV9tZW1vcnlfbWI9JFZNX01FTU9SWV9NQiB2bV9iYWxsb29uX21iPSRWTV9CQUxMT09OX01CIHN0YXR1cz0ke1ZNX1NUQVRVUzotdW5rbm93bn0iID4mMgogIGV4aXQgNQpmaQppZiBbICIkSE9TVF9NRU1PUllfTUFSR0lOX01CIiAtbHQgIiRNSU5fSE9TVF9IRUFEUk9PTV9NQiIgXTsgdGhlbgogIGVjaG8gIlJFRlVTSU5HX0JBQ0tVUF9VTlNBRkVfVk1fTUVNT1JZX0ZPT1RQUklOVCB2bWlkPSRWTUlEIGhvc3RfbWVtX3RvdGFsX21iPSRNRU1fVE9UQUxfTUIgcnVubmluZ192bV9tYXhfbWVtb3J5X21iPSRSVU5OSU5HX1ZNX01BWF9NRU1PUllfTUIgcnVubmluZ192bV9lZmZlY3RpdmVfbWVtb3J5X21iPSRSVU5OSU5HX1ZNX0VGRkVDVElWRV9UT1RBTF9NQiBob3N0X21lbW9yeV9tYXJnaW5fbWI9JEhPU1RfTUVNT1JZX01BUkdJTl9NQiBtaW5faG9zdF9oZWFkcm9vbV9tYj0kTUlOX0hPU1RfSEVBRFJPT01fTUIgaG9zdF9tZW1fYXZhaWxhYmxlX21iPSRNRU1fQVZBSUxBQkxFX01CIGhvc3Rfc3dhcF9mcmVlX21iPSRTV0FQX0ZSRUVfTUIgdm1fbWVtb3J5X21iPSRWTV9NRU1PUllfTUIgdm1fYmFsbG9vbl9tYj0kVk1fQkFMTE9PTl9NQiBzdGF0dXM9JHtWTV9TVEFUVVM6LXVua25vd259IiA+JjIKICBleGl0IDUKZmkKZGVjbGFyZSAtYSBTQ1JBVENIX0NBTkRJREFURVM9KCkKYWRkX3NjcmF0Y2hfY2FuZGlkYXRlKCkgewogIGxvY2FsIHJvb3Q9IiR7MSUvfSIKICBbIC1uICIkcm9vdCIgXSB8fCByZXR1cm4gMAogIGxvY2FsIGV4aXN0aW5nCiAgZm9yIGV4aXN0aW5nIGluICIke1NDUkFUQ0hfQ0FORElEQVRFU1tAXX0iOyBkbwogICAgWyAiJGV4aXN0aW5nIiA9ICIkcm9vdCIgXSAmJiByZXR1cm4gMAogIGRvbmUKICBTQ1JBVENIX0NBTkRJREFURVMrPSgiJHJvb3QiKQp9CgppZiBbIC1uICIke0hFUk1FU19EQUlMWV9CQUNLVVBfU0NSQVRDSF9ST09UUzotfSIgXTsgdGhlbgogIElGUz0nLDogJyByZWFkIC1yIC1hIENPTkZJR1VSRURfU0NSQVRDSF9ST09UUyA8PDwgIiRIRVJNRVNfREFJTFlfQkFDS1VQX1NDUkFUQ0hfUk9PVFMiCiAgZm9yIHJvb3QgaW4gIiR7Q09ORklHVVJFRF9TQ1JBVENIX1JPT1RTW0BdfSI7IGRvCiAgICBhZGRfc2NyYXRjaF9jYW5kaWRhdGUgIiRyb290IgogIGRvbmUKZWxzZQogIGlmIGNvbW1hbmQgLXYgcHZlc20gPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgICB3aGlsZSBJRlM9IHJlYWQgLXIgc3RvcmFnZV9pZDsgZG8KICAgICAgWyAtbiAiJHN0b3JhZ2VfaWQiIF0gfHwgY29udGludWUKICAgICAgc3RvcmFnZV9wYXRoPSIkKHB2ZXNtIHBhdGggIiRzdG9yYWdlX2lkIiAyPi9kZXYvbnVsbCB8fCB0cnVlKSIKICAgICAgWyAtbiAiJHN0b3JhZ2VfcGF0aCIgXSB8fCBjb250aW51ZQogICAgICBhZGRfc2NyYXRjaF9jYW5kaWRhdGUgIiRzdG9yYWdlX3BhdGgvZHVtcCIKICAgICAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIkc3RvcmFnZV9wYXRoIgogICAgZG9uZSA8IDwocHZlc20gc3RhdHVzIC1jb250ZW50IGJhY2t1cCAyPi9kZXYvbnVsbCB8IGF3ayAnTlIgPiAxICYmICQzID09ICJhY3RpdmUiIHsgcHJpbnQgJDEgfScpCiAgZmkKICBhZGRfc2NyYXRjaF9jYW5kaWRhdGUgIi92YXIvbGliL3Z6L2R1bXAiCiAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIvdmFyL3RtcCIKICBhZGRfc2NyYXRjaF9jYW5kaWRhdGUgIi9zcnYiCiAgYWRkX3NjcmF0Y2hfY2FuZGlkYXRlICIvdG1wIgpmaQoKU0NSQVRDSF9ST09UPSIiClNDUkFUQ0hfUk9PVF9BVkFJTF9NQj0wClNDUkFUQ0hfUk9PVF9GUz0idW5rbm93biIKc2VsZWN0X3NjcmF0Y2hfcm9vdCgpIHsKICBsb2NhbCBiZXN0PSIiCiAgbG9jYWwgYmVzdF9hdmFpbD0wCiAgbG9jYWwgYmVzdF9mcz0idW5rbm93biIKICBsb2NhbCByb290IGF2YWlsIGZzCiAgZm9yIHJvb3QgaW4gIiR7U0NSQVRDSF9DQU5ESURBVEVTW0BdfSI7IGRvCiAgICBta2RpciAtcCAiJHJvb3QiID4vZGV2L251bGwgMj4mMSB8fCB0cnVlCiAgICBpZiBbICEgLWQgIiRyb290IiBdIHx8IFsgISAtdyAiJHJvb3QiIF07IHRoZW4KICAgICAgZWNobyAiU0NSQVRDSF9DQU5ESURBVEUgcm9vdD0kcm9vdCB3cml0YWJsZT1ubyByZXF1aXJlZF9tYj0kTUlOX1NDUkFUQ0hfTUIiCiAgICAgIGNvbnRpbnVlCiAgICBmaQogICAgYXZhaWw9IiQoZGYgLVBtICIkcm9vdCIgMj4vZGV2L251bGwgfCBhd2sgJ05SID09IDIgeyBwcmludCAkNCswIH0nKSIKICAgIGZzPSIkKGRmIC1QVCAiJHJvb3QiIDI+L2Rldi9udWxsIHwgYXdrICdOUiA9PSAyIHsgcHJpbnQgJDIgfScpIgogICAgYXZhaWw9IiR7YXZhaWw6LTB9IgogICAgZnM9IiR7ZnM6LXVua25vd259IgogICAgZWNobyAiU0NSQVRDSF9DQU5ESURBVEUgcm9vdD0kcm9vdCBmcz0kZnMgYXZhaWxfbWI9JGF2YWlsIHJlcXVpcmVkX21iPSRNSU5fU0NSQVRDSF9NQiIKICAgIGlmIFtbICIkYXZhaWwiID1+IF5bMC05XSskIF1dICYmIFsgIiRhdmFpbCIgLWdlICIkTUlOX1NDUkFUQ0hfTUIiIF0gJiYgWyAiJGF2YWlsIiAtZ3QgIiRiZXN0X2F2YWlsIiBdOyB0aGVuCiAgICAgIGJlc3Q9IiRyb290IgogICAgICBiZXN0X2F2YWlsPSIkYXZhaWwiCiAgICAgIGJlc3RfZnM9IiRmcyIKICAgIGZpCiAgZG9uZQogIGlmIFsgLXogIiRiZXN0IiBdOyB0aGVuCiAgICBlY2hvICJSRUZVU0lOR19CQUNLVVBfTk9fU0NSQVRDSF9TUEFDRSB2bWlkPSRWTUlEIHJlcXVpcmVkX21iPSRNSU5fU0NSQVRDSF9NQiBjYW5kaWRhdGVzPSR7U0NSQVRDSF9DQU5ESURBVEVTWypdOi1ub25lfSIgPiYyCiAgICBleGl0IDYKICBmaQogIFNDUkFUQ0hfUk9PVD0iJGJlc3QiCiAgU0NSQVRDSF9ST09UX0FWQUlMX01CPSIkYmVzdF9hdmFpbCIKICBTQ1JBVENIX1JPT1RfRlM9IiRiZXN0X2ZzIgogIGVjaG8gIlNDUkFUQ0hfU0VMRUNURUQgcm9vdD0kU0NSQVRDSF9ST09UIGZzPSRTQ1JBVENIX1JPT1RfRlMgYXZhaWxfbWI9JFNDUkFUQ0hfUk9PVF9BVkFJTF9NQiByZXF1aXJlZF9tYj0kTUlOX1NDUkFUQ0hfTUIiCn0Kc2VsZWN0X3NjcmF0Y2hfcm9vdAoKaWYgWyAiJHtIRVJNRVNfREFJTFlfQkFDS1VQX1BSRUZMSUdIVF9PTkxZOi0wfSIgPSAiMSIgXTsgdGhlbgogIGVjaG8gIlBSRUZMSUdIVF9PSyB2bWlkPSRWTUlEIGhvc3RfbWVtb3J5X21hcmdpbl9tYj0kSE9TVF9NRU1PUllfTUFSR0lOX01CIGhvc3RfbWVtX2F2YWlsYWJsZV9tYj0kTUVNX0FWQUlMQUJMRV9NQiBydW5uaW5nX3ZtX2VmZmVjdGl2ZV9tZW1vcnlfbWI9JFJVTk5JTkdfVk1fRUZGRUNUSVZFX1RPVEFMX01CIHJ1bm5pbmdfdm1fbWF4X21lbW9yeV9tYj0kUlVOTklOR19WTV9NQVhfTUVNT1JZX01CIHNjcmF0Y2hfcm9vdD0kU0NSQVRDSF9ST09UIHNjcmF0Y2hfYXZhaWxfbWI9JFNDUkFUQ0hfUk9PVF9BVkFJTF9NQiBzY3JhdGNoX3JlcXVpcmVkX21iPSRNSU5fU0NSQVRDSF9NQiIKICBleGl0IDAKZmkKClBWRV9IT1NUPSIkKGhvc3RuYW1lKSIKVFM9IiQoZGF0ZSAtdSArJVklbSVkVCVIJU0lU1opIgpTQ1JBVENIPSIkKG1rdGVtcCAtZCAiJFNDUkFUQ0hfUk9PVC9oZXJtZXMtZGFpbHktYmFja3VwLSRWTUlELVhYWFgiKSIKdHJhcCAncm0gLXJmICIkU0NSQVRDSCInIEVYSVQKClJFTU9URV9ESVI9ImRhaWx5LyRTVE9SQUdFX1RJRVIvJElOU1RBTkNFX0lEIgpSRU1PVEVfQVJDSElWRT0iJFJFTU9URV9ESVIvdnpkdW1wLXFlbXUtJFZNSUQtJFRTLnZtYS56c3QiClJFTU9URV9NQU5JRkVTVD0iZGFpbHktbWV0YS8kSU5TVEFOQ0VfSUQvJFRTLmpzb24iCgojIHZ6ZHVtcCBpbiBzbmFwc2hvdCBtb2RlIGlzIHRoZSBrZXkgZGlzdGluY3Rpb24gZnJvbSBjb2xkIGFyY2hpdmU6IHNvdXJjZSBWTQojIHJlbWFpbnMgYWN0aXZlIGFuZCBubyBhcHBsaWNhdGlvbiBjb250YWluZXJzIGFyZSBkZWxpYmVyYXRlbHkgc3RvcHBlZC4KZWNobyAi4pWQ4pWQ4pWQIGRhaWx5LWJhY2t1cCBWTUlEPSRWTUlEIFBWRT0kUFZFX0hPU1QgaW5zdGFuY2U9JElOU1RBTkNFX0lEIHRzPSRUUyDilZDilZDilZAiCnZ6ZHVtcCAiJFZNSUQiIFwKICAtLW1vZGUgc25hcHNob3QgXAogIC0tY29tcHJlc3MgenN0ZCBcCiAgLS1kdW1wZGlyICIkU0NSQVRDSCIgXAogIC0tcXVpZXQgMQoKQVJDSElWRT0iJChmaW5kICIkU0NSQVRDSCIgLW1heGRlcHRoIDEgLXR5cGUgZiAtbmFtZSAidnpkdW1wLXFlbXUtJHtWTUlEfS0qLnZtYS56c3QiIHwgaGVhZCAtMSkiCmlmIFsgLXogIiRBUkNISVZFIiBdIHx8IFsgISAtcyAiJEFSQ0hJVkUiIF07IHRoZW4KICBlY2hvICJ2emR1bXAgZGlkIG5vdCBwcm9kdWNlIGFyY2hpdmUgZm9yIFZNSUQ9JFZNSUQiID4mMgogIGV4aXQgNApmaQoKQVJDSElWRV9TSVpFPSIkKHN0YXQgLWMgJXMgIiRBUkNISVZFIiAyPi9kZXYvbnVsbCB8fCBzdGF0IC1mICV6ICIkQVJDSElWRSIpIgpBUkNISVZFX1NIQT0iJChzaGEyNTZzdW0gIiRBUkNISVZFIiB8IGF3ayAne3ByaW50ICQxfScpIgoKc3NoIGNvbGQgIm1rZGlyIC1wICRSRU1PVEVfRElSIGRhaWx5LW1ldGEvJElOU1RBTkNFX0lEIiA+L2Rldi9udWxsCnJzeW5jIC1hIC0taW5wbGFjZSAtLXBhcnRpYWwgLWUgc3NoICIkQVJDSElWRSIgImNvbGQ6JFJFTU9URV9BUkNISVZFIgoKTUFOSUZFU1Q9IiRTQ1JBVENIL21hbmlmZXN0LSRUUy5qc29uIgpjYXQgPiAiJE1BTklGRVNUIiA8PEpTT04KewogICJzY2hlbWFfdmVyc2lvbiI6IDIsCiAgImtpbmQiOiAiZGFpbHlfdm1fYmFja3VwIiwKICAiYmFja2VkX3VwX2F0IjogIiQoZGF0ZSAtdSArJVktJW0tJWRUJUg6JU06JVNaKSIsCiAgImluc3RhbmNlX2lkIjogIiRJTlNUQU5DRV9JRCIsCiAgInZtaWQiOiAkVk1JRCwKICAicHZlX2hvc3QiOiAiJFBWRV9IT1NUIiwKICAidGllciI6ICIkU1RPUkFHRV9USUVSIiwKICAiYmFja3VwX3BhdGgiOiAiJFJFTU9URV9BUkNISVZFIiwKICAiYmFja3VwX3NpemVfYnl0ZXMiOiAkQVJDSElWRV9TSVpFLAogICJiYWNrdXBfc2hhMjU2IjogIiRBUkNISVZFX1NIQSIsCiAgIm1vZGUiOiAidnpkdW1wX3NuYXBzaG90IiwKICAic291cmNlX2Rlc3Ryb3llZCI6IGZhbHNlLAogICJyZXRlbnRpb24iOiB7CiAgICAiZGFpbHlfa2VlcCI6IDcKICB9Cn0KSlNPTgpyc3luYyAtYSAtZSBzc2ggIiRNQU5JRkVTVCIgImNvbGQ6JFJFTU9URV9NQU5JRkVTVCIKCiMgS2VlcCBhIHJvbGxpbmcgNy1kYXkgc2V0IHBlciBwYWlkIGluc3RhbmNlLiBUaGUgbWFuaWZlc3QgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aAojIGFuZCBpcyB3cml0dGVuIGxhc3QsIHNvIHJldGVudGlvbiBvbmx5IHJ1bnMgYWZ0ZXIgdGhlIG5ldyBiYWNrdXAgaXMgZHVyYWJsZS4KUkVURU5USU9OX01FVEE9IiRTQ1JBVENIL3JldGVudGlvbi1tZXRhIgpta2RpciAtcCAiJFJFVEVOVElPTl9NRVRBIgpyc3luYyAtYSAtZSBzc2ggImNvbGQ6ZGFpbHktbWV0YS8kSU5TVEFOQ0VfSUQvIiAiJFJFVEVOVElPTl9NRVRBLyIgPi9kZXYvbnVsbCAyPiYxIHx8IHRydWUKbWFwZmlsZSAtdCBSRVRFTlRJT05fTUFOSUZFU1RTIDwgPChmaW5kICIkUkVURU5USU9OX01FVEEiIC1tYXhkZXB0aCAxIC10eXBlIGYgLW5hbWUgJyouanNvbicgfCBzb3J0KQpSRVRFTlRJT05fVE9UQUw9IiR7I1JFVEVOVElPTl9NQU5JRkVTVFNbQF19IgpSRVRFTlRJT05fS0VFUD03CmlmIFsgIiRSRVRFTlRJT05fVE9UQUwiIC1ndCAiJFJFVEVOVElPTl9LRUVQIiBdOyB0aGVuCiAgUkVURU5USU9OX0RFTEVURV9DT1VOVD0kKChSRVRFTlRJT05fVE9UQUwgLSBSRVRFTlRJT05fS0VFUCkpCiAgZm9yIE9MRF9NQU5JRkVTVF9MT0NBTCBpbiAiJHtSRVRFTlRJT05fTUFOSUZFU1RTW0BdOjA6JFJFVEVOVElPTl9ERUxFVEVfQ09VTlR9IjsgZG8KICAgIE9MRF9NQU5JRkVTVF9OQU1FPSIkKGJhc2VuYW1lICIkT0xEX01BTklGRVNUX0xPQ0FMIikiCiAgICBPTERfQkFDS1VQX1BBVEg9IiQocHl0aG9uMyAtICIkT0xEX01BTklGRVNUX0xPQ0FMIiAiJElOU1RBTkNFX0lEIiA8PCdQWScKaW1wb3J0IGpzb24sIHJlLCBzeXMKcGF0aD1zeXMuYXJndlsxXQppbnN0YW5jZV9pZD1zeXMuYXJndlsyXQp0cnk6CiAgICBkYXRhPWpzb24ubG9hZChvcGVuKHBhdGgpKQogICAgYmFja3VwPXN0cihkYXRhLmdldCgnYmFja3VwX3BhdGgnLCcnKSkKZXhjZXB0IEV4Y2VwdGlvbjoKICAgIHN5cy5leGl0KDApCmV4cGVjdGVkPWYiZGFpbHkvcGFpZC97aW5zdGFuY2VfaWR9LyIKaWYgbm90IGJhY2t1cC5zdGFydHN3aXRoKGV4cGVjdGVkKToKICAgIHN5cy5leGl0KDApCmlmIG5vdCByZS5tYXRjaChyIl5kYWlseS9wYWlkL1swLTlhLWYtXXszNn0vdnpkdW1wLXFlbXUtWzAtOV0rLVswLTldezh9VFswLTldezZ9Wlwudm1hXC56c3QkIiwgYmFja3VwKToKICAgIHN5cy5leGl0KDApCnByaW50KGJhY2t1cCkKUFkKKSIKICAgIGlmIFsgLW4gIiRPTERfQkFDS1VQX1BBVEgiIF07IHRoZW4KICAgICAgc3NoIGNvbGQgInJtIC1mIC0tICckT0xEX0JBQ0tVUF9QQVRIJyAnZGFpbHktbWV0YS8kSU5TVEFOQ0VfSUQvJE9MRF9NQU5JRkVTVF9OQU1FJyIgPi9kZXYvbnVsbAogICAgICBlY2hvICJSRVRFTlRJT05fREVMRVRFRCBtYW5pZmVzdD1kYWlseS1tZXRhLyRJTlNUQU5DRV9JRC8kT0xEX01BTklGRVNUX05BTUUgYXJjaGl2ZT0kT0xEX0JBQ0tVUF9QQVRIIgogICAgZWxzZQogICAgICBlY2hvICJSRVRFTlRJT05fU0tJUFBFRCB1bnNhZmVfb3JfdW5yZWFkYWJsZV9tYW5pZmVzdD0kT0xEX01BTklGRVNUX05BTUUiID4mMgogICAgZmkKICBkb25lCmZpCgplY2hvICLilZDilZDilZAgZG9uZTogJElOU1RBTkNFX0lEIOKGkiBjb2xkOiRSRU1PVEVfQVJDSElWRSDilZDilZDilZAiCmVjaG8gIkJBQ0tVUCBzaGEyNTY9JEFSQ0hJVkVfU0hBIHNpemU9JEFSQ0hJVkVfU0laRSBpaWQ9JElOU1RBTkNFX0lEIHRzPSRUUyB2bWlkPSRWTUlEIGhvc3Q9JFBWRV9IT1NUIHBhdGg9JFJFTU9URV9BUkNISVZFIG1hbmlmZXN0PSRSRU1PVEVfTUFOSUZFU1QiCg==";


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

function redactHostOutput(value: string, max = 4000): string {
  return value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]").slice(0, max);
}

function buildInstallDailyBackupScript(): string {
  const storageKeyB64 = process.env.HETZNER_SSH_PRIVATE_KEY_B64?.trim() ?? "";
  const storageKeyInstall = storageKeyB64
    ? `install -d -m 700 /root/.ssh
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
HERMES_COLD_STORAGE_SSH_CONFIG`
    : `echo "WARNING: HETZNER_SSH_PRIVATE_KEY_B64 missing; cold Storage Box SSH alias not installed" >&2`;

  return `install -d -m 755 /usr/local/sbin
${storageKeyInstall}
base64 -d > /usr/local/sbin/backup-vm-daily.sh <<'HERMES_DAILY_BACKUP_SCRIPT'
${DAILY_BACKUP_SCRIPT_B64}
HERMES_DAILY_BACKUP_SCRIPT
chmod 755 /usr/local/sbin/backup-vm-daily.sh`;
}

function buildHostPreflightScript(row: BackupCandidate): string {
  return `set -euo pipefail
${buildInstallDailyBackupScript()}
HERMES_DAILY_BACKUP_PREFLIGHT_ONLY=1 /usr/local/sbin/backup-vm-daily.sh ${row.proxmox_vmid} ${shellQuote(row.id)} ${shellQuote(row.resource_tier!)} --apply
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
  nohup /usr/local/sbin/backup-vm-daily.sh ${vmid} ${instanceId} ${tier} --apply >"$LOG" 2>&1 </dev/null &
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
  const restoreScript = `#!/usr/bin/env bash
set -euo pipefail
INSTANCE_ID="$1"
SOURCE_VMID="$2"
WORK="/tmp/hermes-daily-restore-smoke-$INSTANCE_ID"
LOG="$WORK/restore.log"
mkdir -p "$WORK/meta"
exec > >(tee -a "$LOG") 2>&1

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
print('BACKUP_TS='+m['backup_path'].split('-')[-1].replace('.vma.zst',''))
PY
. "$WORK/parsed.env"
echo "RESTORE_MANIFEST manifest=$LATEST_MANIFEST path=$BACKUP_PATH sha=$BACKUP_SHA size=$BACKUP_SIZE"
ARCHIVE="$WORK/$(basename "$BACKUP_PATH")"
rsync -a --partial --inplace -e ssh "cold:$BACKUP_PATH" "$ARCHIVE"
ACTUAL_SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$BACKUP_SHA" ]; then echo "sha mismatch expected=$BACKUP_SHA actual=$ACTUAL_SHA"; exit 11; fi
echo "RESTORE_ARCHIVE_VERIFIED sha=$ACTUAL_SHA"

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
SSH_OPTS=(-i /etc/hivra/keys/vm-orchestrator -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
for _ in $(seq 1 60); do
  if ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" true 2>/dev/null; then break; fi
  sleep 5
done
ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" true 2>/dev/null || { echo "guest ssh failed"; exit 14; }
echo "RESTORE_GUEST_SSH_OK"

ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo test -d /opt/hermes/instances/$INSTANCE_ID && sudo docker volume inspect agent-$INSTANCE_ID'_webui-state' >/dev/null && sudo docker volume inspect agent-$INSTANCE_ID'_agent-source' >/dev/null && sudo docker volume inspect agent-$INSTANCE_ID'_webui-workspace' >/dev/null"
echo "RESTORE_STATE_OK instance_dir_and_volumes_present"

ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo docker ps --format '{{.Names}} {{.Status}}' | head -20" | sed 's/^/RESTORE_DOCKER /'
ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo find /var/lib/docker/volumes/agent-$INSTANCE_ID'_webui-state'/_data -maxdepth 4 -type f | head -20" | sed 's/^/RESTORE_WEBUI_STATE_FILE /'
ssh "\${SSH_OPTS[@]}" "hermes@$GUEST_IP" "test -d /opt/hermes/instances/$INSTANCE_ID && echo RESTORE_QUESTION 'Can you see the restored Hermes instance state?' ANSWER yes_instance_state_present"

echo "RESTORE_SMOKE_OK vmid=$NEW_VMID ip=$GUEST_IP"
qm shutdown "$NEW_VMID" --timeout 60 >/dev/null 2>&1 || qm stop "$NEW_VMID" >/dev/null 2>&1 || true
qm destroy "$NEW_VMID" --purge --skiplock >/dev/null 2>&1 || true
echo "RESTORE_SMOKE_CLEANED vmid=$NEW_VMID"
`;
  const restoreScriptB64 = Buffer.from(restoreScript, "utf8").toString("base64");
  const logPath = `/tmp/hermes-daily-restore-smoke-${row.id}.out`;
  return `set -euo pipefail
${buildInstallDailyBackupScript()}
base64 -d > /usr/local/sbin/restore-daily-smoke.sh <<'HERMES_RESTORE_SMOKE_SCRIPT'
${restoreScriptB64}
HERMES_RESTORE_SMOKE_SCRIPT
chmod 755 /usr/local/sbin/restore-daily-smoke.sh
LOG=${shellQuote(logPath)}
if pgrep -f "/usr/local/sbin/restore-daily-smoke.sh ${row.id}" >/dev/null 2>&1; then
  echo "RESTORE_ALREADY_RUNNING log=$LOG"
else
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
        result.error ?? result.stderr ?? "host preflight failed",
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
        result.error ?? result.stderr ?? "memory headroom repair failed",
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
        result.error ?? result.stderr ?? `${manualAction} failed`,
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
          "/usr/local/sbin/backup-vm-daily.sh",
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
          message: result.error ?? result.stderr ?? "unknown error",
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
