"use client";
import { useState } from "react";
import { Terminal, LayoutGrid, Folder, Code2, Bot } from "lucide-react";
import styles from "./home.module.css";
const WORKSPACE_BENEFITS = [
  { title: "Pick up where you left off", body: "Keep the files, apps and setup for a project together. Open the same workspace from your laptop or phone." },
  { title: "Work in the interface you prefer", body: "Use an agent's interface, its terminal, or both. Open the desktop and take over whenever you want." },
  { title: "See what happened", body: "Check the files, results and activity Hivra can observe. Work inside an external app may need checking in that app." },
];
const tabs = [{ name:"Agents", icon:LayoutGrid },{ name:"Files", icon:Folder },{ name:"Terminal", icon:Terminal }];
export default function DashboardShowcaseSection() {
  const [active, setActive] = useState(0);
  return <section id="workspace" className={`${styles.section} ${styles.showcase}`} aria-labelledby="workspace-heading">
    <div><span className={styles.eyebrow}>Inside your workspace</span><h2 id="workspace-heading">Your work.<br /><em>Right where you left it.</em></h2>
      <div className={styles.workspaceBenefits}>{WORKSPACE_BENEFITS.map(item => <div key={item.title}><h3>{item.title}</h3><p>{item.body}</p></div>)}</div>
    </div>
    <div className={styles.preview}>
      <div className={styles.previewHeader}><span>Hivra / Workspace</span><span>Illustration</span></div>
      <div className={styles.previewTabs} role="group" aria-label="Explore the workspace illustration">{tabs.map(({name,icon:Icon},i) => <button type="button" key={name} aria-pressed={active===i} onClick={()=>setActive(i)}><Icon size={13} />{name}</button>)}</div>
      <div className={styles.previewBody} aria-live="polite">
        {active === 0 && <>{["Claude Code","Hermes Agent","Researcher"].map((name,i) => <div className={styles.previewAgent} key={name}>{i === 0 ? <Code2 size={20} /> : <Bot size={20} />}<span>{name}</span><small>Example agent</small></div>)}</>}
        {active === 1 && <>{["workspace / projects", "workspace / notes", "workspace / research"].map(name => <div className={styles.previewAgent} key={name}><Folder size={20} /><span>{name}</span></div>)}</>}
        {active === 2 && <pre>{"~/workspace $ pwd\n/workspace\n\n~/workspace $ ls\nprojects  notes  research\n\n~/workspace $ ▍"}</pre>}
      </div>
      <div className={styles.previewBottom}>Choose a tab to look around.</div>
    </div>
  </section>;
}
