import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Get Started",
  description: "Create your account and launch an agent or a computer on Hivra.",
  robots: { index: false, follow: true },
};

export default function ReservePage() {
  redirect(PUBLIC_START_HREF);
}
