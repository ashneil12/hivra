"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

const RESERVATION_STORAGE_KEY = "hermesos:reservation:email";

interface SuccessState {
  email: string;
  position: number;
  status: "queued" | "invited" | "onboarded" | "cancelled";
  already_existed: boolean;
}

interface PostBody {
  position: number;
  status: SuccessState["status"];
  already_existed: boolean;
}

interface GetBody {
  found: boolean;
  position?: number;
  status?: SuccessState["status"];
}

const labelStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: "var(--text-secondary)",
  fontWeight: 700,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.85rem 1rem",
  background: "var(--vellum-bg)",
  border: "1px solid var(--etched-border)",
  color: "var(--text-primary)",
  fontSize: 15,
  borderRadius: 0,
  fontFamily: "inherit",
};

const submitStyle: CSSProperties = {
  padding: "0.95rem 1.4rem",
  background: "var(--text-primary)",
  color: "var(--vellum-bg)",
  border: "1px solid var(--text-primary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  fontWeight: 700,
  cursor: "pointer",
  borderRadius: 0,
};

function isValidEmailShape(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function ReserveForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [lookupChecked, setLookupChecked] = useState(false);

  // On first mount, look up the signed-in visitor's existing registration
  // (if any) so they land on the success state. The legacy endpoint is
  // auth-gated — for unauthenticated visitors, we only pre-fill the email
  // input from localStorage and let them re-submit, which idempotently
  // returns their current record via the POST endpoint.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const stored = window.localStorage.getItem(RESERVATION_STORAGE_KEY);
        const trimmed = stored?.trim();
        if (trimmed && !isValidEmailShape(trimmed)) {
          window.localStorage.removeItem(RESERVATION_STORAGE_KEY);
        } else if (trimmed) {
          // Pre-fill the form so a returning visitor's email is already
          // there; the POST submit will return their existing position.
          if (!cancelled) setEmail(trimmed);
        }
        const res = await fetch(`/api/reserve`);
        if (!res.ok) {
          // 401 (signed-out) is expected — the form is the fallback.
          return;
        }
        const json = (await res.json()) as { success: boolean; data?: GetBody };
        if (cancelled) return;
        if (json.success && json.data?.found && json.data.position && json.data.status) {
          setSuccess({
            email: trimmed || "",
            position: json.data.position,
            status: json.data.status,
            already_existed: true,
          });
        }
      } catch {
        // ignore — show the form
      } finally {
        if (!cancelled) setLookupChecked(true);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    const trimmedEmail = email.trim();
    if (!isValidEmailShape(trimmedEmail)) {
      setSubmitError("Enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Always register for Free. Subscription paths (Pro / Power)
        // are presented after signup on the confirmation page, not here.
        body: JSON.stringify({ email: trimmedEmail, tier_intent: "free" }),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: PostBody;
      };

      if (!res.ok || !json.success || !json.data) {
        setSubmitError(json.error || "Something went wrong. Please try again.");
        return;
      }

      try {
        window.localStorage.setItem(RESERVATION_STORAGE_KEY, trimmedEmail);
      } catch {
        // localStorage may be disabled — failure is non-fatal
      }

      // Redirect to Clerk sign-up. The registration row is already created
      // server-side; signing up locks it to the user's Clerk account
      // (the funnel page after signup picks up where this leaves off).
      const params = new URLSearchParams({
        from: "reserve",
        email_address: trimmedEmail,
      });
      window.location.href = `/sign-up?${params.toString()}`;
      // Keep submitting=true so the button stays disabled during the
      // hard navigation; setSubmitting(false) in finally handles the
      // edge case where the navigation is cancelled.
      return;
    } catch {
      setSubmitError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setSuccess(null);
    setSubmitError(null);
  }

  if (success) {
    return (
      <section className="etched-card" style={{ padding: "1.5rem", display: "grid", gap: "1.1rem" }} aria-live="polite">
        <p className="mono" style={{ ...labelStyle, color: "var(--red, #b3261e)" }}>
          {success.already_existed ? "Registration already started" : "Registration started"}
        </p>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          <p className="serif" style={{ fontSize: "1.6rem", fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
            Free setup is ready
          </p>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
            Continue with <strong>{success.email}</strong> to finish account setup and launch Free.
          </p>
        </div>
        <div style={{ display: "grid", gap: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid var(--etched-border)" }}>
          <p className="mono" style={labelStyle}>What happens next</p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.4rem", color: "var(--text-secondary)", fontSize: 14 }}>
            <li>Create your account and start Free.</li>
            <li>Anti-abuse checks may apply during provisioning.</li>
            <li>Upgrade to Pro or Power any time from billing.</li>
          </ul>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="mono"
          style={{
            ...submitStyle,
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--etched-border)",
            justifySelf: "start",
          }}
        >
          Use a different email
        </button>
      </section>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="etched-card"
      style={{ padding: "1.5rem", display: "grid", gap: "1.25rem" }}
      noValidate
    >
      <div style={{ display: "grid", gap: "0.45rem" }}>
        <label htmlFor="reserve-email" className="mono" style={labelStyle}>
          Email
        </label>
        <input
          id="reserve-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
          aria-invalid={Boolean(submitError)}
        />
      </div>

      {submitError ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "0.75rem 0.9rem",
            border: "1px solid var(--red, #b3261e)",
            color: "var(--red, #b3261e)",
            fontSize: 13,
          }}
        >
          {submitError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting || !lookupChecked}
        className="mono"
        style={{
          ...submitStyle,
          opacity: submitting ? 0.6 : 1,
          cursor: submitting ? "wait" : "pointer",
        }}
      >
        {submitting ? "Registering..." : "Register"}
      </button>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
        Use the email you want attached to your Hivra account.
      </p>
    </form>
  );
}
