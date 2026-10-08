"use client";

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface LocalUser {
  createdAt: Date;
  emailAddresses: Array<{ emailAddress: string; id: string }>;
  firstName: string;
  fullName: string;
  id: string;
  lastName: null;
  lastSignInAt: Date;
  primaryEmailAddress: { emailAddress: string; id: string };
}

interface LocalAuthContextValue {
  accessToken: string | null;
  isLoaded: boolean;
  user: LocalUser | null;
}

const LocalAuthContext = createContext<LocalAuthContextValue>({
  accessToken: null,
  isLoaded: false,
  user: null,
});

function parseUser(value: unknown): LocalUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.firstName !== "string") return null;
  const emails = Array.isArray(candidate.emailAddresses) ? candidate.emailAddresses : [];
  const primary = candidate.primaryEmailAddress;
  if (!primary || typeof primary !== "object") return null;
  return {
    ...(candidate as unknown as LocalUser),
    createdAt: new Date(typeof candidate.createdAt === "string" ? candidate.createdAt : 0),
    lastSignInAt: new Date(typeof candidate.lastSignInAt === "string" ? candidate.lastSignInAt : Date.now()),
    emailAddresses: emails as LocalUser["emailAddresses"],
    primaryEmailAddress: primary as LocalUser["primaryEmailAddress"],
  };
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LocalAuthContextValue>({
    accessToken: null,
    isLoaded: false,
    user: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/self-host/auth/session", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        setState({
          accessToken: response.ok && typeof body.accessToken === "string" ? body.accessToken : null,
          isLoaded: true,
          user: response.ok ? parseUser(body.user) : null,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ accessToken: null, isLoaded: true, user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <LocalAuthContext.Provider value={state}>{children}</LocalAuthContext.Provider>;
}

export function useUser() {
  const state = useContext(LocalAuthContext);
  return {
    isLoaded: state.isLoaded,
    isSignedIn: Boolean(state.user),
    user: state.user,
  };
}

export function useAuth() {
  const state = useContext(LocalAuthContext);
  return {
    getToken: async () => state.accessToken,
    isLoaded: state.isLoaded,
    isSignedIn: Boolean(state.user),
    sessionId: state.user ? "hivra-local-session" : null,
    userId: state.user?.id ?? null,
  };
}

export function useSession() {
  const state = useContext(LocalAuthContext);
  const getToken = useCallback(async () => state.accessToken, [state.accessToken]);
  const session = useMemo(
    () => state.user ? { id: "hivra-local-session", getToken } : null,
    [getToken, state.user],
  );
  return {
    isLoaded: state.isLoaded,
    isSignedIn: Boolean(state.user),
    session,
  };
}

/**
 * Clerk's useReverification retries a request after its "confirm it's you"
 * dialog. A local operator has no such dialog, and the server shim answers
 * that check for any signed-in operator, so requests go straight through.
 */
export function useReverification<Fetcher extends (...args: never[]) => unknown>(fetcher: Fetcher): Fetcher {
  return fetcher;
}

function safeRedirect(value: unknown, fallback: string): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : fallback;
}

function LocalOperatorSignIn(props: Record<string, unknown>) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/self-host/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Sign in failed.");
        return;
      }
      window.location.assign(
        safeRedirect(props.forceRedirectUrl ?? props.fallbackRedirectUrl, "/dashboard"),
      );
    } catch {
      setError("Could not reach this Hivra installation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        width: "100%",
        border: "1px solid var(--etched-border)",
        background: "var(--bg-surface)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.08)",
        padding: "2rem",
      }}
    >
      <p className="mono" style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--red)", marginBottom: 12 }}>
        Independent Hivra
      </p>
      <h1 className="serif" style={{ fontSize: "2.35rem", lineHeight: 1, marginBottom: 10 }}>
        Open local Hivra.
      </h1>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, marginBottom: 24 }}>
        Use the local operator created during setup. This is not a Hivra Cloud account, and the credentials stay on this installation.
      </p>
      <label className="mono" htmlFor="hivra-local-email" style={{ display: "block", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 7 }}>
        Operator email
      </label>
      <input
        id="hivra-local-email"
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        style={{ width: "100%", border: "1px solid var(--etched-border)", background: "transparent", padding: "12px 14px", marginBottom: 18 }}
      />
      <label className="mono" htmlFor="hivra-local-password" style={{ display: "block", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 7 }}>
        Password
      </label>
      <input
        id="hivra-local-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        style={{ width: "100%", border: "1px solid var(--etched-border)", background: "transparent", padding: "12px 14px", marginBottom: 18 }}
      />
      {error ? <p role="alert" style={{ color: "var(--red)", fontSize: 12, marginBottom: 14 }}>{error}</p> : null}
      <button
        type="submit"
        disabled={submitting}
        className="mono"
        style={{ width: "100%", border: 0, background: "var(--red)", color: "#fff", padding: "14px 18px", letterSpacing: "0.14em", textTransform: "uppercase", cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1 }}
      >
        {submitting ? "Signing in…" : "Open command center"}
      </button>
      <p style={{ color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.55, margin: "16px 0 0" }}>
        New installation? Finish setup in the Hivra app, or run the self-host setup command from your clone first.
      </p>
    </form>
  );
}

export function SignIn(props: Record<string, unknown>) {
  return <LocalOperatorSignIn {...props} />;
}

export function SignUp(props: Record<string, unknown>) {
  return <LocalOperatorSignIn {...props} fallbackRedirectUrl={props.fallbackRedirectUrl ?? "/dashboard"} />;
}

export function UserButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title="Sign out"
      aria-label="Sign out"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/self-host/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.assign("/sign-in");
      }}
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: "1px solid var(--etched-border)",
        background: "var(--ink-black)",
        color: "white",
        fontSize: 11,
        fontWeight: 700,
        cursor: busy ? "wait" : "pointer",
      }}
    >
      H
    </button>
  );
}
