// /dashboard/agent-setup/<code>: the person's side of "set up from a coding
// agent". Their coding agent gave them this link and a code. They check the
// code, press Continue, and land on Launch with the agent preselected; the
// coding agent's poll then follows the launch. Off unless
// HIVRA_AGENT_SETUP_HANDSHAKE is on.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  SETUP_AGENT_IDS,
  displaySetupCode,
  parseSetupCode,
  setupAgentName,
  setupClaimUsable,
  type SetupAgentId,
  type SetupRow,
} from "@/lib/agent-setup/core";
import { agentSetupHandshakeEnabled } from "@/lib/agent-setup/flag";
import { findSetupByCode } from "@/lib/agent-setup/store";
import ContinueSetupButton from "./ContinueSetupButton";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up from your coding agent",
  robots: { index: false, follow: false },
};

type View = { kind: "open"; row: SetupRow } | { kind: "gone" } | { kind: "unavailable" };

async function loadView(code: string, userId: string): Promise<View> {
  let row: SetupRow | null;
  try {
    row = await findSetupByCode(code);
  } catch {
    return { kind: "unavailable" };
  }
  if (!row) return { kind: "gone" };
  if (row.user_id && !setupClaimUsable(row, userId)) return { kind: "gone" };
  if (!row.user_id && Date.now() > Date.parse(row.expires_at)) return { kind: "gone" };
  return { kind: "open", row };
}

const isSetupAgent = (value: string | null): value is SetupAgentId => (SETUP_AGENT_IDS as readonly string[]).includes(value ?? "");

export default async function AgentSetupPage({ params }: { params: Promise<{ code: string }> }) {
  if (!agentSetupHandshakeEnabled()) notFound();
  const { code: rawCode } = await params;
  const code = parseSetupCode(rawCode);
  if (!code) notFound();
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/dashboard/agent-setup/${code}`)}`);

  const view = await loadView(code, userId);

  if (view.kind !== "open") {
    return (
      <main className={styles.page}>
        <section className={styles.card}>
          <span className={styles.eyebrow}>Set up from your coding agent</span>
          <h1>{view.kind === "gone" ? "This setup link has expired" : "Hivra couldn't open this setup"}</h1>
          <p>
            {view.kind === "gone"
              ? "Ask your coding agent to start again. It will give you a new link and code."
              : "Try again in a moment, or launch your agent yourself."}
          </p>
          <div className={styles.actions}>
            <Link className={styles.secondary} href="/dashboard/launch?kind=agent&start=1">Go to Launch</Link>
          </div>
        </section>
      </main>
    );
  }

  const { row } = view;
  const client = row.client?.trim() || "Your coding agent";
  const agentName = isSetupAgent(row.agent) ? setupAgentName(row.agent) : null;
  const modelLine = row.inference === "venice"
    ? "It will use Hivra credits for its AI model, so there is nothing to set up."
    : row.inference === "venice-key"
      ? "You'll paste your own Venice API key on the next screen."
      : "You'll choose how it gets its AI model on the next screen.";

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="agent-setup-title">
        <span className={styles.eyebrow}>Set up from your coding agent</span>
        <h1 id="agent-setup-title">
          {client} wants to set up {agentName ?? "an agent"} for you
        </h1>
        <p>
          {agentName ? `${agentName} gets a cloud computer of its own and keeps running when your laptop is closed. ` : "Pick an agent on the next screen. It gets a cloud computer of its own. "}
          {modelLine}
        </p>
        <div className={styles.code}>
          <span>Check this code matches the one {client} showed you</span>
          <strong>{displaySetupCode(row.code)}</strong>
        </div>
        <div className={styles.actions}>
          <ContinueSetupButton code={row.code} />
          <Link className={styles.secondary} href="/dashboard">Cancel</Link>
        </div>
        <p className={styles.note}>
          Only continue if you asked your own coding agent to do this. You still choose everything and press Launch yourself.{" "}
          {client} only learns whether your new agent is running, and its link.
        </p>
      </section>
    </main>
  );
}
