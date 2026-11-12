"use client";

// Bot connect wizard (/tools/telegram-discord-bot-setup).
//
// Pick Telegram or Discord, then walk the steps in order. The Discord step builds the invite link from the
// Application ID and the ticked permissions (lib/tools/agent-tools/bot-connect-wizard.ts does the bit math).
// The token checker reads the SHAPE of what is typed and nothing else: the text is held in component state
// only, is never stored, never put in the address and never sent anywhere (there is no fetch in this file).
// The address carries just the platform and the ticked permissions, both allow-listed.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import own from "./BotConnectWizardTool.module.css";
import CopyButton from "./CopyButton";
import ToolRadioGroup from "./ToolRadioGroup";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { currentSearch, replaceToolSearch } from "@/lib/tools/tool-params";
import {
  AGENT_KEYS,
  AGENT_LABEL,
  AGENT_PLACEMENTS,
  BOT_CONNECT_FACTS,
  BOT_CONNECT_PARAM_KEYS,
  DEFAULT_LINK_STATE,
  DEFAULT_PLATFORM,
  LEAK_STEPS,
  PERMISSIONS,
  PERMISSION_PRESETS,
  PLATFORMS,
  PLATFORM_LABEL,
  STEPS,
  buildInviteUrl,
  checkToken,
  normalisePermissions,
  parseBotConnectParams,
  serializeBotConnectParams,
  startHrefFor,
  type AgentKey,
  type Platform,
  type PermissionKey,
  type StepId,
} from "@/lib/tools/agent-tools/bot-connect-wizard";
import { monthYear } from "@/lib/tools/month-year";

function Cmd({ text }: { text: string }) {
  return (
    <div className={own.cmdRow}>
      <code>{text}</code>
      <CopyButton text={text} label="Copy" copiedLabel="Copied" compact ariaLabel={`Copy: ${text}`} />
    </div>
  );
}

function TokenChecker({ platform }: { platform: Platform }) {
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const result = checkToken(platform, token);
  const id = `bot-token-${platform}`;
  return (
    <div className={own.fieldBlock}>
      <label className={styles.label} htmlFor={id}>
        {PLATFORM_LABEL[platform]} bot token, to check its shape
      </label>
      <input
        id={id}
        className={styles.field}
        type={shown ? "text" : "password"}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className={styles.hint}>
        Checked in your browser only. Nothing is sent, stored or added to the page address. Do not paste a real token anywhere you do not trust. A
        made-up one with the same shape works for trying the checker.
      </p>
      <label className={[styles.check, own.showRow].join(" ")}>
        <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
        Show what I typed
      </label>
      {token !== "" && (
        <button type="button" className={styles.smallButton} onClick={() => setToken("")}>
          Clear
        </button>
      )}
      <div role="status" aria-live="polite" data-testid="token-result">
        {result.level !== "empty" && (
          <div className={styles.verdictBox} data-level={result.level === "looks-right" ? "ok" : "caveat"} style={{ marginTop: 16 }}>
            <p className={styles.verdictTitle}>{result.headline}</p>
            {result.details.map((d) => (
              <p key={d} className={styles.verdictDetail}>
                {d}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InviteBuilder({
  appId,
  onAppId,
  permissions,
  onChange,
}: {
  appId: string;
  onAppId: (next: string) => void;
  permissions: PermissionKey[];
  onChange: (next: PermissionKey[]) => void;
}) {
  const invite = buildInviteUrl(appId, permissions);
  const toggle = (key: PermissionKey) =>
    onChange(normalisePermissions(permissions.includes(key) ? permissions.filter((k) => k !== key) : [...permissions, key]));
  return (
    <div>
      <div className={own.fieldBlock}>
        <label className={styles.label} htmlFor="bot-app-id">
          Application ID
        </label>
        <input
          id="bot-app-id"
          className={styles.field}
          inputMode="numeric"
          value={appId}
          onChange={(e) => onAppId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="bot-app-id-hint"
        />
        <p id="bot-app-id-hint" className={styles.hint}>
          On the General Information page of your application. It is a public number, not the token. It is kept out of the page address anyway.
        </p>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Permissions for the bot</legend>
        <div className={own.presetRow}>
          {PERMISSION_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={styles.smallButton} onClick={() => onChange(normalisePermissions(preset.keys))}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className={own.permGrid}>
          {PERMISSIONS.map((p) => (
            <label key={p.key} className={[styles.check, p.risky ? own.permRisky : ""].join(" ")}>
              <input type="checkbox" checked={permissions.includes(p.key)} onChange={() => toggle(p.key)} />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>

      <p className={styles.hint} style={{ marginTop: 0 }}>
        Permissions number: <strong className={styles.noteLead} data-testid="perm-integer">{invite.integer}</strong>
      </p>
      {invite.warnings.map((w) => (
        <p key={w} className={own.warn}>
          {w}
        </p>
      ))}
      <div role="status" aria-live="polite">
        {invite.url ? (
          <>
            <p className={own.urlBox} data-testid="invite-url">
              {invite.url}
            </p>
            <div className={styles.panelHead} style={{ justifyContent: "flex-start" }}>
              <CopyButton text={invite.url} label="Copy invite link" copiedLabel="Link copied" />
              <a className={styles.smallButton} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none", marginTop: 0 }} href={invite.url} target="_blank" rel="noopener noreferrer">
                Open the link
              </a>
            </div>
          </>
        ) : (
          <p className={styles.hint}>{invite.problem}</p>
        )}
      </div>
    </div>
  );
}

function PastePlacement({ platform }: { platform: Platform }) {
  const [agent, setAgent] = useState<AgentKey>("hermes");
  const placement = AGENT_PLACEMENTS[agent][platform];
  return (
    <div>
      <ToolRadioGroup
        name="bot-connect-agent"
        label="Which agent are you connecting?"
        value={agent}
        onChange={setAgent}
        options={AGENT_KEYS.map((k) => ({ value: k, label: AGENT_LABEL[k] }))}
      />
      <div style={{ marginTop: 16 }} data-testid="placement">
        <ol>
          {placement.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {placement.commands.map((c) => (
          <Cmd key={c} text={c} />
        ))}
        {placement.after.map((a) => (
          <p key={a} style={{ marginTop: 12 }}>
            {a}
          </p>
        ))}
        <p>
          Read the source:{" "}
          <a href={placement.docs.url} target="_blank" rel="noopener noreferrer">
            {placement.docs.label}
          </a>
          . Docs change, so check the page before you rely on a name above.
        </p>
      </div>
      <div className={styles.bridge}>
        <p>
          Hivra runs {AGENT_LABEL[agent]} as the upstream agent on a computer that stays on, so the same commands apply there. A Hivra computer
          costs {formatPlanSize("entry")}. The plan does not include AI usage. Running it on a machine of your own is a fair choice too.
        </p>
        <Link href={startHrefFor(agent)} className={styles.bridgeLink}>
          Start {AGENT_LABEL[agent]} on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function StepContent({
  id,
  platform,
  permissions,
  onPermissions,
  appId,
  onAppId,
}: {
  id: StepId;
  platform: Platform;
  permissions: PermissionKey[];
  onPermissions: (next: PermissionKey[]) => void;
  appId: string;
  onAppId: (next: string) => void;
}) {
  switch (id) {
    case "tg-create":
      return (
        <>
          <p>You make a Telegram bot by talking to another bot, BotFather. It is run by Telegram.</p>
          <ol>
            <li>In Telegram, search for @BotFather and open the chat.</li>
            <li>
              Send <code className={styles.inlineCode}>/newbot</code>.
            </li>
            <li>Give it a name, which people see, then a username. The username must end in bot.</li>
            <li>BotFather replies with the token. It looks like digits, a colon, then a long string.</li>
          </ol>
          <p>
            Telegram&apos;s docs say anyone with the token can control the bot, so keep it secret. To change the name, picture or settings later, send{" "}
            <code className={styles.inlineCode}>/mybots</code> and pick your bot.
          </p>
        </>
      );
    case "dc-create":
      return (
        <>
          <ol>
            <li>Open the Discord Developer Portal and create an application. Give it a name.</li>
            <li>New applications already have a bot user. Open the Bot page to see it.</li>
            <li>
              Copy the Application ID from the General Information page. You will need it for the invite link, and it is not the token.
            </li>
          </ol>
          <p>The token comes later, in its own step, because Discord shows it only once.</p>
        </>
      );
    case "dc-intents":
      return (
        <>
          <p>On the Bot page, under Privileged Gateway Intents, switch on what the agent needs.</p>
          <ul>
            <li>
              <strong className={styles.noteLead}>Message Content: required.</strong> Without it Discord sends empty message text for most
              messages in servers. It does still send messages that mention the bot and direct messages. Hermes and OpenClaw both say to turn it on.
            </li>
            <li>
              <strong className={styles.noteLead}>Server Members:</strong> needed if you allow people by username or by role. OpenClaw recommends
              it, and Hermes lists it as needed for those cases.
            </li>
            <li>
              <strong className={styles.noteLead}>Presence:</strong> optional. Leave it off unless you know you need it.
            </li>
          </ul>
          <p>
            While the bot is in fewer than {BOT_CONNECT_FACTS.verifiedThreshold} servers you only switch these on. Past that, Discord requires
            verification and approval for each, which most personal agents never reach.
          </p>
        </>
      );
    case "dc-invite":
      return (
        <>
          <p>
            The invite link is Discord&apos;s authorize address with your Application ID, the scopes bot and applications.commands, and a permissions
            number. Tick what the bot needs. The number is the sum of one bit per permission.
          </p>
          <InviteBuilder appId={appId} onAppId={onAppId} permissions={permissions} onChange={onPermissions} />
          <p style={{ marginTop: 16 }}>
            Open the link, choose your server, and confirm. You can only pick a server where you have permission to add apps. Start with the minimal set and add more only when the agent needs it.
          </p>
        </>
      );
    case "dc-check":
      return (
        <>
          <ol>
            <li>On the Bot page, choose Reset Token and copy the result straight away. Discord shows it once.</li>
            <li>Store it in a password manager or paste it into the agent&apos;s config, not into a chat or a document.</li>
            <li>Check its shape below if you want to catch a bad copy.</li>
          </ol>
          <TokenChecker platform="discord" />
        </>
      );
    case "tg-check":
      return (
        <>
          <p>Checks the shape only: digits, a colon, then 35 characters. It cannot tell you the token is live.</p>
          <TokenChecker platform="telegram" />
        </>
      );
    case "tg-userid":
      return (
        <>
          <p>Agents use your numeric Telegram user id as an allowlist, so only you can talk to the bot. It is a number, not your @username.</p>
          <ul>
            <li>Hermes&apos; Telegram guide suggests messaging @userinfobot, which replies with your id. @get_id_bot does the same.</li>
            <li>
              Those are third-party bots, not Telegram&apos;s. Use them only for this, and never send them a token.
            </li>
            <li>
              OpenClaw takes a different route. It pairs unknown senders by default: you message the bot and approve the code it shows, so you do
              not need the id first.
            </li>
          </ul>
        </>
      );
    case "dc-userid":
      return (
        <>
          <p>Agents use your Discord user id as an allowlist. Hermes&apos; guide gives these steps.</p>
          <ol>
            <li>In Discord, open Settings, then Advanced, and turn on Developer Mode.</li>
            <li>Close Settings.</li>
            <li>Right-click your own name, in a message or the member list, and choose Copy User ID.</li>
          </ol>
        </>
      );
    case "tg-groups":
      return (
        <>
          <p>
            In a group, a bot with privacy mode on sees commands addressed to it and replies to its own messages, not the rest. Telegram turns
            privacy mode on by default for every bot, except bots that are admins of the group.
          </p>
          <p>For an agent you message one to one, leave it on. If you want it to read a whole group, you have two options.</p>
          <ol>
            <li>
              Turn privacy mode off: send <code className={styles.inlineCode}>/mybots</code> to BotFather, pick the bot, then Bot Settings, then
              Group Privacy, then Turn off. Remove the bot from the group and add it again, because Telegram says the change only takes effect
              after that.
            </li>
            <li>Or make the bot an admin of the group.</li>
          </ol>
          <p>Either way, the bot then reads everything said in that group. Only do it in a group you trust with the agent.</p>
        </>
      );
    case "paste":
      return <PastePlacement platform={platform} />;
  }
}

export default function BotConnectWizardTool() {
  const [platform, setPlatform] = useState<Platform>(DEFAULT_PLATFORM);
  const [permissions, setPermissions] = useState<PermissionKey[]>(DEFAULT_LINK_STATE.permissions);
  const [stepIndex, setStepIndex] = useState(0);
  const [ready, setReady] = useState(false);
  // The Application ID is a public number kept here so it survives Back and Next. It never goes in the address.
  // The token state stays inside TokenChecker, so it is cleared on every step change.
  const [appId, setAppId] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Read a shared link once, after hydration, so the server render stays the default state.
  useEffect(() => {
    const state = parseBotConnectParams(currentSearch());
    // Reading the address is an external system; it can only happen after hydration. Same pattern as the other tools.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlatform(state.platform);
    setPermissions(state.permissions);
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) replaceToolSearch(serializeBotConnectParams({ platform, permissions }), BOT_CONNECT_PARAM_KEYS);
  }, [platform, permissions, ready]);

  const steps = STEPS[platform];
  const goTo = (i: number) => {
    moved.current = true;
    setStepIndex(i);
  };
  const index = Math.min(stepIndex, steps.length - 1);
  const step = steps[index];

  // After a step change the heading changes, so move focus to it for keyboard and screen-reader users.
  useEffect(() => {
    if (moved.current) headingRef.current?.focus();
  }, [platform, stepIndex]);

  const choosePlatform = (next: Platform) => {
    setPlatform(next);
    goTo(0);
  };

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <ToolRadioGroup
          name="bot-connect-platform"
          label="Where do you want to talk to your agent?"
          value={platform}
          onChange={choosePlatform}
          options={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
        />
      </div>

      <nav aria-label={`${PLATFORM_LABEL[platform]} setup steps`}>
        <ol className={own.steps}>
          {steps.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={own.stepButton} aria-current={i === index ? "step" : undefined} onClick={() => goTo(i)}>
                <span className={own.stepNum}>{i + 1}.</span> {s.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className={own.stepBody} aria-labelledby="bot-connect-step-title" data-testid="wizard-step">
        <h3 id="bot-connect-step-title" ref={headingRef} tabIndex={-1}>
          Step {index + 1} of {steps.length}: {step.title}
        </h3>
        <StepContent key={`${platform}-${step.id}`} id={step.id} platform={platform} permissions={permissions} onPermissions={setPermissions} appId={appId} onAppId={setAppId} />
      </section>

      <div className={own.nav}>
        <button type="button" className={styles.smallButton} disabled={index === 0} onClick={() => goTo(index - 1)}>
          Back
        </button>
        <button type="button" className={styles.smallButton} disabled={index === steps.length - 1} onClick={() => goTo(index + 1)}>
          Next step
        </button>
      </div>

      <div className={[styles.panel, own.leak].join(" ")} data-testid="leak-panel">
        <span className={styles.panelTitle}>If a {PLATFORM_LABEL[platform]} token leaked</span>
        <ol className={styles.plainList} style={{ marginTop: 0 }}>
          {LEAK_STEPS[platform].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>

      <p className={styles.note}>
        <strong className={styles.noteLead}>Assumptions:</strong> Telegram and Discord steps come from their own documentation, and where each agent
        reads the token comes from that agent&apos;s docs, all last checked {monthYear(BOT_CONNECT_FACTS.lastVerified)}. The token check reads shape only,
        because neither platform publishes a full token format. A token that passes can still be wrong, and one that fails can still work.
      </p>
    </div>
  );
}
