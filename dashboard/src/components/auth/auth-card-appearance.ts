/**
 * The Clerk card on sign-in, sign-up and get-started.
 *
 * Colours come from Clerk's own variables, bound to the app's theme tokens, so
 * the card, its text, inputs and primary button follow light and dark mode in
 * every browser. Two things made the old per-page copies miss:
 *
 * - @clerk/ui 1.x renamed the colour variables. `colorText`, `colorInputText`
 *   and `colorInputBackground` are ignored now; the names are below.
 * - Clerk's styles are unlayered, and Tailwind's utilities sit in
 *   `@layer utilities`, so a colour utility on a Clerk element loses to Clerk's
 *   own colour. The old `bg-white/95` card never painted: the card was the
 *   transparent `colorBackground`, with Clerk's default text colours. Those only
 *   follow dark mode where CSS light-dark() works (not WebKit before 17.5, as
 *   on macOS 14.0–14.4); elsewhere dark mode got dark text on the dark page and
 *   white text on the near-white primary button.
 *
 * The element classes keep layout and type, and name the same tokens so they
 * agree with the variables if Clerk's styles are ever layered below Tailwind.
 */

type AuthCardElements = Record<string, string>;

/** Every colour variable @clerk/ui 1.7 reads (see its parseVariables). */
export const CLERK_UI_COLOR_VARIABLES = [
  "colorPrimary", "colorPrimaryForeground", "colorDanger", "colorSuccess", "colorWarning", "colorNeutral",
  "colorForeground", "colorMuted", "colorMutedForeground", "colorBackground", "colorInputForeground", "colorInput",
  "colorShimmer", "colorRing", "colorShadow", "colorBorder", "colorModalBackdrop",
] as const;

const AUTH_CARD_VARIABLES = {
  borderRadius: 0,
  colorBackground: "var(--bg-surface)",
  colorForeground: "var(--ink-black)",
  colorMutedForeground: "var(--text-secondary)",
  colorPrimary: "var(--ink-black)",
  colorPrimaryForeground: "var(--vellum-bg)",
  colorInput: "transparent",
  colorInputForeground: "var(--ink-black)",
  // Borders, dividers and hover fills derive from the neutral colour.
  colorNeutral: "var(--ink-black)",
  fontFamily: "inherit",
};

export const AUTH_CARD_ELEMENTS = {
  rootBox: "w-full",
  cardBox: "w-full max-w-full",
  card: "rounded-none border border-[var(--etched-border)] shadow-[0_24px_80px_rgba(0,0,0,0.08)] bg-[var(--bg-surface)] p-8 pb-10",
  headerSubtitle: "mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)] mt-0",
  formButtonPrimary: "rounded-none bg-[var(--ink-black)] text-[var(--vellum-bg)] hover:bg-[var(--ink-hover)] font-mono uppercase tracking-[0.15em] text-[11px] font-bold py-3.5 transition-all mt-2",
  formFieldInput: "rounded-none border-[var(--etched-border)] focus:border-[var(--ink-black)] focus:ring-1 focus:ring-[var(--ink-black)] text-sm py-2.5 bg-transparent",
  formFieldLabel: "mono text-[9px] uppercase tracking-[0.15em] font-bold text-[var(--text-secondary)] mb-1.5",
  footerActionLink: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] font-bold transition-colors",
  identityPreview: "rounded-none border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-4 py-3",
  identityPreviewEditButton: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] transition-colors",
  dividerLine: "bg-[var(--etched-border)]",
  dividerText: "mono text-[9px] uppercase tracking-[0.15em] text-[var(--text-muted)] bg-transparent",
  socialButtonsBlockButton: "rounded-none border border-[var(--etched-border)] hover:bg-[var(--bg-elevated)] hover:border-[var(--ink-black)] text-[var(--ink-black)] transition-all",
  socialButtonsBlockButtonText: "mono text-[11px] font-semibold tracking-wider uppercase",
  footer: "!bg-transparent !bg-none border-none rounded-none mt-2",
  footerActionText: "text-xs text-[var(--text-secondary)]",
  main: "gap-6",
} satisfies AuthCardElements;

/** The shared card, with a page's own element classes (its title size, say). */
export function authCardAppearance(overrides: AuthCardElements = {}) {
  // Any element name, so a page can style one the shared card leaves alone.
  const elements: AuthCardElements = { ...AUTH_CARD_ELEMENTS, ...overrides };
  return {
    elements,
    variables: { ...AUTH_CARD_VARIABLES },
  };
}
