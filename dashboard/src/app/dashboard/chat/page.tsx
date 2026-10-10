import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { cookies } from "next/headers";
import { log } from "@/lib/logger";
import { resolveDefaultHivraResource } from "@/lib/workspace/default-resource";
import {
  getDefaultInstanceSurfacePreference,
  getInstanceSurfaceHref,
  readInstanceSurfacePreferenceCookie,
} from "@/lib/instance-surface-preference";

interface InstanceSurfaceCandidate {
  id?: string | null;
  backend?: string | null;
}

export default async function ChatIndexPage(props: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const searchParams = await props.searchParams;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const redirectParams = new URLSearchParams();
  const templateId = typeof searchParams?.templateId === "string" ? searchParams.templateId : undefined;
  const profile = typeof searchParams?.profile === "string" ? searchParams.profile : undefined;

  if (templateId) {
    redirectParams.set("templateId", templateId);
  }
  if (profile) {
    redirectParams.set("profile", profile);
  }

  const searchStr = redirectParams.size > 0 ? `?${redirectParams.toString()}` : "";

  const cookieStore = await cookies();
  const lastChatId = cookieStore.get("hermes_last_chat")?.value;

  const maybeSelectSingleId = async (
    builder: {
      maybeSingle: () => PromiseLike<{ data?: InstanceSurfaceCandidate | null } | undefined>;
    }
  ): Promise<InstanceSurfaceCandidate | null> => {
    const result = await builder.maybeSingle();
    return result?.data ?? null;
  };

  if (supabaseAdmin) {
    if (lastChatId) {
      const data = await maybeSelectSingleId(supabaseAdmin
        .from("hermes_instances")
        .select("id, backend")
        .eq("user_id", userId)
        .eq("id", lastChatId)
        .neq("status", "deleted")
      );

      if (data && data.id) {
        const defaultSurface = getDefaultInstanceSurfacePreference(data.backend);
        const preferredSurface = readInstanceSurfacePreferenceCookie(
          cookieStore,
          data.id,
          defaultSurface
        );
        if (preferredSurface === "tui") {
          log.info("chat resolver routing to saved TUI surface preference", {
            source: "dashboard.chat.surface",
            route: "/dashboard/chat",
            userId,
            instanceId: data.id,
            backend: data.backend ?? null,
            defaultSurface,
            preferredSurface,
          });
        }
        redirect(`${getInstanceSurfaceHref(data.id, preferredSurface)}${searchStr}`);
      }
    }

    const data = await maybeSelectSingleId(supabaseAdmin
      .from("hermes_instances")
      .select("id, backend")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: true })
      .limit(1)
    );

    if (data && data.id) {
      const defaultSurface = getDefaultInstanceSurfacePreference(data.backend);
      const preferredSurface = readInstanceSurfacePreferenceCookie(
        cookieStore,
        data.id,
        defaultSurface
      );
      if (preferredSurface === "tui") {
        log.info("chat resolver routing to saved TUI surface preference", {
          source: "dashboard.chat.surface",
          route: "/dashboard/chat",
          userId,
          instanceId: data.id,
          backend: data.backend ?? null,
          defaultSurface,
          preferredSurface,
        });
      }
      redirect(`${getInstanceSurfaceHref(data.id, preferredSurface)}${searchStr}`);
    }

    // No Hermes instance: an owner whose resources are all Hivra agents or
    // computers lands on the best of those instead of a dead end.
    let hivraId: string | null = null;
    try {
      hivraId = await resolveDefaultHivraResource({ userId, supabase: supabaseAdmin });
    } catch (error) {
      log.warn("chat resolver could not look up Hivra agents", {
        source: "dashboard.chat.surface",
        route: "/dashboard/chat",
        userId,
        failureType: "chat_resolver_hivra_lookup_failed",
      }, error);
    }
    if (hivraId) {
      redirect(`/dashboard/agent/${encodeURIComponent(hivraId)}?tab=chat`);
    }
  }

  return (
    <div
      style={{
        minHeight: "100%",
        display: "grid",
        placeItems: "center",
        padding: "clamp(16px, 5vw, 2rem)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 540,
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          padding: "clamp(16px, 5vw, 2rem)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.06)",
          display: "grid",
          gap: "1rem",
        }}
      >
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <span
            className="mono"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              opacity: 0.55,
            }}
          >
            Chat unavailable
          </span>
          <h1
            className="serif"
            style={{
              fontSize: "clamp(1.9rem, 5vw, 2.5rem)",
              fontWeight: 400,
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            Chat needs an agent first.
          </h1>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.7,
              color: "var(--text-secondary)",
              margin: 0,
            }}
          >
            There&apos;s no agent on this account yet. Launch one to start chatting. If you just launched
            one, it will appear on Home once it finishes starting.
          </p>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Link
            href="/dashboard/launch"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              padding: "12px 16px",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              textDecoration: "none",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Launch an agent
          </Link>
          <Link
            href="/dashboard"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              padding: "12px 16px",
              border: "1px solid var(--etched-border)",
              color: "var(--ink-black)",
              textDecoration: "none",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Go to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
