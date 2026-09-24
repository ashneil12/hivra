import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Cpu,
  KeyRound,
  MemoryStick,
  Monitor,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { getHivraPreview } from "@/lib/hivra/preview-catalog";

import styles from "./DeepSeekHarnessPreviewPage.module.css";

const agent = getAgent("deepseek-harness");
const preview = getHivraPreview("deepseek-harness");

/** DeepSeek Harness is in private preview: what it will be, in plain words,
 * and that it can't be launched yet. */
export function DeepSeekHarnessPreviewPage() {
  if (!agent || !preview) return null;

  return (
    <main className={styles.page}>
      <div className={styles.gridBackdrop} aria-hidden="true" />
      <div className={styles.inner}>
        <Link className={styles.breadcrumb} href={preview.href}>
          <ArrowLeft size={13} /> Agents <span>/ DeepSeek Harness</span>
        </Link>

        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}><SquareTerminal size={14} /> Private preview</span>
            <h1>DeepSeek Harness is <em>coming to Hivra.</em></h1>
            <p>
              DeepSeek&apos;s coding agent will run on a computer of its own, in its own interface, with the model
              key you choose. It can&apos;t be launched yet. It will appear in Launch as soon as it&apos;s ready.
            </p>
          </div>
          <div className={styles.headerState}>
            <span>Status</span>
            <strong><i /> Private preview</strong>
          </div>
        </header>

        <section className={styles.runtime} aria-labelledby="deepseek-title">
          <div className={styles.runtimeLead}>
            <div className={styles.runtimeIdentity}>
              <span className={styles.mark}>D.</span>
              <div>
                <span className={styles.previewLabel}>DeepSeek&apos;s coding agent</span>
                <h2 id="deepseek-title">{agent.name}</h2>
                <p>{preview.summary}</p>
              </div>
            </div>
            <a className={styles.upstream} href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">
              About DeepSeek Harness <ArrowUpRight size={13} />
            </a>
          </div>

          <div className={styles.requirements} aria-label="What DeepSeek Harness needs">
            <div><Cpu size={14} /><span>CPU</span><strong>At least {agent.floor?.cpu} CPU</strong></div>
            <div><MemoryStick size={14} /><span>Memory</span><strong>At least {agent.floor?.ram} GB</strong></div>
            <div><KeyRound size={14} /><span>Model</span><strong>Your own key</strong></div>
            <div><Monitor size={14} /><span>Runs on</span><strong>Its own computer</strong></div>
          </div>

          <div className={styles.runtimeBody}>
            <div className={styles.contract}>
              <span className={styles.sectionKicker}>What you&apos;ll get</span>
              <h3>Its full interface, on a computer of its own.</h3>
              <p>
                Like every agent on Hivra, DeepSeek Harness gets a private computer. You open its interface from
                Hivra, it works on its own files there, and you can remove it cleanly when you&apos;re done.
              </p>
              <div className={styles.truthNotice}>
                <ShieldCheck size={16} />
                <p>
                  <strong>Not open for launch yet.</strong> Until it is, Claude Code and Codex are ready to launch
                  as coding agents.
                </p>
              </div>
              <Link className={styles.primary} href={buildLaunchHref({ kind: "agent", start: true })}>
                Launch a coding agent <ArrowRight size={13} />
              </Link>
            </div>

            <div className={styles.acceptance}>
              <span className={styles.sectionKicker}>Where it stands</span>
              <ol>
                <li><Check size={13} /><span><strong>Its own interface</strong> Opens from Hivra, signed in, with a real model answering.</span></li>
                <li><Check size={13} /><span><strong>Your model key</strong> Delivered to its computer, never shown back in your browser.</span></li>
                <li><Check size={13} /><span><strong>Restart and remove</strong> Comes back after a restart, and removes cleanly.</span></li>
                <li data-pending="true"><span className={styles.pendingRing} /><span><strong>Working with other agents</strong> Still being finished.</span></li>
              </ol>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
