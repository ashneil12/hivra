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
  borderRadius: "0.625rem",
  colorBackground: "var(--hg-glass-strong)",
  colorForeground: "var(--hg-text)",
  colorMutedForeground: "var(--hg-text-2)",
  colorPrimary: "var(--hg-accent)",
  colorPrimaryForeground: "var(--hg-on-accent)",
  colorInput: "var(--hg-fill-1)",
  colorInputForeground: "var(--hg-text)",
  // Borders, dividers and hover fills derive from the neutral colour.
  colorNeutral: "var(--hg-fg)",
  fontFamily: "inherit",
};

export const AUTH_CARD_ELEMENTS = {
  rootBox: "w-full",
  cardBox: "w-full max-w-full",
  card: "rounded-[var(--hg-radius-xl)] border border-[var(--hg-stroke)] shadow-[var(--hg-glass-edge),var(--hg-shadow-lg)] bg-[var(--hg-glass-strong)] backdrop-blur-xl p-8 pb-10",
  headerSubtitle: "text-[13px] text-[var(--hg-text-2)] mt-0",
  formButtonPrimary: "rounded-[var(--hg-radius-sm)] bg-[var(--hg-accent)] text-[var(--hg-on-accent)] hover:opacity-90 text-[13px] font-semibold py-3 transition-[opacity,background-color] duration-150 mt-2",
  formFieldInput: "rounded-[var(--hg-radius-md)] border-[var(--hg-stroke)] focus:border-[var(--hg-focus)] focus:ring-1 focus:ring-[var(--hg-focus)] text-sm py-2.5 bg-[var(--hg-fill-1)]",
  formFieldLabel: "text-[11px] tracking-[0.05em] font-semibold text-[var(--hg-text-2)] mb-1.5",
  footerActionLink: "text-[var(--hg-text)] underline underline-offset-4 hover:opacity-70 font-semibold transition-opacity",
  identityPreview: "rounded-[var(--hg-radius-md)] border border-[var(--hg-stroke)] bg-[var(--hg-fill-1)] px-4 py-3",
  identityPreviewEditButton: "text-[var(--hg-text)] hover:opacity-70 transition-opacity",
  dividerLine: "bg-[var(--hg-stroke)]",
  dividerText: "text-[11px] tracking-[0.05em] text-[var(--hg-text-3)] bg-transparent",
  socialButtonsBlockButton: "rounded-[var(--hg-radius-sm)] border border-[var(--hg-stroke)] hover:bg-[var(--hg-fill-hover)] hover:border-[var(--hg-stroke-strong)] text-[var(--hg-text)] transition-colors duration-150",
  socialButtonsBlockButtonText: "text-[13px] font-semibold",
  footer: "!bg-transparent !bg-none border-none rounded-none mt-2",
  footerActionText: "text-xs text-[var(--hg-text-2)]",
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
