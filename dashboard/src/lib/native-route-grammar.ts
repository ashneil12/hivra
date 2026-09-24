import type { PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";
import type { LaunchProfileId, LaunchStage } from "@/lib/launch/contracts";
import type { PlanKey } from "@/lib/subscription/plans";

/**
 * The dashboard route grammar shared with native shells.
 *
 * A native shell adopts dashboard pages into resource tabs and asks the page to
 * navigate. Both sides canonicalize every route through this grammar, so a route
 * one side produces is always accepted by the other. Every case in
 * apps/shared/native-contract/route-grammar.v1.json must give the same result
 * here and in the Mac app's HivraWorkspaceRouteGrammar.swift. The rules:
 *
 * - Input is printable ASCII (no whitespace, controls, backslash or non-ASCII),
 *   at most 2,048 characters, and rooted at /dashboard. A fragment is discarded.
 * - Each path segment is percent-decoded once and must then be non-empty RFC 3986
 *   unreserved text other than "." and "..", so encoded separators, traversal and
 *   double encoding are rejected.
 * - Each query parameter is decoded once to printable ASCII, named at most once,
 *   and either kept (validated and canonicalized), discarded because the page
 *   consumed it on arrival, or the whole route is rejected. Kept parameters are
 *   written in a fixed per-route order, so a canonical route is a fixed point.
 */
export const NATIVE_ROUTE_GRAMMAR_VERSION = 1;
const MAX_ROUTE_LENGTH = 2048;

type Canonical = (value: string) => string | null;
type Parameter = { name: string; value: Canonical; requires?: { name: string; value: string } };
type Rule = { kept: readonly Parameter[]; discarded?: readonly string[] };

/** A literal list that the compiler proves names every member of `Union`. */
function everyMember<Union extends string>() {
  return <const List extends readonly Union[]>(
    list: List & ([Exclude<Union, List[number]>] extends [never] ? unknown : never),
  ): List => list;
}

const oneOf = (...values: readonly string[]): Canonical => (value) => (values.includes(value) ? value : null);
const matching = (pattern: RegExp, lowercase = false): Canonical => (value) =>
  pattern.test(value) ? (lowercase ? value.toLowerCase() : value) : null;
/** Accepted spellings and the value each one canonicalizes to. */
const mapped = (values: Readonly<Record<string, string>>): Canonical => (value) =>
  Object.hasOwn(values, value) ? values[value] : null;

const SURFACE = matching(/^[a-z][a-z0-9_-]{0,63}$/);
const ONE = oneOf("1");
const UUID = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, true);
/** A launch draft id (launch-plan.ts LAUNCH_DRAFT_ID). */
const LAUNCH_DRAFT = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, true);
/** A template id, slug or share token (launch-template.ts TEMPLATE_REF). */
const TEMPLATE_REFERENCE = matching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export const NATIVE_LAUNCH_PROFILES = everyMember<LaunchProfileId>()([
  "claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon",
  "ubuntu-desktop", "linux-terminal", "omarchy", "windows",
]);
/** Launch history stages, and the names used before Choose merged its steps
 * (LaunchJourney parseHistoryStage). The launch step itself is never history. */
const LAUNCH_STAGES = everyMember<Exclude<LaunchStage, "launch">>()(["choose", "plan", "review"]);
const LAUNCH_STAGE = mapped({
  ...Object.fromEntries(LAUNCH_STAGES.map((stage) => [stage, stage])),
  type: "choose", profile: "choose", capacity: "plan",
});
/** The paid plans an upgrade can return with (PLAN_ORDER without free). */
export const NATIVE_UPGRADE_PLANS = ["operator", "fleet", "command"] as const satisfies readonly PlanKey[];
const PORTABLE_LAUNCH_RESOURCES = everyMember<PortableLaunchResourceId>()([
  "claude-code", "codex", "aeon", "openclaw", "agent-zero", "linux-desktop", "linux-terminal", "windows",
]);

const TAB: Parameter = { name: "tab", value: SURFACE };
/** A client flag hint the agent page appends when it leaves a resource. */
const GLOBALLY_DISCARDED = ["hivra"];

/** `route` is the canonical path below /dashboard. */
function ruleFor(route: readonly string[]): Rule {
  const [section, id] = route;
  if (route.length === 0) {
    // The shell owns Home, so the web list request is not a route; needs-attention is a view.
    return { kept: [TAB, { name: "attention", value: ONE }], discarded: ["runtimes"] };
  }
  if (route.length === 1 && section === "computers") {
    return { kept: [TAB, { name: "launch", value: ONE }, { name: "targetId", value: UUID }] };
  }
  if (route.length === 2 && section === "computers" && id === "recovery") {
    return { kept: [TAB, { name: "source", value: matching(RESOURCE_ID) }] };
  }
  if (route.length === 1 && section === "launch") {
    return {
      kept: [
        { name: "kind", value: oneOf("agent", "computer") }, { name: "start", value: ONE },
        { name: "profile", value: oneOf(...NATIVE_LAUNCH_PROFILES) }, { name: "template", value: TEMPLATE_REFERENCE },
        { name: "templateToken", value: TEMPLATE_REFERENCE }, { name: "targetId", value: UUID },
        { name: "draft", value: LAUNCH_DRAFT }, { name: "upgraded", value: oneOf("1", ...NATIVE_UPGRADE_PLANS) },
        { name: "stage", value: LAUNCH_STAGE },
      ],
    };
  }
  if (route.length === 1 && section === "infrastructure") {
    return {
      kept: [TAB, { name: "launch", value: oneOf(...PORTABLE_LAUNCH_RESOURCES) },
        { name: "returnTo", value: oneOf("unified-launch") }, { name: "replaceToken", value: UUID }],
    };
  }
  if (route.length === 2 && RESOURCE_ID.test(id)) {
    // A launch result arrives with welcome (and Codex's #model-settings); the page consumes these once.
    if (section === "agent") {
      return {
        kept: [TAB, { name: "open", value: oneOf("fast", "native"), requires: { name: "tab", value: "desktop" } }],
        discarded: ["welcome", "prepare", "tools"],
      };
    }
    if (section === "instances") {
      return { kept: [TAB, { name: "surface", value: oneOf("chat") }], discarded: ["welcome", "connect", "focus"] };
    }
  }
  return { kept: [TAB] };
}

/** Decodes each escape once. Every decoded character must be printable ASCII, so
 * no platform's Unicode or "+" handling can make the two implementations differ. */
function percentDecoded(raw: string): string | null {
  let output = "";
  for (let index = 0; index < raw.length;) {
    let code = raw.charCodeAt(index);
    if (code === 0x25) {
      const hex = raw.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      code = Number.parseInt(hex, 16);
      index += 3;
    } else {
      index += 1;
    }
    if (code < 0x21 || code > 0x7e) return null;
    output += String.fromCharCode(code);
  }
  return output;
}

/** The canonical dashboard route for `value`, or null when it is not one. */
export function normalizeNativeDashboardRoute(value: string): string | null {
  if (!value || value.length > MAX_ROUTE_LENGTH || !/^[\x21-\x5b\x5d-\x7e]+$/.test(value)) return null;
  const hash = value.indexOf("#");
  const reference = hash === -1 ? value : value.slice(0, hash);
  const question = reference.indexOf("?");
  const rawPath = question === -1 ? reference : reference.slice(0, question);
  const rawQuery = question === -1 ? "" : reference.slice(question + 1);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === "") rawSegments.pop();
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    const segment = percentDecoded(rawSegment);
    if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) return null;
    segments.push(segment);
  }
  if (segments[0] !== "dashboard") return null;

  const parameters = new Map<string, string>();
  if (rawQuery) {
    for (const pair of rawQuery.split("&")) {
      const equals = pair.indexOf("=");
      const name = percentDecoded(equals === -1 ? pair : pair.slice(0, equals));
      const parameter = equals === -1 ? "" : percentDecoded(pair.slice(equals + 1));
      if (!name || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || parameters.has(name) || parameter === null) return null;
      parameters.set(name, parameter);
    }
  }

  const rule = ruleFor(segments.slice(1));
  const kept = new Map<string, string>();
  for (const [name, parameter] of parameters) {
    if (GLOBALLY_DISCARDED.includes(name) || rule.discarded?.includes(name)) continue;
    const canonical = rule.kept.find((candidate) => candidate.name === name)?.value(parameter);
    if (!canonical) return null;
    kept.set(name, canonical);
  }
  for (const { name, requires } of rule.kept) {
    if (requires && kept.has(name) && kept.get(requires.name) !== requires.value) return null;
  }
  const query = rule.kept.filter(({ name }) => kept.has(name)).map(({ name }) => `${name}=${kept.get(name)}`);
  const route = `/${segments.join("/")}${query.length ? `?${query.join("&")}` : ""}`;
  return route.length <= MAX_ROUTE_LENGTH ? route : null;
}
