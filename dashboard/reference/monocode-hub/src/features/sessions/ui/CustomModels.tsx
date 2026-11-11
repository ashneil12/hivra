import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Plus } from "../../../shared/ui/icons";
import {
  addCustomModel,
  CUSTOM_PROVIDERS,
  customModelsVersion,
  emptyForm,
  listCustomModels,
  needsKey,
  providerName,
  removeCustomModel,
  REMOVE_MODEL_COPY,
  subscribeCustomModels,
  testCustomModel,
  validateCustomModel,
  defaultBaseUrl,
  defaultModelId,
  isClaudeKeyError,
  CLAUDE_KEY_ERROR,
  CLAUDE_KEY_MESSAGE,
  KEY_FAILED,
  REASONING_EFFORTS,
  setCustomModelEfforts,
  customModelEfforts,
  clearRefusedEfforts,
  effortLabel,
  refusedEfforts,
  type ReasoningEffort,
  type CustomModel,
  type CustomModelForm,
  type KeyTestResult,
} from "../model/customModels";
import { notConnectedYet } from "../../providers/model/providerSignIn";

export function useCustomModels(): CustomModel[] {
  useSyncExternalStore(subscribeCustomModels, customModelsVersion, customModelsVersion);
  return listCustomModels();
}

/** "Other models": Ash's own models under the subscription list, each tagged "billed separately", then Add model. */
export function OtherModelsSection({
  query,
  currentModel,
  onPick,
  onAdd,
}: {
  query: string;
  currentModel: string;
  onPick: (model: CustomModel) => void;
  /** Opens Add model; the Grok row passes its name, with xAI (the form's default) already chosen. */
  onAdd: (preset?: { name: string }) => void;
}) {
  const all = useCustomModels();
  // Removing is a big deal (it also deletes the key), so it asks first.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editingEffort, setEditingEffort] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const models = needle
    ? all.filter((m) => `${m.name} ${providerName(m.provider)} ${m.modelId}`.toLowerCase().includes(needle))
    : all;
  const grokPlaceholder = !all.some((m) => m.provider === "xai") && (!needle || "grok xai".includes(needle));
  if (needle && !models.length && !grokPlaceholder) return null;
  return (
    <div role="group" aria-label="Other models" data-other-models className="mt-1 border-t border-stroke pt-1">
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">Other models</div>
      {/* Grok is always first: until an xAI model is saved, a row that opens Add model with xAI filled in. */}
      {grokPlaceholder ? (
        <button
          type="button"
          data-grok-add-key
          aria-label="Grok, xAI, add key"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAdd({ name: "Grok" })}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-content hover:bg-content/5"
        >
          <span className="min-w-0 flex-1 truncate">Grok</span>
          <span className="shrink-0 text-[10px] text-content/40">Add key</span>
        </button>
      ) : null}
      {models.map((m) => (
        <div key={m.id}>
        <div className="group relative">
        <button
          key={m.id}
          type="button"
          role="option"
          aria-selected={currentModel === `custom:${m.id}`}
          aria-label={`${m.name}, ${providerName(m.provider)}, billed separately`}
          data-custom-model={m.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(m)}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-content hover:bg-content/5"
        >
          <span className="min-w-0 flex-1 truncate">{m.name}</span>
          <span className="shrink-0 text-[10px] text-content/40 group-hover:invisible" data-billed-separately>billed separately</span>
        </button>
        <button
          type="button"
          data-remove-model={m.id}
          aria-label={`Remove ${m.name}`}
          title="Remove"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setConfirming(m.id)}
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1.5 text-[12px] text-content/45 hover:bg-content/8 hover:text-content/80 group-hover:block"
        >
          ×
        </button>
        </div>
        <button type="button" data-model-reasoning={m.id} onClick={() => setEditingEffort(editingEffort === m.id ? null : m.id)}
          className="px-2.5 py-0.5 text-[11px] text-content/50 hover:text-content">Reasoning settings</button>
        {editingEffort === m.id ? <EffortChoices levels={customModelEfforts(m.reasoningEfforts)} onChange={(levels) => setCustomModelEfforts(m.id, levels)}
          refused={refusedEfforts(m)} provider={m.provider === "custom" ? "Your provider" : providerName(m.provider)} onRetry={() => clearRefusedEfforts(m.id)} /> : null}
        {confirming === m.id ? (
          // The title wraps onto as many lines as it needs (never cut off), with the buttons on their own row below.
          <div data-remove-confirm={m.id} className="flex w-full flex-col gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-content/80">
            <p data-remove-title className="whitespace-normal break-words leading-snug">{REMOVE_MODEL_COPY.title(m.name)}</p>
            <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              data-remove-cancel
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setConfirming(null)}
              className="rounded-md px-2 py-0.5 text-content/60 hover:bg-content/8"
            >
              {REMOVE_MODEL_COPY.cancel}
            </button>
            <button
              type="button"
              data-remove-yes
              onMouseDown={(e) => e.preventDefault()}
              onClick={async () => {
                try {
                  await removeCustomModel(m.id);
                  setProblem(null);
                } catch {
                  setProblem(REMOVE_MODEL_COPY.keyDeleteFailed(m.name));
                }
                setConfirming(null);
              }}
              className="rounded-md bg-red-500/15 px-2 py-0.5 text-red-400 hover:bg-red-500/25"
            >
              {REMOVE_MODEL_COPY.confirm}
            </button>
            </div>
          </div>
        ) : null}
        </div>
      ))}
      {problem ? <div className="px-2.5 py-1 text-[11px] text-content/55" data-remove-problem>{problem}</div> : null}
      {needle ? null : (
        <button
          type="button"
          data-add-model
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAdd()}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-left text-[12px] text-content/50 hover:bg-content/5 hover:text-content/70"
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
          Add model
        </button>
      )}
    </div>
  );
}

const input =
  "w-full rounded-md border border-content/15 bg-content/3 px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/35";

/** Shared Esc hook: only one Add model form is open at a time. */
export const addModelEscRef: { current: ((event?: Event) => boolean) | null } = { current: null };
// More than one window listener sees the same Esc (the picker's and its popover's); each press acts once.
const seenEsc = new WeakSet<Event>();

/**
 * Name, provider, address, model id and a masked key. The provider list opens in the form's own flow
 * (it pushes the fields down, never covers them), closes on a pick, and Esc closes it. Back and Esc return to the list.
 * The key goes to the key store, never settings.
 */
export function AddModelForm({
  onDone,
  onCancel,
  initial,
  escRef,
}: {
  onDone: (model: CustomModel) => void;
  onCancel: () => void;
  initial?: { name?: string };
  /** The picker calls this on Esc while the form is open; true when the form handled it. */
  escRef?: { current: ((event?: Event) => boolean) | null };
}) {
  const [form, setForm] = useState<CustomModelForm>(() => ({ ...emptyForm(), ...(initial?.name ? { name: initial.name } : {}) }));
  const [touched, setTouched] = useState(false);
  const [test, setTest] = useState<KeyTestResult | "testing" | null>(null);
  const [saving, setSaving] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const errors = validateCustomModel(form);
  const valid = Object.keys(errors).length === 0;
  const passed = test !== null && test !== "testing" && test.ok;
  const keyed = needsKey(form.provider);
  const set = (patch: Partial<CustomModelForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTest(null);
  };
  const esc = (event?: Event) => {
    if (event) {
      if (seenEsc.has(event)) return true;
      seenEsc.add(event);
    }
    if (providerOpen) setProviderOpen(false);
    else onCancel();
    return true;
  };
  if (escRef) escRef.current = esc;
  useEffect(() => () => { if (escRef) escRef.current = null; }, [escRef]);
  const field = (name: keyof CustomModelForm) =>
    touched && errors[name] ? <span className="text-[11px] text-content/55" data-form-error={name}>{errors[name]}</span> : null;
  const runTest = async (): Promise<boolean> => {
    setTouched(true);
    if (!valid) return false;
    setTest("testing");
    const r = await testCustomModel(form);
    setTest(r);
    return r.ok;
  };
  return (
    <div
      className="flex flex-col gap-2.5 p-2"
      data-add-model-form
      onKeyDown={(e) => {
        // The picker's window listener usually handles Esc first (and marks it handled); this is the fallback.
        if (e.key === "Escape") { e.preventDefault(); esc(e.nativeEvent); }
        e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-2">
        <button type="button" data-add-model-back aria-label="Back to models" onClick={onCancel}
          className="rounded-md px-1.5 py-0.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content/85">
          ← Back
        </button>
        <div className="text-[13px] text-content">Add a model</div>
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Name
        <input className={input} value={form.name} placeholder="Grok" aria-label="Name" onChange={(e) => set({ name: e.target.value })} />
        {field("name")}
      </label>
      <div className="flex flex-col gap-1 text-[11px] text-content/55">
        <span id="add-model-provider">Provider</span>
        <button type="button" aria-labelledby="add-model-provider" aria-label="Provider" aria-haspopup="menu" aria-expanded={providerOpen}
          data-provider-button={form.provider}
          onClick={() => setProviderOpen((v) => !v)}
          className={`${input} flex items-center justify-between text-left`}>
          <span>{providerName(form.provider)}</span>
          <ChevronDown className={`size-3.5 shrink-0 text-content/45 transition-transform ${providerOpen ? "rotate-180" : ""}`} strokeWidth={1.75} />
        </button>
        {providerOpen ? (
          // In the form's own flow, not floating: it pushes the fields below down, so nothing is covered.
          <div role="menu" aria-label="Provider" data-provider-menu className="rounded-lg bg-content/4 p-1 ring-1 ring-content/10">
            {CUSTOM_PROVIDERS.map((p) => {
              const selected = p.id === form.provider;
              return (
                <button key={p.id} type="button" role="menuitemradio" aria-checked={selected} data-provider-choice={p.id}
                  onClick={() => {
                    setProviderOpen(false);
                    if (p.id !== form.provider)
                      set({ provider: p.id, baseUrl: defaultBaseUrl(p.id), modelId: defaultModelId(p.id), key: needsKey(p.id) ? form.key : "" });
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-content hover:bg-content/8">
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {selected ? <Check className="size-3.5 shrink-0 text-content/50" strokeWidth={2} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {notConnectedYet(form.provider).map((option) => (
        // Honest about what isn't built: the provider has this sign-in, the app doesn't yet. Never a button.
        <div key={option.label} className="text-[11px] text-content/45" data-signin-not-connected={form.provider}>
          {option.label}: {option.note ?? "Not connected yet"}
        </div>
      ))}
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Your provider's address
        <input className={input} value={form.baseUrl} placeholder="https://api.example.com/v1" aria-label="Base URL" onChange={(e) => set({ baseUrl: e.target.value })} />
        {field("baseUrl")}
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Model ID
        <input className={input} value={form.modelId} placeholder={defaultModelId(form.provider) || "model-name"} aria-label="Model id" onChange={(e) => set({ modelId: e.target.value })} />
        {field("modelId")}
      </label>
      <details className="text-[11px] text-content/60" data-model-efforts>
        <summary className="cursor-pointer">Reasoning effort (optional)</summary>
        <EffortChoices levels={customModelEfforts(form.reasoningEfforts)} onChange={(levels) => set({ reasoningEfforts: levels })} />
      </details>
      {keyed ? (
        <label className="flex flex-col gap-1 text-[11px] text-content/55">
          Key
          <input className={input} type="password" autoComplete="off" spellCheck={false} value={form.key}
            placeholder="Kept in your Keychain" aria-label="Key" onChange={(e) => set({ key: e.target.value })} />
          {field("key")}
        </label>
      ) : null}
      {test === "testing" ? (
        <div className="text-[12px] text-content/55" data-key-test="testing">Testing…</div>
      ) : test ? (
        <div className="flex items-center gap-1.5 text-[12px] text-content/70" data-key-test={test.ok ? "ok" : test.code === CLAUDE_KEY_ERROR ? "guidance" : "failed"}>
          <span className={`size-1.5 shrink-0 rounded-full ${test.ok ? "bg-emerald-500" : test.code === CLAUDE_KEY_ERROR ? "bg-content/40" : "bg-red-500"}`} aria-hidden data-key-test-dot />
          {test.message}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button type="button" data-add-model-cancel onClick={onCancel} className="rounded-md px-2.5 py-1 text-[12px] text-content/60 hover:bg-content/8">
          Cancel
        </button>
        <button type="button" data-test-key disabled={test === "testing"} onClick={() => void runTest()}
          className="rounded-md bg-content/8 px-2.5 py-1 text-[12px] text-content/85 hover:bg-content/12 disabled:opacity-40">
          {test === "testing" ? "Testing…" : keyed ? "Test key" : "Test connection"}
        </button>
        <button
          type="button"
          data-save-model
          disabled={!valid || saving || test === "testing"}
          onClick={async () => {
            // Save tests first when it hasn't been tested, and only keeps a model that answered.
            if (!passed && !(await runTest())) return;
            setSaving(true);
            try {
              onDone(await addCustomModel(form));
            } catch (e) {
              const claude = isClaudeKeyError(e);
              setTest({ ok: false, code: claude ? CLAUDE_KEY_ERROR : undefined, message: claude ? CLAUDE_KEY_MESSAGE : KEY_FAILED });
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-selection px-2.5 py-1 text-[12px] text-content hover:bg-selection-hover disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function EffortChoices({ levels, onChange, refused = [], provider, onRetry }: {
  levels: ReasoningEffort[];
  onChange: (levels: ReasoningEffort[]) => void;
  /** Levels the provider itself refused for this model: shown unticked and marked, never as on. */
  refused?: ReasoningEffort[];
  provider?: string;
  onRetry?: () => void;
}) {
  return <fieldset className="px-2 py-1 text-[11px] text-content/65" aria-label="Supported reasoning effort levels">
    <p className="mb-1 leading-4">Every level is on to start. Turn off any your model doesn't support, or turn them all off to leave it to the provider.</p>
    <div className="flex flex-wrap gap-x-3 gap-y-1">{REASONING_EFFORTS.map((level) => {
      const no = refused.includes(level);
      return <label key={level} className={`flex items-center gap-1 ${no ? "text-content/40" : ""}`} data-effort-refused={no ? "" : undefined}
        title={no ? `${provider ?? "The provider"} didn't accept this level for this model` : undefined}>
        <input type="checkbox" checked={!no && levels.includes(level)} disabled={no}
          onChange={(e) => onChange(e.target.checked ? [...levels, level] : levels.filter((v) => v !== level))} />{level}{no ? " · not supported" : ""}
      </label>;
    })}</div>
    {refused.length ? <p className="mt-1 leading-4" data-effort-refused-note>
      {provider ?? "The provider"} didn't accept {refused.map(effortLabel).join(", ")} for this model, so chats on {refused.length === 1 ? "that level" : "those levels"} use the provider's default.{" "}
      {onRetry ? <button type="button" data-effort-retry onClick={onRetry} className="underline hover:text-content">Try {refused.length === 1 ? "it" : "them"} again</button> : null}
    </p> : null}
  </fieldset>;
}
