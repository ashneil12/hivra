"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getHomeConnectorStatus,
  startHomeConnector,
  type HomeConnectorEnrolmentDto,
} from "@/lib/infrastructure/home-connector-client";

import { CopyButton } from "./CopyButton";
import styles from "./Infrastructure.module.css";
import enrollmentStyles from "./ServerEnrollment.module.css";

const POLL_MS = 3_000;

/**
 * Hosted Hivra cannot dial into a home network. This installs a small
 * connector on the machine that dials out to Hivra instead, so nothing on the
 * router changes. Shown only when the server reports the feature is on.
 */
export function HomeConnectorInstall({ onContinue }: { onContinue: (hostname: string) => void }) {
  const [enrolment, setEnrolment] = useState<HomeConnectorEnrolmentDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      setEnrolment(await startHomeConnector());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Hivra could not start connecting a machine.");
    } finally {
      setStarting(false);
    }
  }

  const connectorId = enrolment?.connectorId ?? null;
  useEffect(() => {
    if (!connectorId || online) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      const status = await getHomeConnectorStatus(connectorId, controller.signal);
      if (status?.online) setOnline(true);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [connectorId, online]);

  return (
    <div className={styles.providerSafetyNote}>
      <ShieldCheck size={19} aria-hidden="true" />
      <div>
        <strong>Connect it with one command. Nothing on your router changes.</strong>
        <span>
          Your machine dials out to Hivra. Hivra never connects into your network. You can disconnect it any time by removing the connection.
        </span>
        {!enrolment ? (
          <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={starting}>
            {starting ? "Getting your command…" : "Get my install command"} <ArrowRight size={14} aria-hidden="true" />
          </button>
        ) : online ? (
          <>
            <p className={enrollmentStyles.lead}>Your machine is connected.</p>
            <button type="button" className={styles.primaryButton} onClick={() => onContinue(enrolment.hostname)}>
              Continue <ArrowRight size={14} aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <p className={enrollmentStyles.lead}>Run this on the machine, in a terminal where you can use sudo:</p>
            <div className={enrollmentStyles.commandRow}>
              <code className={enrollmentStyles.command} data-testid="home-connector-command">{enrolment.command}</code>
              <CopyButton value={enrolment.command} label="Copy the install command" />
            </div>
            <p className={enrollmentStyles.meta}>
              Works once and expires in 15 minutes. Waiting for your machine…{" "}
              <button type="button" className={enrollmentStyles.linkButton} onClick={() => void start()} disabled={starting}>
                Get a new command
              </button>
            </p>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </div>
  );
}
