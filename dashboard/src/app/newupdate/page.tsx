import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import { EditorialArt } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Venice Multimodal Agents",
  robots: {
    index: false,
    follow: false,
  },
};

// The announcement in Ash's words (14-newupdate.md). The Venice integration it describes exists: an agent can
// be given the owner's own Venice key (Manage, "My Venice key") or use the managed gateway paid from Hivra
// credits, and the Hermes model list carries Venice's multimodal models. Hermes runs on Hivra Cloud only.
export default function NewUpdatePage() {
  return (
    <PublicSite className={styles.page} data-page="newupdate">
      <main className={styles.announcement} id="main-content">
        <div>
          <h1>
            <span>Venice</span> <span>multimodal</span> <span>agents on Hivra.</span>
          </h1>
          <p>
            Give a persistent Hermes agent access to supported multimodal models using your Venice credentials. Your
            agent runs on a Hivra computer, so its working environment stays available beyond a single browser
            session.
          </p>
          <p className={styles.tagline}>
            <strong>One Venice key. A persistent agent computer.</strong>
          </p>
          <p>
            A paid Hivra Cloud computer stays on and is not paused for inactivity. The plan does not include AI
            usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.
          </p>
          <p style={{ fontSize: 15, color: "var(--text-muted)" }}>
            Model availability and supported modalities depend on the current Venice integration and your account
            configuration.
          </p>
          <ActionLinks
            items={[
              { label: "Deploy your agent", href: PUBLIC_START_HREF, kind: "primary" },
              { label: "Explore Hermes", href: "/agents/hermes", kind: "secondary" },
            ]}
          />
        </div>
        <EditorialArt label="Venice · Multimodal" number="AI" />
      </main>
    </PublicSite>
  );
}
