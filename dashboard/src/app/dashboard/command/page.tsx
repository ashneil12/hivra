// The Hivra Command Center has merged into the main /dashboard Command Center
// (the multi-agent surface now lives there, in the Command Center's own design).
// This route redirects so old links + the in-app back buttons still resolve.
import { redirect } from "next/navigation";

export default function CommandCenterRedirect() {
  redirect("/dashboard");
}
