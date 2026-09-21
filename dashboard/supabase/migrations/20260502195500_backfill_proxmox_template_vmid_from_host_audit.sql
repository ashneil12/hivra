-- Backfill template provenance for existing Proxmox linked clones from the
-- 2026-05-02 host audit. Future rows are populated during provisioning.

with host_audit(vmid, template_vmid) as (
  values
    (200, 9002),
    (201, 9000),
    (202, 9002),
    (203, 9000),
    (204, 9000),
    (205, 9002),
    (206, 9002),
    (207, 9002),
    (208, 9002),
    (209, 9003),
    (210, 9003),
    (211, 9003)
)
update public.hermes_instances as instance
set
  proxmox_template_vmid = host_audit.template_vmid,
  config = case
    when instance.config ? 'infrastructure' then
      jsonb_set(
        instance.config,
        '{infrastructure,templateVmid}',
        to_jsonb(host_audit.template_vmid),
        true
      )
    else instance.config
  end
from host_audit
where instance.infrastructure_provider = 'proxmox'
  and instance.proxmox_vmid = host_audit.vmid
  and instance.proxmox_template_vmid is null;
