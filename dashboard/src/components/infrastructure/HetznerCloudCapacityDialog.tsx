"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  ExternalLink,
  HardDrive,
  Loader2,
  MapPin,
  Network,
  ReceiptText,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  createHetznerCloudCapacity,
  getHetznerCloudOfferCatalog,
  InfrastructureApiError,
  quoteHetznerCloudCapacity,
} from "@/lib/infrastructure/client";
import {
  HETZNER_CLOUD_SPENDING_CONFIRMATION,
  HetznerCloudCapacityQuoteRequestSchema,
  type HetznerCloudCapacityOperationDto,
  type HetznerCloudCapacityQuoteDto,
  type HetznerCloudConnectionDto,
  type HetznerCloudOfferCatalogDto,
  type HetznerCloudServerInventoryDto,
} from "@/lib/infrastructure/contracts";
import { FIRST_BOOT_PREPARATION_CONFIRMATION, PreparedCapacityCreateRequestSchema,
  type PreparedCapacityCreateRequest } from "@/lib/infrastructure/provider-computer-setup-contracts";
import { verifyExternalCleanup } from "@/lib/infrastructure/hetzner-external-cleanup-client";
import { HETZNER_EXTERNAL_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-external-cleanup-contracts";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type CapacityPhase = "choose" | "review" | "recovery" | "result";

type HetznerCloudCapacityDialogProps = {
  connection: HetznerCloudConnectionDto;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onInventoryChanged: (inventory: HetznerCloudServerInventoryDto[]) => void;
  onSetup?: () => void;
};

type Selection = {
  serverTypeId: string;
  locationId: string;
  imageId: string;
};

const EMPTY_SELECTION: Selection = {
  serverTypeId: "",
  locationId: "",
  imageId: "",
};

const RECOVERY_RECORD_VERSION = 2 as const;
const RECOVERY_STORAGE_PREFIX = "hivra:hetzner-capacity-recovery:";
const MAX_RECOVERY_RECORD_BYTES = 1_024;
const HETZNER_CONSOLE_URL = "https://console.hetzner.com/projects";

type CapacityRecoveryRecord = {
  version: typeof RECOVERY_RECORD_VERSION;
  connectionId: string;
  quoteId: string;
  idempotencyKey: string;
  prepare: boolean;
};

function recoveryStorageKey(connectionId: string): string {
  return `${RECOVERY_STORAGE_PREFIX}${connectionId}`;
}

function readRecoveryRecord(connectionId: string): CapacityRecoveryRecord | null {
  try {
    const key = recoveryStorageKey(connectionId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    if (raw.length > MAX_RECOVERY_RECORD_BYTES) {
      window.localStorage.removeItem(key);
      return null;
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      window.localStorage.removeItem(key);
      return null;
    }
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    const expectedKeys = [
      "connectionId",
      "idempotencyKey",
      ...(candidate.version === 2 ? ["prepare"] : []),
      "quoteId",
      "version",
    ];
    const request = PreparedCapacityCreateRequestSchema.safeParse({
      quoteId: candidate.quoteId,
      idempotencyKey: candidate.idempotencyKey,
      spendingConfirmation: HETZNER_CLOUD_SPENDING_CONFIRMATION,
    });
    if (
      keys.length !== expectedKeys.length
      || keys.some((entry, index) => entry !== expectedKeys[index])
      || (candidate.version !== 1 && candidate.version !== RECOVERY_RECORD_VERSION)
      || (candidate.version === 2 && typeof candidate.prepare !== "boolean")
      || candidate.connectionId !== connectionId
      || !request.success
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return {
      version: RECOVERY_RECORD_VERSION,
      connectionId,
      quoteId: request.data.quoteId,
      idempotencyKey: request.data.idempotencyKey,
      prepare: candidate.version === 2 && candidate.prepare === true,
    };
  } catch {
    return null;
  }
}

function writeRecoveryRecord(
  connectionId: string,
  request: PreparedCapacityCreateRequest,
): CapacityRecoveryRecord {
  const validated = PreparedCapacityCreateRequestSchema.parse(request);
  const record: CapacityRecoveryRecord = {
    version: RECOVERY_RECORD_VERSION,
    connectionId,
    quoteId: validated.quoteId,
    idempotencyKey: validated.idempotencyKey,
    prepare: validated.preparationConfirmation === FIRST_BOOT_PREPARATION_CONFIRMATION,
  };
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_RECOVERY_RECORD_BYTES) {
    throw new Error("The recovery record exceeded its safe browser-storage limit.");
  }
  window.localStorage.setItem(recoveryStorageKey(connectionId), serialized);
  return record;
}

function clearRecoveryRecord(connectionId: string, expected?: { quoteId: string; idempotencyKey: string }): void {
  try {
    if (expected) {
      const current = readRecoveryRecord(connectionId);
      if (!current || current.quoteId !== expected.quoteId || current.idempotencyKey !== expected.idempotencyKey) return;
    }
    window.localStorage.removeItem(recoveryStorageKey(connectionId));
  } catch {
    // A terminal provider result remains authoritative even when browser
    // storage cleanup is blocked. The stale record is strictly parsed and an
    // idempotent replay cannot create a second order.
  }
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error(
      "Secure request identifiers are unavailable in this browser. Update the browser before creating billable capacity.",
    );
  }
  return globalThis.crypto.randomUUID();
}

function displayDecimal(amount: string): string {
  // Remove only insignificant zeroes; never round a provider price through Number.
  return amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
}

function formatMoney(currency: string, amount: string): string {
  return `${currency.toUpperCase()} ${displayDecimal(amount)}`;
}

function formatIncludedTraffic(bytes: number): string {
  const tebibyte = 1024 ** 4;
  const gibibyte = 1024 ** 3;
  if (bytes >= tebibyte && bytes % tebibyte === 0) return `${bytes / tebibyte} TiB`;
  if (bytes >= gibibyte && bytes % gibibyte === 0) return `${bytes / gibibyte} GiB`;
  return `${bytes.toLocaleString()} bytes`;
}

function errorMessage(error: unknown): string {
  if (error instanceof InfrastructureApiError) {
    switch (error.code) {
      case "token_read_only":
        return "This project token is read-only. Disconnect this project, then reconnect it with a Read & Write project token.";
      case "quote_expired":
        return "This price expired before creation. Request a fresh quote and confirm the current total again.";
      case "quote_changed":
        return "Hetzner pricing or availability changed. Request a fresh quote and confirm the new configuration.";
      case "connection_changed":
        return "This project connection changed after the quote. Request a fresh quote against the current encrypted credential.";
      case "credential_reconnect_required":
        return "This project uses a legacy credential that is not bound for billable capacity. Disconnect and reconnect this Hetzner project with a current Read & Write token before in-app server creation. Existing read-only inventory may still work.";
      case "idempotency_conflict":
        return "This creation request no longer matches its original confirmation. Reconcile the existing request before trying again.";
      case "canary_capacity_limit":
        return "This Hivra account already has a non-rejected in-app Hetzner server claim. Canary allows one across all Hetzner connections. Disconnecting the project or deleting the server directly in Hetzner does not automatically free this slot. Use Remove created server on the original project to verify cleanup of a receipted, powered-off server and release its slot. Older or unresolved launches require manual review; additional simultaneous capacity is not supported in this Canary.";
      case "selection_invalid":
        return "Hetzner no longer offers this exact selection. Choose another size, location, or image.";
      case "access_setup_failed":
        return "Hivra could not create the dedicated SSH access required for this server. No agent was prepared or launched.";
      case "invalid_credentials":
        return "Hetzner no longer accepts this token. Reconnect the project with a current Read & Write project token.";
      case "provider_forbidden":
        return "Hetzner authenticated this project token but denied the requested project change. Check project permissions and account restrictions before trying again.";
      case "provider_resource_limit":
        return "This Hetzner project has reached a provider resource limit. Increase the project limit or remove unused capacity before trying again.";
      case "provider_maintenance":
        return "Hetzner is temporarily unavailable for maintenance. No success is assumed; retry this same request later.";
      case "quote_rate_limited":
        return "Too many active price reviews; wait for one to expire or use an existing review.";
      case "provider_rate_limited":
        return "Hetzner is rate limiting this project. No success is assumed; wait and retry this same request.";
      case "provider_conflict":
        return "Hetzner reported a conflict with the selected resource or generated server identity. Request a fresh quote before trying again.";
      case "provider_action_failed":
        return "Hetzner accepted the request but its create action failed. Hivra did not mark a powered-off server as created.";
      case "provider_response_invalid":
        return "Hetzner returned a response Hivra could not safely verify. Do not submit a different request until you sync the project inventory.";
      case "provider_unavailable":
        return "Hetzner could not be reached. No success is assumed; retry this same request when the provider is available.";
      default:
        return error.message;
    }
  }
  return error instanceof Error
    ? error.message
    : "Hivra could not complete this Hetzner request.";
}

function compareDecimal(left: string, right: string): number {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  const integerLength = Math.max(leftInteger.length, rightInteger.length);
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = `${leftInteger.padStart(integerLength, "0")}${leftFraction.padEnd(fractionLength, "0")}`;
  const normalizedRight = `${rightInteger.padStart(integerLength, "0")}${rightFraction.padEnd(fractionLength, "0")}`;
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function addDecimals(...values: string[]): string {
  const fractionLength = values.reduce((maximum, value) => (
    Math.max(maximum, value.split(".")[1]?.length ?? 0)
  ), 0);
  const total = values.reduce((sum, value) => {
    const [integer, fraction = ""] = value.split(".");
    return sum + BigInt(`${integer}${fraction.padEnd(fractionLength, "0")}`);
  }, 0n);
  const raw = total.toString().padStart(fractionLength + 1, "0");
  if (fractionLength === 0) return raw;
  return `${raw.slice(0, -fractionLength)}.${raw.slice(-fractionLength)}`;
}

type CatalogServerType = HetznerCloudOfferCatalogDto["serverTypes"][number];

function simpleOfferMonthlyGross(
  catalog: HetznerCloudOfferCatalogDto,
  serverType: CatalogServerType,
  locationName: string,
): string | null {
  const policy = catalog.simpleModePolicy;
  if (
    serverType.deprecated
    || serverType.cpuType !== policy.cpuType
    || serverType.architecture === null
    || serverType.cores < policy.minCores
    || serverType.memoryGb < policy.minMemoryGb
    || serverType.cores > policy.maxCores
    || serverType.memoryGb > policy.maxMemoryGb
    || serverType.diskGb > policy.maxDiskGb
  ) {
    return null;
  }
  const availability = serverType.locations.find((location) => location.name === locationName);
  const price = serverType.prices.find((candidate) => candidate.location === locationName);
  const primaryIpPrice = catalog.primaryIpPrices.find((candidate) => candidate.location === locationName);
  const currencyCap = catalog.simpleModePolicy.maxMonthlyGrossByCurrency.find(
    (candidate) => candidate.currency === catalog.currency,
  );
  if (
    !availability?.available
    || availability.deprecated
    || !price
    || price.monthly.currency !== catalog.currency
    || !primaryIpPrice
    || !currencyCap
  ) {
    return null;
  }
  const total = addDecimals(
    price.monthly.gross,
    primaryIpPrice.ipv4.monthly.gross,
    primaryIpPrice.ipv6.monthly.gross,
  );
  return compareDecimal(total, currencyCap.amount) <= 0 ? total : null;
}

function selectableServerTypes(catalog: HetznerCloudOfferCatalogDto): CatalogServerType[] {
  return catalog.serverTypes.filter((serverType) => (
    catalog.locations.some((location) => (
      simpleOfferMonthlyGross(catalog, serverType, location.name) !== null
    ))
    && catalog.images.some((image) => (
      !image.deprecated
      && image.osFlavor === "ubuntu"
      && image.architecture === serverType.architecture
    ))
  ));
}

function recommendedSelection(catalog: HetznerCloudOfferCatalogDto): Selection {
  const candidates = selectableServerTypes(catalog);
  const offers = candidates.flatMap((serverType) => serverType.locations
    .flatMap((location) => {
      const providerLocation = catalog.locations.find((candidate) => candidate.name === location.name);
      const price = serverType.prices.find((candidate) => candidate.location === location.name);
      const totalMonthlyGross = simpleOfferMonthlyGross(catalog, serverType, location.name);
      return providerLocation && price && totalMonthlyGross
        ? [{ serverType, providerLocation, price, totalMonthlyGross }]
        : [];
    }));
  offers.sort((left, right) => (
    Number(right.serverType.architecture === "x86") - Number(left.serverType.architecture === "x86")
    || left.price.monthly.currency.localeCompare(right.price.monthly.currency)
    || compareDecimal(left.totalMonthlyGross, right.totalMonthlyGross)
    || left.serverType.name.localeCompare(right.serverType.name)
    || left.providerLocation.name.localeCompare(right.providerLocation.name)
  ));
  const offer = offers[0];
  if (!offer) return EMPTY_SELECTION;

  const image = catalog.images
    .filter((candidate) => (
      !candidate.deprecated
      && candidate.osFlavor === "ubuntu"
      && candidate.architecture === offer.serverType.architecture
    ))
    .sort((left, right) => (
      Number(right.osVersion === "22.04") - Number(left.osVersion === "22.04")
      || (right.osVersion ?? "").localeCompare(left.osVersion ?? "", undefined, { numeric: true })
      || left.name.localeCompare(right.name)
      || left.id - right.id
    ))[0];

  return {
    ...EMPTY_SELECTION,
    serverTypeId: String(offer.serverType.id),
    locationId: String(offer.providerLocation.id),
    imageId: image ? String(image.id) : "",
  };
}

function resultCopy(operation: HetznerCloudCapacityOperationDto): {
  title: string;
  body: string;
  tone: "ready" | "warning" | "error";
} {
  if (operation.externalCleanupResolutionId) return {
    title: "External cleanup verified.",
    body: "The original creation outcome remains ambiguous. Fresh Hetzner checks confirmed the server and generated key absent, with no servers or Primary IPs remaining in the project. The slot is released; earlier charges still apply.",
    tone: "ready",
  };
  if (operation.status === "deleted") return {
    title: "Provider resources removed.",
    body: "Hivra verified removal of the original server, both Primary IPs, and generated SSH key. The capacity slot is released; accrued provider charges still apply.",
    tone: "ready",
  };
  if (operation.status === "cleaning") return {
    title: "Resource cleanup is in progress.",
    body: "Reopen Remove created server from this project to inspect or resume the saved cleanup. This request cannot buy another server.",
    tone: "warning",
  };
  if (
    operation.status === "created_off"
    && operation.createdPoweredOff
    && operation.providerActionStatus === "success"
    && operation.observedServerStatus === "off"
  ) {
    return {
      title: "Created, powered off, not prepared.",
      body: "Hetzner accepted the server and Hivra saved its provider identity. Starting, preparing, and launching an agent are separate later actions.",
      tone: "ready",
    };
  }
  if (operation.status === "creating") {
    return {
      title: "Creation is still being observed.",
      body: "Hetzner has not produced final server evidence yet. Hivra does not treat this request as ready, prepared, or available for agent launch.",
      tone: "warning",
    };
  }
  if (operation.status === "ambiguous") {
    return {
      title: "Creation outcome needs reconciliation.",
      body: "Hivra could not prove whether Hetzner created the server. Do not start a different request; check this same request again to reconcile it safely.",
      tone: "warning",
    };
  }
  return {
    title: "Hetzner rejected the request.",
    body: "Hivra recorded the provider rejection and did not mark any server as created, prepared, or launch-ready.",
    tone: "error",
  };
}

export function HetznerCloudCapacityDialog({
  connection,
  onClose,
  returnFocusRef,
  onInventoryChanged,
  onSetup,
}: HetznerCloudCapacityDialogProps) {
  const [phase, setPhase] = useState<CapacityPhase>("choose");
  const [catalog, setCatalog] = useState<HetznerCloudOfferCatalogDto | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [quote, setQuote] = useState<HetznerCloudCapacityQuoteDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [prepare, setPrepare] = useState(false);
  const [creating, setCreating] = useState(false);
  const [verifyingCleanup, setVerifyingCleanup] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operation, setOperation] = useState<HetznerCloudCapacityOperationDto | null>(null);
  const [resultInventory, setResultInventory] = useState<HetznerCloudServerInventoryDto[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [recoveryRequest, setRecoveryRequest] = useState<CapacityRecoveryRecord | null>(null);
  const [quoteClock, setQuoteClock] = useState(() => Date.now());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const screenKey = phase === "result"
    ? `${phase}:${operation?.id}:${operation?.status}:${operation?.externalCleanupResolutionId}`
    : phase;
  const previousScreenRef = useRef(screenKey);
  const serverTypeId = useId();
  const locationId = useId();
  const imageId = useId();
  const confirmationId = useId();
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !creating && !verifyingCleanup,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
  });

  const selectedType = useMemo(() => catalog?.serverTypes.find(
    (candidate) => candidate.id === Number(selection.serverTypeId),
  ) ?? null, [catalog, selection.serverTypeId]);
  const availableLocations = useMemo(() => {
    if (!catalog || !selectedType) return [];
    return catalog.locations.filter((location) => (
      simpleOfferMonthlyGross(catalog, selectedType, location.name) !== null
    ));
  }, [catalog, selectedType]);
  const availableImages = useMemo(() => {
    if (!catalog || !selectedType?.architecture) return [];
    return catalog.images.filter((image) => (
      !image.deprecated
      && image.osFlavor === "ubuntu"
      && image.architecture === selectedType.architecture
    ));
  }, [catalog, selectedType]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    void getHetznerCloudOfferCatalog(connection.id, controller.signal)
      .then((nextCatalog) => {
        if (controller.signal.aborted) return;
        setCatalog(nextCatalog);
        setSelection(recommendedSelection(nextCatalog));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setCatalogError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [connection.id]);

  useEffect(() => {
    const recovered = readRecoveryRecord(connection.id);
    if (!recovered) return;
    setRecoveryRequest(recovered);
    setPhase("recovery");
  }, [connection.id]);

  useEffect(() => {
    if (previousScreenRef.current === screenKey) return;
    previousScreenRef.current = screenKey;
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
    headingRef.current?.focus({ preventScroll: true });
  }, [screenKey, dialogRef]);

  useEffect(() => {
    if (phase !== "review" || !quote) return;
    setQuoteClock(Date.now());
    const interval = window.setInterval(() => setQuoteClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [phase, quote]);

  function changeServerType(value: string) {
    if (!catalog) return;
    const nextType = catalog.serverTypes.find((candidate) => candidate.id === Number(value));
    const eligibleLocations = nextType?.locations.filter((location) => (
      simpleOfferMonthlyGross(catalog, nextType, location.name) !== null
    )) ?? [];
    const nextLocationCandidate = eligibleLocations.find((location) => location.recommended)
      ?? eligibleLocations.sort((left, right) => left.name.localeCompare(right.name))[0];
    const nextLocation = catalog.locations.find(
      (location) => location.name === nextLocationCandidate?.name,
    );
    const nextImage = catalog.images.find((image) => (
      !image.deprecated
      && image.osFlavor === "ubuntu"
      && image.architecture === nextType?.architecture
    ));
    setSelection((current) => ({
      ...current,
      serverTypeId: value,
      locationId: nextLocation ? String(nextLocation.id) : "",
      imageId: nextImage ? String(nextImage.id) : "",
    }));
    setSelectionError(null);
  }

  async function requestQuote() {
    setSelectionError(null);
    setOperationError(null);
    const parsed = HetznerCloudCapacityQuoteRequestSchema.safeParse({
      serverTypeId: Number(selection.serverTypeId),
      locationId: Number(selection.locationId),
      imageId: Number(selection.imageId),
    });
    if (!parsed.success) {
      setSelectionError(parsed.error.issues[0]?.message ?? "Complete each server option.");
      return;
    }

    setQuoting(true);
    try {
      const requestKey = createIdempotencyKey();
      const nextQuote = await quoteHetznerCloudCapacity(connection.id, parsed.data);
      setQuote(nextQuote);
      setPrepare(false);
      setConfirmed(false);
      setIdempotencyKey(requestKey);
      setPhase("review");
    } catch (error) {
      setSelectionError(errorMessage(error));
    } finally {
      setQuoting(false);
    }
  }

  function editSelection() {
    setPrepare(false);
    setPhase("choose");
    setQuote(null);
    setConfirmed(false);
    setIdempotencyKey(null);
    setOperationError(null);
  }

  async function submitCreate(request: PreparedCapacityCreateRequest) {
    if (creating) return;
    setCreating(true);
    setOperationError(null);
    try {
      const result = await createHetznerCloudCapacity(connection.id, request);
      setPrepare(request.preparationConfirmation === FIRST_BOOT_PREPARATION_CONFIRMATION);
      setOperation(result.operation);
      setResultInventory(result.inventory);
      onInventoryChanged(result.inventory);
      setPhase("result");
      if (
        result.operation.status === "created_off"
        || result.operation.externalCleanupResolutionId
        || (
          result.operation.status === "provider_rejected"
          && !result.operation.canarySlotHeld
        )
      ) {
        clearRecoveryRecord(connection.id, request);
        setRecoveryRequest(null);
      }
    } catch (error) {
      const code = error instanceof InfrastructureApiError ? error.code : undefined;
      setOperationError(errorMessage(error));
      if (
        code === "quote_expired"
        || code === "quote_changed"
        || code === "selection_invalid"
        || code === "canary_capacity_limit"
        || code === "first_boot_callback_unreachable"
      ) {
        clearRecoveryRecord(connection.id);
        setRecoveryRequest(null);
        setQuote(null);
        setConfirmed(false);
        setIdempotencyKey(null);
        setPhase("choose");
      } else {
        setPhase("recovery");
      }
    } finally {
      setCreating(false);
    }
  }

  async function createServer() {
    if ((phase === "recovery" || phase === "result") && recoveryRequest) {
      await submitCreate({
        quoteId: recoveryRequest.quoteId,
        idempotencyKey: recoveryRequest.idempotencyKey,
        spendingConfirmation: HETZNER_CLOUD_SPENDING_CONFIRMATION,
        ...(recoveryRequest.prepare ? { preparationConfirmation: FIRST_BOOT_PREPARATION_CONFIRMATION } : {}),
      });
      return;
    }
    if (!quote || !confirmed || creating) return;
    if (!idempotencyKey) {
      setOperationError(
        "The secure creation identifier is missing. Close this window and request a new quote.",
      );
      return;
    }
    const request = {
      quoteId: quote.id,
      idempotencyKey,
      spendingConfirmation: HETZNER_CLOUD_SPENDING_CONFIRMATION,
      ...(prepare ? { preparationConfirmation: FIRST_BOOT_PREPARATION_CONFIRMATION } : {}),
    } satisfies PreparedCapacityCreateRequest;
    let persisted: CapacityRecoveryRecord;
    try {
      persisted = writeRecoveryRecord(connection.id, request);
    } catch {
      setOperationError(
        "Hivra could not save the non-secret recovery identifiers in this browser. No provider request was sent.",
      );
      return;
    }
    setRecoveryRequest(persisted);
    await submitCreate(request);
  }

  const copy = operation ? resultCopy(operation) : null;
  const quoteFresh = Boolean(quote && Date.parse(quote.expiresAt) > quoteClock);
  const title = phase === "choose"
    ? "Choose a Hetzner server"
    : phase === "review"
      ? "Review price and creation"
      : phase === "recovery"
        ? "Recover pending request"
        : "Provider result";

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.wizard} ${styles.capacityDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hetzner-capacity-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>Simple mode · {connection.name}</span>
            <h1 ref={headingRef} tabIndex={-1} id="hetzner-capacity-title">{title}</h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={creating || verifyingCleanup}
            aria-label="Close Hetzner server setup"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <ol className={styles.capacityProgress} aria-label="Server creation steps">
          {(["Choose", "Review", phase === "recovery" ? "Recover" : "Result"] as const).map((label, index) => {
            const currentIndex = phase === "choose" ? 0 : phase === "review" ? 1 : 2;
            return (
              <li
                key={label}
                className={index === currentIndex
                  ? styles.capacityProgressActive
                  : index < currentIndex
                    ? styles.capacityProgressDone
                    : undefined}
                aria-current={index === currentIndex ? "step" : undefined}
              >
                <span>{index < currentIndex ? <CheckCircle2 size={12} aria-hidden="true" /> : index + 1}</span>
                {label}
              </li>
            );
          })}
        </ol>

        <div className={styles.wizardBody}>
          {phase === "choose" ? (
            <ChooseCapacity
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              selection={selection}
              selectedType={selectedType}
              availableLocations={availableLocations}
              availableImages={availableImages}
              selectableTypes={catalog ? selectableServerTypes(catalog) : []}
              serverTypeId={serverTypeId}
              locationId={locationId}
              imageId={imageId}
              selectionError={selectionError ?? operationError}
              quoting={quoting}
              onSelectionChange={setSelection}
              onServerTypeChange={changeServerType}
              onRetryCatalog={() => {
                setCatalog(null);
                setCatalogError(null);
                setCatalogLoading(true);
                void getHetznerCloudOfferCatalog(connection.id)
                  .then((nextCatalog) => {
                    setCatalog(nextCatalog);
                    setSelection(recommendedSelection(nextCatalog));
                  })
                  .catch((error: unknown) => setCatalogError(errorMessage(error)))
                  .finally(() => setCatalogLoading(false));
              }}
              onQuote={() => void requestQuote()}
            />
          ) : phase === "review" && quote ? (
            <ReviewCapacity
              quote={quote}
              confirmed={confirmed}
              confirmationId={confirmationId}
              creating={creating}
              quoteFresh={quoteFresh}
              requestReady={Boolean(idempotencyKey)}
              error={operationError}
              onConfirmed={setConfirmed}
              prepare={prepare}
              onPrepare={setPrepare}
              onBack={editSelection}
              onCreate={() => void createServer()}
            />
          ) : phase === "recovery" && recoveryRequest ? (
            <CapacityRecovery
              request={recoveryRequest}
              checking={creating}
              error={operationError}
              onCheck={() => void createServer()}
              onClose={onClose}
            />
          ) : operation && copy ? (
            <CapacityResult
              key={operation.id}
              operation={operation}
              inventory={resultInventory}
              copy={copy}
              checking={creating}
              error={operationError}
              onCheck={() => void createServer()}
              onClose={onClose}
              verifying={verifyingCleanup}
              onVerifyingChange={setVerifyingCleanup}
              onResolved={(resolutionId) => {
                setOperation({ ...operation, externalCleanupResolutionId: resolutionId, canarySlotHeld: false });
                const remaining = resultInventory.filter(server => server.providerResourceId !== operation.providerServerId);
                setResultInventory(remaining);
                onInventoryChanged(remaining);
                clearRecoveryRecord(connection.id, { quoteId: operation.id, idempotencyKey: operation.idempotencyKey });
                setRecoveryRequest(null);
              }}
            />
          ) : null}
          {phase === "result" && operation?.status === "created_off" && prepare && onSetup && <div className={styles.resultActions}>
            <button type="button" className={styles.primaryButton} onClick={onSetup}>Continue computer setup</button>
          </div>}
        </div>
      </section>
    </div>
  );
}

function CapacityRecovery({
  request,
  checking,
  error,
  onCheck,
  onClose,
}: {
  request: CapacityRecoveryRecord;
  checking: boolean;
  error: string | null;
  onCheck: () => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.capacityResult}>
      <div className={`${styles.capacityResultHero} ${styles.capacityResult_warning}`}>
        <span aria-hidden="true"><AlertTriangle size={24} /></span>
        <div>
          <span className={styles.sectionLabel}>Saved recovery request</span>
          <h2>A previous creation request needs checking.</h2>
          <p>
            Hivra saved these non-secret request identifiers immediately before the
            confirmed provider call. A response was not safely resolved, so no success,
            failure, or agent readiness is assumed. Checking reuses the same request and
            cannot create a second Hivra order.
          </p>
        </div>
      </div>

      <dl className={styles.capacityOperationFacts} aria-label="Saved recovery identifiers">
        <div><dt>Connection</dt><dd>{request.connectionId}</dd></div>
        <div><dt>Quote</dt><dd>{request.quoteId}</dd></div>
        <div><dt>Request key</dt><dd>{request.idempotencyKey}</dd></div>
      </dl>

      <div className={styles.capacityBoundary}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Nothing is submitted automatically after a reload.</strong>
          <span>
            Check this saved request to reconcile the original provider call. Do not
            start a different request: the account-wide Canary slot may already be held.
          </span>
        </div>
      </div>

      {error ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className={styles.resultActions}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onClose}
          disabled={checking}
        >
          Return to infrastructure
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onCheck}
          disabled={checking}
        >
          {checking ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <ReceiptText size={15} aria-hidden="true" />}
          {checking ? "Checking the saved request…" : "Check saved request"}
        </button>
      </div>
    </div>
  );
}

function ChooseCapacity({
  catalog,
  loading,
  error,
  selection,
  selectedType,
  availableLocations,
  availableImages,
  selectableTypes,
  serverTypeId,
  locationId,
  imageId,
  selectionError,
  quoting,
  onSelectionChange,
  onServerTypeChange,
  onRetryCatalog,
  onQuote,
}: {
  catalog: HetznerCloudOfferCatalogDto | null;
  loading: boolean;
  error: string | null;
  selection: Selection;
  selectedType: HetznerCloudOfferCatalogDto["serverTypes"][number] | null;
  availableLocations: HetznerCloudOfferCatalogDto["locations"];
  availableImages: HetznerCloudOfferCatalogDto["images"];
  selectableTypes: HetznerCloudOfferCatalogDto["serverTypes"];
  serverTypeId: string;
  locationId: string;
  imageId: string;
  selectionError: string | null;
  quoting: boolean;
  onSelectionChange: (selection: Selection) => void;
  onServerTypeChange: (value: string) => void;
  onRetryCatalog: () => void;
  onQuote: () => void;
}) {
  if (loading) {
    return (
      <div className={styles.capacityLoading} role="status" aria-live="polite">
        <Loader2 size={21} className={styles.spin} aria-hidden="true" />
        <div>
          <strong>Loading live Hetzner choices…</strong>
          <span>Reading available sizes, locations, system images, and provider pricing.</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.capacityError} role="alert">
        <AlertTriangle size={23} aria-hidden="true" />
        <h2>Live Hetzner choices are unavailable.</h2>
        <p>{error}</p>
        <button type="button" className={styles.secondaryButton} onClick={onRetryCatalog}>
          Try again
        </button>
      </div>
    );
  }

  if (!catalog || selectableTypes.length === 0 || availableLocations.length === 0 || availableImages.length === 0) {
    return (
      <div className={styles.capacityError} role="status">
        <Cloud size={23} aria-hidden="true" />
        <h2>No compatible server choices are available.</h2>
        <p>
          This project currently has no available Hetzner size, location, and Ubuntu
          image combination that Hivra can quote safely.
        </p>
        <button type="button" className={styles.secondaryButton} onClick={onRetryCatalog}>
          Refresh choices
        </button>
      </div>
    );
  }

  return (
    <>
      {selectionError ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{selectionError}</span>
        </div>
      ) : null}

      <div className={styles.capacityIntro}>
        <Cloud size={20} aria-hidden="true" />
        <div>
          <strong>Choose first. Nothing is created yet.</strong>
          <p>
            These options come from your Hetzner project. The next screen requests a
            short-lived observation of current provider rates before any billable action
            is available.
          </p>
        </div>
      </div>

      <div className={styles.formSection}>
        <div className={styles.formSectionHeading}>
          <span className={styles.sectionNumber}>01</span>
          <div>
            <h2>Cloud server</h2>
            <p>Choose one provider VM. Hivra generates a non-personal server name and creates it powered off.</p>
          </div>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field} htmlFor={serverTypeId}>
            <span className={styles.fieldLabel}>Server size</span>
            <select
              id={serverTypeId}
              value={selection.serverTypeId}
              onChange={(event) => onServerTypeChange(event.target.value)}
              required
            >
              {selectableTypes.map((serverType) => (
                <option key={serverType.id} value={serverType.id}>
                  {serverType.name} · {serverType.cores} vCPU · {serverType.memoryGb} GB RAM
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field} htmlFor={locationId}>
            <span className={styles.fieldLabel}>Location</span>
            <select
              id={locationId}
              value={selection.locationId}
              onChange={(event) => onSelectionChange({ ...selection, locationId: event.target.value })}
              required
            >
              {availableLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.city}, {location.country} · {location.name}
                </option>
              ))}
            </select>
          </label>

          <label className={`${styles.field} ${styles.fullField}`} htmlFor={imageId}>
            <span className={styles.fieldLabel}>System image</span>
            <select
              id={imageId}
              value={selection.imageId}
              onChange={(event) => onSelectionChange({ ...selection, imageId: event.target.value })}
              required
            >
              {availableImages.map((image) => (
                <option key={image.id} value={image.id}>
                  {image.description}{image.osVersion ? ` · ${image.osVersion}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {selectedType ? (
        <dl className={styles.capacitySelectionFacts} aria-label="Selected server capacity">
          <div><dt><Server size={14} aria-hidden="true" /> CPU</dt><dd>{selectedType.cores} vCPU</dd></div>
          <div><dt><HardDrive size={14} aria-hidden="true" /> Memory</dt><dd>{selectedType.memoryGb} GB</dd></div>
          <div><dt><HardDrive size={14} aria-hidden="true" /> Disk</dt><dd>{selectedType.diskGb} GB</dd></div>
          <div><dt><MapPin size={14} aria-hidden="true" /> Architecture</dt><dd>{selectedType.architecture}</dd></div>
        </dl>
      ) : null}

      <div className={styles.capacityBoundary}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Creation stops at a powered-off provider VM.</strong>
          <span>
            No agent is installed or launched. Starting and preparing this node require
            separate later approval and are not part of this flow. Canary allows one
            non-rejected in-app Hetzner server per Hivra account across all connected
            projects.
          </span>
        </div>
      </div>

      <div className={styles.wizardActions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onQuote}
          disabled={quoting}
        >
          {quoting ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <ReceiptText size={15} aria-hidden="true" />}
          {quoting ? "Getting current rates…" : "Review current rates"}
        </button>
      </div>
    </>
  );
}

function ReviewCapacity({
  quote,
  confirmed,
  confirmationId,
  creating,
  quoteFresh,
  requestReady,
  error,
  onConfirmed,
  onBack,
  onCreate,
  prepare,
  onPrepare,
}: {
  quote: HetznerCloudCapacityQuoteDto;
  confirmed: boolean;
  confirmationId: string;
  creating: boolean;
  quoteFresh: boolean;
  requestReady: boolean;
  error: string | null;
  onConfirmed: (confirmed: boolean) => void;
  onBack: () => void;
  onCreate: () => void;
  prepare: boolean;
  onPrepare: (prepare: boolean) => void;
}) {
  const currency = quote.price.currency;
  const preparationSupported = quote.serverType.architecture === "x86" && quote.image.architecture === "x86" && quote.image.osVersion === "22.04";
  const guidedSetupSelected = prepare && preparationSupported;
  const confirmationLabel = `I approve this observed configuration and gross base rate of ${formatMoney(currency, quote.price.total.hourly.gross)} per hour, capped at ${formatMoney(currency, quote.price.total.monthly.gross)} per month, before variable traffic overage. Hetzner determines final billing and may reject or change the request before creation.`;

  return (
    <>
      <div className={styles.capacityQuoteHero}>
        <div>
          <span className={styles.sectionLabel}>Base hourly rate</span>
          <strong>{formatMoney(currency, quote.price.total.hourly.gross)}<small> / hour gross</small></strong>
          <span>Partial hours are rounded up</span>
        </div>
        <div>
          <span className={styles.sectionLabel}>Monthly cap</span>
          <strong>{formatMoney(currency, quote.price.total.monthly.gross)}<small> gross</small></strong>
          <span>Variable traffic overage is not included</span>
        </div>
        <span className={styles.quoteExpiry}>
          Quote expires {new Date(quote.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <dl className={styles.capacityPriceBreakdown} aria-label="Freshly observed provider rate breakdown">
        <div>
          <dt>Hetzner server</dt>
          <dd>
            <strong>{formatMoney(currency, quote.price.server.monthly.gross)} / month cap</strong>
            <span>{formatMoney(currency, quote.price.server.hourly.gross)} / hour gross</span>
          </dd>
        </div>
        <div>
          <dt>Primary IPv4</dt>
          <dd>
            <strong>{formatMoney(currency, quote.price.primaryIpv4.monthly.gross)} / month cap</strong>
            <span>{formatMoney(currency, quote.price.primaryIpv4.hourly.gross)} / hour gross</span>
          </dd>
        </div>
        <div>
          <dt>Primary IPv6</dt>
          <dd>
            <strong>{formatMoney(currency, quote.price.primaryIpv6.monthly.gross)} / month cap</strong>
            <span>{formatMoney(currency, quote.price.primaryIpv6.hourly.gross)} / hour gross</span>
          </dd>
        </div>
      </dl>

      <p className={styles.capacityVatNote}>
        Gross provider prices in {currency.toUpperCase()}. Hetzner VAT rate: {displayDecimal(quote.price.vatRate)}%.
      </p>

      <section className={styles.capacityTraffic} aria-labelledby="capacity-traffic-heading">
        <div>
          <span className={styles.sectionLabel}>Variable usage</span>
          <h2 id="capacity-traffic-heading">Traffic beyond {formatIncludedTraffic(quote.price.traffic.includedBytes)}</h2>
          <p>{quote.billing.trafficOverage}</p>
        </div>
        <strong>
          {formatMoney(currency, quote.price.traffic.additionalPerTb.gross)}
          <small> / additional TB gross</small>
        </strong>
      </section>

      <div className={styles.capacityReviewGrid}>
        <section aria-labelledby="capacity-review-server">
          <span className={styles.sectionNumber} aria-hidden="true"><Server size={14} /></span>
          <div>
            <h2 id="capacity-review-server">Server</h2>
            <dl>
              <div><dt>Name</dt><dd>{quote.serverName}</dd></div>
              <div><dt>Size</dt><dd>{quote.serverType.name} · {quote.serverType.cores} vCPU · {quote.serverType.memoryGb} GB</dd></div>
              <div><dt>Location</dt><dd>{quote.location.city}, {quote.location.country} · {quote.location.name}</dd></div>
              <div><dt>Image</dt><dd>{quote.image.description}</dd></div>
              <div><dt>Isolation</dt><dd>Hetzner provider VM</dd></div>
            </dl>
          </div>
        </section>
        <section aria-labelledby="capacity-review-policy">
          <span className={styles.sectionNumber} aria-hidden="true"><Network size={14} /></span>
          <div>
            <h2 id="capacity-review-policy">Fixed creation policy</h2>
            <dl>
              <div><dt>Network</dt><dd>Public IPv4 + IPv6</dd></div>
              <div><dt>Backups</dt><dd>Off</dd></div>
              <div><dt>Volumes</dt><dd>None</dd></div>
              <div><dt>Power</dt><dd>Powered off after creation</dd></div>
              <div><dt>Canary limit</dt><dd>One non-rejected in-app Hetzner server per Hivra account</dd></div>
            </dl>
          </div>
        </section>
      </div>

      <div className={styles.capacityAccessDisclosure}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>{guidedSetupSelected
            ? "Guided setup checks the firewall before startup."
            : "Access policy is planned, but it does not run while powered off."}</strong>
          <span>
            A later approved first boot creates the <code>{quote.access.username}</code> user
            with generated Ed25519 access and TCP 22. Password authentication and root
            SSH login stay disabled. {guidedSetupSelected
              ? "When you continue computer setup, Hivra applies and verifies the provider firewall before requesting power-on. Hivra does not request startup until those checks pass. Selecting this option does not apply changes."
              : quote.access.firewallLimitation}
          </span>
        </div>
      </div>

      <div className={styles.capacityBoundary}>
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>One in-app Hetzner server per Hivra account in Canary.</strong>
          <span>
            A creating, ambiguous, or created request uses the slot across all connected
            Hetzner projects. Disconnecting a project or deleting its server directly in
            Hetzner does not automatically free the slot. Use Remove created server on
            the original project to verify cleanup and release an eligible server&apos;s slot.
            Older or unresolved launches remain manual; additional simultaneous capacity
            is not supported in this Canary.
          </span>
        </div>
      </div>

      <label className={styles.capacityConfirmation} htmlFor={confirmationId}>
        <input
          id={confirmationId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmed(event.target.checked)}
          disabled={creating}
        />
        <span>
          <strong>Confirm provider billing</strong>
          <span>{confirmationLabel}</span>
        </span>
      </label>

      <label className={styles.capacityConfirmation} htmlFor={confirmationId + "-prepare"}>
        <input id={confirmationId + "-prepare"} type="checkbox" checked={guidedSetupSelected}
          disabled={creating || !preparationSupported} onChange={event => onPrepare(event.target.checked)} />
        <span><strong>Enable guided computer setup</strong><span>{preparationSupported
          ? "Include the one-time connection recipe. After creation, Continue computer setup will apply the firewall, start this exact server, verify its SSH identity, and install Hivra’s setup files. No agent is launched yet."
          : "Automatic setup currently requires an x86 server and Ubuntu 22.04. Change the configuration to enable it; other choices remain capacity-only."}</span></span>
      </label>

      {!quoteFresh ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>This rate observation has expired. Go back and request current provider rates before creating.</span>
        </div>
      ) : null}

      <div className={styles.capacityBoundary}>
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>“Powered off” is a point-in-time provider observation.</strong>
          <span>
            Hetzner bills partial hours as full hours and Primary IPs separately. The
            result is not prepared and cannot launch an agent. Use Remove created server
            for eligible Hivra-created resources, or inspect the server and any retained
            Primary IPs in Hetzner Console. Hetzner
            documents rare migration or hardware-failure cases where an off server can
            be powered on when its prior state is unknown, so inspect or delete it there;
            Hivra does not yet provide durable power isolation or monitoring.
          </span>
        </div>
      </div>

      {error ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className={styles.wizardActions}>
        <button type="button" className={styles.secondaryButton} onClick={onBack} disabled={creating}>
          <ArrowLeft size={14} aria-hidden="true" /> Change configuration
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onCreate}
          disabled={!confirmed || !quoteFresh || !requestReady || creating}
        >
          {creating ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <ReceiptText size={15} aria-hidden="true" />}
          {creating ? "Submitting the confirmed request…" : HETZNER_CLOUD_SPENDING_CONFIRMATION}
        </button>
      </div>
    </>
  );
}

function CapacityResult({
  operation,
  inventory,
  copy,
  checking,
  error,
  onCheck,
  onClose,
  onResolved,
  verifying,
  onVerifyingChange,
}: {
  operation: HetznerCloudCapacityOperationDto;
  inventory: HetznerCloudServerInventoryDto[];
  copy: ReturnType<typeof resultCopy>;
  checking: boolean;
  error: string | null;
  onCheck: () => void;
  onClose: () => void;
  onResolved: (resolutionId: string) => void;
  verifying: boolean;
  onVerifyingChange: (value: boolean) => void;
}) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const verificationKey = useRef<string | null>(null);
  const resolved = Boolean(operation.externalCleanupResolutionId);
  const canRecheck = !resolved && (operation.status === "creating" || operation.status === "ambiguous");
  async function verifyRemoved() {
    if (verifying || checking) return;
    onVerifyingChange(true); setVerificationError(null);
    try {
      verificationKey.current ??= createIdempotencyKey();
      const result = await verifyExternalCleanup(operation.connectionId, {
        orderId: operation.id, idempotencyKey: verificationKey.current,
        serverName: operation.quote.serverName, confirmation: HETZNER_EXTERNAL_CLEANUP_CONFIRMATION,
      });
      if (active.current) onResolved(result.resolutionId);
    } catch (error) { if (active.current) setVerificationError(error instanceof Error ? error.message : "Verification could not be confirmed."); }
    finally { if (active.current) onVerifyingChange(false); }
  }
  const observedUnexpectedlyPowered = operation.observedServerStatus === "running"
    || operation.observedServerStatus === "starting";
  return (
    <div className={styles.capacityResult}>
      <div className={`${styles.capacityResultHero} ${styles[`capacityResult_${copy.tone}`]}`}>
        <span aria-hidden="true">
          {copy.tone === "ready" ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
        </span>
        <div>
          <span className={styles.sectionLabel}>Provider operation</span>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
      </div>

      <dl className={styles.capacityOperationFacts} aria-label="Provider operation evidence">
        <div><dt>Hivra operation</dt><dd>{operation.id}</dd></div>
        <div><dt>Status</dt><dd>{operation.status.replaceAll("_", " ")}</dd></div>
        <div><dt>Provider server</dt><dd>{operation.providerServerId ?? "Not confirmed"}</dd></div>
        <div><dt>Provider action</dt><dd>{operation.providerActionId ?? "Not confirmed"}</dd></div>
        <div><dt>Action command</dt><dd>{operation.providerActionCommand ?? "Not confirmed"}</dd></div>
        <div><dt>Observed power</dt><dd>{operation.observedServerStatus ?? "Not confirmed"}</dd></div>
        <div><dt>Observed at</dt><dd>{operation.providerObservedAt ? new Date(operation.providerObservedAt).toLocaleString() : "Not confirmed"}</dd></div>
        <div><dt>Canary slot</dt><dd>{operation.canarySlotHeld ? "Held" : "Available"}</dd></div>
        <div><dt>Replay</dt><dd>{operation.replayed ? "Existing request" : "First response"}</dd></div>
      </dl>

      {operation.providerNextActions.length > 0 ? (
        <div className={styles.capacityNextActions}>
          <span className={styles.sectionLabel}>Provider follow-up actions</span>
          <ul>
            {operation.providerNextActions.map((action) => (
              <li key={action.id}>
                <span>{action.command}</span>
                <code>{action.id}</code>
                <strong>{action.status}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inventory.length > 0 ? (
        <div className={styles.capacityResultInventory}>
          <span className={styles.sectionLabel}>Project inventory after this operation</span>
          {inventory.map((server) => (
            <article key={server.id}>
              <Server size={17} aria-hidden="true" />
              <div>
                <strong>{server.name}</strong>
                <span>
                  {server.serverType.name} · {server.location.city ?? server.location.name} · {server.status}
                </span>
              </div>
              <span className={styles.statusBadge}>Not prepared</span>
            </article>
          ))}
        </div>
      ) : null}

      {observedUnexpectedlyPowered && !resolved ? (
        <div className={`${styles.capacityBoundary} ${styles.capacityCritical}`} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Server observed powered on — check Hetzner immediately.</strong>
            <span>
              Hetzner reported this server as {operation.observedServerStatus}. Hivra did
              not authorize an agent launch and will not power the server off
              automatically. Open Hetzner Console now, inspect the server, and power it
              off if it should not be running.
            </span>
            <a
              className={`${styles.secondaryButton} ${styles.capacityCriticalAction}`}
              href={HETZNER_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Hetzner Console <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : null}

      <div className={styles.capacityBoundary}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>
            {operation.createdPoweredOff
              ? "Billing is active; agent launch remains blocked."
              : "Agent launch remains blocked."}
          </strong>
          <span>
            {operation.createdPoweredOff
              ? `The server was off when Hivra observed it, but that is not durable power isolation. Hetzner documents rare automatic power-on during migration or hardware recovery when prior state is unknown. Billing continues while off; inspect or delete the server and any retained Primary IPs in Hetzner Console. ${operation.launchBlockedReason}`
              : operation.launchBlockedReason}
          </span>
        </div>
      </div>

      <div className={styles.capacityBoundary}>
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>
            {operation.canarySlotHeld
              ? "This request uses the account's one Canary capacity slot."
              : "This request did not retain the Canary capacity slot."}
          </strong>
          <span>
            {operation.canarySlotHeld
              ? "The slot applies across all Hetzner connections. Use Remove created server to verify cleanup of a receipted, powered-off server. Disconnecting alone does not stop charges or free the slot; older unresolved launches require manual review."
              : operation.status === "deleted"
                ? "The original resources were confirmed absent. You can review a fresh price quote for another server."
                : resolved
                  ? "External cleanup was independently checked. The original failure record is retained; you can review a fresh quote. This is point-in-time evidence, not a guarantee against later changes in Hetzner."
                  : "Hivra recorded no provider server or project SSH key holding the slot. You can retry after fixing the reported cause."}
          </span>
        </div>
      </div>

      {operation.canarySlotHeld
      && (operation.status === "ambiguous" || operation.status === "provider_rejected") ? (
        <div className={styles.capacityBoundary}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Inspect retained Hetzner resources before leaving this request.</strong>
            <span>
              This request may have created a Hivra project SSH key and separately
              billable Primary IPv4 or IPv6 resources before its final outcome. After
              reconciling the server, inspect and remove any unused key and retained
              Primary IPs in Hetzner Console. Hivra does not auto-delete them in v1.
            </span>
          </div>
        </div>
      ) : null}

      {!resolved && operation.status === "ambiguous" && operation.providerServerId ? (
        <div className={styles.capacityBoundary}>
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>Already removed these resources in Hetzner?</strong>
            <span>Verify external cleanup to release this request&apos;s slot. Hivra checks the original server and generated key, and requires this project to have no servers or Primary IPs. This action deletes nothing and does not retry the purchase.</span>
            <button type="button" className={styles.secondaryButton} onClick={() => void verifyRemoved()} disabled={verifying || checking}>
              {verifying ? "Verifying external cleanup…" : HETZNER_EXTERNAL_CLEANUP_CONFIRMATION}
            </button>
            {verificationError ? <p role="alert" className={styles.formError}>{verificationError}</p> : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className={styles.resultActions}>
        <button
          type="button"
          className={canRecheck ? styles.secondaryButton : styles.primaryButton}
          onClick={onClose}
          disabled={checking || verifying}
        >
          Return to infrastructure
        </button>
        {canRecheck ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onCheck}
            disabled={checking || verifying}
          >
            {checking ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <ReceiptText size={15} aria-hidden="true" />}
            {checking ? "Checking the same request…" : "Check this request again"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
