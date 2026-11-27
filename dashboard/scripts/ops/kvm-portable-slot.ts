import { buildPortableKvmSlotClaimScript } from "../../src/lib/hivra/portable-kvm/slot-claim";

const [action, hostId, vmid, ip, bindingTag, ...extra] = process.argv.slice(2);
if (extra.length || (action !== "reserve" && action !== "verify" && action !== "release") || !hostId || !vmid || !ip || !bindingTag) {
  process.stderr.write("Usage: npm run --silent ops:proxmox:portable-slot -- <reserve|verify|release> <host> <vmid> <ip> <binding-tag>\n");
  process.exit(2);
}

try {
  process.stdout.write(buildPortableKvmSlotClaimScript(action, { hostId, vmid: Number(vmid), ip, bindingTag }));
} catch {
  process.stderr.write("Invalid exact portable KVM slot.\n");
  process.exit(2);
}
