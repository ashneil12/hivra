"use client";

// Keep-awake command builder (/tools/keep-mac-awake).
//
// Four answers (system, how long, power, lid) and the command to keep awake
// produce the exact caffeinate (macOS) or systemd-inhibit (Linux) command, how
// to check it, what pmset can and cannot do, and a plain list of what it will
// not cover. The rules live in lib/tools/keep-awake.ts; every fact in them has a
// source and a verified date that the page's method section renders.
//
// The default answers compute a full result on first render, so the server HTML
// carries it. A link restores the answers on mount and the component writes
// them back with history.replaceState; only structured answers travel in a link,
// never a command the visitor typed.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import CopyButton from "./CopyButton";
import Prose from "./InlineCode";
import ToolRadioGroup from "./ToolRadioGroup";
import {
  KEEP_AWAKE_COMMAND_MAX,
  KEEP_AWAKE_DEFAULTS,
  KEEP_AWAKE_FACTS,
  KEEP_AWAKE_HOURS,
  KEEP_AWAKE_PRESET_COMMANDS,
  buildKeepAwake,
  clampHours,
  type KeepAwakeDuration,
  type KeepAwakeLid,
  type KeepAwakeOs,
  type KeepAwakePower,
} from "@/lib/tools/keep-awake";
import { keepAwakeCta } from "@/lib/tools/keep-awake-cta";
import {
  KEEP_AWAKE_PARAM_KEYS,
  absoluteLinkFor,
  currentSearch,
  parseKeepAwakeParams,
  replaceToolSearch,
  serializeKeepAwakeParams,
} from "@/lib/tools/tool-params";
import { toolPath } from "@/lib/tools/tool-catalog";

/** "A closed lid. caffeinate is not..." becomes a bold lead and the rest. */
function splitLead(item: string): { lead: string; rest: string } {
  const at = item.indexOf(". ");
  return at === -1 ? { lead: item, rest: "" } : { lead: item.slice(0, at + 1), rest: item.slice(at + 2) };
}

export default function KeepMacAwakeTool() {
  const [os, setOs] = useState<KeepAwakeOs>(KEEP_AWAKE_DEFAULTS.os);
  const [duration, setDuration] = useState<KeepAwakeDuration>(KEEP_AWAKE_DEFAULTS.duration);
  const [hoursText, setHoursText] = useState(String(KEEP_AWAKE_DEFAULTS.hours));
  const [power, setPower] = useState<KeepAwakePower>(KEEP_AWAKE_DEFAULTS.power);
  const [lid, setLid] = useState<KeepAwakeLid>(KEEP_AWAKE_DEFAULTS.lid);
  const [command, setCommand] = useState<string>(KEEP_AWAKE_DEFAULTS.command);
  // Whether the address bar has been read yet. Until then nothing is written
  // back, so a shared link is never wiped by the default state.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const fromLink = parseKeepAwakeParams(currentSearch());
    // Reading an external system (the address bar) once after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOs(fromLink.os);
    setDuration(fromLink.duration);
    setHoursText(String(fromLink.hours));
    setPower(fromLink.power);
    setLid(fromLink.lid);
    setCommand(fromLink.command);
    setRestored(true);
  }, []);

  const parsedHours = Number.parseInt(hoursText, 10);
  const hours = Number.isFinite(parsedHours) ? clampHours(parsedHours) : KEEP_AWAKE_DEFAULTS.hours;
  const result = buildKeepAwake({ os, duration, hours, power, lid, command });
  const search = serializeKeepAwakeParams(result.input);
  const cta = keepAwakeCta(result);

  useEffect(() => {
    if (restored) replaceToolSearch(search, KEEP_AWAKE_PARAM_KEYS);
  }, [restored, search]);

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <ToolRadioGroup
          name="kma-os"
          label="System"
          value={os}
          onChange={setOs}
          options={[
            { value: "macos", label: "macOS" },
            { value: "linux", label: "Linux with systemd" },
          ]}
        />
        <div>
          <ToolRadioGroup
            name="kma-duration"
            label="How long"
            value={duration}
            onChange={setDuration}
            options={[
              { value: "until-exit", label: "Until the command exits" },
              { value: "hours", label: "For a set number of hours" },
            ]}
          />
          {duration === "hours" && (
            <div style={{ marginTop: 10 }}>
              <label htmlFor="kma-hours" className={styles.label}>
                Hours ({KEEP_AWAKE_HOURS.min} to {KEEP_AWAKE_HOURS.max})
              </label>
              <input
                id="kma-hours"
                type="number"
                inputMode="numeric"
                min={KEEP_AWAKE_HOURS.min}
                max={KEEP_AWAKE_HOURS.max}
                step={1}
                value={hoursText}
                onChange={(event) => setHoursText(event.target.value)}
                onBlur={() => setHoursText(String(hours))}
                className={styles.field}
              />
            </div>
          )}
        </div>
        <ToolRadioGroup
          name="kma-power"
          label="Power"
          value={power}
          onChange={setPower}
          options={[
            { value: "plugged", label: "Plugged in" },
            { value: "battery", label: "On battery" },
          ]}
        />
        <ToolRadioGroup
          name="kma-lid"
          label="Lid"
          value={lid}
          onChange={setLid}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
        />
        <div>
          <label htmlFor="kma-command" className={styles.label}>
            Command to keep awake
          </label>
          <input
            id="kma-command"
            type="text"
            list="kma-commands"
            value={command}
            maxLength={KEEP_AWAKE_COMMAND_MAX}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onChange={(event) => setCommand(event.target.value)}
            className={styles.field}
          />
          <datalist id="kma-commands">
            {KEEP_AWAKE_PRESET_COMMANDS.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
          <p className={styles.hint}>What you type stays in your browser. A share link carries only your answers, and claude or codex.</p>
        </div>
      </div>

      <div className={styles.verdictBox} data-level={result.verdict.level} data-testid="kma-verdict">
        <p className={styles.verdictTitle} aria-live="polite">
          {result.verdict.title}
        </p>
        <p className={styles.verdictDetail}>
          <Prose text={result.verdict.detail} />
        </p>
      </div>

      <div className={styles.panel}>
        <div className={styles.headWrap}>
          <span className={styles.panelTitle} style={{ margin: 0 }}>
            Your command
          </span>
          <span className={styles.citeActions}>
            <CopyButton text={result.script} label="Copy command" />
            <CopyButton text={result.agentPrompt} label="Copy for agent" ariaLabel="Copy for agent (a prompt for Claude Code or Codex)" />
            <CopyButton text={() => absoluteLinkFor(search)} label="Copy link" ariaLabel="Copy link to this setup" />
          </span>
        </div>
        <pre className={styles.pre} data-testid="kma-script">
          {result.script}
        </pre>
        <ul className={styles.plainList}>
          {result.explain.map((line) => (
            <li key={line}>
              <Prose text={line} />
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.panel}>
        <span className={styles.panelTitle}>Check it is working</span>
        <pre className={styles.pre} style={{ marginTop: 0 }}>
          {result.verify.command}
        </pre>
        <p className={styles.hint}>
          <Prose text={result.verify.hint} />
        </p>
        {result.pmset && (
          <>
            <span className={styles.panelTitle} style={{ marginTop: 20 }}>
              pmset, if you want it to last
            </span>
            <pre className={styles.pre} style={{ marginTop: 0 }}>
              {result.pmset.lines.join("\n")}
            </pre>
            <p className={styles.hint}>
              <Prose text={result.pmset.note} />
            </p>
          </>
        )}
      </div>

      <div>
        <h2 className={styles.h3}>What this will not cover</h2>
        <ul className={styles.coverList} data-testid="kma-not-covered">
          {result.notCovered.map((item) => {
            const { lead, rest } = splitLead(item);
            return (
              <li key={item}>
                <strong>{lead}</strong> <Prose text={rest} />
              </li>
            );
          })}
        </ul>
        <p className={styles.note}>
          Run the agent and the keep-awake inside tmux so a closed terminal window does not end them. The{" "}
          <Link href={toolPath("tmux-cheat-sheet")}>tmux cheat sheet</Link> has the commands.
        </p>
      </div>

      <p className={styles.note}>
        {`Commands last verified ${KEEP_AWAKE_FACTS.lastVerified} against the caffeinate, pmset, systemd-inhibit and logind.conf manuals and Apple Support. The method section below links each source.`}
      </p>

      <div className={styles.bridge} data-testid="kma-cta" data-state={cta.state}>
        <p>
          {cta.text}{" "}
          <Link href={cta.survivalCheck.href}>{cta.survivalCheck.label}</Link>.
        </p>
        {cta.button && (
          <Link href={cta.button.href} className={styles.bridgeLink}>
            {cta.button.label}
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}
