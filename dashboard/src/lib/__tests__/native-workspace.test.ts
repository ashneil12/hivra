/** @jest-environment jsdom */
import { nativeDashboardHref, nativeWorkspaceHandler, postNativeWorkspace, workspaceMetadata } from "../native-workspace";
import type { DashboardResource } from "@/components/layout/dashboard-resources";

type HostWindow = Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
const host = window as HostWindow;
const origin = "https://hivra.example";

afterEach(() => { delete host.__HIVRA_NATIVE_WORKSPACE__; delete host.webkit; });

it("requires both the versioned native marker and a callable message handler", () => {
  const postMessage = jest.fn();
  expect(nativeWorkspaceHandler()).toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  expect(nativeWorkspaceHandler()).toBeNull();
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage } } };
  expect(nativeWorkspaceHandler()).not.toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 2 };
  expect(nativeWorkspaceHandler()).toBeNull();
  delete host.__HIVRA_NATIVE_WORKSPACE__;
  expect(nativeWorkspaceHandler()).toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage: true } } };
  expect(nativeWorkspaceHandler()).toBeNull();
});

it("does not let a detached native receiver break the web surface", () => {
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage() { throw new Error("detached"); } } } };
  expect(() => postNativeWorkspace({ version: 1, kind: "surfaces", pathname: "/dashboard", active: "", surfaces: [] })).not.toThrow();
});

it.each([
  ["/dashboard", "/dashboard"],
  ["/dashboard/", "/dashboard"],
  ["/dashboard/agent/item?tab=desktop", "/dashboard/agent/item?tab=desktop"],
  ["/dashboard/agent/item?open=fast&tab=desktop", "/dashboard/agent/item?tab=desktop&open=fast"],
  ["/dashboard/agent/item?open=native&tab=desktop", "/dashboard/agent/item?tab=desktop&open=native"],
  ["/dashboard/agent/%69tem?tab=%66iles", "/dashboard/agent/item?tab=files"],
  [`${origin}/dashboard/computers`, "/dashboard/computers"],
  ["/dashboard/launch?start=1&kind=computer", "/dashboard/launch?kind=computer&start=1"],
])("accepts and canonicalizes the app-owned dashboard route %s", (input, expected) => {
  expect(nativeDashboardHref(input, origin)).toBe(expected);
});

it.each([
  "https://elsewhere.example/dashboard", "https://hivra.example.evil/dashboard", "http://hivra.example/dashboard",
  "https://user:password@hivra.example/dashboard", "//hivra.example/dashboard", "javascript:alert(1)",
  "/api/instances", "/dashboard-elsewhere", "/dashboard/../api", "/dashboard/%2e%2e/api", "/dashboard/%252e%252e/api",
  "/dashboard//settings", "/dashboard/agent%2fitem", "/dashboard/agent%255citem", "/dashboard/agent/%2569tem",
  "/dashboard/agent/..\\api", "/dashboard?token=secret", "/dashboard#secret", "/dashboard?tab=files&tab=manage",
  "/dashboard?tab=Files", "/dashboard?tab=https://elsewhere.example", "/dashboard/launch?tab=files",
  "/dashboard/agent/item?tab=desktop&open=slow", "/dashboard/agent/item?tab=files&open=fast",
  "/dashboard/agents?tab=desktop&open=fast", "/dashboard/agent/item?tab=desktop&open=fast&token=secret",
  "/dashboard/launch?kind=agent", "/dashboard/launch?kind=computer&start=0", "/dashboard/launch?kind=agent&start=1&profile=private",
  "/dashboard?tab=files\n", "/dashboard/agent/%00item", "/dashboard/agent/%23fragment", "/dashboard/agent/%3fquery",
])("rejects unsafe or unsupported navigation %s", input => {
  expect(nativeDashboardHref(input, origin)).toBeNull();
});

it("copies only the eight catalog metadata fields", () => {
  const resource = { uid: "x-item", id: "item", source: "hivra", kind: "computer", name: "Desktop",
    description: "Ubuntu Desktop", status: "running", href: "/dashboard/agent/item?tab=desktop",
    api_token: "secret", chat_url: "https://guest.example", config: { credentials: "secret" } };
  const result = workspaceMetadata([resource as DashboardResource]);
  expect(Object.keys(result[0])).toEqual(["uid", "id", "source", "kind", "name", "description", "status", "href"]);
  expect(JSON.stringify(result)).not.toMatch(/secret|guest\.example/);
  expect(result[0]).not.toBe(resource);
});
