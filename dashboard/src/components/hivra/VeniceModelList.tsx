"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { VENICE_CHAT_MODEL_PRICES, type VeniceChatModelPrice } from "@/lib/venice/pricing";
import { veniceCatalogEntry } from "@/lib/venice/model-catalog";
import styles from "./VeniceModelList.module.css";

export { veniceModelName } from "@/lib/venice/model-catalog";

export const DEFAULT_SUGGESTED_MODELS: readonly string[] = ["deepseek-v4-1-flash", "deepseek-v4-pro", "kimi-k2-6", "zai-org-glm-5-1"];

const FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/^deepseek/, "DeepSeek"], [/^kimi/, "Kimi"], [/^(zai-org-)?glm/, "GLM"], [/^qwen/, "Qwen"],
  [/^(openai|gpt)/, "OpenAI"], [/^claude/, "Claude"], [/^gemini/, "Gemini"], [/^minimax/, "MiniMax"],
  [/^nemotron/, "NVIDIA"], [/^grok/, "Grok"], [/^gemma/, "Gemma"], [/^llama/, "Llama"],
  [/^mistral/, "Mistral"], [/^venice/, "Venice"],
];
export function veniceModelFamily(id: string): string {
  const lower = id.toLowerCase();
  for (const [re, name] of FAMILIES) if (re.test(lower)) return name;
  // Ids such as "zai-org-glm-5-1" or "nvidia-nemotron-…" carry the family inside.
  if (/(^|-)glm(-|$)/.test(lower)) return "GLM";
  if (lower.includes("nemotron")) return "NVIDIA";
  return "Other";
}

const PRIVACY_LABEL: Record<VeniceChatModelPrice["privacy"], string> = {
  private: "Private", e2ee_private: "End-to-end encrypted", anonymized: "Anonymized",
};

function usd(value: number) { return value < 0.1 ? value.toFixed(3) : value.toFixed(2); }
function contextLabel(tokens: number) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
  return `${Math.round(tokens / 1000)}K context`;
}
function metaFor(entry: VeniceChatModelPrice) {
  const input = entry.inputMicroUsdPerMillion / 1_000_000, output = entry.outputMicroUsdPerMillion / 1_000_000;
  return `${contextLabel(entry.contextWindow)} · $${usd(input)} / $${usd(output)}`;
}

interface Row { id: string; name: string; badge: string | null; meta: string; }
interface Group { label: string; rows: Row[]; }

const rowFor = (entry: VeniceChatModelPrice): Row =>
  ({ id: entry.model, name: entry.displayName, badge: PRIVACY_LABEL[entry.privacy], meta: metaFor(entry) });
const unknownRow = (id: string): Row => ({ id, name: id, badge: null, meta: "Not in Hivra's Venice list" });

export function VeniceModelList({ value, current, onChange, disabled, label, suggested = DEFAULT_SUGGESTED_MODELS }: {
  value: string | null; current?: string | null; onChange: (id: string) => void; disabled?: boolean;
  label: string; suggested?: readonly string[];
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Group[] = [];
    if (!q) {
      const extras = [current, value].filter((id, i, all): id is string => !!id && !veniceCatalogEntry(id) && all.indexOf(id) === i);
      if (extras.length) out.push({ label: "Not in the list", rows: extras.map(unknownRow) });
      const picks = suggested.map(veniceCatalogEntry).filter((e): e is VeniceChatModelPrice => !!e);
      if (picks.length) out.push({ label: "Suggested", rows: picks.map(rowFor) });
    }
    const suggestedSet = new Set(q ? [] : suggested);
    const byFamily = new Map<string, Row[]>();
    for (const entry of VENICE_CHAT_MODEL_PRICES) {
      if (suggestedSet.has(entry.model)) continue;
      if (q && !entry.displayName.toLowerCase().includes(q) && !entry.model.toLowerCase().includes(q)) continue;
      const family = veniceModelFamily(entry.model);
      byFamily.set(family, [...(byFamily.get(family) ?? []), rowFor(entry)]);
    }
    for (const [family, rows] of [...byFamily].sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))) out.push({ label: family, rows });
    return out;
  }, [query, current, value, suggested]);

  const flat = useMemo(() => groups.flatMap(g => g.rows), [groups]);
  // The same id can appear twice only if it is both unknown and suggested, which cannot happen.
  const optionId = (id: string) => `${uid}-opt-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const active = activeId && flat.some(r => r.id === activeId) ? activeId : (value && flat.some(r => r.id === value) ? value : flat[0]?.id ?? null);

  useEffect(() => {
    if (!active) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${optionId(active)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const move = (delta: number | "start" | "end") => {
    if (!flat.length) return;
    const index = flat.findIndex(r => r.id === active);
    const next = delta === "start" ? 0 : delta === "end" ? flat.length - 1 : Math.min(flat.length - 1, Math.max(0, index + delta));
    setActiveId(flat[next].id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); move("start"); }
    else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); move("end"); }
    else if (event.key === "Enter") { event.preventDefault(); if (active) onChange(active); }
  };

  const listId = `${uid}-list`;
  return <div className={styles.root}>
    <input type="search" role="combobox" aria-label="Search models" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={active ? optionId(active) : undefined} className={styles.search}
      placeholder={`Search ${VENICE_CHAT_MODEL_PRICES.length} Venice models`} value={query} disabled={disabled}
      onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
      autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
    <div ref={listRef} id={listId} role="listbox" aria-label={label} aria-disabled={disabled || undefined}
      className={`${styles.list} ${disabled ? styles.disabled : ""}`}>
      {groups.length === 0 ? <p className={styles.empty}>No model matches. Try another name.</p> : null}
      {groups.map(group => <div key={group.label} role="group" aria-label={group.label} className={styles.group}>
        <div className={styles.groupLabel} aria-hidden="true">{group.label}</div>
        {group.rows.map(row => {
          const selected = row.id === value, isCurrent = !!current && row.id === current;
          return <div key={row.id} id={optionId(row.id)} role="option" aria-selected={selected} aria-disabled={disabled || undefined}
            className={`${styles.option} ${selected ? styles.selected : ""} ${row.id === active ? styles.active : ""}`}
            onClick={() => { if (!disabled) { setActiveId(row.id); onChange(row.id); } }}>
            <span className={styles.check} aria-hidden="true">{selected ? "✓" : ""}</span>
            <span className={styles.body}>
              <span className={styles.top}>
                <span className={styles.name}>{row.name}</span>
                {row.badge ? <span className={styles.badge}>{row.badge}</span> : null}
                {isCurrent ? <span className={styles.tag}>Current</span> : null}
              </span>
              <span className={styles.meta}>{row.meta}</span>
            </span>
          </div>;
        })}
      </div>)}
    </div>
  </div>;
}
