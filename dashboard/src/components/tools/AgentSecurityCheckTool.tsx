"use client";

// Agent Security Check (/tools/ai-agent-security-checklist).
//
// Twelve yes / no / not-sure questions in eight groups, scored by the table in
// lib/tools/agent-tools/agent-security-check.ts. A "no" or "not sure" opens the fix under its question. When all twelve are
// answered the card shows a band and the top three fixes in order. The answers (one character each) go in the page
// address so a result can be shared; nothing typed travels, because the page takes no typed text. Nothing is sent
// anywhere. The last section states what a Hivra computer changes, and only what the repository supports.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import toolStyles from "@/app/tools/tools.module.css";
import styles from "./AgentSecurityCheckTool.module.css";
import CopyButton from "./CopyButton";
import ToolRadioGroup from "./ToolRadioGroup";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { absoluteLinkFor, currentSearch, replaceToolSearch } from "@/lib/tools/tool-params";
import {
  AGENT_SECURITY_FACTS,
  AGENT_SECURITY_PARAM_KEYS,
  ANSWERS,
  ANSWER_LABELS,
  CHECKS,
  CHECK_TITLES,
  EMPTY_ANSWERS,
  GROUPS,
  HIVRA_SECURITY_FACTS,
  SOURCE_LIST,
  answeredCount,
  assess,
  parseSecurityParams,
  serializeSecurityParams,
  summaryText,
  type Answer,
  type Check,
  type CheckId,
  type SecurityAnswers,
} from "@/lib/tools/agent-tools/agent-security-check";
import { monthYear } from "@/lib/tools/month-year";

const WEIGHT_LABEL = { 1: "Lower impact", 2: "Medium impact", 3: "High impact" } as const;

function FixBlock({ check }: { check: Check }) {
  return (
    <div className={styles.fix} data-testid={`asc-fix-${check.id}`}>
      <p className={styles.fixTitle}>How to fix it</p>
      <p className={styles.fixText}>{check.fix}</p>
      {check.lines.length > 0 && (
        <ul className={styles.lines}>
          {check.lines.map((line) => (
            <li key={`${line.agent}-${line.code}`} className={styles.line}>
              <span className={styles.agent}>{line.agent}</span>
              <span>
                <code className={styles.code}>{line.code}</code>
                <span className={styles.codeNote}>{line.note}</span>
              </span>
              {line.kind === "command" ? <CopyButton text={line.code} compact label="Copy" ariaLabel={`Copy: ${line.code}`} /> : <span />}
            </li>
          ))}
        </ul>
      )}
      {check.gap && <p className={styles.general}>{check.gap}</p>}
      {check.generalPractice && <p className={styles.general}>This is common practice, not a step from either project&apos;s docs.</p>}
      <p className={styles.general}>
        Sources:{" "}
        {check.sources.map((key, i) => (
          <span key={key}>
            {i > 0 && ", "}
            <a href={AGENT_SECURITY_FACTS.sources[key].url} target="_blank" rel="noopener noreferrer">
              {AGENT_SECURITY_FACTS.sources[key].label}
            </a>
          </span>
        ))}
      </p>
    </div>
  );
}

export default function AgentSecurityCheckTool() {
  const [answers, setAnswers] = useState<SecurityAnswers>(EMPTY_ANSWERS);
  const [ready, setReady] = useState(false);
  const firstGroupRef = useRef<HTMLHeadingElement>(null);

  // Read a shared link once, after hydration, so the server render stays the empty state.
  useEffect(() => {
    // Reading the address is an external system; it can only happen after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnswers(parseSecurityParams(currentSearch()));
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) replaceToolSearch(serializeSecurityParams(answers), AGENT_SECURITY_PARAM_KEYS);
  }, [answers, ready]);

  const setAnswer = (id: CheckId, value: SecurityAnswers[CheckId]) => setAnswers((prev) => ({ ...prev, [id]: value }));

  const answered = answeredCount(answers);
  const total = CHECKS.length;
  const result = assess(answers);

  return (
    <div className={toolStyles.tool}>
      <p className={toolStyles.hint} style={{ marginTop: 0, marginBottom: 12 }}>
        {result
          ? `All ${total} answered. Change any answer and the result updates.`
          : `${answered} of ${total} answered. Your band and top three fixes appear when you have answered all ${total}. Answer "Not sure" if you cannot tell.`}
      </p>
      <p className={toolStyles.hint} role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {result ? `Result: ${result.band.label}` : ""}
      </p>
      <p style={{ margin: "0 0 24px" }}>
        <button
          type="button"
          className={toolStyles.smallButton}
          style={{ marginTop: 0 }}
          disabled={answered === 0}
          onClick={() => {
            setAnswers(EMPTY_ANSWERS);
            firstGroupRef.current?.focus();
          }}
        >
          Clear answers
        </button>
      </p>

      <div>
        {result && (
          <section className={styles.result} aria-labelledby="asc-result" data-testid="asc-result">
            <div className={toolStyles.panel}>
              <span className={toolStyles.panelTitle}>Your result</span>
              <h2 id="asc-result" className={styles.bandName}>
                {result.band.label}
              </h2>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>{result.band.meaning}</p>
              <p className={toolStyles.hint}>
                A band is a rough reading of twelve answers, not a score out of 100 and not an audit.
                {result.raisedBy ? ` The band is higher than the points alone give because of ${result.raisedBy}.` : ""}
              </p>
              {result.topThree.length > 0 ? (
                <>
                  <h3 className={toolStyles.h3} style={{ fontSize: 17, marginTop: 20 }}>
                    Your top {result.topThree.length === 3 ? "three fixes" : result.topThree.length === 1 ? "fix" : "two fixes"}, in order
                  </h3>
                  <ol className={styles.top} data-testid="asc-top">
                    {result.topThree.map((row) => (
                      <li key={row.check.id}>
                        <strong className={toolStyles.noteLead}>{CHECK_TITLES[row.check.id]}</strong>
                        {row.answer === "unsure" ? " (confirm first: you answered not sure)" : ""}. {row.check.fix}{" "}
                        <a href={`#asc-check-${row.check.id}`}>Commands and sources under the question</a>
                      </li>
                    ))}
                  </ol>
                  {result.open.length > result.topThree.length && (
                    <p className={toolStyles.hint}>
                      {result.open.length - result.topThree.length} more open {result.open.length - result.topThree.length === 1 ? "item" : "items"} are
                      marked under their questions.
                    </p>
                  )}
                </>
              ) : (
                <p style={{ margin: "16px 0 0", fontSize: 15, lineHeight: 1.75 }}>Nothing is open. Run this again when you add a channel, a tool or a person.</p>
              )}
            </div>
            <div className={toolStyles.panelHead}>
              <CopyButton text={() => absoluteLinkFor(serializeSecurityParams(answers))} label="Copy link to this result" copiedLabel="Link copied" />
              <CopyButton text={() => summaryText(result)} label="Copy summary" copiedLabel="Summary copied" />
            </div>
          </section>
        )}
      </div>

      {GROUPS.map((group) => (
        <section key={group.id} className={styles.group} aria-labelledby={`asc-group-${group.id}`}>
          <h3
            id={`asc-group-${group.id}`}
            className={styles.groupTitle}
            ref={group.id === GROUPS[0].id ? firstGroupRef : undefined}
            tabIndex={group.id === GROUPS[0].id ? -1 : undefined}
          >
            {group.label}
          </h3>
          {CHECKS.filter((check) => check.group === group.id).map((check) => {
            const answer = answers[check.id];
            return (
              <div key={check.id} id={`asc-check-${check.id}`} className={styles.check}>
                <p className={styles.meta}>
                  <span>{WEIGHT_LABEL[check.weight]}</span>
                </p>
                <ToolRadioGroup<Answer | "">
                  name={`asc-${check.id}`}
                  label={check.question}
                  value={answer ?? ""}
                  onChange={(value: Answer | "") => setAnswer(check.id, value === "" ? null : value)}
                  options={ANSWERS.map((value) => ({ value, label: ANSWER_LABELS[value] }))}
                />
                <p className={styles.why} style={{ marginTop: 10 }}>
                  <strong className={toolStyles.noteLead}>Why it matters:</strong> {check.why}
                </p>
                {(answer === "no" || answer === "unsure") && <FixBlock check={check} />}
              </div>
            );
          })}
        </section>
      ))}

      <p className={toolStyles.note}>
        <strong className={toolStyles.noteLead}>Assumptions:</strong> the commands and settings come from the OpenClaw and Hermes security docs and the OWASP
        list for LLM apps, last checked {monthYear(AGENT_SECURITY_FACTS.lastVerified)}. Upstream projects change quickly, so check the linked page before
        you apply a setting. This tool cannot see your setup, so it takes your answers as true. It is not an audit.{" "}
        {SOURCE_LIST.length} sources are linked in the method section below.
      </p>

      <section className={toolStyles.panel} aria-labelledby="asc-hivra" data-testid="asc-hivra">
        <h2 id="asc-hivra" className={toolStyles.h3} style={{ marginTop: 0 }}>
          What a Hivra computer changes
        </h2>
        <p className={toolStyles.hint} style={{ marginTop: 0 }}>
          Each statement here is written in Hivra&apos;s own code or status document. Checked {monthYear(HIVRA_SECURITY_FACTS.lastVerified)}.
        </p>
        <h3 className={toolStyles.h3} style={{ fontSize: 17 }}>
          What it does
        </h3>
        <ul className={styles.hivraList}>
          {HIVRA_SECURITY_FACTS.does.map((fact) => (
            <li key={fact.text}>{fact.text}</li>
          ))}
        </ul>
        <h3 className={toolStyles.h3} style={{ fontSize: 17 }}>
          What it does not do
        </h3>
        <ul className={styles.hivraList}>
          {HIVRA_SECURITY_FACTS.doesNot.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p style={{ margin: "0 0 4px", fontSize: 15, lineHeight: 1.75 }}>
          <strong className={toolStyles.noteLead}>Still your responsibility:</strong> {HIVRA_SECURITY_FACTS.stillYours}
        </p>
      </section>

      <div className={toolStyles.bridge}>
        <p>
          If you want the agent on a machine of its own, a Hivra computer costs {formatPlanSize("entry")}. Running it on a machine you already own is a fair
          choice too.
        </p>
        <Link href={PUBLIC_START_HREF} className={toolStyles.bridgeLink}>
          Start an agent on its own Hivra computer
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
