"use client";

// Agent Picker (/tools/hermes-vs-openclaw).
//
// Six questions, scored against a fixed weight table (lib/tools/agent-tools/agent-picker.ts). When all six
// are answered the card shows the top pick with the three answers that moved it most, its honest
// tradeoff, the runner-up and when to choose that one instead. The answers (and only the answers) go
// in the page address so a result can be shared. Nothing is sent anywhere.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import CopyButton from "./CopyButton";
import ToolRadioGroup from "./ToolRadioGroup";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { currentSearch, absoluteLinkFor, replaceToolSearch } from "@/lib/tools/tool-params";
import {
  AGENT_PICKER_FACTS,
  AGENT_PICKER_PARAM_KEYS,
  AGENT_PROFILES,
  EMPTY_ANSWERS,
  HERMES_VS_OPENCLAW_ROWS,
  QUESTIONS,
  answeredCount,
  parseAgentPickerParams,
  recommend,
  serializeAgentPickerParams,
  startHrefFor,
  summaryText,
  type PickerAnswers,
  type QuestionKey,
} from "@/lib/tools/agent-tools/agent-picker";
import { monthYear } from "@/lib/tools/month-year";

export default function AgentPickerTool() {
  const [answers, setAnswers] = useState<PickerAnswers>(EMPTY_ANSWERS);
  const [ready, setReady] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Read a shared link once, after hydration, so the server render stays the empty state.
  useEffect(() => {
    // Reading the address is an external system; it can only happen after hydration. Same pattern as the keep-awake tool.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnswers(parseAgentPickerParams(currentSearch()));
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) replaceToolSearch(serializeAgentPickerParams(answers), AGENT_PICKER_PARAM_KEYS);
  }, [answers, ready]);

  const setAnswer = (key: QuestionKey, value: string) => setAnswers((prev) => ({ ...prev, [key]: value }));

  const answered = answeredCount(answers);
  const result = recommend(answers);
  const top = result ? AGENT_PROFILES[result.top.agent] : null;
  const runner = result?.runnerUp ? AGENT_PROFILES[result.runnerUp.agent] : null;

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        {QUESTIONS.map((question) => (
          <ToolRadioGroup
            key={question.key}
            name={`agent-picker-${question.key}`}
            label={question.label}
            value={answers[question.key]}
            onChange={(value) => setAnswer(question.key, value)}
            options={question.answers.map((a) => ({ value: a.value, label: a.label }))}
          />
        ))}
      </div>

      <p className={styles.hint} role="status" aria-live="polite" style={{ marginTop: 0, marginBottom: 24 }}>
        {result ? `All six answered. Change any answer and the result updates.` : `${answered} of 6 answered. The pick appears when you have answered all six.`}
        {answered > 0 && (
          <>
            {" "}
            <button type="button" className={styles.smallButton} style={{ marginTop: 0 }} onClick={() => setAnswers(EMPTY_ANSWERS)}>
              Clear answers
            </button>
          </>
        )}
      </p>

      <div ref={resultRef} aria-live="polite">
        {result && top && (
          <section aria-labelledby="agent-picker-result" data-testid="agent-picker-result">
            <h2 id="agent-picker-result" className={styles.h3}>
              {result.tied && runner
                ? `A tie: ${top.name} and ${runner.name} scored the same`
                : `Your best fit: ${top.name}`}
            </h2>
            {result.tied && runner && (
              <p className={styles.hint} style={{ marginTop: 0 }}>
                Your answers fit both equally well. {top.name} is listed first by our tie-break rule, which is a fixed order and not a verdict. Read both
                cards below.
              </p>
            )}

            <div className={styles.panel}>
              <span className={styles.panelTitle}>
                {top.name} by {top.vendor}, {result.top.score} of {result.maxScore} points
              </span>
              <p className={styles.big} style={{ fontSize: "clamp(18px,2vw,22px)", letterSpacing: "-0.02em" }}>
                {top.summary}
              </p>
              <h3 className={styles.h3} style={{ fontSize: 17, marginTop: 20 }}>
                Why it fits your answers
              </h3>
              <ul className={styles.plainList}>
                {result.reasons.map((reason) => (
                  <li key={reason.question}>{reason.text}</li>
                ))}
              </ul>
              <h3 className={styles.h3} style={{ fontSize: 17, marginTop: 20 }}>
                The honest tradeoff
              </h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>{top.tradeoff}</p>
            </div>

            {runner && result.runnerUp && (
              <div className={styles.panel}>
                <span className={styles.panelTitle}>
                  {result.tied ? "Level with it" : "Runner-up"}: {runner.name}, {result.runnerUp.score} of {result.maxScore} points
                </span>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>{runner.summary}</p>
                <h3 className={styles.h3} style={{ fontSize: 17, marginTop: 20 }}>
                  When {runner.name} is the better choice
                </h3>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>
                  Pick {runner.name} instead if {runner.betterWhen}
                </p>
                <p style={{ margin: "12px 0 0", fontSize: 15, lineHeight: 1.75 }}>
                  <strong className={styles.noteLead}>Its tradeoff:</strong> {runner.tradeoff}
                </p>
              </div>
            )}

            <div className={styles.panel}>
              <span className={styles.panelTitle}>Every agent, ranked</span>
              <ol className={styles.plainList} style={{ marginTop: 0 }}>
                {result.ranking.map((row) => (
                  <li key={row.agent}>
                    <strong className={styles.noteLead}>{AGENT_PROFILES[row.agent].name}</strong>, {row.score} of {result.maxScore}
                  </li>
                ))}
              </ol>
              <p className={styles.hint}>
                The points are our judgement of fit, not a benchmark. A gap of one or two points is a close call.
              </p>
            </div>

            <div className={styles.panelHead}>
              <CopyButton text={() => absoluteLinkFor(serializeAgentPickerParams(answers))} label="Copy link to this result" copiedLabel="Link copied" />
              <CopyButton text={() => summaryText(answers, result)} label="Copy summary" copiedLabel="Summary copied" />
            </div>
          </section>
        )}
      </div>

      <div className={styles.panel} style={{ marginTop: 24 }}>
        <span className={styles.panelTitle}>Hermes and OpenClaw side by side</span>
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Hermes and OpenClaw compared">
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Question</th>
                <th scope="col">Hermes</th>
                <th scope="col">OpenClaw</th>
              </tr>
            </thead>
            <tbody>
              {HERMES_VS_OPENCLAW_ROWS.map((row) => (
                <tr key={row.label}>
                  <th scope="row" style={{ fontWeight: 600, color: "var(--ink-black)" }}>
                    {row.label}
                  </th>
                  <td>{row.hermes}</td>
                  <td>{row.openclaw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className={styles.note}>
        <strong className={styles.noteLead}>Assumptions:</strong> what each agent does comes from its own repository and docs, last checked{" "}
        {monthYear(AGENT_PICKER_FACTS.lastVerified)}. Projects change quickly, so check the source before you commit. Only agents Hivra offers are
        scored, which leaves out others that may suit you. Running any of them on a machine of your own is a fair choice.
      </p>

      {result && top && (
        <div className={styles.bridge}>
          <p>
            {top.hivraNote ? `${top.hivraNote} ` : ""}
            A Hivra computer for {top.name} costs {formatPlanSize("entry")}. The plan does not include AI usage.
          </p>
          <Link href={startHrefFor(result.top.agent)} className={styles.bridgeLink}>
            Start {top.name} on Hivra
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
