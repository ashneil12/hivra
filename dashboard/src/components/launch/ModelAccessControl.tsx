"use client";

import { useId } from "react";

import type { Provider } from "@/lib/models";
import type { LaunchModelAccess, LaunchProfileId } from "@/lib/launch/contracts";
import {
  bothWalletsFunded,
  choosesModel,
  effectiveModel,
  effectiveProvider,
  modelChoices,
  providerName,
  requiresSavedKey,
  savedKeyHint,
  savedKeysFor,
  type CreditsBalance,
  type ModelAccessOption,
  type SavedModelKey,
} from "@/lib/launch/model-access";

import styles from "./ModelAccessControl.module.css";

/** How the agent reaches a model, the same three choices for every agent:
 * sign in inside it after it opens, send your own API key to its computer,
 * or pay with Hivra credits. Only the choices a runtime supports are shown,
 * and one that can't be used here says why instead of being pressed. */
export function ModelAccessControl({
  profileId,
  agentName,
  access,
  options,
  onChange,
  pastedKey,
  onPastedKeyChange,
  savedKeys,
  providers,
  balance,
  onAddCredit,
  problem,
  disabled = false,
}: {
  profileId: LaunchProfileId;
  agentName: string;
  access: LaunchModelAccess;
  options: readonly ModelAccessOption[];
  onChange: (change: Partial<LaunchModelAccess>) => void;
  /** The key typed for this launch; held by the page, never stored. */
  pastedKey: string;
  onPastedKeyChange: (value: string) => void;
  savedKeys: readonly SavedModelKey[];
  providers: readonly Provider[];
  balance: CreditsBalance;
  onAddCredit: () => void;
  problem: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const name = agentName.trim() || "this agent";
  const provider = effectiveProvider(profileId, access);
  const saved = savedKeysFor(profileId, access, savedKeys)[0] ?? null;
  const savedOnly = requiresSavedKey(profileId, access);
  const usingSaved = access.mode === "api-key" && (access.keySource === "saved" || savedOnly);
  const models = modelChoices(profileId, access);
  const model = effectiveModel(profileId, access);
  const customModel = model !== "" && !models.some(choice => choice.value === model);

  const chooseMode = (mode: LaunchModelAccess["mode"]) => {
    if (mode === access.mode) return;
    // A saved key is offered first when the owner has one for this provider;
    // it is still sent only after they confirm it for this launch.
    const savedForMode = mode === "api-key" ? savedKeysFor(profileId, { ...access, mode }, savedKeys)[0] ?? null : null;
    // A key typed for one choice is never carried into another.
    onPastedKeyChange("");
    onChange({
      mode,
      source: "custom",
      model: "",
      keySource: savedForMode ? "saved" : "paste",
      vaultKeyId: savedForMode?.id ?? null,
      sendSavedKey: false,
    });
  };

  const chooseProvider = (providerId: string) => {
    const savedForProvider = savedKeys.find(key => key.provider === providerId) ?? null;
    onPastedKeyChange("");
    onChange({
      provider: providerId,
      model: "",
      keySource: savedForProvider ? "saved" : "paste",
      vaultKeyId: savedForProvider?.id ?? null,
      sendSavedKey: false,
      baseUrl: "",
    });
  };

  // A custom endpoint has no list to pick from: its model ID is typed.
  const typedModelOnly = access.mode === "api-key" && provider === "custom_llm";
  const modelPicker = !choosesModel(profileId, access.mode) ? null : typedModelOnly ? (
    <div className={styles.field}>
      <label htmlFor={`${id}-model-id`}>Model ID</label>
      <input
        id={`${id}-model-id`}
        value={access.model}
        disabled={disabled}
        maxLength={128}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder="e.g. llama3.2"
        onChange={event => onChange({ model: event.target.value.trim() })}
      />
      <small>The model your endpoint serves.</small>
    </div>
  ) : (
    <div className={styles.field}>
      <label htmlFor={`${id}-model`}>Model</label>
      <select
        id={`${id}-model`}
        value={customModel ? "__custom" : model}
        disabled={disabled}
        onChange={event => onChange({ model: event.target.value === "__custom" ? access.model : event.target.value })}
      >
        {models.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        {customModel ? <option value="__custom">{model} (entered under Advanced)</option> : null}
      </select>
      <details className={styles.advanced} open={customModel || undefined}>
        <summary>Advanced</summary>
        <label htmlFor={`${id}-model-id`}>Model ID</label>
        <input
          id={`${id}-model-id`}
          value={access.model}
          disabled={disabled}
          maxLength={128}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={models[0]?.value ?? "model-id"}
          onChange={event => onChange({ model: event.target.value.trim() })}
        />
        <small>Leave it empty to use the model chosen above.</small>
      </details>
    </div>
  );

  return (
    <div className={styles.control}>
      <div className={styles.options} role="group" aria-label="Model access">
        {options.map(option => {
          const selected = access.mode === option.mode;
          return (
            <div key={option.mode} className={styles.option}>
              <button
                type="button"
                aria-pressed={selected}
                // The chosen option is never shown pressed but disabled; the
                // problem line below says what to change.
                disabled={disabled || (Boolean(option.unavailable) && !selected)}
                onClick={() => chooseMode(option.mode)}
              >
                <strong>{option.title}</strong>
                <small>{option.unavailable ?? option.detail}</small>
              </button>
              {option.offerAddCredit ? (
                <button type="button" className={styles.inlineAction} disabled={disabled} onClick={onAddCredit}>
                  Add credit
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {access.mode === "api-key" ? (
        <div className={styles.details}>
          {profileId === "hermes" ? (
            <div className={styles.field}>
              <label htmlFor={`${id}-provider`}>Provider</label>
              <select id={`${id}-provider`} value={provider} disabled={disabled} onChange={event => chooseProvider(event.target.value)}>
                {providers.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
            </div>
          ) : null}

          {saved && !savedOnly ? (
            <div className={styles.keySource} role="group" aria-label="Which key">
              <button
                type="button"
                aria-pressed={usingSaved}
                disabled={disabled}
                onClick={() => onChange({ keySource: "saved", vaultKeyId: saved.id, sendSavedKey: false })}
              >
                Use my saved key {savedKeyHint(saved)}
              </button>
              <button
                type="button"
                aria-pressed={!usingSaved}
                disabled={disabled}
                onClick={() => onChange({ keySource: "paste", sendSavedKey: false })}
              >
                Paste a new key
              </button>
            </div>
          ) : null}

          {usingSaved ? (
            saved ? (
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={access.sendSavedKey && access.vaultKeyId === saved.id}
                  disabled={disabled}
                  onChange={event => onChange({ vaultKeyId: saved.id, sendSavedKey: event.target.checked })}
                />
                <span>
                  <strong>Send this key to {name}&apos;s computer</strong>
                  <small>Your saved {providerName(provider)} key {savedKeyHint(saved)} is sent for this launch only. {providerName(provider)} bills its usage.</small>
                </span>
              </label>
            ) : (
              <p className={styles.note}>{providerName(provider)} signs in with a saved session, and none is in your Vault yet.</p>
            )
          ) : (
            <div className={styles.field}>
              <label htmlFor={`${id}-key`}>{providerName(provider)} API key</label>
              <input
                id={`${id}-key`}
                type="password"
                value={pastedKey}
                disabled={disabled}
                maxLength={512}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                data-ph-no-capture="true"
                className="ph-no-capture"
                placeholder={`Paste your ${providerName(provider)} key`}
                onChange={event => onPastedKeyChange(event.target.value)}
              />
              <small>Sent only to {name}&apos;s computer. It isn&apos;t kept in this browser.</small>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={access.saveKey}
                  disabled={disabled}
                  onChange={event => onChange({ saveKey: event.target.checked })}
                />
                <span>Save it in my Vault for next time</span>
              </label>
            </div>
          )}

          {profileId === "hermes" && provider === "custom_llm" ? (
            <div className={styles.field}>
              <label htmlFor={`${id}-base-url`}>Base URL</label>
              <input
                id={`${id}-base-url`}
                type="url"
                inputMode="url"
                value={access.baseUrl}
                disabled={disabled}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                placeholder="https://api.example.com/v1"
                onChange={event => onChange({ baseUrl: event.target.value.trim() })}
              />
            </div>
          ) : null}
          {modelPicker}
        </div>
      ) : null}

      {access.mode === "credits" ? (
        <div className={styles.details}>
          {bothWalletsFunded(balance) ? (
            <div className={styles.field}>
              <label htmlFor={`${id}-wallet`}>Pay from</label>
              <select
                id={`${id}-wallet`}
                value={access.walletType}
                disabled={disabled}
                onChange={event => onChange({ walletType: event.target.value === "hermesos" ? "hermesos" : "card" })}
              >
                <option value="card">Card credits</option>
                <option value="hermesos">Token credits</option>
              </select>
            </div>
          ) : null}
          {profileId === "aeon" ? (
            <p className={styles.note}>Aeon adds the credits to its model settings when you connect GitHub. You can change this choice there.</p>
          ) : profileId === "openclaw" || profileId === "agent-zero" ? (
            <p className={styles.note}>Hivra sets {name} up with Venice models paid from your credits. You can change its provider later in its own settings.</p>
          ) : null}
          {modelPicker}
        </div>
      ) : null}

      {problem ? <p className={styles.problem} role="status">{problem}</p> : null}
    </div>
  );
}
