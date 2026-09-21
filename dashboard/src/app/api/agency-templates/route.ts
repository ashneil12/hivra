import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiSuccess, handleApiError } from "@/lib/api-response";
import { buildAgencyTemplates, type AgentTemplate, type RawAgencyTemplate } from "@/data/agency-templates";

// The templates JSON ships with the bundle and never changes at runtime
// (it's a static asset), so we read+parse+normalize it ONCE on first
// request and cache the resulting array in module scope. Without this,
// every GET parsed a 2 MB JSON blob from disk — measurable on warm
// containers and a wasted 5–15 ms per request under load.
//
// Cache invalidation: none needed. The file changes only when a new
// build is shipped, which spawns fresh module instances.
let cachedTemplates: AgentTemplate[] | null = null;
let cachedTemplatesPromise: Promise<AgentTemplate[]> | null = null;

async function loadTemplates(): Promise<AgentTemplate[]> {
  if (cachedTemplates) return cachedTemplates;
  if (cachedTemplatesPromise) return cachedTemplatesPromise;

  const templatesPath = path.join(process.cwd(), "src/data/agency-templates.json");
  cachedTemplatesPromise = (async () => {
    const raw = await readFile(templatesPath, "utf8");
    const parsed = JSON.parse(raw) as RawAgencyTemplate[];
    const built = buildAgencyTemplates(parsed);
    cachedTemplates = built;
    return built;
  })();

  try {
    return await cachedTemplatesPromise;
  } finally {
    // Keep the promise around only on success — on failure we want the
    // next GET to retry the file read instead of replaying the rejection.
    if (!cachedTemplates) cachedTemplatesPromise = null;
  }
}

export async function GET() {
  try {
    const templates = await loadTemplates();
    return apiSuccess(templates);
  } catch (err) {
    return handleApiError(err);
  }
}
