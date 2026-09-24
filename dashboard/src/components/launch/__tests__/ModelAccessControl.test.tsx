/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { useEffect, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { DEFAULT_MODEL_ACCESS, type LaunchModelAccess, type LaunchProfileId } from "@/lib/launch/contracts";
import {
  apiKeyProviders,
  modelAccessOptions,
  modelAccessProblem,
  type CreditsBalance,
  type SavedModelKey,
} from "@/lib/launch/model-access";
import { ModelAccessControl } from "../ModelAccessControl";

const VENICE_KEY: SavedModelKey = { id: "44444444-4444-4444-8444-444444444444", provider: "venice", name: "Venice AI", key_preview: "venice...3f2a" };
const FUNDED: CreditsBalance = { state: "known", cardMicroUsd: 4_250_000, hermesosMicroUsd: 0 };
const EMPTY: CreditsBalance = { state: "known", cardMicroUsd: 0, hermesosMicroUsd: 0 };

let latest: { access: LaunchModelAccess; pastedKey: string } = { access: DEFAULT_MODEL_ACCESS, pastedKey: "" };

function Harness({
  profileId,
  savedKeys = [],
  balance = FUNDED,
  initial = {},
  onAddCredit = () => undefined,
}: {
  profileId: LaunchProfileId;
  savedKeys?: SavedModelKey[];
  balance?: CreditsBalance;
  initial?: Partial<LaunchModelAccess>;
  onAddCredit?: () => void;
}) {
  const [access, setAccess] = useState<LaunchModelAccess>({ ...DEFAULT_MODEL_ACCESS, ...initial });
  const [pastedKey, setPastedKey] = useState("");
  useEffect(() => { latest = { access, pastedKey }; });
  const options = modelAccessOptions(profileId, {
    selfHosted: false, providerComputer: false, selfManaged: false, modelSettingsSupported: true, balance,
  });
  return (
    <ModelAccessControl
      profileId={profileId}
      agentName="Codex 1"
      access={access}
      options={options}
      onChange={change => setAccess(current => ({ ...current, ...change, source: "custom" }))}
      pastedKey={pastedKey}
      onPastedKeyChange={setPastedKey}
      savedKeys={savedKeys}
      providers={apiKeyProviders(profileId, savedKeys)}
      balance={balance}
      onAddCredit={onAddCredit}
      problem={modelAccessProblem(profileId, access, { name: "Codex 1", pastedKey, savedKeys, options })}
    />
  );
}

const choices = () => screen.getByRole("group", { name: "Model access" });
const choice = (name: RegExp) => within(choices()).getByRole("button", { name });

describe("ModelAccessControl", () => {
  it("defaults Codex to signing in inside it, with a key and Hivra credits as the other choices", () => {
    render(<Harness profileId="codex" />);
    expect(choice(/^Sign in inside Codex after it opens/)).toHaveAttribute("aria-pressed", "true");
    expect(choice(/^Use my API key/)).toHaveAttribute("aria-pressed", "false");
    expect(choice(/^Hivra credits/)).toHaveTextContent("$4.25 available");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows Claude Code's unavailable choices with why, never pressed", () => {
    render(<Harness profileId="claude-code" />);
    expect(choice(/^Sign in inside Claude Code after it opens/)).toHaveAttribute("aria-pressed", "true");
    expect(choice(/^Use my API key/)).toBeDisabled();
    expect(choice(/^Use my API key/)).toHaveAttribute("aria-pressed", "false");
    expect(choice(/^Use my API key/)).toHaveTextContent("Not available for Claude Code yet.");
    expect(choice(/^Hivra credits/)).toBeDisabled();
  });

  it("offers the saved Vault key first and sends it only after the per-launch consent", () => {
    render(<Harness profileId="codex" savedKeys={[VENICE_KEY]} />);
    fireEvent.click(choice(/^Use my API key/));

    expect(screen.getByRole("button", { name: "Use my saved key ••3f2a" })).toHaveAttribute("aria-pressed", "true");
    const consent = screen.getByRole("checkbox", { name: /Send this key to Codex 1's computer/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Confirm that your saved key can be sent to Codex 1's computer.");
    expect(latest.access).toMatchObject({ mode: "api-key", keySource: "saved", vaultKeyId: VENICE_KEY.id, sendSavedKey: false });

    fireEvent.click(consent);
    expect(latest.access.sendSavedKey).toBe(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("takes a pasted key into the page's memory only, and drops it on another choice", () => {
    render(<Harness profileId="codex" savedKeys={[VENICE_KEY]} />);
    fireEvent.click(choice(/^Use my API key/));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new key" }));
    const input = screen.getByLabelText("Venice AI API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("data-ph-no-capture", "true");
    fireEvent.change(input, { target: { value: "synthetic-venice-key" } });
    expect(latest.pastedKey).toBe("synthetic-venice-key");
    expect(JSON.stringify(latest.access)).not.toContain("synthetic-venice-key");
    // Saving is opt-in, and says it replaces the saved key: the Vault keeps one per provider.
    const save = screen.getByRole("checkbox", { name: /^Save it in my Vault for next time, replacing your saved key ••/ });
    expect(save).not.toBeChecked();
    fireEvent.click(save);
    expect(latest.access.saveKey).toBe(true);

    fireEvent.click(choice(/^Hivra credits/));
    expect(latest.pastedKey).toBe("");
  });

  it("offers to save a pasted key without mentioning a replacement when none is saved", () => {
    render(<Harness profileId="codex" savedKeys={[]} />);
    fireEvent.click(choice(/^Use my API key/));
    const save = screen.getByRole("checkbox", { name: "Save it in my Vault for next time" });
    expect(save).not.toBeChecked();
  });

  it("picks models from a list, with a free-text model ID only under Advanced", () => {
    render(<Harness profileId="codex" />);
    fireEvent.click(choice(/^Hivra credits/));
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("deepseek-v4-pro");
    const advanced = screen.getByText("Advanced").closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    fireEvent.change(within(advanced).getByLabelText("Model ID"), { target: { value: "my-model-1" } });
    expect(latest.access.model).toBe("my-model-1");
    expect(model).toHaveValue("__custom");
  });

  it("disables credits at $0 and offers to add some", () => {
    const onAddCredit = jest.fn();
    render(<Harness profileId="hermes" balance={EMPTY} onAddCredit={onAddCredit} />);
    expect(choice(/^Hivra credits/)).toBeDisabled();
    expect(choice(/^Hivra credits/)).toHaveTextContent("You have $0 in Hivra credits.");
    fireEvent.click(within(choices()).getByRole("button", { name: "Add credit" }));
    expect(onAddCredit).toHaveBeenCalledTimes(1);
  });

  it("lets Hermes pick a provider and type a custom endpoint's model", () => {
    render(<Harness profileId="hermes" initial={{ mode: "api-key", source: "custom" }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "custom_llm" } });
    expect(latest.access.provider).toBe("custom_llm");
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://llm.example.test/v1" } });
    fireEvent.change(screen.getByLabelText("Custom LLM Provider API key"), { target: { value: "local-key-1" } });
    expect(screen.getByRole("status")).toHaveTextContent("Enter the model ID your endpoint serves.");
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "llama3.2" } });
    expect(latest.access).toMatchObject({ baseUrl: "https://llm.example.test/v1", model: "llama3.2" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
