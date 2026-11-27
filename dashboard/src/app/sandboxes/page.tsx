import type { Metadata } from "next";

import PublicSite from "@/components/public-site/PublicSite";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import local from "../features/features.module.css";

const title = "Linux Sandboxes | Hivra";
const description = "Compare a lightweight gVisor sandbox with a full Ubuntu virtual machine. See what stays on disk and how sleep and wake work.";

export const metadata: Metadata = {
  title: absoluteTitle(title),
  description,
  ...buildWebsiteMetadata({ path: "/sandboxes", title, description }),
};

const topics = [
  {
    title: "A terminal, not a desktop",
    body: "Pick a sandbox for scripts, command-line tools or working with files. The terminal runs one command at a time; a sandbox has no graphical desktop. Pick a full KVM virtual machine when you need a desktop, your own Linux kernel or long-running services.",
  },
  {
    title: "Files that stay when compute stops",
    body: "Save work in the workspace. Those files survive stop and start. In the managed idle-sleep pilot, the sandbox stops when idle and its owner can start it again. That starts a fresh session: running processes and unsaved work don’t resume. Managed sandboxes have their own storage limits.",
  },
  {
    title: "An isolated place to run code",
    body: "gVisor handles Linux system calls in a separate application kernel, reducing the code’s direct access to the host kernel. A sandbox isn’t a virtual machine or a guarantee of complete security. What your code can reach still depends on the access you give it.",
  },
  {
    title: "Sleep on a full computer",
    body: "On eligible paid KVM computers with sleep enabled, idle time can trigger a nap and then hibernation. Open the computer again to wake it with its files intact. Keep it awake if you need work to continue in the background.",
  },
] as const;

export default function SandboxesPage() {
  return (
    <PublicSite className={styles.page} data-page="sandboxes">
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Sandboxes" }]} />
        <header className={`${styles.masthead} ${local.masthead}`}>
          <span className={styles.eyebrow}>Hivra computers</span>
          <h1>Linux sandboxes.</h1>
          <p>A lightweight Linux workspace with a terminal, persistent files and gVisor isolation. Use a sandbox when your work needs a shell, not a whole virtual machine.</p>
          <ActionLinks items={[
            { label: "Compare computer types", href: "#compare-computers", kind: "primary" },
            { label: "Open Launch", href: buildLaunchHref({ kind: "computer" }), kind: "secondary" },
          ]} />
        </header>

        <section className={`${local.introBand} ${local.split}`} aria-labelledby="sandbox-access">
          <h2 id="sandbox-access">Two ways to run a sandbox</h2>
          <div className={local.prose}>
            <p><strong>Your server.</strong> Connect a compatible Linux server and choose Linux Sandbox in Launch.</p>
            <p><strong>Hivra Cloud.</strong> Managed Light computers use the Linux Sandbox option in Launch. Managed access is limited to eligible test accounts on Canary, and automatic idle sleep is a separate pilot.</p>
          </div>
        </section>

        <section id="compare-computers" aria-labelledby="computer-types">
          <div className={local.sectionHead}>
            <h2 id="computer-types">Choose the computer your work needs.</h2>
          </div>
          <ol className={local.index}>
            {topics.map(({ title, body }, index) => (
              <li key={title} className={`${local.item} ${local.split}`}>
                <h3><span aria-hidden="true" className={local.itemNumber}>0{index + 1}</span>{title}</h3>
                <div className={local.prose}><p>{body}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <EditorialRelated links={[
          { label: "See Hivra features", href: "/features" },
          { label: "Compare hosting plans", href: "/pricing" },
        ]} />
      </main>
    </PublicSite>
  );
}
