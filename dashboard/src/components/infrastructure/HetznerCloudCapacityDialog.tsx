"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  HardDrive,
  Loader2,
  MapPin,
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
import {
  HETZNER_GUIDED_SETUP_BASE,
  isHetznerGuidedSetupImage,
  isHetznerGuidedSetupServerType,
} from "@/lib/infrastructure/hetzner-guided-setup";
import { hetznerCapacitySlotReason, type HetznerCloudCapacitySlotDto } from "@/lib/infrastructure/hetzner-cloud-token-contracts";
import type { PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";

import styles from "./Infrastructure.module.css";
import { ProviderComputerSetupPanel } from "./ProviderComputerSetupPanel";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type CapacityPhase = "choose" | "review" | "recovery" | "result";

type HetznerCloudCapacityDialogProps = {
  connection: HetznerCloudConnectionDto;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onInventoryChanged: (inventory: HetznerCloudServerInventoryDto[]) => void;
  /** The account's one in-app server slot, when already observed. */
  slot?: HetznerCloudCapacitySlotDto | null;
  /** The launch this server is being created for, if any. */
  launchResourceId?: PortableLaunchResourceId | null;
  launchLabel?: string | null;
  unifiedLaunchReturn?: boolean;
  /** Setup or creation changed saved state the page should re-read. */
  onChanged?: () => void;
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

/** Whether this browser holds an unresolved creation request for the project,
 * so its card can offer the saved-request check instead of a new purchase. */
export function hasSavedCapacityRequest(connectionId: string): boolean {
  if (typeof window === "undefined") return false;
  return readRecoveryRecord(connectionId) !== null;
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
        return "This project token is read-only. Use Replace token on the project card with a Read & Write token from the same project, then try again.";
      case "quote_expired":
        return "This price expired before creation. Review current rates again and confirm the new total.";
      case "quote_changed":
        return "Hetzner pricing or availability changed. Review current rates again and confirm the new configuration.";
      case "connection_changed":
        return "This project connection changed after the price review. Review current rates again.";
      case "credential_reconnect_required":
        return "This project uses an older saved token that can't create servers. Use Replace token on the project card with a current Read & Write token. The server list keeps working meanwhile.";
      case "idempotency_conflict":
        return "This creation request no longer matches its original confirmation. Check the existing request before trying again.";
      case "canary_capacity_limit":
        return "Right now Hivra can create one Hetzner server per account, and this account's is in use. Deleting the server directly in Hetzner doesn't free it; use Remove created server on its project. Older or unresolved launches need manual review.";
      case "selection_invalid":
        return "Hetzner no longer offers this exact selection. Choose another size, location, or image.";
      case "access_setup_failed":
        return "Hivra couldn't create the dedicated SSH access this server needs. Nothing was set up or launched.";
      case "invalid_credentials":
        return "Hetzner no longer accepts this token. Use Replace token on the project card with a current Read & Write token.";
      case "provider_forbidden":
        return "Hetzner accepted this token but refused the change. Check the project's permissions and account restrictions before trying again.";
      case "provider_resource_limit":
        return "This Hetzner project has reached a provider limit. Raise the limit or remove unused servers in Hetzner before trying again.";
      case "provider_maintenance":
        return "Hetzner is down for maintenance. Nothing is assumed to have happened; retry this same request later.";
      case "quote_rate_limited":
        return "Too many active price reviews; wait for one to expire or use an existing review.";
      case "provider_rate_limited":
        return "Hetzner is rate limiting this project. Nothing is assumed to have happened; wait and retry this same request.";
      case "provider_conflict":
        return "Hetzner reported a conflict with the selected resource or generated server name. Review current rates again before trying again.";
      case "provider_action_failed":
        return "Hetzner accepted the request but its create step failed. Hivra did not record a server as created.";
      case "provider_response_invalid":
        return "Hetzner returned a response Hivra couldn't safely verify. Sync the project's servers before submitting a different request.";
      case "provider_unavailable":
        return "Hetzner couldn't be reached. Nothing is assumed to have happened; retry this same request when Hetzner is available.";
      default:
        return error.message;
    }
  }
  return error instanceof Error
    ? error.message
    : "Hivra couldn't complete this Hetzner request.";
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

/** Only sizes and images Hivra's agent setup supports, so every choice on
 * this screen can be set up after creation. */
function guidedImages(catalog: HetznerCloudOfferCatalogDto): HetznerCloudOfferCatalogDto["images"] {
  return catalog.images.filter((image) => isHetznerGuidedSetupImage(image));
}

function selectableServerTypes(catalog: HetznerCloudOfferCatalogDto): CatalogServerType[] {
  const images = guidedImages(catalog);
  return catalog.serverTypes.filter((serverType) => (
    isHetznerGuidedSetupServerType(serverType)
    && catalog.locations.some((location) => (
      simpleOfferMonthlyGross(catalog, serverType, location.name) !== null
    ))
    && images.some((image) => image.architecture === serverType.architecture)
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
    left.price.monthly.currency.localeCompare(right.price.monthly.currency)
    || compareDecimal(left.totalMonthlyGross, right.totalMonthlyGross)
    || left.serverType.name.localeCompare(right.serverType.name)
    || left.providerLocation.name.localeCompare(right.providerLocation.name)
  ));
  const offer = offers[0];
  if (!offer) return EMPTY_SELECTION;

  const image = guidedImages(catalog)
    .filter((candidate) => candidate.architecture === offer.serverType.architecture)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id)[0];

  return {
    ...EMPTY_SELECTION,
    serverTypeId: String(offer.serverType.id),
    locationId: String(offer.providerLocation.id),
    imageId: image ? String(image.id) : "",
  };
}

function resultCopy(operation: HetznerCloudCapacityOperationDto, prepared: boolean): {
  title: string;
  body: string;
  tone: "ready" | "warning" | "error";
} {
  if (operation.externalCleanupResolutionId) return {
    title: "External cleanup verified.",
    body: "The original creation outcome remains ambiguous. Fresh Hetzner checks confirmed the server and generated key absent, with no servers or Primary IPs left in the project. The slot is free again; earlier charges still apply.",
    tone: "ready",
  };
  if (operation.status === "deleted") return {
    title: "Provider resources removed.",
    body: "Hivra verified that the server, both Primary IPs and the generated SSH key are gone. You can create another server; charges already accrued still apply.",
    tone: "ready",
  };
  if (operation.status === "cleaning") return {
    title: "Server removal is in progress.",
    body: "Open Remove created server on this project to check or resume it. This request can't buy another server.",
    tone: "warning",
  };
  if (
    operation.status === "created_off"
    && operation.createdPoweredOff
    && operation.providerActionStatus === "success"
    && operation.observedServerStatus === "off"
  ) {
    return prepared
      ? {
          title: "Server created (powered off). Billing has started.",
          body: "Next: set it up for agents. Start setup turns it on and installs Hivra's setup files.",
          tone: "ready",
        }
      : {
          title: "Server created (powered off). Billing has started.",
          body: "You chose a plain server, so Hivra won't set it up for agents. Manage or delete it in Hetzner.",
          tone: "ready",
        };
  }
  if (operation.status === "creating") {
    return {
      title: "Creation is still being observed.",
      body: "Hetzner hasn't produced final server evidence yet. Hivra doesn't treat this request as created or ready.",
      tone: "warning",
    };
  }
  if (operation.status === "ambiguous") {
    return {
      title: "Creation outcome needs reconciliation.",
      body: "Hivra couldn't prove whether Hetzner created the server. Don't start a different request; check this same request again to reconcile it safely.",
      tone: "warning",
    };
  }
  return {
    title: "Hetzner rejected the request.",
    body: "Hivra recorded the rejection and did not record any server as created.",
    tone: "error",
  };
}

export function HetznerCloudCapacityDialog({
  connection,
  onClose,
  returnFocusRef,
  onInventoryChanged,
  slot = null,
  launchResourceId = null,
  launchLabel = null,
  unifiedLaunchReturn = false,
  onChanged,
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
  // Every Hivra-created server carries the setup recipe unless the user opts
  // out under Advanced; a plain server can never be set up later.
  const [prepare, setPrepare] = useState(true);
  const [creating, setCreating] = useState(false);
  const [verifyingCleanup, setVerifyingCleanup] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
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
  const busy = creating || verifyingCleanup || settingUp;
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !busy,
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
    return guidedImages(catalog).filter((image) => image.architecture === selectedType.architecture);
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
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.scrollTop = 0;
      // Phones scroll this dialog with the dashboard page, not inside itself.
      if (window.getComputedStyle(dialog).overflowY === "visible") {
        dialog.scrollIntoView?.({ block: "start" });
      }
    }
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
    const nextImage = guidedImages(catalog).find((image) => image.architecture === nextType?.architecture);
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
      setPrepare(true);
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
    setPrepare(true);
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
      onChanged?.();
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
        "The secure creation identifier is missing. Close this window and review current rates again.",
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
        "Hivra couldn't save the non-secret recovery identifiers in this browser. No provider request was sent.",
      );
      return;
    }
    setRecoveryRequest(persisted);
    await submitCreate(request);
  }

  const copy = operation ? resultCopy(operation, prepare) : null;
  const quoteFresh = Boolean(quote && Date.parse(quote.expiresAt) > quoteClock);
  const createdForSetup = phase === "result" && operation?.status === "created_off" && prepare
    && !operation.externalCleanupResolutionId;
  const title = phase === "choose"
    ? "Choose a Hetzner server"
    : phase === "review"
      ? "Review and create"
      : phase === "recovery"
        ? "Recover pending request"
        : createdForSetup
          ? "Set it up for agents"
          : "Hetzner result";
  const currentStep = phase === "choose" ? 0 : phase === "review" ? 1 : 2;

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
            <span className={styles.eyebrow}>My cloud · {connection.name}</span>
            <h1 ref={headingRef} tabIndex={-1} id="hetzner-capacity-title">{title}</h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={busy}
            aria-label="Close Hetzner server setup"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <ol className={styles.capacityProgress} aria-label="Server creation steps">
          {(["Choose", "Review", phase === "recovery" ? "Recover" : "Set up"] as const).map((label, index) => (
            <li
              key={label}
              className={index === currentStep
                ? styles.capacityProgressActive
                : index < currentStep
                  ? styles.capacityProgressDone
                  : undefined}
              aria-current={index === currentStep ? "step" : undefined}
            >
              <span>{index < currentStep ? <CheckCircle2 size={12} aria-hidden="true" /> : index + 1}</span>
              {label}
            </li>
          ))}
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
              slot={slot}
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
              launchLabel={launchLabel}
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
              connection={connection}
              operation={operation}
              inventory={resultInventory}
              copy={copy}
              prepared={prepare}
              checking={creating}
              error={operationError}
              launchResourceId={launchResourceId}
              unifiedLaunchReturn={unifiedLaunchReturn}
              onCheck={() => void createServer()}
              onClose={onClose}
              onSetupChanged={() => onChanged?.()}
              onSettingUpChange={setSettingUp}
              verifying={verifyingCleanup}
              onVerifyingChange={setVerifyingCleanup}
              onResolved={(resolutionId) => {
                setOperation({ ...operation, externalCleanupResolutionId: resolutionId, canarySlotHeld: false });
                const remaining = resultInventory.filter(server => server.providerResourceId !== operation.providerServerId);
                setResultInventory(remaining);
                onInventoryChanged(remaining);
                onChanged?.();
                clearRecoveryRecord(connection.id, { quoteId: operation.id, idempotencyKey: operation.idempotencyKey });
                setRecoveryRequest(null);
              }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "selected">("idle");
  const valueRef = useRef<HTMLSpanElement>(null);
  const active = useRef(true);
  const resetTimer = useRef<number | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function copyValue() {
    let copiedToClipboard = true;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      copiedToClipboard = false;
    }
    if (!active.current) return;
    if (!copiedToClipboard && valueRef.current) {
      // Clipboard access can be denied or missing (insecure origin, some
      // webviews). Selecting the value leaves the system Copy one step away.
      window.getSelection()?.selectAllChildren(valueRef.current);
    }
    setCopyState(copiedToClipboard ? "copied" : "selected");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      if (active.current) setCopyState("idle");
    }, copiedToClipboard ? 1_500 : 6_000);
  }

  const copied = copyState === "copied";
  return (
    <dd className={styles.copyableValue}>
      <span ref={valueRef}>{value}</span>
      <button
        type="button"
        className={styles.copyValueButton}
        data-copied={copied ? "true" : undefined}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copyValue()}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span role="status" className={copyState === "selected" ? styles.copyStatus : styles.srOnly}>
        {copied ? `Copied ${label}` : copyState === "selected" ? "Selected — use Copy" : ""}
      </span>
    </dd>
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

      <dl
        className={`${styles.capacityOperationFacts} ${styles.capacityRecoveryFacts}`}
        aria-label="Saved recovery identifiers"
      >
        <div><dt>Connection</dt><CopyableValue label="connection id" value={request.connectionId} /></div>
        <div><dt>Quote</dt><CopyableValue label="quote id" value={request.quoteId} /></div>
        <div><dt>Request key</dt><CopyableValue label="request key" value={request.idempotencyKey} /></div>
      </dl>

      <div className={styles.capacityBoundary}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Nothing is submitted automatically after a reload.</strong>
          <span>
            Check this saved request to reconcile the original provider call. Don&apos;t
            start a different request: this account&apos;s one Hetzner server slot may already be in use.
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
          Close
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
  slot,
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
  slot: HetznerCloudCapacitySlotDto | null;
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
        <h2>No server Hivra can set up is available here.</h2>
        <p>
          Hivra sets up {HETZNER_GUIDED_SETUP_BASE.label} servers. This project doesn&apos;t
          currently offer a size, location and {HETZNER_GUIDED_SETUP_BASE.label} image
          combination within Hivra&apos;s price limits.
        </p>
        <button type="button" className={styles.secondaryButton} onClick={onRetryCatalog}>
          Refresh choices
        </button>
      </div>
    );
  }

  const slotUsed = Boolean(slot?.held);

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
            These options come live from your Hetzner project. The next screen shows
            Hetzner&apos;s current price before anything can be bought.
          </p>
        </div>
      </div>

      <div className={styles.formSection}>
        <div className={styles.formSectionHeading}>
          <span className={styles.sectionNumber}>01</span>
          <div>
            <h2>Cloud server</h2>
            <p>
              One server for your agents. Hivra names it and creates it powered off. Only
              images Hivra can set up for agents are listed ({HETZNER_GUIDED_SETUP_BASE.label}).
            </p>
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

      {slotUsed ? (
        <div className={styles.capacityBoundary} role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>This account&apos;s Hetzner server slot is in use.</strong>
            <span>{hetznerCapacitySlotReason(slot)}</span>
          </div>
        </div>
      ) : null}

      <div className={styles.wizardActions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onQuote}
          disabled={quoting || slotUsed}
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
  launchLabel,
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
  launchLabel: string | null;
  onConfirmed: (confirmed: boolean) => void;
  onBack: () => void;
  onCreate: () => void;
  prepare: boolean;
  onPrepare: (prepare: boolean) => void;
}) {
  const currency = quote.price.currency;
  // The dialog lists only supported bases, but the quote is the server's truth.
  const preparationSupported = isHetznerGuidedSetupServerType(quote.serverType) && isHetznerGuidedSetupImage(quote.image);
  const guided = prepare && preparationSupported;
  const hourly = formatMoney(currency, quote.price.total.hourly.gross);
  const monthly = formatMoney(currency, quote.price.total.monthly.gross);
  const advancedId = `${confirmationId}-plain`;

  return (
    <>
      <div className={styles.capacityQuoteHero}>
        <div>
          <span className={styles.sectionLabel}>From Hetzner now</span>
          <strong>{hourly}<small> / hour</small></strong>
          <span>At most {monthly} a month, before extra traffic</span>
        </div>
        <div>
          <span className={styles.sectionLabel}>Server</span>
          <strong className={styles.capacityQuoteServer}>{quote.serverType.name}<small> · {quote.serverType.cores} vCPU · {quote.serverType.memoryGb} GB</small></strong>
          <span>{quote.location.city} · {quote.image.description}</span>
        </div>
        <span className={styles.quoteExpiry}>
          Price valid until {new Date(quote.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <section className={styles.createTimelineSection} aria-labelledby="capacity-next-heading">
        <h2 id="capacity-next-heading" className={styles.sectionLabel}>What happens next</h2>
        <ol className={styles.createTimeline}>
          <li>
            <span aria-hidden="true">1</span>
            <div><strong>Create</strong><p>Hetzner starts billing.</p></div>
          </li>
          <li className={guided ? undefined : styles.createTimelineSkipped}>
            <span aria-hidden="true">2</span>
            <div>
              <strong>Set it up for agents</strong>
              <p>{guided ? "About 5 minutes; you start it next." : "Skipped. You chose a plain server under Advanced."}</p>
            </div>
          </li>
          <li className={guided ? undefined : styles.createTimelineSkipped}>
            <span aria-hidden="true">3</span>
            <div>
              <strong>{launchLabel ? `Launch ${launchLabel}` : "Launch"}</strong>
              <p>{guided ? "You review it next." : "Not available on a plain server."}</p>
            </div>
          </li>
        </ol>
      </section>

      <label className={styles.capacityConfirmation} htmlFor={confirmationId}>
        <input
          id={confirmationId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmed(event.target.checked)}
          disabled={creating}
        />
        <span>
          <strong>Confirm Hetzner billing</strong>
          <span>
            I understand Hetzner bills this server {hourly} an hour, at most {monthly} a month,
            from now until I delete it, and Hetzner&apos;s bill is final.
          </span>
        </span>
      </label>

      <details className={styles.capacityDisclosure}>
        <summary>Billing details</summary>
        <div className={styles.capacityDisclosureBody}>
          <dl className={styles.capacityPriceBreakdown} aria-label="Hetzner price breakdown">
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
            <div>
              <dt>Traffic beyond {formatIncludedTraffic(quote.price.traffic.includedBytes)}</dt>
              <dd>
                <strong>{formatMoney(currency, quote.price.traffic.additionalPerTb.gross)}</strong>
                <span>per additional TB gross</span>
              </dd>
            </div>
          </dl>
          <ul className={styles.capacityDetailList}>
            <li>Gross prices in {currency.toUpperCase()}, including Hetzner&apos;s VAT rate of {displayDecimal(quote.price.vatRate)}%.</li>
            <li>Hetzner rounds partial hours up and keeps billing while the server is powered off.</li>
            <li>The two Primary IPs are billed separately while they exist. Remove created server deletes them with the server.</li>
            <li>{quote.billing.trafficOverage}</li>
            <li>Hivra creates the server powered off, with public IPv4 and IPv6, no backups and no volumes. In rare migration or hardware-failure cases Hetzner can power a server on by itself; check Hetzner Console if the server looks wrong.</li>
            <li>
              Setup adds a <code>{quote.access.username}</code> user with a generated Ed25519 key and opens SSH
              (TCP 22). Password and root logins stay off. {guided
                ? "Setup applies and checks a Hetzner firewall before it turns the server on."
                : quote.access.firewallLimitation}
            </li>
            <li>Right now Hivra can create one Hetzner server per account. Remove created server frees it again.</li>
          </ul>
        </div>
      </details>

      <details className={styles.capacityDisclosure}>
        <summary>Advanced</summary>
        <div className={styles.capacityDisclosureBody}>
          <label className={styles.capacityAdvancedOption} htmlFor={advancedId}>
            <input
              id={advancedId}
              type="checkbox"
              checked={!guided}
              disabled={creating || !preparationSupported}
              onChange={(event) => onPrepare(!event.target.checked)}
            />
            <span>
              <strong>Create a plain server without agent setup</strong>
              <span>
                Hivra won&apos;t set it up for agents, and it can&apos;t be set up later. You
                manage it yourself in Hetzner.
              </span>
            </span>
          </label>
        </div>
      </details>

      {!quoteFresh ? (
        <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>This price has expired. Go back and review current rates before creating.</span>
        </div>
      ) : null}

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
  connection,
  operation,
  inventory,
  copy,
  prepared,
  checking,
  error,
  launchResourceId,
  unifiedLaunchReturn,
  onCheck,
  onClose,
  onSetupChanged,
  onSettingUpChange,
  onResolved,
  verifying,
  onVerifyingChange,
}: {
  connection: HetznerCloudConnectionDto;
  operation: HetznerCloudCapacityOperationDto;
  inventory: HetznerCloudServerInventoryDto[];
  copy: ReturnType<typeof resultCopy>;
  prepared: boolean;
  checking: boolean;
  error: string | null;
  launchResourceId: PortableLaunchResourceId | null;
  unifiedLaunchReturn: boolean;
  onCheck: () => void;
  onClose: () => void;
  onSetupChanged: () => void;
  onSettingUpChange: (running: boolean) => void;
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
  const createdOff = operation.status === "created_off" && !resolved;
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
  // A server created for setup hands straight to the setup status; one status
  // block, with the purchase as its first line.
  const handsToSetup = createdOff && prepared;
  return (
    <div className={styles.capacityResult}>
      {handsToSetup ? null : (
        <div className={`${styles.capacityResultHero} ${styles[`capacityResult_${copy.tone}`]}`}>
          <span aria-hidden="true">
            {copy.tone === "ready" ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
          </span>
          <div>
            <span className={styles.sectionLabel}>{operation.quote.serverName}</span>
            <h2>{copy.title}</h2>
            <p>{copy.body}</p>
          </div>
        </div>
      )}

      {observedUnexpectedlyPowered && !resolved ? (
        <div className={`${styles.capacityBoundary} ${styles.capacityCritical}`} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Server observed powered on — check Hetzner now.</strong>
            <span>
              Hetzner reported this server as {operation.observedServerStatus}. Hivra did
              not authorize an agent launch and will not power the server off
              automatically. Open Hetzner Console, inspect the server, and power it
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

      {!createdOff ? (
        <div className={styles.capacityBoundary}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>
              {operation.canarySlotHeld
                ? "This request uses the account's one Hetzner server slot."
                : "This request did not keep the account's Hetzner server slot."}
            </strong>
            <span>
              {operation.canarySlotHeld
                ? "The slot covers every Hetzner project you connect. Use Remove created server to verify cleanup of a created, powered-off server. Disconnecting alone doesn't stop charges or free the slot; older unresolved launches need manual review."
                : operation.status === "deleted"
                  ? "The original resources were confirmed gone. You can review a fresh price for another server."
                  : resolved
                    ? "External cleanup was checked independently. The original failure record is kept; you can review a fresh price. This is point-in-time evidence, not a guarantee against later changes in Hetzner."
                    : "Hivra recorded no Hetzner server or project SSH key holding the slot. You can retry after fixing the reported cause."}
            </span>
          </div>
        </div>
      ) : null}

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
            <span>Verify external cleanup to free this request&apos;s slot. Hivra checks the original server and generated key, and requires this project to have no servers or Primary IPs. This deletes nothing and does not retry the purchase.</span>
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

      {handsToSetup ? (
        <ProviderComputerSetupPanel
          note={copy.title}
          connection={connection}
          orderId={operation.id}
          launchResourceId={launchResourceId}
          unifiedLaunchReturn={unifiedLaunchReturn}
          onChanged={onSetupChanged}
          onRunningChange={onSettingUpChange}
        />
      ) : (
        <div className={styles.resultActions}>
          <button
            type="button"
            className={canRecheck ? styles.secondaryButton : styles.primaryButton}
            onClick={onClose}
            disabled={checking || verifying}
          >
            {createdOff ? "Done" : "Close"}
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
      )}

      <details className={styles.capacityDisclosure}>
        <summary>Technical details</summary>
        <div className={styles.capacityDisclosureBody}>
          <dl className={styles.capacityOperationFacts} aria-label="Provider operation evidence">
            <div><dt>Hivra operation</dt><dd>{operation.id}</dd></div>
            <div><dt>Status</dt><dd>{operation.status.replaceAll("_", " ")}</dd></div>
            <div><dt>Provider server</dt><dd>{operation.providerServerId ?? "Not confirmed"}</dd></div>
            <div><dt>Provider action</dt><dd>{operation.providerActionId ?? "Not confirmed"}</dd></div>
            <div><dt>Action command</dt><dd>{operation.providerActionCommand ?? "Not confirmed"}</dd></div>
            <div><dt>Observed power</dt><dd>{operation.observedServerStatus ?? "Not confirmed"}</dd></div>
            <div><dt>Observed at</dt><dd>{operation.providerObservedAt ? new Date(operation.providerObservedAt).toLocaleString() : "Not confirmed"}</dd></div>
            <div><dt>Server slot</dt><dd>{operation.canarySlotHeld ? "In use" : "Free"}</dd></div>
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
              <span className={styles.sectionLabel}>Project servers after this request</span>
              {inventory.map((server) => (
                <article key={server.id}>
                  <Server size={17} aria-hidden="true" />
                  <div>
                    <strong>{server.name}</strong>
                    <span>
                      {server.serverType.name} · {server.location.city ?? server.location.name} · {server.status}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
