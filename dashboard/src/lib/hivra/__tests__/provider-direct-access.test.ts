/** @jest-environment node */
import { providerDirectAccessForAddress, readStoredProviderDirectAccess, readAgentProviderDirectAccess } from "../provider-direct-access";

it("derives one exact public HTTPS origin without a platform credential", () => {
  expect(providerDirectAccessForAddress("203.0.113.10")).toEqual({
    mode: "direct-https",
    hostname: "203-0-113-10.sslip.io",
    origin: "https://203-0-113-10.sslip.io",
    tunnelId: null,
    tunnelToken: null,
  });
  expect(readStoredProviderDirectAccess("https://203-0-113-10.sslip.io", "203.0.113.10"))
    .toEqual(providerDirectAccessForAddress("203.0.113.10"));
});

it.each(["", "127.0.0.1", "10.240.0.2", "169.254.169.254", "192.168.1.2", "::1", "not-an-ip", " 203.0.113.10 "])(
  "rejects non-public or non-IPv4 direct access %s",
  address => expect(() => providerDirectAccessForAddress(address)).toThrow(),
);

it.each([
  ["http://203-0-113-10.sslip.io", "203.0.113.10"],
  ["https://203-0-113-11.sslip.io", "203.0.113.10"],
  ["https://example.com", "203.0.113.10"],
  [null, "203.0.113.10"],
])("does not adopt a changed stored origin", (origin, address) => {
  expect(readStoredProviderDirectAccess(origin, address)).toBeNull();
});

it.each([{ computer_substrate: "proxmox-kvm" }, { computer_substrate: null },
  { cf_hostname: "other.test" }, { cf_tunnel_id: "mixed" }])("refuses non-provider or mixed direct state: %j", changes => {
  const row = { computer_substrate: "provider-vm", cf_hostname: null, cf_tunnel_id: null,
    chat_url: "https://203-0-113-10.sslip.io", ip: "203.0.113.10" };
  expect(readAgentProviderDirectAccess(row)).not.toBeNull();
  expect(readAgentProviderDirectAccess({ ...row, ...changes })).toBeNull();
});
