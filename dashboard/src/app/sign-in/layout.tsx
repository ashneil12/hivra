import type { Metadata } from "next";
import { PostHogIdentify } from "@/app/providers/PostHogProvider";
import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";
import { AuthRuntimeNotice } from "@/components/auth/AuthRuntimeNotice";
import { isLocalAuthMode } from "@/lib/self-host/config";

export const metadata: Metadata = {
  title: "Sign In | Hivra",
  robots: {
    index: false,
    follow: false,
  },
};

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  const selfHosted = isLocalAuthMode();
  return (
    <AuthClerkProvider>
      {!selfHosted ? <PostHogIdentify /> : null}
      {!selfHosted ? <AuthRuntimeNotice /> : null}
      {children}
    </AuthClerkProvider>
  );
}
