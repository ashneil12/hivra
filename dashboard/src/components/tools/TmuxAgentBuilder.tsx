"use client";

// The tmux command builder on /tools/tmux-cheat-sheet: pick the agent, name the
// session, choose whether to log, and get the commands in the right order
// (logging starts before the agent does, so the file holds the whole run).
//
// Defaults render a full result on the server. A link restores the agent and
// the logging choice; a session name or command the visitor types stays in
// their browser (lib/tools/tool-params.ts).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import CopyButton from "./CopyButton";
import { Cmd } from "./InlineCode";
import ToolRadioGroup from "./ToolRadioGroup";
import {
  TMUX_AGENTS,
  TMUX_AGENT_LABELS,
  TMUX_BUILDER_DEFAULTS,
  TMUX_COMMAND_MAX,
  TMUX_OTHER_PLACEHOLDER,
  TMUX_SESSION_NAME_MAX,
  buildTmuxCommands,
  defaultSessionName,
  type TmuxAgent,
} from "@/lib/tools/tmux-sheet";
import { PLAN_LINE, agentButton, ctaAgentFor, tmuxOnHivraSentence } from "@/lib/tools/agent-cta";
import { TMUX_PARAM_KEYS, currentSearch, parseTmuxParams, replaceToolSearch, serializeTmuxParams } from "@/lib/tools/tool-params";

export default function TmuxAgentBuilder() {
  const [agent, setAgent] = useState<TmuxAgent>(TMUX_BUILDER_DEFAULTS.agent);
  const [sessionName, setSessionName] = useState(TMUX_BUILDER_DEFAULTS.sessionName);
  const [otherCommand, setOtherCommand] = useState(TMUX_BUILDER_DEFAULTS.otherCommand);
  const [logging, setLogging] = useState(TMUX_BUILDER_DEFAULTS.logging);
  // Whether the address bar has been read yet; nothing is written back before.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const fromLink = parseTmuxParams(currentSearch());
    // Reading an external system (the address bar) once after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgent(fromLink.agent);
    setLogging(fromLink.logging);
    setRestored(true);
  }, []);

  const result = buildTmuxCommands({ agent, sessionName, otherCommand, logging });
  const search = serializeTmuxParams({ agent, sessionName, otherCommand, logging });
  const ctaAgent = ctaAgentFor(result.command);
  const button = agentButton(ctaAgent);

  useEffect(() => {
    if (restored) replaceToolSearch(search, TMUX_PARAM_KEYS);
  }, [restored, search]);

  return (
    <section className={styles.builder} aria-labelledby="tmux-builder-heading" id="builder">
      <h2 className={styles.h3} id="tmux-builder-heading">
        Build the commands for your agent
      </h2>
      <div className={styles.inputs}>
        <ToolRadioGroup
          name="tmux-agent"
          label="Agent"
          value={agent}
          onChange={setAgent}
          options={TMUX_AGENTS.map((value) => ({ value, label: TMUX_AGENT_LABELS[value] }))}
        />
        <div>
          <label htmlFor="tmux-session" className={styles.label}>
            Session name
          </label>
          <input
            id="tmux-session"
            type="text"
            value={sessionName}
            placeholder={defaultSessionName(agent)}
            maxLength={TMUX_SESSION_NAME_MAX}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onChange={(event) => setSessionName(event.target.value)}
            className={styles.field}
          />
          <p className={styles.hint}>Letters, digits, dash and underscore. Anything else is dropped.</p>
        </div>
        {agent === "other" && (
          <div>
            <label htmlFor="tmux-command" className={styles.label}>
              Command to run
            </label>
            <input
              id="tmux-command"
              type="text"
              value={otherCommand}
              placeholder={TMUX_OTHER_PLACEHOLDER}
              maxLength={TMUX_COMMAND_MAX}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(event) => setOtherCommand(event.target.value)}
              className={styles.field}
            />
            <p className={styles.hint}>Stays in your browser. A share link never carries it.</p>
          </div>
        )}
        <div>
          <span className={styles.label}>Log the pane to a file</span>
          <label className={styles.check}>
            <input type="checkbox" checked={logging} onChange={(event) => setLogging(event.target.checked)} />
            Append everything the pane prints to ~/{result.sessionName}.log
          </label>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.headWrap}>
          <span className={styles.panelTitle} style={{ margin: 0 }}>
            Your commands
          </span>
          <CopyButton text={result.script} label="Copy commands" />
        </div>
        <pre className={styles.pre} data-testid="tmux-script">
          {result.script}
        </pre>
        <ul className={styles.laterList}>
          {result.later.map((item) => (
            <li key={item.command}>
              <span>{item.label}</span>
              <Cmd command={item.command} />
              <CopyButton text={item.command} compact ariaLabel={`Copy: ${item.command}`} />
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.bridge} data-testid="tmux-cta" data-agent={ctaAgent}>
        <p>
          tmux keeps a session alive through disconnects, not through sleep. For a run that has to outlast your laptop, start it in
          tmux on a computer that stays on. {tmuxOnHivraSentence(ctaAgent)} {PLAN_LINE}
        </p>
        <Link href={button.href} className={styles.bridgeLink}>
          {button.label}
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
