/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentPrivateModelsOnly } from "../AgentPrivateModelsOnly";

const realFetch = global.fetch;
const view = (over: Record<string, unknown> = {}) => ({
  enabled: false, updatedAt: null, savedModel: "kimi-k2-6", savedModelIsPrivate: true, ...over,
});
const answer = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function mockApi(...responses: Response[]) {
  const fetchMock = jest.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => { global.fetch = realFetch; });

it("renders nothing when the server does not offer the setting", async () => {
  const fetchMock = mockApi(answer(404, { success: false, code: "feature_disabled" }));
  const onChange = jest.fn();
  const { container } = render(<AgentPrivateModelsOnly agentId="a1" onChange={onChange} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
  expect(container).toBeEmptyDOMElement();
  expect(fetchMock.mock.calls[0][0]).toBe("/api/hivra/agents/a1/private-models");
});

it("shows the setting off, turns it on, and reports the saved state", async () => {
  const fetchMock = mockApi(
    answer(200, { success: true, data: view() }),
    answer(200, { success: true, data: view({ enabled: true, updatedAt: "2026-11-17T12:00:00.000Z" }) }),
  );
  const onChange = jest.fn();
  render(<AgentPrivateModelsOnly agentId="a1" onChange={onChange} />);
  const toggle = await screen.findByRole("switch");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toHaveTextContent("Turn on");
  expect(screen.getByText(/Off\. This agent can use any model/)).toBeInTheDocument();
  expect(screen.queryByText(/is not marked private/)).not.toBeInTheDocument();

  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
  expect(screen.getByText(/On\. This agent can only use models Venice marks private/)).toBeInTheDocument();
  expect(screen.getByText("Private models only is on. It applies to the next request.")).toBeInTheDocument();
  expect(onChange).toHaveBeenLastCalledWith(true);
  const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(init.method).toBe("PUT");
  expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
});

it("warns when the saved model is not private", async () => {
  mockApi(answer(200, { success: true, data: view({ enabled: true, savedModel: "claude-opus-4-8", savedModelIsPrivate: false }) }));
  render(<AgentPrivateModelsOnly agentId="a1" />);
  expect(await screen.findByText(/The saved model, claude-opus-4-8, is not marked private, so requests to it are refused/)).toBeInTheDocument();
});

it("keeps the shown state and explains when a save fails", async () => {
  mockApi(
    answer(200, { success: true, data: view() }),
    answer(409, { success: false, error: "This setting changed while it was being saved. Try again." }),
  );
  const onChange = jest.fn();
  render(<AgentPrivateModelsOnly agentId="a1" onChange={onChange} />);
  fireEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("This setting changed while it was being saved. Try again.");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  expect(onChange).not.toHaveBeenCalledWith(true);
});

it("does not reload because the parent passed a new callback", async () => {
  const fetchMock = mockApi(answer(200, { success: true, data: view() }));
  const { rerender } = render(<AgentPrivateModelsOnly agentId="a1" onChange={() => {}} />);
  await screen.findByRole("switch");
  rerender(<AgentPrivateModelsOnly agentId="a1" onChange={() => {}} />);
  rerender(<AgentPrivateModelsOnly agentId="a1" onChange={() => {}} />);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
