"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileKey2,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import {
  HostConnectionCreateSchema,
  MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES,
  ProxmoxConnectionUpdateSchema,
  type InfrastructureConnectionDto,
  type InfrastructureConnectionCreate,
  type ProxmoxAdvancedConfiguration,
  type ProxmoxConnectionUpdate,
  type ProxmoxPreflightResult,
} from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import {
  createInfrastructureConnection,
  discoverInfrastructureHost,
  preflightInfrastructureConnection,
  updateInfrastructureConnection,
} from "@/lib/infrastructure/client";
import { canPrepareFromPreflight } from "@/lib/infrastructure/preparation-eligibility";

import {
  InfrastructureHostDiscoveryResult,
  supportsStrictProxmoxDiscovery,
} from "./InfrastructureHostDiscoveryResult";
import { InfrastructurePreflightResult } from "./InfrastructurePreflightResult";
import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

export type InfrastructureConnectionFormValues = {
  name: string;
  setupMode: "simple" | "advanced";
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshHostFingerprintSha256: string;
  sshPrivateKey: string;
  node: string;
  bridge: string;
  storage: string;
  templateVmid: string;
  templateExpectedName: string;
  provisionerDirectory: string;
  provisionerExpectedVersion: string;
  vmidStart: string;
  vmidEnd: string;
  capacityPolicyConfigured: boolean;
  capacityPolicyMode: "observe" | "enforce";
  hostMemoryReserveMb: string;
  cpuCeilingDensity: string;
  memoryCeilingDensity: string;
};

type FieldErrors = Record<string, string>;

type BuildResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors };

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function issueMap(issues: Array<{ path: PropertyKey[]; message: string }>): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.length ? issue.path.join(".") : "form";
    errors[key] ??= issue.message;
  }
  return errors;
}

function advancedConfiguration(
  form: InfrastructureConnectionFormValues,
): ProxmoxAdvancedConfiguration {
  const templateVmid = optionalNumber(form.templateVmid);
  const templateExpectedName = optionalText(form.templateExpectedName);
  const provisionerDirectory = optionalText(form.provisionerDirectory);
  const provisionerExpectedVersion = optionalText(form.provisionerExpectedVersion);
  const vmidStart = optionalNumber(form.vmidStart);
  const vmidEnd = optionalNumber(form.vmidEnd);

  return {
    ...(optionalText(form.node) ? { node: optionalText(form.node) } : {}),
    ...(optionalText(form.bridge) ? { bridge: optionalText(form.bridge) } : {}),
    ...(optionalText(form.storage) ? { storage: optionalText(form.storage) } : {}),
    ...(templateVmid !== undefined || templateExpectedName
      ? {
          template: {
            vmid: templateVmid as number,
            ...(templateExpectedName ? { expectedName: templateExpectedName } : {}),
          },
        }
      : {}),
    ...(provisionerDirectory || provisionerExpectedVersion
      ? {
          provisioner: {
            directory: provisionerDirectory as string,
            expectedVersion: provisionerExpectedVersion as string,
          },
        }
      : {}),
    ...(vmidStart !== undefined || vmidEnd !== undefined
      ? {
          vmidRange: {
            start: vmidStart as number,
            end: vmidEnd as number,
          },
        }
      : {}),
    ...(form.capacityPolicyConfigured ? { capacityPolicy: capacityPolicyFromForm(form) } : {}),
  };
}

function capacityPolicyFromForm(form: InfrastructureConnectionFormValues) {
  return {
    mode: form.capacityPolicyMode,
    hostMemoryReserveMb: Number(form.hostMemoryReserveMb),
    cpuCeilingDensity: Number(form.cpuCeilingDensity),
    memoryCeilingDensity: Number(form.memoryCeilingDensity),
  };
}

function endpointFromForm(form: InfrastructureConnectionFormValues) {
  return {
    sshHost: form.sshHost.trim(),
    sshPort: Number(form.sshPort),
    sshUser: form.sshUser.trim(),
    sshHostFingerprintSha256: form.sshHostFingerprintSha256.trim(),
  };
}

export function buildInfrastructureConnectionCreate(
  form: InfrastructureConnectionFormValues,
): BuildResult<InfrastructureConnectionCreate> {
  if (form.setupMode !== "simple") {
    return {
      ok: false,
      errors: {
        setupMode: "New hosts start in Simple mode. Hivra recommends advanced options only after inspection.",
      },
    };
  }
  const candidate = {
    name: form.name.trim(),
    provider: "host" as const,
    operatingMode: "self-managed" as const,
    setupMode: "simple" as const,
    endpoint: endpointFromForm(form),
    credentials: { sshPrivateKey: form.sshPrivateKey },
  };
  const parsed = HostConnectionCreateSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issueMap(parsed.error.issues) };
}

export function buildInfrastructureConnectionUpdate(
  form: InfrastructureConnectionFormValues,
  current: InfrastructureConnectionDto,
): BuildResult<ProxmoxConnectionUpdate | null> {
  const patch: ProxmoxConnectionUpdate = {};
  const name = form.name.trim();
  const endpoint = endpointFromForm(form);
  const nextConfiguration = form.setupMode === "advanced"
    ? advancedConfiguration(form)
    : form.capacityPolicyConfigured
      ? { capacityPolicy: capacityPolicyFromForm(form) }
      : null;

  if (name !== current.name) patch.name = name;
  if (form.setupMode !== current.setupMode) patch.setupMode = form.setupMode;
  if (JSON.stringify(endpoint) !== JSON.stringify(current.endpoint)) patch.endpoint = endpoint;

  if (form.setupMode === "simple") {
    if (JSON.stringify(nextConfiguration) !== JSON.stringify(current.configuration)) {
      patch.configuration = nextConfiguration;
    }
  } else if (JSON.stringify(nextConfiguration) !== JSON.stringify(current.configuration ?? {})) {
    patch.configuration = nextConfiguration;
  }

  if (form.sshPrivateKey.trim()) {
    patch.credentials = { sshPrivateKey: form.sshPrivateKey };
  }

  if (Object.keys(patch).length === 0) return { ok: true, value: null };
  const parsed = ProxmoxConnectionUpdateSchema.safeParse(patch);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issueMap(parsed.error.issues) };
}

function initialForm(
  connection: InfrastructureConnectionDto | null,
  prefill: InfrastructureConnectionPrefill | null = null,
): InfrastructureConnectionFormValues {
  const configuration = connection?.configuration;
  return {
    name: connection?.name ?? prefill?.name ?? "My host",
    setupMode: connection?.setupMode ?? "simple",
    sshHost: connection?.endpoint?.sshHost ?? prefill?.sshHost ?? "",
    sshPort: String(connection?.endpoint?.sshPort ?? 22),
    sshUser: connection?.endpoint?.sshUser ?? "root",
    sshHostFingerprintSha256: connection?.endpoint?.sshHostFingerprintSha256 ?? "",
    sshPrivateKey: "",
    node: configuration?.node ?? "",
    bridge: configuration?.bridge ?? "",
    storage: configuration?.storage ?? "",
    templateVmid: configuration?.template?.vmid ? String(configuration.template.vmid) : "",
    templateExpectedName: configuration?.template?.expectedName ?? "",
    provisionerDirectory: configuration?.provisioner?.directory ?? "",
    provisionerExpectedVersion: configuration?.provisioner?.expectedVersion ?? "",
    vmidStart: configuration?.vmidRange?.start !== undefined
      ? String(configuration.vmidRange.start)
      : connection
        ? ""
        : "200",
    vmidEnd: configuration?.vmidRange?.end !== undefined
      ? String(configuration.vmidRange.end)
      : connection
        ? ""
        : "399",
    capacityPolicyConfigured: Boolean(configuration?.capacityPolicy),
    capacityPolicyMode: configuration?.capacityPolicy?.mode ?? "observe",
    hostMemoryReserveMb: String(configuration?.capacityPolicy?.hostMemoryReserveMb ?? 2048),
    cpuCeilingDensity: String(configuration?.capacityPolicy?.cpuCeilingDensity ?? 1),
    memoryCeilingDensity: String(configuration?.capacityPolicy?.memoryCeilingDensity ?? 1),
  };
}

/** Known facts about a new server, such as a Hetzner server Hivra didn't create. */
export type InfrastructureConnectionPrefill = { name: string; sshHost: string };

type InfrastructureConnectionWizardProps = {
  connection?: InfrastructureConnectionDto | null;
  prefill?: InfrastructureConnectionPrefill | null;
  onClose: () => void;
  onConnectionSaved: (connection: InfrastructureConnectionDto) => void;
  onPreflightComplete: (connectionId: string, result: ProxmoxPreflightResult) => void;
  onPrepareRequested?: (connection: InfrastructureConnectionDto) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

type WizardPhase = "form" | "discovering" | "discovery" | "preflighting" | "preflight";

const WIZARD_STEPS = ["Connect", "Inspect", "Recommend", "Prepare", "Ready"] as const;

export function InfrastructureConnectionWizard({
  connection = null,
  prefill = null,
  onClose,
  onConnectionSaved,
  onPreflightComplete,
  onPrepareRequested,
  returnFocusRef,
}: InfrastructureConnectionWizardProps) {
  const [form, setForm] = useState(() => initialForm(connection, prefill));
  const [sshSettingsOpen, setSshSettingsOpen] = useState(() => Boolean(
    connection?.endpoint
    && (connection.endpoint.sshPort !== 22 || connection.endpoint.sshUser !== "root"),
  ));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<WizardPhase>("form");
  const [savedConnection, setSavedConnection] = useState<InfrastructureConnectionDto | null>(connection);
  const [discovery, setDiscovery] = useState<HostDiscoveryResult | null>(null);
  const [preflight, setPreflight] = useState<ProxmoxPreflightResult | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [privateKeyFileName, setPrivateKeyFileName] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const stateHeadingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);
  const editing = Boolean(connection);
  const legacyProxmox = connection?.provider === "proxmox";
  const busy = phase === "discovering" || phase === "preflighting";
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !busy,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
  });

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Phones scroll this dialog with the dashboard page, so a phase that
    // replaces the body in place starts at its top. A failed save returns to
    // the form with its error beside the actions, so that error is shown
    // instead. Runs before the invalid-field focus below.
    if (!dialog || window.getComputedStyle(dialog).overflowY !== "visible") return;
    const formError = phase === "form" ? formErrorRef.current : null;
    if (formError) formError.scrollIntoView?.({ block: "center" });
    else dialog.scrollIntoView?.({ block: "start" });
  }, [phase, dialogRef]);

  useEffect(() => {
    if (phase === "discovering" || phase === "preflighting") {
      stateHeadingRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "form" || Object.keys(errors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors, phase]);

  useEffect(() => {
    if (errors["endpoint.sshPort"] || errors["endpoint.sshUser"]) {
      setSshSettingsOpen(true);
    }
  }, [errors]);

  const setField = <K extends keyof InfrastructureConnectionFormValues>(
    field: K,
    value: InfrastructureConnectionFormValues[K],
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (key === field || key.endsWith(`.${field}`)) delete next[key];
      }
      delete next.form;
      return next;
    });
  };

  async function runDiscovery(targetConnection: InfrastructureConnectionDto) {
    setPhase("discovering");
    setOperationError(null);
    setDiscovery(null);
    setPreflight(null);
    try {
      const result = await discoverInfrastructureHost(targetConnection.id);
      setDiscovery(result);
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "The connection was saved, but Hivra could not finish inspecting the host.",
      );
    } finally {
      setPhase("discovery");
    }
  }

  async function runPreflight(targetConnection: InfrastructureConnectionDto) {
    if (!discovery || !supportsStrictProxmoxDiscovery(discovery)) return;
    setPhase("preflighting");
    setOperationError(null);
    setPreflight(null);
    try {
      const result = await preflightInfrastructureConnection(targetConnection.id);
      setPreflight(result);
      onPreflightComplete(targetConnection.id, result);
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "Hivra could not finish the strict readiness check.",
      );
    } finally {
      setPhase("preflight");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setOperationError(null);

    try {
      let saved: InfrastructureConnectionDto;
      if (connection) {
        const built = buildInfrastructureConnectionUpdate(form, connection);
        if (!built.ok) {
          setErrors(built.errors);
          return;
        }
        setPhase("discovering");
        saved = built.value
          ? await updateInfrastructureConnection(connection.id, built.value)
          : connection;
      } else {
        const built = buildInfrastructureConnectionCreate(form);
        if (!built.ok) {
          setErrors(built.errors);
          return;
        }
        setPhase("discovering");
        saved = await createInfrastructureConnection(built.value);
      }
      setSavedConnection(saved);
      onConnectionSaved(saved);

      // A stored credential is never rendered back into the form. Clear the
      // browser copy before read-only discovery begins.
      setForm((current) => ({ ...current, sshPrivateKey: "" }));
      setPrivateKeyFileName(null);
      await runDiscovery(saved);
    } catch (error) {
      setPhase("form");
      setOperationError(
        error instanceof Error ? error.message : "The infrastructure connection could not be saved.",
      );
    }
  }

  async function handleKeyFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES) {
      setErrors((current) => ({
        ...current,
        "credentials.sshPrivateKey": `SSH private key must be ${MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES.toLocaleString("en")} bytes or fewer.`,
      }));
      return;
    }
    try {
      const value = await file.text();
      setField("sshPrivateKey", value);
      setPrivateKeyFileName(file.name);
    } catch {
      setErrors((current) => ({ ...current, "credentials.sshPrivateKey": "Hivra could not read that key file." }));
    }
  }

  const preparationEligible = Boolean(
    savedConnection
    && preflight
    && discovery
    && supportsStrictProxmoxDiscovery(discovery)
    && canPrepareFromPreflight(savedConnection, preflight),
  );
  const activeStep = phase === "form"
    ? 0
    : phase === "discovering"
      ? 1
      : phase === "discovery"
        ? 2
        : phase === "preflighting"
          ? 2
          : phase === "preflight" && preflight?.ok && preflight.target.launchReady
            ? 4
            : preparationEligible
              ? 3
              : 2;
  const wizardHeading = phase === "form"
    ? editing
      ? `Update ${connection?.name}`
      : "Connect a host"
    : phase === "discovering"
      ? `Inspecting ${savedConnection?.name ?? form.name}`
      : phase === "discovery"
        ? "Host recommendation"
        : phase === "preflighting"
          ? "Checking readiness"
          : preflight?.ok && preflight.target.launchReady
            ? "Ready for agents"
            : preparationEligible
              ? "Preparation needed"
              : "Readiness issue";

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={styles.wizard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="infrastructure-wizard-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>{editing ? "Edit connected host" : "Connect your host"}</span>
            <h1
              ref={stateHeadingRef}
              id="infrastructure-wizard-title"
              tabIndex={-1}
            >
              {wizardHeading}
            </h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={busy}
            aria-label="Close infrastructure setup"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <ol className={styles.wizardProgress} aria-label="Host setup progress">
          {WIZARD_STEPS.map((step, index) => (
            <li
              key={step}
              className={index < activeStep
                ? styles.progressDone
                : index === activeStep
                  ? styles.progressActive
                  : undefined}
              aria-current={index === activeStep ? "step" : undefined}
              aria-label={`${step}${index === activeStep ? ", current" : index < activeStep ? ", complete" : ""}`}
            >
              <span className={styles.progressMarker} aria-hidden="true">
                {index < activeStep ? <CheckCircle2 size={13} /> : index + 1}
              </span>
              <span className={styles.progressText}>{step}</span>
            </li>
          ))}
        </ol>

        <div className={styles.wizardBody}>
          {phase === "form" ? (
            <form ref={formRef} onSubmit={handleSubmit} noValidate>
              {legacyProxmox ? (
                <div className={styles.modePicker} role="group" aria-label="Setup mode">
                  <button
                    type="button"
                    className={form.setupMode === "simple" ? styles.modeActive : styles.modeOption}
                    aria-pressed={form.setupMode === "simple"}
                    onClick={() => setField("setupMode", "simple")}
                  >
                    <Sparkles size={18} aria-hidden="true" />
                    <span>
                      <strong>Simple</strong>
                      <small>Use Hivra&apos;s detected placement.</small>
                    </span>
                    <em>Recommended</em>
                  </button>
                  <button
                    type="button"
                    className={form.setupMode === "advanced" ? styles.modeActive : styles.modeOption}
                    aria-pressed={form.setupMode === "advanced"}
                    onClick={() => setField("setupMode", "advanced")}
                  >
                    <Settings2 size={18} aria-hidden="true" />
                    <span>
                      <strong>Advanced</strong>
                      <small>Keep or update this existing Proxmox placement.</small>
                    </span>
                  </button>
                </div>
              ) : null}

              <div className={styles.formSection}>
                <div className={styles.formSectionHeading}>
                  <span className={styles.sectionNumber}>01</span>
                  <div>
                    <h2>Connection details</h2>
                    <p>Hivra connects over SSH and inspects the host without changing it.</p>
                  </div>
                </div>
                <div className={styles.formGrid}>
                  <Field label="Connection name" error={errors.name} className={styles.fullField}>
                    <input
                      value={form.name}
                      onChange={(event) => setField("name", event.target.value)}
                      maxLength={80}
                      autoComplete="off"
                      required
                    />
                  </Field>
                  <Field label="SSH host" hint="Hostname or IP address - no URL" error={errors["endpoint.sshHost"]} className={styles.wideField}>
                    <input
                      value={form.sshHost}
                      onChange={(event) => setField("sshHost", event.target.value)}
                      placeholder="pve.example.com"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                    />
                  </Field>
                  <details
                    className={`${styles.connectionDefaults} ${styles.fullField}`}
                    open={sshSettingsOpen}
                    onToggle={(event) => setSshSettingsOpen(event.currentTarget.open)}
                  >
                    <summary>
                      SSH settings
                      <span>{form.sshUser || "user"} · port {form.sshPort || "-"}</span>
                    </summary>
                    <div className={styles.connectionDefaultsGrid}>
                      <Field label="SSH user" hint="Root access is required before Hivra can prepare or run agents" error={errors["endpoint.sshUser"]}>
                        <input
                          value={form.sshUser}
                          onChange={(event) => setField("sshUser", event.target.value)}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          required
                        />
                      </Field>
                      <Field label="Port" error={errors["endpoint.sshPort"]}>
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          inputMode="numeric"
                          value={form.sshPort}
                          onChange={(event) => setField("sshPort", event.target.value)}
                          required
                        />
                      </Field>
                    </div>
                  </details>
                  <Field
                    label="Pinned SSH fingerprint"
                    hint="Verify this independently before saving. Hivra never trusts a first connection automatically."
                    error={errors["endpoint.sshHostFingerprintSha256"]}
                    className={styles.fullField}
                  >
                    <input
                      value={form.sshHostFingerprintSha256}
                      onChange={(event) => setField("sshHostFingerprintSha256", event.target.value)}
                      placeholder="SHA256:…"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                    />
                    <code className={styles.commandHint}>
                      ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
                    </code>
                  </Field>
                </div>
              </div>

              <div className={styles.formSection}>
                <div className={styles.formSectionHeading}>
                  <span className={styles.sectionNumber}>02</span>
                  <div>
                    <h2>Credential</h2>
                    <p>
                      {editing
                        ? "Leave this blank to keep the current encrypted key."
                        : "Use a key already authorized on this host."}
                    </p>
                  </div>
                </div>
                <div className={`${styles.field} ${styles.fullField}`}>
                  <span id="ssh-private-key-label" className={styles.fieldLabel}>SSH private key</span>
                  <div className={styles.secretField}>
                    <LockKeyhole size={17} aria-hidden="true" />
                    <textarea
                      aria-labelledby="ssh-private-key-label"
                      aria-describedby="ssh-private-key-help"
                      aria-invalid={Boolean(errors["credentials.sshPrivateKey"])}
                      value={form.sshPrivateKey}
                      onChange={(event) => {
                        setField("sshPrivateKey", event.target.value);
                        setPrivateKeyFileName(null);
                      }}
                      placeholder={editing ? "Leave blank to keep the saved key" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                      rows={5}
                      maxLength={MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required={!editing || !connection?.credentialsConfigured}
                      data-lpignore="true"
                    />
                  </div>
                  <label className={styles.fileButton}>
                    <FileKey2 size={14} aria-hidden="true" />
                    {privateKeyFileName ? privateKeyFileName : "Choose key file"}
                    <input type="file" accept=".pem,.key,text/plain" onChange={handleKeyFile} />
                  </label>
                  <span
                    id="ssh-private-key-help"
                    className={errors["credentials.sshPrivateKey"] ? styles.fieldError : styles.fieldHint}
                  >
                    {errors["credentials.sshPrivateKey"]
                      ?? "Encrypted before storage and never returned to this browser."}
                  </span>
                </div>
              </div>

              {legacyProxmox && form.setupMode === "advanced" ? (
                <AdvancedFields form={form} setField={setField} errors={errors} />
              ) : (
                <>
                  <div className={styles.simpleExplanation}>
                    <Sparkles size={18} aria-hidden="true" />
                    <div>
                      <strong>Read-only inspection first</strong>
                      <span>
                        Hivra will detect the operating system, capacity, environment, KVM access,
                        and installed isolation engines without changing the host. Today, an existing
                        Proxmox KVM installation can continue to strict readiness. On a compatible
                        Ubuntu amd64 host with root access and cgroup v2, you can explicitly prepare
                        the pinned gVisor adapter for Linux terminal and Python application sandboxes.
                      </span>
                    </div>
                  </div>
                  <div className={styles.hostSetupBoundary}>
                    <strong>What the isolation labels mean</strong>
                    <span>
                      Proxmox is the management layer and KVM provides each hardware VM boundary.
                      Hardware VM does not mean a dedicated physical server. A Linux VM needs nested
                      KVM before it can host KVM guests. gVisor provides an application-kernel boundary
                      for supported Linux workloads; it does not provide a general desktop or Windows computer.
                    </span>
                  </div>
                </>
              )}

              {editing ? <CapacityPolicyFields form={form} setField={setField} errors={errors} /> : null}

              {operationError || errors.form ? (
                <div ref={formErrorRef} className={styles.formError} role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>{operationError ?? errors.form}</span>
                </div>
              ) : null}

              <div className={styles.wizardActions}>
                <button type="button" className={styles.secondaryButton} onClick={onClose}>
                  <ArrowLeft size={14} aria-hidden="true" /> Cancel
                </button>
                <button type="submit" className={styles.primaryButton}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  {editing ? "Save and inspect" : "Connect and inspect"}
                </button>
              </div>
            </form>
          ) : phase === "discovering" ? (
            <InspectingState name={savedConnection?.name ?? form.name} />
          ) : phase === "discovery" && discovery ? (
            <InfrastructureHostDiscoveryResult
              result={discovery}
              connectionId={savedConnection?.id}
              onRetry={() => savedConnection && void runDiscovery(savedConnection)}
              onDone={onClose}
              onStrictPreflightRequested={supportsStrictProxmoxDiscovery(discovery)
                ? () => savedConnection && void runPreflight(savedConnection)
                : undefined}
            />
          ) : phase === "discovery" ? (
            <OperationFailure
              eyebrow="Connection saved"
              title="The host inspection could not finish."
              detail={operationError}
              retryLabel="Inspect again"
              onRetry={() => savedConnection && void runDiscovery(savedConnection)}
              onDone={onClose}
            />
          ) : phase === "preflighting" ? (
            <ReadinessCheckingState name={savedConnection?.name ?? form.name} />
          ) : preflight ? (
            <InfrastructurePreflightResult
              result={preflight}
              onRetry={() => savedConnection && void runPreflight(savedConnection)}
              onDone={onClose}
              onPrepareRequested={
                preparationEligible
                && savedConnection
                && onPrepareRequested
                  ? () => onPrepareRequested(savedConnection)
                  : undefined
              }
            />
          ) : (
            <OperationFailure
              eyebrow="Readiness check interrupted"
              title="The strict readiness check could not finish."
              detail={operationError}
              retryLabel="Check readiness again"
              onRetry={() => savedConnection && void runPreflight(savedConnection)}
              onDone={onClose}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function CapacityPolicyFields({
  form,
  setField,
  errors,
}: {
  form: InfrastructureConnectionFormValues;
  setField: <K extends keyof InfrastructureConnectionFormValues>(field: K, value: InfrastructureConnectionFormValues[K]) => void;
  errors: FieldErrors;
}) {
  const enable = () => setField("capacityPolicyConfigured", true);
  return (
    <div className={styles.formSection}>
      <div className={styles.formSectionHeading}>
        <span className={styles.sectionNumber}>03</span>
        <div>
          <h2>Host capacity policy</h2>
          <p>New active memory floors must fit physical memory after the host reserve. Existing overcommit can only move toward a smaller allocation. Save changes, then inspect again before Hivra can enforce them.</p>
        </div>
      </div>
      <div className={styles.formGrid}>
        <Field label="Proxmox VM ceiling policy" hint="Observation preserves existing Proxmox hosts; enforcement bounds opportunistic VM maxima." error={errors["configuration.capacityPolicy.mode"]}>
          <select value={form.capacityPolicyMode} onChange={(event) => { enable(); setField("capacityPolicyMode", event.target.value as "observe" | "enforce"); }}>
            <option value="observe">Observe only</option>
            <option value="enforce">Enforce bounded ceilings</option>
          </select>
        </Field>
        <Field label="Host memory reserve (MB)" error={errors["configuration.capacityPolicy.hostMemoryReserveMb"]}>
          <input type="number" min={512} max={1048576} step={256} value={form.hostMemoryReserveMb} onChange={(event) => { enable(); setField("hostMemoryReserveMb", event.target.value); }} />
        </Field>
        <Field label="Proxmox VM CPU ceiling density" hint="1× to 4× aggregate active Proxmox VM CPU limits" error={errors["configuration.capacityPolicy.cpuCeilingDensity"]}>
          <input type="number" min={1} max={4} step={0.25} value={form.cpuCeilingDensity} onChange={(event) => { enable(); setField("cpuCeilingDensity", event.target.value); }} />
        </Field>
        <Field label="Proxmox VM memory ceiling density" hint="1× to 4× aggregate active Proxmox VM memory maxima" error={errors["configuration.capacityPolicy.memoryCeilingDensity"]}>
          <input type="number" min={1} max={4} step={0.25} value={form.memoryCeilingDensity} onChange={(event) => { enable(); setField("memoryCeilingDensity", event.target.value); }} />
        </Field>
      </div>
      <div className={styles.hostSetupBoundary}>
        <strong>{form.capacityPolicyMode === "enforce" ? "Enforcement activates after fresh evidence" : "Legacy observation"}</strong>
        <span>CPU values are accounting limits, not guaranteed scheduling. Proxmox VM maxima may burst only when the host has room. gVisor computers reserve their full CPU and memory limit at 1×; these density settings do not apply to them. Hivra does not resize or evict existing computers.</span>
      </div>
    </div>
  );
}

function AdvancedFields({
  form,
  setField,
  errors,
}: {
  form: InfrastructureConnectionFormValues;
  setField: <K extends keyof InfrastructureConnectionFormValues>(
    field: K,
    value: InfrastructureConnectionFormValues[K],
  ) => void;
  errors: FieldErrors;
}) {
  return (
    <div className={styles.formSection}>
      <div className={styles.formSectionHeading}>
        <span className={styles.sectionNumber}>03</span>
        <div>
          <h2>Placement overrides</h2>
          <p>Only set values you already operate on this host. Unsupported combinations stay blocked.</p>
        </div>
      </div>
      <div className={styles.formGrid}>
        <Field label="Node" hint="Must be the SSH-local Proxmox node" error={errors["configuration.node"]}>
          <input value={form.node} onChange={(event) => setField("node", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="fixturenode1" />
        </Field>
        <Field label="Network bridge" error={errors["configuration.bridge"]}>
          <input value={form.bridge} onChange={(event) => setField("bridge", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="vmbr0" />
        </Field>
        <Field label="VM storage" error={errors["configuration.storage"]}>
          <input value={form.storage} onChange={(event) => setField("storage", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="local-lvm" />
        </Field>
        <Field label="Template VMID" error={errors["configuration.template.vmid"]}>
          <input type="number" inputMode="numeric" value={form.templateVmid} onChange={(event) => setField("templateVmid", event.target.value)} placeholder="9000" />
        </Field>
        <Field label="Expected template name" error={errors["configuration.template.expectedName"]}>
          <input value={form.templateExpectedName} onChange={(event) => setField("templateExpectedName", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="hivra-template" />
        </Field>
        <Field label="Provisioner directory" error={errors["configuration.provisioner.directory"]}>
          <input value={form.provisionerDirectory} onChange={(event) => setField("provisionerDirectory", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/root/hivra-provisioner" />
        </Field>
        <Field label="Provisioner version" error={errors["configuration.provisioner.expectedVersion"]}>
          <input value={form.provisionerExpectedVersion} onChange={(event) => setField("provisionerExpectedVersion", event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="1.0.0" />
        </Field>
        <Field label="VMID range start" error={errors["configuration.vmidRange.start"]}>
          <input type="number" inputMode="numeric" value={form.vmidStart} onChange={(event) => setField("vmidStart", event.target.value)} />
        </Field>
        <Field label="VMID range end" error={errors["configuration.vmidRange.end"]}>
          <input type="number" inputMode="numeric" value={form.vmidEnd} onChange={(event) => setField("vmidEnd", event.target.value)} />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  const described = Boolean(error || hint);
  const controls = Children.map(children, (child) => {
    if (!isValidElement(child) || typeof child.type !== "string") return child;
    if (!(["input", "select", "textarea"] as string[]).includes(child.type)) return child;
    const control = child as ReactElement<{
      id?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean | "true" | "false";
    }>;
    const existingDescription = control.props["aria-describedby"];
    return cloneElement(control, {
      id: control.props.id ?? controlId,
      "aria-describedby": [existingDescription, described ? descriptionId : null]
        .filter(Boolean)
        .join(" ") || undefined,
      "aria-invalid": error ? true : control.props["aria-invalid"],
    });
  });

  return (
    <div className={`${styles.field} ${className ?? ""}`}>
      <label className={styles.fieldLabel} htmlFor={controlId}>{label}</label>
      {controls}
      {error ? (
        <span id={descriptionId} className={styles.fieldError}>{error}</span>
      ) : hint ? (
        <span id={descriptionId} className={styles.fieldHint}>{hint}</span>
      ) : null}
    </div>
  );
}

function InspectingState({ name }: { name: string }) {
  return (
    <div className={styles.checkingState} role="status" aria-live="polite">
      <span className={styles.checkingVisual} aria-hidden="true">
        <ServerCog size={28} />
        <span />
        <Loader2 size={18} className={styles.spin} />
      </span>
      <span className={styles.eyebrow}>Read-only host inspection</span>
      <h2>Inspecting {name}...</h2>
      <p>
        Hivra is detecting the operating system, capacity, environment, KVM access,
        and installed isolation engines. Nothing is being installed or changed.
      </p>
      <div className={styles.securityNote}>
        <KeyRound size={15} aria-hidden="true" />
        This can take up to a minute. Keep this window open.
      </div>
    </div>
  );
}

function ReadinessCheckingState({ name }: { name: string }) {
  return (
    <div className={styles.checkingState} role="status" aria-live="polite">
      <span className={styles.checkingVisual} aria-hidden="true">
        <ShieldCheck size={28} />
        <span />
        <Loader2 size={18} className={styles.spin} />
      </span>
      <span className={styles.eyebrow}>Strict Proxmox readiness</span>
      <h2>Checking {name}...</h2>
      <p>
        Hivra is verifying exact isolation, network, storage, image, runtime, and
        available agent capacity. This check does not prepare or launch an agent.
      </p>
      <div className={styles.securityNote}>
        <KeyRound size={15} aria-hidden="true" />
        Discovery does not grant launch authority. This stricter evidence is required.
      </div>
    </div>
  );
}

function OperationFailure({
  eyebrow,
  title,
  detail,
  retryLabel,
  onRetry,
  onDone,
}: {
  eyebrow: string;
  title: string;
  detail: string | null;
  retryLabel: string;
  onRetry: () => void;
  onDone: () => void;
}) {
  return (
    <div className={`${styles.resultPanel} ${styles.resultError}`} role="alert">
      <div className={styles.resultHero}>
        <span className={styles.resultIcon} aria-hidden="true"><AlertTriangle size={22} /></span>
        <div>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2 className={styles.resultTitle}>{title}</h2>
          <p className={styles.resultDescription}>{detail}</p>
        </div>
      </div>
      <div className={styles.resultActions}>
        <button type="button" className={styles.secondaryButton} onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> {retryLabel}
        </button>
        <button type="button" className={styles.primaryButton} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
