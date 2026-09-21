"use client";
import { useState } from "react";
import { Check, Terminal, LayoutGrid, Folder, Code2, Bot } from "lucide-react";
import styles from "./home.module.css";
const CAPABILITIES = ["Launch new agents", "Monitor activity", "View logs", "Manage browser sessions", "Store API keys", "Upgrade resources", "Restart deployments"];
const tabs = [{ name:"Agents", icon:LayoutGrid },{ name:"Files", icon:Folder },{ name:"Terminal", icon:Terminal }];
export default function DashboardShowcaseSection() {
  const [active, setActive] = useState(0);
  return <section className={`${styles.section} ${styles.showcase}`}>
    <div><span className={styles.eyebrow}>03 / One dashboard</span><h2>One place to <em>manage everything.</em></h2><p>Whether you run one agent or ten, Hivra gives you a single dashboard to manage them all.</p><ul>{CAPABILITIES.map(cap => <li key={cap}><Check size={14} />{cap}</li>)}</ul></div>
    <div className={styles.preview}>
      <div className={styles.previewHeader}><span>Hivra / Workspace</span><span>Illustration</span></div>
      <div className={styles.previewTabs} role="group" aria-label="Explore the workspace illustration">{tabs.map(({name,icon:Icon},i) => <button type="button" key={name} aria-pressed={active===i} onClick={()=>setActive(i)}><Icon size={13} />{name}</button>)}</div>
      <div className={styles.previewBody} aria-live="polite">
        {active === 0 && <>{["Claude Code","Hermes Agent","Researcher"].map((name,i) => <div className={styles.previewAgent} key={name}>{i === 0 ? <Code2 size={20} /> : <Bot size={20} />}<span>{name}</span><small>Example agent</small></div>)}</>}
        {active === 1 && <>{["workspace / projects", "workspace / notes", "workspace / research"].map(name => <div className={styles.previewAgent} key={name}><Folder size={20} /><span>{name}</span></div>)}</>}
        {active === 2 && <pre>{"~/workspace $ pwd\n/workspace\n\n~/workspace $ ls\nprojects  notes  research\n\n~/workspace $ ▍"}</pre>}
      </div>
      <div className={styles.previewBottom}>Click a tab to look around.</div>
    </div>
  </section>;
}
