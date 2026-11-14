"use client";

// SOUL.md generator (/tools/soul-md-generator).
//
// A form on one side and the finished file on the other, rebuilt on every keystroke by the pure function in
// lib/tools/agent-tools/soul-md-builder.ts. Copy and download (a Blob and a temporary link, no server). What the
// visitor types never leaves the browser and never enters the page address: only the preset choice may, and it
// is dropped as soon as they edit a field. Nothing is fetched.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import toolStyles from "@/app/tools/tools.module.css";
import styles from "./SoulMdBuilderTool.module.css";
import CopyButton from "./CopyButton";
import ToolRadioGroup from "./ToolRadioGroup";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { currentSearch, replaceToolSearch } from "@/lib/tools/tool-params";
import { monthYear } from "@/lib/tools/month-year";
import {
  APPROVAL_IDS,
  APPROVAL_TEXT,
  BOUNDARY_IDS,
  BOUNDARY_TEXT,
  EMPTY_FORM,
  LIMITS,
  PRESETS,
  SOUL_FACTS,
  SOUL_FILE_NAME,
  SOUL_LIMITS,
  SOUL_PARAM_KEYS,
  WHERE_IT_GOES,
  buildSoulMd,
  charCount,
  overrideLikePhrases,
  parseSoulParams,
  presetForm,
  serializeSoulParams,
  type ApprovalId,
  type BoundaryId,
  type PresetId,
  type SoulForm,
} from "@/lib/tools/agent-tools/soul-md-builder";

function downloadText(text: string, name: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toggle<T extends string>(list: T[], id: T): T[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export default function SoulMdBuilderTool() {
  const [form, setForm] = useState<SoulForm>(EMPTY_FORM);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [ready, setReady] = useState(false);

  // Read a shared preset once, after hydration, so the server render stays the empty form.
  useEffect(() => {
    const id = parseSoulParams(currentSearch());
    if (id) {
      // Reading the address is an external system; it can only happen after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(presetForm(id));
      setPreset(id);
    }
    setReady(true);
  }, []);

  // Back and forward to an address that carries a preset fill the form from it again.
  useEffect(() => {
    const onPop = () => {
      const id = parseSoulParams(currentSearch());
      if (id) {
        setForm(presetForm(id));
        setPreset(id);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (ready) replaceToolSearch(serializeSoulParams(preset), SOUL_PARAM_KEYS);
  }, [preset, ready]);

  const edit = (patch: Partial<SoulForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setPreset(null);
  };

  const text = useMemo(() => buildSoulMd(form), [form]);
  const warnings = useMemo(() => overrideLikePhrases(form), [form]);
  const chars = charCount(text);
  const lines = text === "" ? 0 : text.trimEnd().split("\n").length;

  const choose = (id: PresetId) => {
    setForm(presetForm(id));
    setPreset(id);
  };
  const clear = () => {
    setForm(EMPTY_FORM);
    setPreset(null);
  };

  return (
    <div className={toolStyles.tool}>
      <h2 className={toolStyles.h3} style={{ marginTop: 0 }}>
        Start from a preset
      </h2>
      <p className={toolStyles.hint} style={{ marginTop: 0 }}>
        A preset fills the form. Change anything after.
      </p>
      <div className={styles.presets} role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={styles.preset} data-active={preset === p.id} aria-pressed={preset === p.id} onClick={() => choose(p.id)}>
            <span className={styles.presetName}>{p.label}</span>
            <span className={styles.presetBlurb}>{p.blurb}</span>
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        <div>
          <section className={styles.group} aria-labelledby="sm-identity">
            <h3 id="sm-identity" className={styles.groupTitle}>
              Name, role and who it works for
            </h3>
            <div className={styles.fieldBlock}>
              <label className={toolStyles.label} htmlFor="sm-name">
                Name
              </label>
              <input id="sm-name" className={toolStyles.field} value={form.name} maxLength={LIMITS.name} autoComplete="off" onChange={(e) => edit({ name: e.target.value })} />
            </div>
            <div className={styles.fieldBlock}>
              <label className={toolStyles.label} htmlFor="sm-role">
                Role
              </label>
              <input
                id="sm-role"
                className={toolStyles.field}
                value={form.role}
                maxLength={LIMITS.role}
                placeholder="for example: an assistant who handles my email"
                autoComplete="off"
                onChange={(e) => edit({ role: e.target.value })}
              />
            </div>
            <div className={styles.fieldBlock}>
              <label className={toolStyles.label} htmlFor="sm-employer">
                Who it works for
              </label>
              <input
                id="sm-employer"
                className={toolStyles.field}
                value={form.employer}
                maxLength={LIMITS.employer}
                placeholder="a name, or leave empty for the person you work for"
                autoComplete="off"
                onChange={(e) => edit({ employer: e.target.value })}
              />
            </div>
          </section>

          <section className={styles.group} aria-labelledby="sm-tone">
            <h3 id="sm-tone" className={styles.groupTitle}>
              Tone
            </h3>
            <p className={styles.groupHint}>Leave a group on no preference and that line is left out.</p>
            <ToolRadioGroup
              name="sm-formality"
              label="Register"
              value={form.formality}
              onChange={(formality) => edit({ formality })}
              options={[
                { value: "", label: "No preference" },
                { value: "casual", label: "Casual" },
                { value: "balanced", label: "Plain and professional" },
                { value: "formal", label: "Formal" },
              ]}
            />
            <div style={{ height: 16 }} />
            <ToolRadioGroup
              name="sm-directness"
              label="When it disagrees"
              value={form.directness}
              onChange={(directness) => edit({ directness })}
              options={[
                { value: "", label: "No preference" },
                { value: "gentle", label: "Gentle" },
                { value: "balanced", label: "Direct and kind" },
                { value: "blunt", label: "Blunt" },
              ]}
            />
            <div style={{ height: 16 }} />
            <ToolRadioGroup
              name="sm-humor"
              label="Humor"
              value={form.humor}
              onChange={(humor) => edit({ humor })}
              options={[
                { value: "", label: "No preference" },
                { value: "none", label: "None" },
                { value: "light", label: "Light" },
                { value: "playful", label: "Playful" },
              ]}
            />
          </section>

          <section className={styles.group} aria-labelledby="sm-decide">
            <h3 id="sm-decide" className={styles.groupTitle}>
              Act or ask
            </h3>
            <ToolRadioGroup
              name="sm-decision"
              label="When it is not sure what you want"
              value={form.decision}
              onChange={(decision) => edit({ decision })}
              options={[
                { value: "", label: "No preference" },
                { value: "act", label: "Act on small reversible steps, then tell me" },
                { value: "balanced", label: "Ask only when the answer changes the result" },
                { value: "ask", label: "Ask before acting" },
              ]}
            />
          </section>

          <section className={styles.group} aria-labelledby="sm-bounds">
            <h3 id="sm-bounds" className={styles.groupTitle}>
              Hard boundaries
            </h3>
            <p className={styles.groupHint}>Things it should never do. These are requests to the model, not locks.</p>
            <fieldset className={toolStyles.fieldset}>
              <legend className={toolStyles.legend}>Preset boundaries</legend>
              <div className={styles.checks}>
                {BOUNDARY_IDS.map((id: BoundaryId) => (
                  <label key={id} className={toolStyles.check}>
                    <input type="checkbox" checked={form.boundaries.includes(id)} onChange={() => edit({ boundaries: toggle(form.boundaries, id) })} />
                    {BOUNDARY_TEXT[id].label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.fieldBlock}>
              <label className={toolStyles.label} htmlFor="sm-boundary-lines">
                Your own boundaries, one per line
              </label>
              <textarea
                id="sm-boundary-lines"
                className={`${toolStyles.field} ${styles.textarea}`}
                value={form.boundaryLines}
                onChange={(e) => edit({ boundaryLines: e.target.value })}
                spellCheck
              />
            </div>
          </section>

          <section className={styles.group} aria-labelledby="sm-private">
            <h3 id="sm-private" className={styles.groupTitle}>
              Private information
            </h3>
            <ToolRadioGroup
              name="sm-privacy"
              label="How it treats what it can see about you"
              value={form.privacy}
              onChange={(privacy) => edit({ privacy })}
              options={[
                { value: "", label: "No preference" },
                { value: "strict", label: "Everything is private, ask when unsure" },
                { value: "need", label: "Share only what the task needs" },
              ]}
            />
            <div className={styles.fieldBlock} style={{ marginTop: 16 }}>
              <label className={toolStyles.label} htmlFor="sm-privacy-lines">
                Extra rules about private information, one per line
              </label>
              <textarea
                id="sm-privacy-lines"
                className={`${toolStyles.field} ${styles.textarea}`}
                value={form.privacyLines}
                onChange={(e) => edit({ privacyLines: e.target.value })}
                spellCheck
              />
            </div>
          </section>

          <section className={styles.group} aria-labelledby="sm-writing">
            <h3 id="sm-writing" className={styles.groupTitle}>
              How it writes
            </h3>
            <ToolRadioGroup
              name="sm-length"
              label="Length"
              value={form.length}
              onChange={(length) => edit({ length })}
              options={[
                { value: "", label: "No preference" },
                { value: "short", label: "Short" },
                { value: "medium", label: "A few paragraphs" },
                { value: "long", label: "Thorough" },
              ]}
            />
            <div style={{ height: 16 }} />
            <ToolRadioGroup
              name="sm-format"
              label="Format"
              value={form.format}
              onChange={(format) => edit({ format })}
              options={[
                { value: "", label: "No preference" },
                { value: "plain", label: "Plain sentences" },
                { value: "bullets", label: "Bullets for steps" },
                { value: "structured", label: "Headings and lists" },
              ]}
            />
            <div className={styles.fieldBlock} style={{ marginTop: 16 }}>
              <label className={toolStyles.label} htmlFor="sm-writing-lines">
                Your own writing rules, one per line
              </label>
              <textarea
                id="sm-writing-lines"
                className={`${toolStyles.field} ${styles.textarea}`}
                value={form.writingLines}
                onChange={(e) => edit({ writingLines: e.target.value })}
                spellCheck
              />
            </div>
          </section>

          <section className={styles.group} aria-labelledby="sm-approval">
            <h3 id="sm-approval" className={styles.groupTitle}>
              Never without approval
            </h3>
            <p className={styles.groupHint}>The agent is asked to stop and check first. For anything that really must be gated, also set approvals in the agent itself.</p>
            <fieldset className={toolStyles.fieldset}>
              <legend className={toolStyles.legend}>Ask first before</legend>
              <div className={styles.checks}>
                {APPROVAL_IDS.map((id: ApprovalId) => (
                  <label key={id} className={toolStyles.check}>
                    <input type="checkbox" checked={form.approvals.includes(id)} onChange={() => edit({ approvals: toggle(form.approvals, id) })} />
                    {APPROVAL_TEXT[id].label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.fieldBlock}>
              <label className={toolStyles.label} htmlFor="sm-approval-lines">
                Other things to ask first about, one per line
              </label>
              <textarea
                id="sm-approval-lines"
                className={`${toolStyles.field} ${styles.textarea}`}
                value={form.approvalLines}
                onChange={(e) => edit({ approvalLines: e.target.value })}
                spellCheck
              />
            </div>
          </section>

          <button type="button" className={toolStyles.smallButton} onClick={clear}>
            Clear the form
          </button>
        </div>

        <div className={styles.sticky}>
          <section className={styles.preview} aria-labelledby="sm-preview" data-testid="sm-preview">
            <div className={styles.previewHead}>
              <h3 id="sm-preview" className={styles.previewTitle}>
                Your {SOUL_FILE_NAME}
              </h3>
              <span className={toolStyles.hint} style={{ margin: 0 }}>
                {lines} {lines === 1 ? "line" : "lines"}, {chars.toLocaleString("en-US")} characters
              </span>
            </div>
            {text ? (
              <pre className={styles.previewText} tabIndex={0} aria-label={`${SOUL_FILE_NAME} preview`} data-testid="sm-output">
                {text}
              </pre>
            ) : (
              <p className={styles.empty} data-testid="sm-empty">
                Nothing yet. Pick a preset or fill in a field and the file appears here. Empty fields leave their section out.
              </p>
            )}
            <div className={styles.actions}>
              <CopyButton text={() => text} label="Copy Markdown" copiedLabel="Copied" />
              <button type="button" className={toolStyles.smallButton} disabled={!text} onClick={() => downloadText(text, SOUL_FILE_NAME)}>
                Download {SOUL_FILE_NAME}
              </button>
            </div>
            {warnings.length > 0 && (
              <p className={styles.warn} role="status" data-testid="sm-warning">
                Your text contains wording that tries to override other instructions ({warnings.join(", ")}). Hermes scans SOUL.md for prompt-injection patterns and
                flags matches for review. Say what you want instead of telling the model to ignore things.
              </p>
            )}
            <p className={toolStyles.hint}>
              Where to save it: Hermes reads <code className={toolStyles.inlineCode}>{SOUL_FACTS.hermes.path}</code>. OpenClaw reads{" "}
              <code className={toolStyles.inlineCode}>SOUL.md</code> in its workspace, <code className={toolStyles.inlineCode}>{SOUL_FACTS.openclaw.path}</code> by
              default. Start a new session after you save. OpenClaw truncates a file over {SOUL_FACTS.openclaw.perFileLimit.toLocaleString("en-US")}{" "}
              characters by default.
            </p>
          </section>
        </div>
      </div>

      <h2 className={toolStyles.h3}>What a SOUL.md cannot do</h2>
      <ul className={styles.limits} data-testid="sm-limits">
        {SOUL_LIMITS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h2 className={toolStyles.h3}>What goes in which file</h2>
      <div className={styles.whereWrap}>
        <table className={styles.where}>
          <caption className="sr-only" style={{ position: "absolute", left: -9999 }}>
            Which file holds which kind of instruction, for Hermes and for OpenClaw
          </caption>
          <thead>
            <tr>
              <th scope="col">What you want to say</th>
              <th scope="col">Hermes Agent</th>
              <th scope="col">OpenClaw</th>
            </tr>
          </thead>
          <tbody>
            {WHERE_IT_GOES.map((row) => (
              <tr key={row.what}>
                <th scope="row">{row.what}</th>
                <td>{row.hermes}</td>
                <td>{row.openclaw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.layout} style={{ marginBottom: 24 }}>
        <section className={toolStyles.panel} aria-labelledby="sm-hermes">
          <h3 id="sm-hermes" className={toolStyles.h3} style={{ marginTop: 0 }}>
            In Hermes Agent
          </h3>
          <ul className={styles.factList}>
            <li>{SOUL_FACTS.hermes.role}</li>
            <li>{SOUL_FACTS.hermes.notIn}</li>
            <li>{SOUL_FACTS.hermes.loaded}</li>
            <li>{SOUL_FACTS.hermes.scan}</li>
            <li>{SOUL_FACTS.hermes.size}</li>
            <li>{SOUL_FACTS.hermes.suggested}</li>
          </ul>
        </section>
        <section className={toolStyles.panel} aria-labelledby="sm-openclaw">
          <h3 id="sm-openclaw" className={toolStyles.h3} style={{ marginTop: 0 }}>
            In OpenClaw
          </h3>
          <ul className={styles.factList}>
            <li>{SOUL_FACTS.openclaw.role}</li>
            <li>
              Truncated over {SOUL_FACTS.openclaw.perFileLimit.toLocaleString("en-US")} characters for the file by default, and {SOUL_FACTS.openclaw.totalLimit.toLocaleString("en-US")} across all
              workspace files.
            </li>
            <li>{SOUL_FACTS.openclaw.subagents}</li>
            <li>{SOUL_FACTS.openclaw.suggested}</li>
          </ul>
        </section>
      </div>

      <p className={toolStyles.note}>
        <strong className={toolStyles.noteLead}>Assumptions:</strong> the file locations and loading rules come from the Hermes Agent and OpenClaw docs, last
        checked {monthYear(SOUL_FACTS.lastVerified)}. Upstream projects change, so check the linked pages if something does not behave as described. The
        sections and wording of the generated file are ours, not a required format. Your text is cleaned so it cannot start a heading, list, quote, table or code block, and
        it stays in this browser.
      </p>

      <div className={toolStyles.bridge}>
        <p>
          If you want the agent on a machine of its own, a Hivra computer costs {formatPlanSize("entry")}. Hermes and OpenClaw there are the official upstream
          agents, so upstream&apos;s SOUL.md docs apply. Running either on a machine you already own is a fair choice too.
        </p>
        <Link href={PUBLIC_START_HREF} className={toolStyles.bridgeLink}>
          Start an agent on its own Hivra computer
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
