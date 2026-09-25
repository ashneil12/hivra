/**
 * An independent (local-auth) build aliases @clerk/nextjs and
 * @clerk/nextjs/server to the self-host shims (next.config.ts). Webpack only
 * warns when a shim lacks a name the app imports, so the build passes and the
 * page or route then fails at runtime with a TypeError. These tests keep the
 * shims complete, and check the one Clerk check a local operator hits most
 * directly: the fresh sign-in check on withdrawal destination changes.
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import ts from "typescript";

import { auth } from "@clerk/nextjs/server";
import { SELF_HOST_SESSION_COOKIE } from "../config";
import { createLocalSessionToken } from "../session-token";

// What the local build does: every @clerk/nextjs/server import is the shim.
jest.mock("@clerk/nextjs/server", () => jest.requireActual("@/lib/self-host/clerk-server-shim"));

const mockCookieValue = { token: null as string | null };
jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({
    get: (name: string) =>
      name === "hivra_operator_session" && mockCookieValue.token ? { value: mockCookieValue.token } : undefined,
  })),
  headers: jest.fn(async () => new Headers()),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  instanceBankrWalletPublicSummary: jest.fn(() => ({ withdrawalDestinationEvm: "0x2222222222222222222222222222222222222222" })),
  listWithdrawalRecipientsForInstance: jest.fn(async () => []),
  setWithdrawalDestination: jest.fn(async () => ({ id: "wallet_1" })),
}));

const SRC = path.resolve(__dirname, "../../..");
const SHIMS: Record<string, string> = {
  "@clerk/nextjs": "@/lib/self-host/clerk-client-shim",
  "@clerk/nextjs/server": "@/lib/self-host/clerk-server-shim",
};
const SECRET = "correct-hivra-test-secret-that-is-at-least-32-characters";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** Every runtime name the app takes from a shimmed Clerk module, by module. */
function clerkImports(): Map<string, Map<string, string[]>> {
  const found = new Map<string, Map<string, string[]>>();
  const add = (specifier: string, name: string, file: string) => {
    if (!(specifier in SHIMS)) return;
    const names = found.get(specifier) ?? new Map<string, string[]>();
    names.set(name, [...(names.get(name) ?? []), path.relative(SRC, file)]);
    found.set(specifier, names);
  };
  for (const file of sourceFiles(SRC)) {
    if (/self-host\/clerk-(client|server)-shim\./.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("@clerk/nextjs")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          if (clause.name) add(specifier, "default", file);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) add(specifier, "*", file);
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) add(specifier, (element.propertyName ?? element.name).text, file);
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        const clause = node.exportClause;
        if (!clause) add(node.moduleSpecifier.text, "*", file);
        else if (ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (!element.isTypeOnly) add(node.moduleSpecifier.text, (element.propertyName ?? element.name).text, file);
          }
        }
      }
      // const { auth } = await import("@clerk/nextjs/server")
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isAwaitExpression(node.initializer) &&
        ts.isCallExpression(node.initializer.expression) &&
        node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const [arg] = node.initializer.expression.arguments;
        if (arg && ts.isStringLiteral(arg)) {
          for (const element of node.name.elements) {
            const key = element.propertyName ?? element.name;
            if (ts.isIdentifier(key)) add(arg.text, key.text, file);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("self-host Clerk shims", () => {
  it("export every name the app imports from the Clerk modules they replace", () => {
    const imports = clerkImports();
    // Guards against a parser that silently finds nothing.
    expect(imports.get("@clerk/nextjs/server")?.has("auth")).toBe(true);
    expect(imports.get("@clerk/nextjs")?.has("useAuth")).toBe(true);

    const missing: string[] = [];
    for (const [specifier, names] of imports) {
      const shim = jest.requireActual(SHIMS[specifier]) as Record<string, unknown>;
      for (const [name, files] of names) {
        if (name === "*" || name === "default" || shim[name] === undefined) {
          missing.push(`${specifier} ${name} (${files.join(", ")})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  describe("fresh sign-in check for withdrawal destinations, in local auth mode", () => {
    const originalEnv = { ...process.env };

    beforeEach(async () => {
      process.env.HIVRA_AUTH_MODE = "local";
      process.env.HIVRA_LOCAL_JWT_SECRET = SECRET;
      mockCookieValue.token = await createLocalSessionToken({
        email: "operator@example.com",
        name: "Operator",
        secret: SECRET,
      });
      const { supabaseAdmin } = jest.requireMock("@/lib/supabase") as { supabaseAdmin: { from: jest.Mock } };
      supabaseAdmin.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: "inst_1" }, error: null }),
      });
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      mockCookieValue.token = null;
    });

    it("lets the signed-in local operator save an agent wallet destination", async () => {
      const { PUT } = await import("@/app/api/instances/[id]/bankr-wallet/withdraw-destination/route");
      const { setWithdrawalDestination } = jest.requireMock("@/lib/billing/bankr-instance-wallets") as {
        setWithdrawalDestination: jest.Mock;
      };

      const response = await PUT(
        new Request("http://127.0.0.1:3000/api/instances/inst_1/bankr-wallet/withdraw-destination", {
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie: `${SELF_HOST_SESSION_COOKIE}=${mockCookieValue.token}` },
          body: JSON.stringify({ destination: "0x2222222222222222222222222222222222222222" }),
        }),
        { params: Promise.resolve({ id: "inst_1" }) },
      );

      expect(response.status).toBe(200);
      expect(setWithdrawalDestination).toHaveBeenCalledWith({
        instanceId: "inst_1",
        userId: "hivra-local-operator",
        destinationEvm: "0x2222222222222222222222222222222222222222",
      });
    });

    it("answers only the reverification check, and only for a signed-in operator", async () => {
      const { withdrawDestinationStepUpResponse } = await import("@/lib/billing/withdraw-destination-notice");
      const context = { route: "/test", userId: "hivra-local-operator" };

      const signedIn = await auth();
      expect(withdrawDestinationStepUpResponse(signedIn, context)).toBeNull();
      // Roles, permissions, plans and features are not modelled locally.
      const has = signedIn.has as (params: Record<string, unknown>) => boolean;
      expect(has({ role: "org:admin" })).toBe(false);
      expect(has({ permission: "org:billing:manage" })).toBe(false);

      mockCookieValue.token = null;
      const signedOut = await auth();
      const refused = withdrawDestinationStepUpResponse(signedOut, context);
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({
        clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: "strict" } },
      });
    });
  });
});
