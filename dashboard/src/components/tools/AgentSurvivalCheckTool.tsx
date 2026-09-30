"use client";

// Agent Survival Check (/tools/agent-survival-check).
//
// Nine questions about where and how an agent runs, mapped to concrete
// failure modes (lid-close suspend, SSH SIGHUP, OOM kill, reboot without
// autostart, network drops, a long run on a managed computer that is not in
// tmux). Output is a 0-100 survival score, a ranked list of the ways this exact
// setup dies, free fixes first, then the CTA. All state is client side; nothing
// is sent anywhere.
//
// Managed computers are not magic, and the copy only promises what holds on
// every Hivra computer (lib/blog/runtime-facts.ts): the computer stays on, and a
// run started inside tmux in its Terminal tab, or on Claude Code one sent
// through Telegram, keeps going. Whether a browser chat or session-tab run
// outlives a closed tab depends on the computer's runtime version, so the copy
// says neither that it stops nor that it keeps going.

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

// Commands and behavior checked on 2026-09-24 against first-party docs: the
// macOS caffeinate(8) manual, Apple's closed-display mode support article,
// OpenSSH ssh_config(5), tmux(1), the systemd logind.conf and systemd.service
// manuals, and util-linux swapon(8)/mkswap(8). Update lastVerified only when
// they are re-checked.
const DEFAULTS = {
  lastVerified: "2026-09-24",
  minutesToRestore: 20,
  hourlyRateUsd: 60,
} as const;

const SHARE_URL = "https://hivra.cloud/tools/agent-survival-check";

type RunsOn = "laptop" | "desktop" | "vps" | "managed";
type Multiplexer = "none" | "tmux" | "screen" | "nohup";
type SleepBehavior = "sleeps" | "kept_awake" | "not_laptop";
type SshAccess = "not_ssh" | "default" | "keepalive";
type AutoRestart = "none" | "manual" | "systemd";
type Reboots = "auto" | "manual" | "unknown";
type Ram = "low" | "mid" | "high";
type NetworkQuality = "wired" | "wifi_ok" | "flaky";
type Checkin = "none" | "laptop_ssh" | "phone_ssh" | "web";

interface FailureMode {
  id: string;
  title: string;
  /** Points deducted from the survival score. */
  severity: number;
  /** Rough interruptions per week this mode causes, for the cost line. */
  perWeek: number;
  scenario: string;
  fix: string;
  snippet?: string;
}

const TMUX_SNIPPET = `tmux new -s agent
claude
# detach: Ctrl-b then d
# reattach: tmux attach -t agent`;

const SYSTEMD_SNIPPET = `# /etc/systemd/system/agent.service
[Unit]
Description=Agent tmux session
After=network-online.target

[Service]
Type=forking
User=you
ExecStart=/usr/bin/tmux new-session -d -s agent claude
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target`;

// dd from /dev/zero is the portable way util-linux documents; a preallocated
// fallocate file can be rejected by swapon on some filesystems.
const SWAP_SNIPPET = `sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile`;

function buildFailureModes(a: {
  runsOn: RunsOn;
  multiplexer: Multiplexer;
  sleep: SleepBehavior;
  ssh: SshAccess;
  autoRestart: AutoRestart;
  reboots: Reboots;
  ram: Ram;
  network: NetworkQuality;
  checkin: Checkin;
}): FailureMode[] {
  const modes: FailureMode[] = [];
  const managed = a.runsOn === "managed";
  const overSsh = a.ssh !== "not_ssh" && !managed;

  if (a.runsOn === "laptop" && a.sleep === "sleeps") {
    modes.push({
      id: "lid_sleep",
      title: "Lid close suspends the machine",
      severity: 35,
      perWeek: 5,
      scenario:
        "You close the lid at 11pm. The OS suspends every process mid tool call, network sockets die, and the run makes no progress until morning. There is no error to tell you.",
      fix:
        "Free fix: keep the machine awake while the agent runs. On macOS, caffeinate blocks sleep while it runs, full system sleep only on AC power, and closing a MacBook lid still sleeps it unless you set up closed-display mode with an external display. On Linux, set HandleLidSwitch=ignore in /etc/systemd/logind.conf. Honest tradeoff: battery drain, heat, and a laptop you cannot close or carry.",
      snippet: "caffeinate -dimsu",
    });
  }

  if (a.runsOn === "laptop" && a.sleep === "kept_awake") {
    modes.push({
      id: "awake_laptop",
      title: "An awake laptop is still a laptop",
      severity: 10,
      perWeek: 1,
      scenario:
        "The machine stays awake until the battery dips, an OS update forces a restart, or you pick it up and leave. Any of those ends the run.",
      fix:
        "Free fix: keep it plugged in and defer OS updates while a run is active. Honest tradeoff: this is a stopgap. You have turned a portable computer into a bad server.",
    });
  }

  if (managed && a.multiplexer === "none") {
    modes.push({
      id: "managed_untracked_run",
      title: "Long runs are not in tmux",
      severity: 15,
      perWeek: 2,
      scenario:
        "The computer stays on, but nothing you control is holding this run. Whether a run started in a browser chat or web terminal outlives a closed tab depends on the provider and the version it runs, so a long run should not rest on it. Your files, sessions and login are still on the computer when you come back.",
      fix:
        "Free fix: start long runs inside tmux in the computer's own terminal (on Hivra, the Terminal tab under Computer), or, on Claude Code, send them from Telegram after connecting a bot in the agent's Telegram tab. A run inside tmux, or one sent from Telegram, keeps going after you close the laptop.",
      snippet: TMUX_SNIPPET,
    });
  }

  if (overSsh && a.multiplexer === "none") {
    modes.push({
      id: "ssh_hup",
      title: "SSH drop sends SIGHUP",
      severity: 25,
      perWeek: 3,
      scenario:
        "Your connection blips for ten seconds. The SSH session closes, the shell sends SIGHUP to its children, and the agent dies mid run.",
      fix:
        "Free fix: run the agent inside tmux. The session detaches from your terminal, so a dropped connection leaves it running and you reattach later. This one is fully solved by tmux on an always-on machine.",
      snippet: TMUX_SNIPPET,
    });
  }

  if (overSsh && a.multiplexer === "nohup") {
    modes.push({
      id: "nohup_stall",
      title: "nohup survives, then stalls",
      severity: 15,
      perWeek: 2,
      scenario:
        "nohup keeps the process alive through a disconnect, but Claude Code is interactive. The next permission prompt sits unanswered and the run stalls until you notice.",
      fix: "Free fix: use tmux instead of nohup. You get the same survival plus a live terminal you can reattach to and answer prompts in.",
      snippet: TMUX_SNIPPET,
    });
  }

  if (overSsh && a.ssh === "default") {
    modes.push({
      id: "keepalive",
      title: "Idle SSH connections get dropped",
      severity: 8,
      perWeek: 2,
      scenario:
        "You watch the agent work without typing. A NAT router or firewall decides the quiet connection is dead and drops it after a few minutes. Without tmux that kills the run; with tmux it still costs you a reconnect.",
      fix: "Free fix: turn on client keepalives so the connection never looks idle.",
      snippet: `# ~/.ssh/config
Host *
  ServerAliveInterval 60
  ServerAliveCountMax 3`,
    });
  }

  if (!managed && a.autoRestart !== "systemd") {
    modes.push({
      id: "crash_no_restart",
      title: "A crash is permanent",
      severity: a.autoRestart === "none" ? 15 : 10,
      perWeek: 1,
      scenario:
        "The agent hits an unhandled error at 2am and exits. Nothing notices and nothing restarts it. The server is fine; the process is just gone.",
      fix:
        "Free fix: a systemd unit that starts the agent in a detached tmux session and restarts it on failure. Replace User=you with your username, then run: sudo systemctl enable --now agent. Honest tradeoff: it restarts a fresh session, not your conversation. Whatever context the run had is gone.",
      snippet: SYSTEMD_SNIPPET,
    });
  }

  if (!managed && a.reboots !== "manual" && a.autoRestart !== "systemd") {
    modes.push({
      id: "reboot_no_autostart",
      title: "Reboot comes back empty",
      severity: a.reboots === "auto" ? 15 : 10,
      perWeek: 0.5,
      scenario:
        "unattended-upgrades reboots the server at 4am for a kernel patch. The machine comes back up clean. The agent does not, because nothing starts it at boot.",
      fix: "Free fix: the same systemd unit covers this. WantedBy=multi-user.target makes it start at boot, so a reboot brings the agent back on its own.",
      snippet: "sudo systemctl enable agent.service",
    });
  }

  if (!managed && a.ram !== "high") {
    modes.push({
      id: "oom_kill",
      title: "OOM killer picks the agent",
      severity: a.ram === "low" ? 15 : 8,
      perWeek: a.ram === "low" ? 1.5 : 0.5,
      scenario:
        a.ram === "low"
          ? "A build step spikes memory on a 1 GB server. The kernel is out of RAM, the OOM killer picks the biggest process, and that is the agent."
          : "Most days 2 to 4 GB is fine. Then the agent runs a test suite next to a dev server and the kernel starts killing things.",
      fix: "Free fix: add a swap file so spikes hit slow disk instead of the OOM killer. Honest tradeoff: swap buys headroom, it does not fix a server that is too small for the workload.",
      snippet: SWAP_SNIPPET,
    });
  }

  if (!managed && a.network !== "wired") {
    modes.push({
      id: "network_drop",
      title: a.network === "flaky" ? "Flaky network kills long calls" : "Wifi drops cost you runs",
      severity: a.network === "flaky" ? 15 : 6,
      perWeek: a.network === "flaky" ? 3 : 1,
      scenario:
        "The wifi drops for two minutes mid tool call. The API request times out, and if you were attached over SSH, that session went down with it.",
      fix: "Free fix: plug into ethernet, or move the run onto a machine with a wired or datacenter connection. Honest answer: there is no config flag that fixes a bad link. tmux limits the damage to the one interrupted call.",
    });
  }

  if (a.checkin === "none") {
    modes.push({
      id: "blind_overnight",
      title: "Failures go unnoticed for hours",
      severity: 8,
      perWeek: 1,
      scenario:
        "The run died at midnight. You find out at 9am. The failure cost you the whole night, not the ten minutes the fix would have taken.",
      fix: "Free fix: an SSH client on your phone plus tmux attach lets you check and restart from anywhere. Honest tradeoff: a phone terminal is a rough place to read diffs.",
      snippet: "tmux attach -t agent",
    });
  }

  return modes.sort((x, y) => y.severity - x.severity);
}

function scoreTone(score: number): { text: string | undefined; fill: string | undefined } {
  if (score >= 80) return { text: styles.toneGood, fill: styles.segInk };
  if (score >= 50) return { text: styles.toneWarn, fill: styles.segMid };
  return { text: styles.toneBad, fill: styles.segAccent };
}

function verdictLabel(score: number): string {
  if (score >= 90) return "Survives the night";
  if (score >= 70) return "Survives, with weak spots";
  if (score >= 40) return "Dies within the week";
  return "Does not survive tonight";
}

interface RadioOption<T extends string> {
  value: T;
  label: string;
}

function RadioGroup<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.radios}>
        {options.map((opt) => (
          <label key={opt.value} className={styles.radio} data-checked={value === opt.value}>
            <input type="radio" name={name} checked={value === opt.value} onChange={() => onChange(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function AgentSurvivalCheckTool() {
  const [runsOn, setRunsOn] = useState<RunsOn>("laptop");
  const [multiplexer, setMultiplexer] = useState<Multiplexer>("none");
  const [sleep, setSleep] = useState<SleepBehavior>("sleeps");
  const [ssh, setSsh] = useState<SshAccess>("not_ssh");
  const [autoRestart, setAutoRestart] = useState<AutoRestart>("none");
  const [reboots, setReboots] = useState<Reboots>("unknown");
  const [ram, setRam] = useState<Ram>("high");
  const [network, setNetwork] = useState<NetworkQuality>("wifi_ok");
  const [checkin, setCheckin] = useState<Checkin>("none");

  const [interruptionsInput, setInterruptionsInput] = useState("");
  const [minutesToRestore, setMinutesToRestore] = useState<number>(DEFAULTS.minutesToRestore);
  const [hourlyRate, setHourlyRate] = useState<number>(DEFAULTS.hourlyRateUsd);
  const [copied, setCopied] = useState(false);

  const modes = buildFailureModes({ runsOn, multiplexer, sleep, ssh, autoRestart, reboots, ram, network, checkin });

  const score = Math.max(0, Math.min(100, 100 - modes.reduce((sum, m) => sum + m.severity, 0)));
  const verdict = verdictLabel(score);
  const tone = scoreTone(score);

  const estimatedPerWeek = Math.round(modes.reduce((sum, m) => sum + m.perWeek, 0) * 10) / 10;
  const interruptions = interruptionsInput.trim() === "" ? estimatedPerWeek : Math.max(0, Number(interruptionsInput) || 0);
  const weeklyCost = interruptions * (minutesToRestore / 60) * hourlyRate;

  const topThree = modes.slice(0, 3);
  const shareText = [
    `Agent Survival Check: ${score}/100 (${verdict})`,
    ...(topThree.length > 0 ? ["Top failure modes:", ...topThree.map((m, i) => `${i + 1}. ${m.title}`)] : ["No structural failure modes found."]),
    SHARE_URL,
  ].join("\n");

  const copyVerdict = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the text is visible below and can be selected.
    }
  };

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <RadioGroup
          name="asc-runs-on"
          label="Where does the agent run?"
          value={runsOn}
          onChange={setRunsOn}
          options={[
            { value: "laptop", label: "My laptop" },
            { value: "desktop", label: "A desktop or home server that stays on" },
            { value: "vps", label: "A raw VPS or cloud VM I manage" },
            { value: "managed", label: "A managed always-on computer (Hivra or similar)" },
          ]}
        />
        <RadioGroup
          name="asc-multiplexer"
          label="How does the session stay alive?"
          value={multiplexer}
          onChange={setMultiplexer}
          options={[
            { value: "none", label: "Plain terminal, nothing else" },
            { value: "tmux", label: "tmux" },
            { value: "screen", label: "screen" },
            { value: "nohup", label: "nohup or a & background job" },
          ]}
        />
        <RadioGroup
          name="asc-sleep"
          label="Laptop sleep behavior"
          value={sleep}
          onChange={setSleep}
          options={[
            { value: "sleeps", label: "It sleeps on lid close or idle" },
            { value: "kept_awake", label: "Sleep is off, or I run caffeinate" },
            { value: "not_laptop", label: "Not a laptop" },
          ]}
        />
        <RadioGroup
          name="asc-ssh"
          label="Do you reach it over SSH?"
          value={ssh}
          onChange={setSsh}
          options={[
            { value: "not_ssh", label: "No, it runs where I sit" },
            { value: "default", label: "Yes, default SSH config" },
            { value: "keepalive", label: "Yes, with keepalives configured" },
          ]}
        />
        <RadioGroup
          name="asc-restart"
          label="What restarts it after a crash?"
          value={autoRestart}
          onChange={setAutoRestart}
          options={[
            { value: "none", label: "Nothing" },
            { value: "manual", label: "Me, when I notice" },
            { value: "systemd", label: "systemd or a supervisor" },
          ]}
        />
        <RadioGroup
          name="asc-reboots"
          label="Reboots and updates on that machine"
          value={reboots}
          onChange={setReboots}
          options={[
            { value: "auto", label: "Automatic updates can reboot it" },
            { value: "manual", label: "I control reboots, they are rare" },
            { value: "unknown", label: "No idea" },
          ]}
        />
        <RadioGroup
          name="asc-ram"
          label="RAM where the agent runs"
          value={ram}
          onChange={setRam}
          options={[
            { value: "low", label: "1 GB or less" },
            { value: "mid", label: "2 to 4 GB" },
            { value: "high", label: "8 GB or more" },
          ]}
        />
        <RadioGroup
          name="asc-network"
          label="Network where the agent runs"
          value={network}
          onChange={setNetwork}
          options={[
            { value: "wired", label: "Wired or datacenter" },
            { value: "wifi_ok", label: "Wifi, mostly solid" },
            { value: "flaky", label: "Wifi with drops, or tethering" },
          ]}
        />
        <RadioGroup
          name="asc-checkin"
          label="How do you check on it remotely?"
          value={checkin}
          onChange={setCheckin}
          options={[
            { value: "none", label: "I do not, I wait until I am back" },
            { value: "laptop_ssh", label: "SSH from my laptop" },
            { value: "phone_ssh", label: "SSH from my phone" },
            { value: "web", label: "A web dashboard or chat" },
          ]}
        />
      </div>

      <div className={styles.panel}>
        <div className={styles.barHead}>
          <span className={styles.panelTitle} style={{ margin: 0 }}>
            Survival score
          </span>
          <span>
            <span className={tone.text} style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.04em" }}>
              {score}
            </span>{" "}
            / 100
          </span>
        </div>
        <div role="img" aria-label={`Survival score ${score} out of 100`} className={styles.gauge}>
          <div className={[styles.gaugeFill, tone.fill].filter(Boolean).join(" ")} style={{ width: `${score}%` }} />
        </div>
        <p className={[styles.badge, tone.text].filter(Boolean).join(" ")} style={{ margin: "12px 0 0" }}>
          {verdict}
        </p>
      </div>

      {modes.length > 0 ? (
        <div>
          <h2 className={styles.h3}>How this setup dies, worst first</h2>
          <div className={styles.modes}>
            {modes.map((mode, i) => (
              <div key={mode.id} className={styles.mode}>
                <div className={styles.modeHead}>
                  <p className={styles.modeTitle}>
                    {i + 1}. {mode.title}
                  </p>
                  <span className={[styles.badge, styles.toneBad].filter(Boolean).join(" ")}>-{mode.severity} pts</span>
                </div>
                <p>{mode.scenario}</p>
                <p className={styles.modeFix}>{mode.fix}</p>
                {mode.snippet && <pre className={styles.pre}>{mode.snippet}</pre>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className={styles.verdict}>
          No structural failure modes found.{" "}
          {runsOn === "managed"
            ? "A managed computer takes the lid and the server upkeep off your list, and your session manager holds the run after you close the tab. The remaining risk is your provider's uptime, which is the right place for it."
            : "This setup should hold. The remaining risks are hardware and power, which no config fixes."}
        </p>
      )}

      {modes.length > 0 && (
        <div className={styles.panel}>
          <p className={styles.inlineRow}>
            <span>What this costs you:</span>
            <input
              type="number"
              min={0}
              step={0.5}
              aria-label="Interruptions per week"
              value={interruptionsInput}
              placeholder={String(estimatedPerWeek)}
              onChange={(e) => setInterruptionsInput(e.target.value)}
              className={styles.inlineNumber}
            />
            <span>interruptions a week x</span>
            <input
              type="number"
              min={0}
              step={5}
              aria-label="Minutes to notice and restore"
              value={minutesToRestore}
              onChange={(e) => setMinutesToRestore(Math.max(0, Number(e.target.value) || 0))}
              className={styles.inlineNumber}
            />
            <span>minutes to restore at $</span>
            <input
              type="number"
              min={0}
              step={5}
              aria-label="Hourly rate in dollars"
              value={hourlyRate}
              onChange={(e) => setHourlyRate(Math.max(0, Number(e.target.value) || 0))}
              className={styles.inlineNumber}
            />
            <span>
              an hour is about <strong className={styles.toneGood}>${Math.round(weeklyCost)} a week</strong> of your time.
            </span>
          </p>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle} style={{ margin: 0 }}>
            Shareable verdict
          </span>
          <button type="button" onClick={copyVerdict} className={styles.smallButton} data-active={copied}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className={[styles.pre, styles.preWrap].filter(Boolean).join(" ")}>{shareText}</pre>
      </div>

      <p className={styles.note}>
        Assumptions: severities and interruption counts are rough estimates from common failure reports, not
        measurements of your machine. The free fixes are real and often enough; a VPS with tmux and a systemd unit
        is a fine setup if you want to run it. Commands and defaults last verified {DEFAULTS.lastVerified} against
        the macOS, OpenSSH, tmux, systemd and util-linux manuals.
      </p>

      <div className={styles.bridge}>
        <p>
          A managed always-on computer takes the lid and the server upkeep off your list. Hivra runs Claude Code on
          a cloud computer with your own sign-in, and that computer stays on with your files, sessions and login.
          Start a run inside tmux in its Terminal tab, or send it from Telegram, and it keeps going after you close
          the laptop. The $9.99 a month plan gives it 2 vCPU and 4 GB, and paid plans are not paused for
          inactivity.
        </p>
        <Link href={TOOLS_CTA.primaryHref} className={styles.bridgeLink}>
          Skip the server upkeep
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
