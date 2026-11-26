// Pure schema and launch-spec serializer for declarative catalog apps and
// agents. Client-safe (no filesystem or secrets).
//
// Every entry in the universal catalog is defined once as a validated manifest.
// The dashboard catalog, launch contracts, resource floors, sleep/wake profile,
// SEO metadata, and the guest catalog-app launch document all derive from it.

import { z } from "zod";

/** Strict slug rule shared across the manifest registry, database checks, and
 * the guest catalog-app runner. */
export const CATALOG_APP_SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Reserved guest loopback port range for universal catalog apps so they never
 * collide with the gateway (:8080), ttyd (:7681/:7682), or legacy runtimes. */
export const CATALOG_APP_PORT_MIN = 3200;
export const CATALOG_APP_PORT_MAX = 3999;

/** OSI-approved open-source licenses vetted for unmodified upstream
 * single-tenant hosting, permissive and copyleft alike. Source-available and
 * commercial-hosting-restricted licenses are intentionally excluded so they
 * fail schema validation before any launch work begins. */
export const CATALOG_OSI_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "ISC",
  "MIT OR Apache-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "MPL-2.0",
] as const;
export type CatalogOsiLicense = (typeof CATALOG_OSI_LICENSES)[number];

export const CATALOG_APP_CATEGORIES = ["agent", "app"] as const;
export type CatalogAppCategory = (typeof CATALOG_APP_CATEGORIES)[number];

export const CATALOG_APP_ICON_KEYS = [
  "bot",
  "code",
  "cpu",
  "globe",
  "layers",
  "terminal",
  "workflow",
  "git",
  "activity",
] as const;
export type CatalogAppIconKey = (typeof CATALOG_APP_ICON_KEYS)[number];

export const CATALOG_APP_JOB_IDS = [
  "coding",
  "research",
  "messages",
  "automation",
  "assistant",
  "self-hosted",
] as const;
export type CatalogAppJobId = (typeof CATALOG_APP_JOB_IDS)[number];

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const IMAGE_REPO_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?(?::[0-9]{2,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,120}$/;
const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MOUNT_PATH_RE = /^\/[A-Za-z0-9._/-]{1,120}$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const BIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_ASSET_RE = /^[A-Za-z0-9._-]{1,120}\.(?:tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/;
const SAFE_ARG_RE = /^[A-Za-z0-9._:/=,@+-]{1,128}$/;

const FORBIDDEN_MOUNT_PREFIXES = [
  "/",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "/boot",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
];

function isSafeMountPath(mountPath: string): boolean {
  if (!MOUNT_PATH_RE.test(mountPath)) return false;
  const parts = mountPath.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  if (mountPath === "/") return false;
  for (const forbidden of FORBIDDEN_MOUNT_PREFIXES) {
    if (forbidden === "/") continue;
    if (mountPath === forbidden || mountPath.startsWith(`${forbidden}/`)) return false;
  }
  return true;
}

function isSafeHealthPath(value: string): boolean {
  if (!HEALTH_PATH_RE.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function isPrintableEnvValue(value: string): boolean {
  if (value.length > 512) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const EnvMapSchema = z
  .record(z.string().regex(ENV_KEY_RE), z.string().refine(isPrintableEnvValue, "Env value must be printable ASCII/UTF-8 without control chars"))
  .refine((obj) => Object.keys(obj).length <= 32, "At most 32 static env vars");

/** Secret names a runtime may ask the guest to generate once (32 random bytes,
 * root-only file, reused across reinstalls). Values are substituted into env
 * placeholders at install; the names themselves travel in the launch spec. */
const GeneratedSecretsSchema = z
  .array(z.string().regex(ENV_KEY_RE))
  .max(8)
  .refine((names) => new Set(names).size === names.length, "generatedSecrets must be unique");

/** Env values may reference the launch document's public origin pieces and the
 * runtime's declared generated secrets — nothing else. The guest substitutes
 * them when it writes the env file(s); secret values never enter the spec. */
export const CATALOG_ENV_PUBLIC_PLACEHOLDERS = ["HIVRA_PUBLIC_ORIGIN", "HIVRA_PUBLIC_HOST"] as const;
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function envValuePlaceholdersOk(value: string, secretNames: ReadonlySet<string>): boolean {
  const allowed = new Set<string>([...CATALOG_ENV_PUBLIC_PLACEHOLDERS, ...secretNames]);
  for (const match of value.matchAll(ENV_PLACEHOLDER_RE)) {
    if (!allowed.has(match[1])) return false;
  }
  // A "${" that does not form one of the allowed placeholders is rejected so a
  // typo can never ship a literal placeholder string to the app.
  return !value.replace(ENV_PLACEHOLDER_RE, "").includes("${");
}

function envMapPlaceholdersOk(
  env: Record<string, string> | undefined,
  secretNames: ReadonlySet<string>,
): boolean {
  if (!env) return true;
  return Object.values(env).every((value) => envValuePlaceholdersOk(value, secretNames));
}

export const ModelEnvBindingSchema = z
  .object({
    apiKeyVar: z.string().regex(ENV_KEY_RE),
    baseUrlVar: z.string().regex(ENV_KEY_RE),
    modelVar: z.string().regex(ENV_KEY_RE).optional(),
    extraEnv: EnvMapSchema.optional(),
  })
  .strict();

export const DockerVolumeSchema = z
  .object({
    name: z.string().regex(VOLUME_NAME_RE),
    mountPath: z.string().refine(isSafeMountPath, "Mount path is forbidden or unsafe"),
  })
  .strict();

export const DockerWebRuntimeSchema = z
  .object({
    kind: z.literal("docker-web"),
    imageRepo: z.string().regex(IMAGE_REPO_RE),
    imageTag: z.string().regex(IMAGE_TAG_RE),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    containerPort: z.number().int().min(1).max(65535),
    hostPort: z.number().int().min(CATALOG_APP_PORT_MIN).max(CATALOG_APP_PORT_MAX),
    healthPath: z.string().refine(isSafeHealthPath, "Invalid health path"),
    volumes: z.array(DockerVolumeSchema).min(1).max(8),
    env: EnvMapSchema.optional(),
    generatedSecrets: GeneratedSecretsSchema.optional(),
    modelEnv: ModelEnvBindingSchema.optional(),
    dropAllCaps: z.boolean().optional(),
    stopTimeoutSeconds: z.number().int().min(5).max(120).optional(),
    proxyMode: z.enum(["standard", "loopback-origin"]),
  })
  .strict();

export const CliInstallerSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("uv-tool"),
      packageName: z.string().regex(PACKAGE_NAME_RE),
      binName: z.string().regex(BIN_NAME_RE),
    })
    .strict(),
  z
    .object({
      method: z.literal("npm-global"),
      packageName: z.string().regex(PACKAGE_NAME_RE),
      binName: z.string().regex(BIN_NAME_RE),
    })
    .strict(),
  z
    .object({
      method: z.literal("github-release-tar"),
      repo: z.string().regex(GITHUB_REPO_RE),
      binName: z.string().regex(BIN_NAME_RE),
      assetX64: z.string().regex(RELEASE_ASSET_RE),
      assetArm64: z.string().regex(RELEASE_ASSET_RE).optional(),
    })
    .strict(),
]);

const SETUP_COMMAND_RE = /^[\x20-\x7e]{1,2000}$/;

export const CliSetupSchema = z
  .object({
    /** Shell commands run once as the agent user after the CLI installs, in
     * order, with the merged static + model env loaded. For headless upstream
     * configuration env vars alone cannot express (e.g. `zeroclaw config set`).
     * Must be idempotent: the update path re-runs the install. */
    commands: z.array(z.string().regex(SETUP_COMMAND_RE, "Setup command must be printable ASCII, at most 2000 chars")).min(1).max(16),
  })
  .strict();

export const CliWebRuntimeBaseSchema = z
  .object({
    kind: z.literal("cli-web"),
    installer: CliInstallerSchema,
    webService: z
      .object({
        binName: z.string().regex(BIN_NAME_RE).optional(),
        args: z.array(z.string().regex(SAFE_ARG_RE)).max(24),
        hostPort: z.number().int().min(CATALOG_APP_PORT_MIN).max(CATALOG_APP_PORT_MAX),
        healthPath: z.string().refine(isSafeHealthPath, "Invalid health path"),
        proxyMode: z.enum(["standard", "loopback-origin"]),
      })
      .strict()
      .optional(),
    cliChat: z
      .object({
        args: z.array(z.string().regex(SAFE_ARG_RE)).max(16),
        promptVia: z.enum(["arg", "stdin"]),
      })
      .strict()
      .optional(),
    setup: CliSetupSchema.optional(),
    env: EnvMapSchema.optional(),
    generatedSecrets: GeneratedSecretsSchema.optional(),
    modelEnv: ModelEnvBindingSchema.optional(),
  })
  .strict();

export const CliWebRuntimeSchema = CliWebRuntimeBaseSchema.refine(
  (runtime) => Boolean(runtime.webService || runtime.cliChat),
  { message: "cli-web runtime must define webService, cliChat, or both" },
);

const STACK_SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** One container in a docker-stack runtime. Image refs are tags in the spec;
 * the guest pins each pulled digest into the rendered compose file. */
export const DockerStackServiceSchema = z
  .object({
    name: z.string().regex(STACK_SERVICE_NAME_RE),
    imageRepo: z.string().regex(IMAGE_REPO_RE),
    imageTag: z.string().regex(IMAGE_TAG_RE),
    env: EnvMapSchema.optional(),
    generatedSecrets: GeneratedSecretsSchema.optional(),
    volumes: z.array(DockerVolumeSchema).max(8).optional(),
    dropAllCaps: z.boolean().optional(),
    dependsOn: z.array(z.string().regex(STACK_SERVICE_NAME_RE)).max(5).optional(),
  })
  .strict();
export type DockerStackService = z.infer<typeof DockerStackServiceSchema>;

/** Multi-container catalog app: the guest renders a compose file itself
 * (never raw YAML from a manifest) with digest-pinned images, one internal
 * network, named volumes, no-new-privileges and the only published port on
 * the web service's loopback hostPort. */
export const DockerStackRuntimeSchema = z
  .object({
    kind: z.literal("docker-stack"),
    services: z.array(DockerStackServiceSchema).min(2).max(6),
    web: z
      .object({
        service: z.string().regex(STACK_SERVICE_NAME_RE),
        containerPort: z.number().int().min(1).max(65535),
        hostPort: z.number().int().min(CATALOG_APP_PORT_MIN).max(CATALOG_APP_PORT_MAX),
        healthPath: z.string().refine(isSafeHealthPath, "Invalid health path"),
        proxyMode: z.enum(["standard", "loopback-origin"]),
      })
      .strict(),
    stopTimeoutSeconds: z.number().int().min(5).max(120).optional(),
  })
  .strict();

const CatalogRuntimeFieldsSchema = z.discriminatedUnion("kind", [
  DockerWebRuntimeSchema,
  CliWebRuntimeBaseSchema,
  DockerStackRuntimeSchema,
]);

type CatalogRuntimeFields = z.infer<typeof CatalogRuntimeFieldsSchema>;

const STACK_PLACEHOLDER_MESSAGE =
  "Env values may only use ${HIVRA_PUBLIC_ORIGIN}, ${HIVRA_PUBLIC_HOST} or declared generatedSecrets";

function catalogRuntimeRefinement(runtime: CatalogRuntimeFields, ctx: z.RefinementCtx) {
  if (runtime.kind === "docker-web" || runtime.kind === "cli-web") {
    const secrets = new Set(runtime.generatedSecrets ?? []);
    if (!envMapPlaceholdersOk(runtime.env, secrets) || !envMapPlaceholdersOk(runtime.modelEnv?.extraEnv, secrets)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: STACK_PLACEHOLDER_MESSAGE });
    }
    return;
  }
  if (runtime.kind !== "docker-stack") return;

  // Secrets are app-wide (one root-only file): every service may reference
  // any declared name via ${NAME}, and a service receives the raw value only
  // for the names it declares itself.
  const allSecrets = new Set<string>(
    runtime.services.flatMap((service) => service.generatedSecrets ?? []),
  );
  for (const service of runtime.services) {
    if (!envMapPlaceholdersOk(service.env, allSecrets)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${STACK_PLACEHOLDER_MESSAGE} (service ${service.name})` });
      return;
    }
  }

  const names = runtime.services.map((service) => service.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "docker-stack service names must be unique" });
  }
  if (!names.includes(runtime.web.service)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `docker-stack web.service ${runtime.web.service} is not a declared service` });
  }
  for (const service of runtime.services) {
    // Non-web services must not track a moving tag: a `latest` pull on update
    // could silently change the database major version under existing data.
    if (service.name !== runtime.web.service && service.imageTag === "latest") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `docker-stack non-web service ${service.name} must not use the latest tag` });
    }
  }
  const seen = new Set<string>();
  for (const service of runtime.services) {
    for (const dep of service.dependsOn ?? []) {
      if (!seen.has(dep)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `docker-stack service ${service.name} dependsOn ${dep} which is not an earlier service` });
      }
    }
    seen.add(service.name);
  }
}

export const CatalogAppRuntimeSchema = CatalogRuntimeFieldsSchema.superRefine(catalogRuntimeRefinement).refine(
  (runtime) => runtime.kind !== "cli-web" || Boolean(runtime.webService || runtime.cliChat),
  { message: "cli-web runtime must define webService, cliChat, or both" },
);
export type CatalogAppRuntime = z.infer<typeof CatalogAppRuntimeSchema>;

const StarterSchema = z
  .object({
    title: z.string().min(4).max(80),
    prompt: z.string().min(10).max(400).regex(/\.$/, "Starter prompt must end with a period"),
  })
  .strict();

const ResourcePairSchema = z
  .object({
    cpu: z.number().min(0.5).max(8),
    ram: z.number().int().min(1).max(24),
  })
  .strict();

export const CatalogAppManifestSchema = z
  .object({
    id: z.string().regex(CATALOG_APP_SLUG_RE),
    name: z.string().min(2).max(60),
    vendor: z.string().min(2).max(60),
    category: z.enum(CATALOG_APP_CATEGORIES),
    license: z.enum(CATALOG_OSI_LICENSES),
    sourceUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/),
    tagline: z.string().min(10).max(180).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
    description: z.string().min(10).max(200).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
    capabilityLine: z.string().min(10).max(220).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
    badge: z.string().min(2).max(24),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$|^var\(--[a-z0-9-]+\)$/),
    icon: z.enum(CATALOG_APP_ICON_KEYS),
    jobs: z.array(z.enum(CATALOG_APP_JOB_IDS)).min(1).max(4),
    keywords: z.array(z.string().min(2).max(40)).min(2).max(16),
    talk: z.string().min(8).max(200),
    firstTasks: z.array(StarterSchema).max(5),
    minPlan: z.enum(["free", "pro", "power"]),
    weight: z.number().int().min(1).max(4),
    floor: ResourcePairSchema,
    recommended: ResourcePairSchema,
    candidates: z.array(ResourcePairSchema).min(1).max(4).optional(),
    cpuOptions: z.array(z.number().min(0.5).max(8)).min(1).max(8),
    ramOptions: z.array(z.number().int().min(1).max(24)).min(1).max(8),
    managedVenice: z.boolean(),
    llm: z
      .object({
        wire: z.literal("openai"),
        providers: z.array(z.literal("venice")).min(1),
      })
      .strict()
      .optional(),
    runtime: CatalogAppRuntimeSchema,
    seo: z
      .object({
        metaTitle: z.string().min(10).max(90).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
        metaDescription: z.string().min(40).max(170).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
        summary: z.string().min(30).max(320).refine((s) => !/[\u2013\u2014]/.test(s), "No em or en dashes"),
      })
      .strict(),
  })
  .strict();

export type CatalogAppManifest = z.infer<typeof CatalogAppManifestSchema>;

/** Secret-free runtime specification serialized into the guest launch document
 * (v5) and consumed by hivra-catalog-app.py on the guest VM. */
export interface CatalogAppLaunchSpec {
  appId: string;
  name: string;
  runtime: CatalogAppRuntime;
}

export function buildCatalogAppLaunchSpec(manifest: CatalogAppManifest): CatalogAppLaunchSpec {
  return {
    appId: manifest.id,
    name: manifest.name,
    runtime: manifest.runtime,
  };
}
