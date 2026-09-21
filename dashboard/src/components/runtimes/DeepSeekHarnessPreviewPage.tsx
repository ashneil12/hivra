import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Cpu,
  KeyRound,
  MemoryStick,
  Network,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { getHivraPreview } from "@/lib/hivra/preview-catalog";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";

import styles from "./DeepSeekHarnessPreviewPage.module.css";

const runtime = getAgent("deepseek-harness");
const preview = getHivraPreview("deepseek-harness");

const SURFACES = [
  {
    icon: SquareTerminal,
    title: "Native interface",
    state: "Live Canary proof",
    body: "Hivra preserves the Harness Web UI at its native root. The authenticated interface and a real model-backed session passed through public TLS on a disposable computer.",
  },
  {
    icon: Network,
    title: "ACP orchestration",
    state: "Still gated",
    body: "The upstream ACP profile remains the final runtime-specific orchestration gate; Web UI and PTY success do not substitute for an ACP exchange.",
  },
  {
    icon: KeyRound,
    title: "Bring your model key",
    state: "Live delivery proven",
    body: "A claim-bound computer received the model setting only after proving the exact runtime capability; the credential was not returned to the browser and was removed with the disposable run.",
  },
] as const;

export function DeepSeekHarnessPreviewPage() {
  if (!runtime || !preview) return null;

  return (
    <main className={styles.page}>
      <div className={styles.gridBackdrop} aria-hidden="true" />
      <div className={styles.inner}>
        <Link className={styles.breadcrumb} href="/dashboard/welcome?step=agent-type">
          <ArrowLeft size={13} /> Agent catalog <span>/ DeepSeek Harness</span>
        </Link>

        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}><SquareTerminal size={14} /> Experimental runtime</span>
            <h1>DeepSeek Harness, <em>without pretending.</em></h1>
            <p>
              The pinned runtime, native gateway, provider installer, and disposable user journey now work.
              Public launch stays closed until the upstream ACP profile passes the same exact-revision gate.
            </p>
          </div>
          <div className={styles.headerState}>
            <span>Catalog state</span>
            <strong><i /> Private preview</strong>
          </div>
        </header>

        <section className={styles.runtime} aria-labelledby="deepseek-title">
          <div className={styles.runtimeLead}>
            <div className={styles.runtimeIdentity}>
              <span className={styles.mark}>D.</span>
              <div>
                <span className={styles.previewLabel}>Official package · isolated runtime</span>
                <h2 id="deepseek-title">{runtime.name}</h2>
                <p>{preview.summary}</p>
              </div>
            </div>
            <a className={styles.upstream} href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">
              View upstream <ArrowUpRight size={13} />
            </a>
          </div>

          <div className={styles.requirements} aria-label="DeepSeek Harness runtime requirements">
            <div><Cpu size={14} /><span>CPU floor</span><strong>{runtime.floor?.cpu} vCPU</strong></div>
            <div><MemoryStick size={14} /><span>Memory floor</span><strong>{runtime.floor?.ram} GB</strong></div>
            <div><SquareTerminal size={14} /><span>Package</span><strong>DSH 0.1.2-alpha.2</strong></div>
            <div><ShieldCheck size={14} /><span>Provisioner</span><strong>{PORTABLE_HIVRA_PROVISIONER_VERSION}</strong></div>
          </div>

          <div className={styles.runtimeBody}>
            <div className={styles.contract}>
              <span className={styles.sectionKicker}>What is implemented</span>
              <h3>The real runtime is wired; release evidence is the gate.</h3>
              <p>
                DeepSeek Harness runs as its own non-root, lifecycle-owned service inside a Hivra computer.
                Its native surface is protected by an authenticated, claim-bound gateway. The current provider-native
                and Proxmox paths validate exact runtime identity before model settings can be delivered.
              </p>
              <dl>
                <div><dt>Package</dt><dd>@deepseek-ai/dsh@0.1.2-alpha.2</dd></div>
                <div><dt>Source revision</dt><dd>0a53fb55bea1</dd></div>
                <div><dt>Surface auth</dt><dd>post-cookie-v1</dd></div>
                <div><dt>Computer boundary</dt><dd>Owned VM / provider VM</dd></div>
              </dl>
              <div className={styles.truthNotice}>
                <ShieldCheck size={16} />
                <p>
                  <strong>No launch button yet.</strong> A disposable Canary computer passed native UI, real reply,
                  shell/PTY, restart, fresh-cookie access, revocation, and exact cleanup. ACP remains unverified, so
                  Hivra keeps the public catalog gate closed.
                </p>
              </div>
              <Link className={styles.primary} href="/dashboard/infrastructure">
                Inspect computer capacity <ArrowUpRight size={13} />
              </Link>
            </div>

            <div className={styles.acceptance}>
              <span className={styles.sectionKicker}>Release gate</span>
              <ol>
                <li><Check size={13} /><span><strong>Pinned package closure</strong> Exact dependency integrity and non-root service composition.</span></li>
                <li><Check size={13} /><span><strong>Owned lifecycle</strong> Claim-bound install, restart, cancellation, and teardown operations.</span></li>
                <li><Check size={13} /><span><strong>Native UI + real model</strong> Public TLS, fresh authenticated cookie, model-backed session, commands, and non-root PTY.</span></li>
                <li><Check size={13} /><span><strong>Restart, revoke, clean</strong> New boot, fresh access, retained runtime state, terminated old access, and zero owned survivors.</span></li>
                <li data-pending="true"><span className={styles.pendingRing} /><span><strong>ACP orchestration</strong> Complete one real automation exchange through the pinned upstream ACP profile.</span></li>
              </ol>
            </div>
          </div>
        </section>

        <section className={styles.surfaces} aria-labelledby="surface-heading">
          <div className={styles.surfacesIntro}>
            <span className={styles.eyebrow}><Network size={14} /> Runtime surfaces</span>
            <h2 id="surface-heading">Keep the interface that makes it useful.</h2>
            <p>Hivra supplies identity, isolation, access, and lifecycle control around the upstream experience.</p>
          </div>
          <div className={styles.surfaceGrid}>
            {SURFACES.map(({ icon: Icon, ...surface }) => (
              <article key={surface.title}>
                <Icon size={17} />
                <h3>{surface.title}</h3>
                <strong>{surface.state}</strong>
                <p>{surface.body}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
