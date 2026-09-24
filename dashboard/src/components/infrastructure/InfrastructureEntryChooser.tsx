"use client";

import { ArrowLeft, ArrowRight, Bot, Cloud, ExternalLink, Server, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { HivraCloudCapacityDto } from "@/lib/infrastructure/hivra-cloud-client";
import { PLANS } from "@/lib/subscription/plans";
import styles from "./Infrastructure.module.css";

type Path = "choose" | "cloud" | "machine" | "remote" | "local";

/** The Free plan's Hivra Cloud allowance, from the plan definition. */
const FREE_CAPACITY = `${PLANS.free.totalCpu} CPU and ${PLANS.free.totalRam >= 1024 ? `${PLANS.free.totalRam / 1024} GB` : `${PLANS.free.totalRam} MB`}`;

export function InfrastructureEntryChooser({
  firstConnection, hivraCloud, selfHosted, onChooseHivraCloud, onConnectHetzner, onConnectDigitalOcean, onConnectExisting,
}: {
  firstConnection: boolean;
  hivraCloud: HivraCloudCapacityDto | null;
  selfHosted: boolean;
  onChooseHivraCloud: () => void;
  onConnectHetzner: () => void;
  onConnectDigitalOcean?: () => void;
  onConnectExisting: () => void;
}) {
  const [path, setPath] = useState<Path>("choose");
  const [remoteOrigin, setRemoteOrigin] = useState<"cloud" | "machine">("machine");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPath = useRef(path);
  useEffect(() => {
    if (previousPath.current !== path) headingRef.current?.focus();
    previousPath.current = path;
  }, [path]);
  const title = path === "choose" ? "How would you like to add capacity?"
    : path === "cloud" ? "Which cloud account do you use?"
      : path === "machine" ? "Where is your machine?"
        : path === "local" ? "Connect a machine on your network" : "Connect an existing server";
  const back = () => setPath(path === "remote" ? remoteOrigin : path === "local" ? "machine" : "choose");

  return (
    <section id="infrastructure-entry-options" className={styles.entryChooser} aria-labelledby="infrastructure-entry-heading">
      <div className={styles.guidedHeading}>
        <div>
          <span className={styles.eyebrow}>{firstConnection ? "First setup" : "Add capacity"}</span>
          <h2 ref={headingRef} id="infrastructure-entry-heading" tabIndex={-1}>{title}</h2>
        </div>
        {path !== "choose" && <button type="button" className={styles.tertiaryButton} onClick={back}><ArrowLeft size={14} aria-hidden="true" /> Back</button>}
      </div>
      {path === "choose" ? (
        <div className={styles.guidedChoices}>
          <article className={`${styles.guidedChoice} ${styles.guidedRecommended}`}>
            <Cloud size={22} aria-hidden="true" />
            <span className={styles.sectionLabel}>Managed by Hivra</span>
            <h3>Let Hivra host it</h3>
            <p>{selfHosted
              ? "Use the separate hosted Hivra service. Your self-hosted installation stays independent."
              : hivraCloud?.paid
                ? "Hivra runs and maintains the servers your plan uses."
                : `Start free: ${FREE_CAPACITY} of Hivra Cloud, enough for one small agent. Hivra runs and maintains the servers.`}</p>
            {selfHosted ? <a className={styles.primaryButton} href="https://hivra.cloud/dashboard/infrastructure" target="_blank" rel="noreferrer">Open Hivra Cloud <ExternalLink size={14} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span></a>
              : hivraCloud?.paid ? <Link className={styles.primaryButton} href="/dashboard/billing">Manage Hivra Cloud <ArrowRight size={14} aria-hidden="true" /></Link>
                : <button type="button" className={styles.primaryButton} onClick={onChooseHivraCloud}>Choose Hivra Cloud <ArrowRight size={14} aria-hidden="true" /></button>}
            <small>{hivraCloud?.paid ? `${hivraCloud.plan?.name ?? "Your plan"} is active. Review plan options in Billing.` : "Free needs no card. Paid plans show their price before payment."}</small>
          </article>
          <article className={styles.guidedChoice}>
            <Cloud size={22} aria-hidden="true" />
            <span className={styles.sectionLabel}>Your provider, your bill</span>
            <h3>Use my cloud account</h3>
            <p>{onConnectDigitalOcean
              ? "Connect Hetzner or DigitalOcean Managed Agents directly, or connect a Linux server from any other provider."
              : "Connect Hetzner directly, or connect an existing Linux server from another provider."}</p>
            <button type="button" className={styles.secondaryButton} onClick={() => setPath("cloud")}>Choose cloud provider <ArrowRight size={14} aria-hidden="true" /></button>
            <small>Connecting does not buy a server.</small>
          </article>
          <article className={styles.guidedChoice}>
            <Server size={22} aria-hidden="true" />
            <span className={styles.sectionLabel}>Hardware you control</span>
            <h3>Connect my own machine</h3>
            <p>Use a compatible Linux machine at home, in your office, or in a data centre.</p>
            <button type="button" className={styles.secondaryButton} onClick={() => setPath("machine")}>Choose my machine <ArrowRight size={14} aria-hidden="true" /></button>
            <small>Availability depends on its network and capabilities.</small>
          </article>
        </div>
      ) : path === "cloud" ? (
        <div className={onConnectDigitalOcean ? styles.guidedChoices : styles.guidedChoicesTwo}>
          <article className={styles.guidedChoice}>
            <span className={styles.sectionLabel}>Direct provider connection</span><h3>Hetzner Cloud</h3>
            <p>Connect a project token, see your servers, and review live prices before creating capacity.</p>
            <button type="button" className={styles.primaryButton} onClick={onConnectHetzner}>Start with Hetzner <ArrowRight size={14} aria-hidden="true" /></button>
            <small>Requires a Read &amp; Write project token. Purchases need a separate confirmation.</small>
            <a href="https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/" target="_blank" rel="noreferrer">API token guide <ExternalLink size={12} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span></a>
          </article>
          {onConnectDigitalOcean ? (
            <article className={styles.guidedChoice}>
              <Bot size={22} aria-hidden="true" />
              <span className={styles.sectionLabel}>Managed agent sessions</span><h3>DigitalOcean Managed Agents</h3>
              <p>Run Claude Code, Codex, or Hermes in DigitalOcean’s managed sandboxes and chat with them here. No server to set up and no terminal.</p>
              <button type="button" className={styles.primaryButton} onClick={onConnectDigitalOcean}>Start with DigitalOcean <ArrowRight size={14} aria-hidden="true" /></button>
              <small>Requires a write-scope API token and a team in the Managed Agents preview. Launches are separate, confirmed steps.</small>
            </article>
          ) : null}
          <article className={styles.guidedChoice}>
            <span className={styles.sectionLabel}>Connect over SSH</span><h3>Another provider or existing server</h3>
            <p>A Droplet, EC2 instance, or VM from AWS, Google Cloud, Azure, DigitalOcean, OVHcloud, or any other provider: create a Linux server there, then connect it here.</p>
            <button type="button" className={styles.secondaryButton} onClick={() => { setRemoteOrigin("cloud"); setPath("remote"); }}>Use an existing server <ArrowRight size={14} aria-hidden="true" /></button>
            <small>This uses SSH inspection, not a provider API. Hivra checks what the server can actually run.</small>
          </article>
        </div>
      ) : path === "machine" ? (
        <div className={styles.guidedChoicesTwo}>
          <article className={styles.guidedChoice}><Server size={22} aria-hidden="true" /><h3>At home or in my office</h3><p>A machine on your local network. Network access depends on where your Hivra installation runs.</p><button type="button" className={styles.secondaryButton} onClick={() => setPath("local")}>On my local network <ArrowRight size={14} aria-hidden="true" /></button></article>
          <article className={styles.guidedChoice}><Cloud size={22} aria-hidden="true" /><h3>A remote server</h3><p>A rented server, bare-metal machine, or existing Proxmox host with reachable SSH access.</p><button type="button" className={styles.secondaryButton} onClick={() => { setRemoteOrigin("machine"); setPath("remote"); }}>Remote server <ArrowRight size={14} aria-hidden="true" /></button></article>
        </div>
      ) : (
        <div className={styles.guidedPreparation}>
          {path === "local" && <div className={styles.providerSafetyNote}><ShieldCheck size={19} aria-hidden="true" /><div><strong>{selfHosted ? "Your Hivra server must be able to reach this machine." : "Hosted Hivra cannot connect to your local network."}</strong><span>{selfHosted ? "Private network connections require the self-hosted operator’s explicit network opt-in. A localhost address refers to the Hivra server, not the computer running this browser." : "A home IP such as 192.168.x.x or localhost is not reachable from hosted Hivra. Use a self-hosted Hivra installation on your network with private networking explicitly enabled, or connect a reachable remote server."}</span></div></div>}
          {path === "local" && selfHosted ? (
            <details className={styles.hostSupportDisclosure}>
              <summary>Set up local network access</summary>
              <p>Ask the operator of your self-hosted Hivra server to set <code>HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS=true</code> in that server’s environment and restart Hivra with the setting applied. This explicitly permits connections to private network addresses.</p>
              <p>Enter the machine’s LAN IP or hostname that the Hivra server can reach. Do not use localhost or a loopback address. The machine must accept SSH connections from the Hivra server; this setting does not create a network connection or change your firewall.</p>
            </details>
          ) : null}
          <h3>Before you connect</h3>
          <ol className={styles.guidedChecklist}>
            <li><strong>A Linux server.</strong> Hivra checks what it can run without changing it.</li>
            <li><strong>Its address and SSH key.</strong> Find the hostname or IP in your provider or machine settings. Have a key file ready that already lets you sign in.</li>
            <li><strong>A way to verify its identity.</strong> Open the server’s trusted console. The next step shows how to check its fingerprint so Hivra connects to the right machine.</li>
          </ol>
          <details className={styles.hostSupportDisclosure}>
            <summary>What can this machine run?</summary>
            <p>Existing Proxmox/KVM can run hardware VMs after readiness checks. Compatible Ubuntu amd64 with root access and cgroup v2 can be prepared for Linux terminal and Python sandboxes; these do not provide a desktop or Windows.</p>
            <p>Proxmox manages the host; KVM provides the hardware-VM isolation boundary. A cloud VM needs nested KVM to host hardware VMs. Linux sandboxes use gVisor’s application-kernel boundary, not a hardware VM. Connecting does not guarantee compatibility.</p>
          </details>
          <p>Preparation and launch are separate steps you approve after inspection.</p>
          <div className={styles.entryActions}>
            {path !== "local" || selfHosted ? <button type="button" className={styles.primaryButton} onClick={onConnectExisting}>Connect existing host <ArrowRight size={14} aria-hidden="true" /></button> : <button type="button" className={styles.secondaryButton} onClick={() => { setRemoteOrigin("machine"); setPath("remote"); }}>Use a remote server instead <ArrowRight size={14} aria-hidden="true" /></button>}
          </div>
        </div>
      )}
      <p className={styles.guidedFootnote}>Where your agents run doesn’t change who operates Hivra. Connecting, setup, payment, and launch are each their own step.</p>
    </section>
  );
}
