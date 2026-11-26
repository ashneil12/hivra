import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";

/**
 * Desktop sign-in finishes inside the app's web view, so it needs the same
 * Clerk provider boundary as the browser sign-in routes.
 */
export default function DesktopLayout({ children }: { children: React.ReactNode }) {
  return <AuthClerkProvider>{children}</AuthClerkProvider>;
}
