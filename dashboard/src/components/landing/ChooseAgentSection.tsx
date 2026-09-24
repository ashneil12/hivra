import Link from "next/link";
import { ArrowRight, Bot, Boxes, Code2, Cpu, Triangle, Orbit, Terminal } from "lucide-react";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { getHivraPreview } from "@/lib/hivra/preview-catalog";
import styles from "./home.module.css";
import refresh from "./copy-refresh.module.css";

const AGENTS = [
  { id: "claude-code", name: "Claude Code", role: "Coding", description: "Build, debug and review your projects with Claude Code in its own workspace.", icon: Code2, href: buildLaunchHref({ start: true, profile: "claude-code" }) },
  { id: "codex", name: "Codex", role: "Coding", description: "Work through engineering tasks with Codex, your project files and your own model connection.", icon: Boxes, href: buildLaunchHref({ start: true, profile: "codex" }) },
  { id: "hermes", name: "Hermes", role: "Research and automation", description: "Browse, research and automate work with Hermes, keeping its tools and memory in one place.", icon: Bot, href: buildLaunchHref({ start: true, profile: "hermes" }) },
  { id: "agent-zero", name: "Agent Zero", role: "Agent workspace", description: "Use Agent Zero's own interface, with your tools, files and model settings on its computer.", icon: Orbit, href: buildLaunchHref({ start: true, profile: "agent-zero" }) },
  { id: "deepseek-harness", name: "DeepSeek", role: "Coding and agent work", description: "Work with DeepSeek in its own interface, with the model key you choose.", icon: Terminal, href: getHivraPreview("deepseek-harness")!.href },
  { id: "openclaw", name: "OpenClaw", role: "Automation", description: "Open OpenClaw's interface and connect the model providers and messaging channels you use.", icon: Cpu, href: buildLaunchHref({ start: true, profile: "openclaw" }) },
  { id: "aeon", name: "Aeon", role: "Project automation", description: "Run Aeon's dashboard and connect your GitHub workflows to the projects you want it working on.", icon: Triangle, href: buildLaunchHref({ start: true, profile: "aeon" }) },
] as const;

export default function ChooseAgentSection({ embedded = false }: { embedded?: boolean }) {
  return <section id={embedded ? undefined : "agents"} className={embedded ? refresh.embedded : styles.section}>
    {!embedded && <div className={styles.sectionHeading}>
      <span className={styles.eyebrow}>Launch an agent</span>
      <h2>Pick the agent.<br /><em>Give it a workspace.</em></h2>
      <p>Connect the account or key it uses. Its tools and files live on that computer, so you can leave your personal machine out of the job.</p>
    </div>}
    {embedded && <p className={refresh.agentIntro}>Choose an agent and connect the account or key it uses. Its tools and files live on a separate computer.</p>}
    <p className={refresh.agentIntro}>Run a terminal agent through an interface, work directly in its terminal, or move between the two. Agents that come with their own interface keep it.</p>
    <div className={styles.agentList}>{AGENTS.filter(agent => getAgent(agent.id)?.available || getHivraPreview(agent.id)).map(agent => {
      const Icon = agent.icon;
      // Catalog truth: a runtime that is not launchable yet is labelled as a preview.
      const preview = !getAgent(agent.id)?.available;
      return <article className={styles.agentRow} key={agent.id}>
        <Icon size={30} aria-hidden="true" />
        <div><h3>{agent.name}</h3><small>{preview ? `${agent.role} · Preview` : agent.role}</small></div>
        <p>{agent.description}</p>
        <div><Link className={styles.textLink} href={agent.href}>{preview ? "See the preview" : "Choose agent"}<ArrowRight size={16} aria-hidden="true" /></Link></div>
      </article>;
    })}</div>
    <div className={refresh.moreAgents}><span><i aria-hidden="true" />More agents are coming.</span><p>Your workspace stays yours as the lineup grows.</p><Link href="/roadmap">Follow what&apos;s next<ArrowRight size={16} aria-hidden="true" /></Link></div>
  </section>;
}
