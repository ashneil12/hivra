/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryApp } from "../MemoryApp";

const ENDPOINT = "https://memory.example.com";
const NEW_KEY = ["hm", "account.keyid.rw.signature"].join("_");

function respond(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

describe("MemoryApp", () => {
  let keys: Array<Record<string, unknown>>;
  let calls: Array<{ method: string; path: string; body?: unknown }>;

  beforeEach(() => {
    keys = [];
    calls = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace("/api/memory", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/keys") return respond({ ok: true, keys, endpoint: ENDPOINT });
      if (method === "GET" && path === "/stats") return respond({ ok: true, active: 12, saves: 30, recalls: 7 });
      if (method === "POST" && path === "/keys") {
        keys = [{ id: "k1", label: body.label, scope: body.scope, created_at: 1, last_used_at: null }];
        return respond({ ok: true, keyId: "k1", key: NEW_KEY });
      }
      if (method === "DELETE" && path === "/keys") {
        keys = [];
        return respond({ ok: true });
      }
      if (method === "DELETE" && path === "/account") {
        keys = [];
        return respond({ ok: true });
      }
      return respond({ error: "not_found" }, 404);
    }) as unknown as typeof fetch;
  });

  it("shows setup with a placeholder, then fills in a new key shown once", async () => {
    render(<MemoryApp />);
    await screen.findByText("1. Get a key");
    expect(screen.getByTestId("setup-code")).toHaveTextContent("YOUR_MEMORY_KEY");
    expect(screen.getByTestId("memory-usage")).toHaveTextContent("12 of 10,000 memories used · 30 saves · 7 searches");

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: /Create key/ }));
    await screen.findByTestId("fresh-key");
    expect(calls).toContainEqual({ method: "POST", path: "/keys", body: { label: "Laptop", scope: "rw" } });
    expect(screen.getByTestId("fresh-key")).toHaveTextContent(NEW_KEY);
    expect(screen.getByTestId("setup-code")).toHaveTextContent(`${ENDPOINT}/mcp --header "Authorization: Bearer ${NEW_KEY}"`);
    expect(screen.getByText(/read and write · never used/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByTestId("setup-code")).toHaveTextContent("[mcp_servers.memory]");
    expect(screen.getByText(/Paste this into ~\/.codex\/AGENTS.md/)).toBeInTheDocument();
  });

  it("revokes a key and asks twice before deleting everything", async () => {
    keys = [{ id: "k9", label: "Old laptop", scope: "ro", created_at: 1, last_used_at: null }];
    render(<MemoryApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Old laptop" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: "/keys", body: { keyId: "k9" } }));

    fireEvent.click(screen.getByRole("button", { name: /Delete everything/ }));
    expect(calls.some((call) => call.path === "/account")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete everything" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/account")).toBe(true));
  });

  it("says so plainly when memory is not switched on", async () => {
    global.fetch = jest.fn(() => respond({ error: "not_configured" }, 503)) as unknown as typeof fetch;
    render(<MemoryApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Memory isn't switched on here yet.");
  });
});
