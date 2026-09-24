import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hivra",
    short_name: "Hivra",
    description: "Run and manage Hivra agents from an installable app.",
    start_url: "/dashboard",
    scope: "/dashboard/",
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#0d0d0d",
    categories: ["productivity", "utilities", "business"],
    // The approved Hivra mark (docs/brand/hivra-logo.jpg), exported by
    // docs/brand/export-brand-assets.py. It is a full-bleed opaque square whose
    // red H sits inside the maskable safe zone, so one file serves both purposes.
    icons: [
      {
        src: "/brand/hivra-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/hivra-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/hivra-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/hivra-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Where the installed app's long-press menu goes: the two inventories,
    // the one place to start something new, then money.
    shortcuts: [
      {
        name: "Agents",
        short_name: "Agents",
        description: "Open your agents",
        url: "/dashboard/agents",
      },
      {
        name: "Computers",
        short_name: "Computers",
        description: "Open your computers",
        url: "/dashboard/computers",
      },
      {
        name: "Launch",
        short_name: "Launch",
        description: "Launch an agent or a computer",
        url: "/dashboard/launch",
      },
      {
        name: "Wallet",
        short_name: "Wallet",
        description: "Open wallet and credit controls",
        url: "/dashboard/wallet",
      },
      {
        name: "Billing",
        short_name: "Billing",
        description: "Open billing and plan controls",
        url: "/dashboard/billing",
      },
    ],
  };
}
