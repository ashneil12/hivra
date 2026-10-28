import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Get Started",
  description: "Create your Hivra account. A free account works with a computer or server you connect yourself. Every Hivra Cloud computer needs a paid plan.",
  robots: { index: false, follow: true },
};

export default function ReservePage() {
  redirect(PUBLIC_START_HREF);
}
