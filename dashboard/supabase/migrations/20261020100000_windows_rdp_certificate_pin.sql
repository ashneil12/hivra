-- The RDP certificate each Windows computer's sessions pin. Windows renews its
-- self-signed RDP certificate on its own; owner preparation reads the current
-- one from the guest and stores it here, under its own preparation lease.
-- Null means the computer was prepared before Hivra stored it: its sessions
-- keep the gateway's configured certificate until its next preparation.

alter table public.hivra_agents
  add column if not exists windows_rdp_certificate_fingerprint text,
  add column if not exists windows_rdp_certificate_observed_at timestamptz;

alter table public.hivra_agents
  drop constraint if exists hivra_windows_rdp_certificate_pin_shape_check,
  add constraint hivra_windows_rdp_certificate_pin_shape_check check (
    (windows_rdp_certificate_fingerprint is null and windows_rdp_certificate_observed_at is null)
    or (windows_rdp_certificate_fingerprint ~ '^sha256:[a-f0-9]{64}$'
      and windows_rdp_certificate_observed_at is not null
      and computer_profile = 'windows')
  );
