/**
 * Clerk copy that names the product.
 *
 * Clerk fills `{{applicationName}}` from the Clerk instance's settings, and
 * both the Canary and production instances still carry the old name. These
 * strings say "Hivra" whatever the instance is called. They are every sign-in
 * and sign-up default that interpolates the application name in the pinned
 * @clerk/ui 1.7.0 English resource, plus the sign-up title. The OAuth-consent
 * and organization strings name other applications or flows this app does not
 * use, so they stay as is. Re-check the list when NEXT_PUBLIC_CLERK_UI_VERSION
 * moves. Emails and other Clerk-hosted text still use the instance's name.
 */
import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

type ClerkLocalization = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

export const HIVRA_CLERK_LOCALIZATION: ClerkLocalization = {
  signIn: {
    start: {
      title: "Sign in to Hivra",
      titleCombined: "Continue to Hivra",
      alternativePhoneCodeProvider: { title: "Sign in to Hivra with {{provider}}" },
    },
    emailCode: { subtitle: "to continue to Hivra" },
    emailCodeMfa: { subtitle: "to continue to Hivra" },
    emailLink: { subtitle: "to continue to Hivra" },
    emailLinkMfa: { subtitle: "to continue to Hivra" },
    phoneCode: { subtitle: "to continue to Hivra" },
    alternativePhoneCodeProvider: { subtitle: "to continue to Hivra" },
  },
  signUp: {
    start: {
      title: "Create your Hivra account",
      alternativePhoneCodeProvider: { title: "Sign up to Hivra with {{provider}}" },
    },
    emailLink: { subtitle: "to continue to Hivra" },
  },
};
