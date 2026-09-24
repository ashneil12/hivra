import fs from "node:fs";
import path from "node:path";

// A loading.tsx wraps its segment in a Suspense boundary, so the response
// starts streaming with HTTP 200 before the page can call notFound() or
// redirect(). A root app/loading.tsx turned every unknown /blog, /features and
// /compare slug into a 200 soft-404 (noindex, canonical to the homepage) and
// every page-level redirect (/reserve) into a 200 + meta refresh, and hid the
// public page content behind the loader until JavaScript ran. Loading
// boundaries therefore belong only to the signed-in dashboard.
const APP_DIR = path.resolve(__dirname, "..");

function findLoadingFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findLoadingFiles(full));
    } else if (/^loading\.(t|j)sx?$/.test(entry.name)) {
      found.push(path.relative(APP_DIR, full));
    }
  }
  return found;
}

describe("route loading boundaries", () => {
  it("keeps loading.tsx out of the root and every public route", () => {
    const outsideDashboard = findLoadingFiles(APP_DIR).filter(
      (file) => !file.split(path.sep).includes("dashboard"),
    );
    expect(outsideDashboard).toEqual([]);
  });
});
