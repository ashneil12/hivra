/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesModelSettings } from "../HermesModelSettings";
import { getBoxModel, setBoxModel } from "@/lib/hivra/agent-api";

jest.mock("@/lib/hivra/agent-api", () => ({ getBoxModel: jest.fn(), setBoxModel: jest.fn() }));
const get = jest.mocked(getBoxModel), set = jest.mocked(setBoxModel);
const props = { chatUrl: "https://box.example.com", apiToken: "t", agentName: "Hermes", running: true, disabled: false };
const ready = { model: "deepseek-v4-1-flash", error: null, hermesConfig: true, provider: "venice" as const };
beforeEach(() => { jest.clearAllMocks(); get.mockResolvedValue(ready); });

it("tells owners of an old box to update", async () => {
  get.mockResolvedValue({ ...ready, hermesConfig: false });
  render(<HermesModelSettings {...props} />);
  expect(screen.getByText("Checking which model Hermes uses…")).toBeInTheDocument();
  expect(await screen.findByText(/Update Hermes to choose its model here/)).toBeInTheDocument();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("explains an own provider", async () => {
  get.mockResolvedValue({ ...ready, provider: "other" });
  render(<HermesModelSettings {...props} />);
  expect(await screen.findByText(/uses a provider you set up in Hermes itself/)).toBeInTheDocument();
});

it("applies a picked model and reports it", async () => {
  set.mockResolvedValue({ ok: true, model: "kimi-k2-6", error: null });
  render(<HermesModelSettings {...props} />);
  await screen.findByRole("listbox", { name: "Model" });
  expect(screen.getByRole("button", { name: /^Use / })).toBeDisabled();
  fireEvent.click(screen.getAllByRole("option").find(o => /Kimi/.test(o.textContent || ""))!);
  fireEvent.click(screen.getByRole("button", { name: /^Use / }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Hermes now uses .* for new chats\./));
  expect(set).toHaveBeenCalledWith("https://box.example.com", "kimi-k2-6", "t");
  expect(set).toHaveBeenCalledTimes(1);
});

it("shows an error", async () => {
  set.mockResolvedValue({ ok: false, error: "bad id" });
  render(<HermesModelSettings {...props} />);
  await screen.findByRole("listbox");
  fireEvent.click(screen.getAllByRole("option")[1]);
  fireEvent.click(screen.getByRole("button", { name: /^Use / }));
  expect(await screen.findByRole("alert")).toHaveTextContent("bad id");
});

it("asks to start a stopped computer instead of reading its model", async () => {
  render(<HermesModelSettings {...props} running={false} />);
  expect(screen.getByText("Start this computer to choose which model Hermes uses.")).toBeInTheDocument();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
});

it("says when the computer cannot be reached, without asking for an update", async () => {
  get.mockResolvedValue({ model: null, error: "HTTP 502", hermesConfig: false, provider: null });
  render(<HermesModelSettings {...props} />);
  expect(await screen.findByText(/couldn.t reach Hermes to read its model/)).toBeInTheDocument();
  expect(screen.queryByText(/Update Hermes/)).not.toBeInTheDocument();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
