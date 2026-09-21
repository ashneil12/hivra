"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Command, Monitor, Terminal, Apple, Layers } from "lucide-react";
import styles from "./product.module.css";

export const COMPUTER_OPTIONS = [
  { id: "ubuntu-desktop", name: "Ubuntu", label: "A familiar Linux workspace", icon: Terminal, detail: "Write code, run services and install the tools you use every day. Keep a project workspace ready without setting up another machine on your desk.", uses: ["Development tools", "Browsers & apps", "Long-running services"] },
  { id: "windows", name: "Windows", label: "Room for your Windows apps", icon: Monitor, detail: "Need Windows for one application? Give it a computer of its own. Set up your apps and files, use the desktop yourself, and bring an agent in when you want help.", uses: ["Windows applications", "A separate desktop", "Your own files & setup"] },
  { id: "omarchy", name: "Omarchy", label: "A Linux desktop for your flow", icon: Command, detail: "Make a workspace around your editor, terminal and browser. Use Omarchy yourself or give an agent somewhere to work beside the tools you've already set up.", uses: ["A keyboard-first desktop", "Editor & terminal", "Your project workspace"] },
] as const;

export function computerLaunchHref(profile: string) {
  return `/dashboard/launch?kind=computer&start=1&profile=${profile}`;
}

export default function ComputersSection() {
  const [selected, setSelected] = useState<(typeof COMPUTER_OPTIONS)[number]["id"]>("ubuntu-desktop");
  const computer = COMPUTER_OPTIONS.find(option => option.id === selected)!;

  return <section id="computers" className={styles.section} aria-labelledby="computers-heading">
    <div className={styles.heading}>
      <span className={styles.eyebrow}>Launch a computer</span>
      <h2 id="computers-heading">Sometimes you just need<br /><em>another computer.</em></h2>
      <p>Ubuntu, Windows or Omarchy. Install apps, browse, write code, run services. You don&apos;t have to attach an agent at all. It&apos;s a computer.</p>
    </div>
    <div className={styles.computerChoices} aria-label="Choose an operating system">
      {COMPUTER_OPTIONS.map(option => { const Icon = option.icon; return <article key={option.id} data-selected={selected === option.id}>
        <button type="button" aria-pressed={selected === option.id} aria-controls="computer-description" onClick={() => setSelected(option.id)}>
          <Icon size={26} strokeWidth={1.5} aria-hidden="true" /><span><strong>{option.name}</strong><small>{option.label}</small></span><span className={styles.inspect}>Explore <ArrowRight size={14} /></span>
        </button>
        <Link href={computerLaunchHref(option.id)}>Launch {option.name}<ArrowRight size={15} aria-hidden="true" /></Link>
      </article>; })}
    </div>
    <div className={styles.computerFeature} data-os={selected}>
      <figure className={styles.computerArt}>
        <Image key={selected} src={`/images/computers/${selected === "ubuntu-desktop" ? "ubuntu" : selected}-workspace.webp`} alt={`${computer.name} workspace illustration`} width={1536} height={1024} sizes="(max-width: 760px) 100vw, 65vw" unoptimized />
        <figcaption><span>{computer.name} / A space of your own</span><small>Workspace illustration</small></figcaption>
      </figure>
      <div id="computer-description" className={styles.computerDescription} aria-live="polite" aria-atomic="true">
        <div key={computer.id} className={styles.selectionContent}>
          <span className={styles.eyebrow}>Your {computer.name} computer</span>
          <h3>Settle in.<br /> Make it yours.</h3>
          <p>{computer.detail}</p>
          <ul>{computer.uses.map(use => <li key={use}>{use}</li>)}</ul>
          <p className={styles.small}>Choose compatible capacity and review the resources, access and price before you launch.</p>
        </div>
      </div>
    </div>
    <div className={styles.computerEnding}><p>Bring an agent into the workspace when you want one. Take the screen back whenever you&apos;d rather do it yourself.</p></div>
    <div className={styles.comingComputers} aria-label="More computer options coming soon">
      <span>More ways to make it yours.</span>
      <div><Apple size={21} aria-hidden="true" /><strong>macOS</strong><small>Coming soon</small></div>
      <div><Layers size={21} aria-hidden="true" /><strong>Custom images</strong><small>Coming soon</small></div>
    </div>
  </section>;
}
