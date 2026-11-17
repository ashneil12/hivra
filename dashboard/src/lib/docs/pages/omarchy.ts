import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "omarchy",
  section: "computers",
  title: "Omarchy (prepared computer)",
  metaTitle: "Omarchy (prepared computer) on Hivra",
  metaDescription: "Omarchy is an Arch and Hyprland computer for development and AI work. It is a prepared computer, so a launch claims the one the site holds.",
  summary: "An Arch and Hyprland computer for development and AI work, offered as a prepared computer.",
  lastReviewed: "2026-11-17",
  status: "condition",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Omarchy is an opinionated Arch Linux and Hyprland computer made for development and AI work. Hivra offers it as Omarchy (prepared computer). It is an operating system image, so you launch it as a computer, not as an agent.",
      ],
    },
    {
      heading: "The condition",
      paragraphs: [
        "Omarchy is a prepared computer. A launch claims the one prepared Omarchy computer the site holds, so the Omarchy tile appears only where that computer is set up. Hivra does not yet build a fresh Omarchy computer for each customer.",
        "If you do not see Omarchy in Launch, the site you are on does not hold a prepared computer to claim.",
      ],
    },
    {
      heading: "Where it runs and what it costs",
      paragraphs: [
        "It runs on Hivra Cloud, and every Hivra Cloud computer needs a paid plan. See [what you pay for](/docs/plans-and-billing). The prepared computer has a fixed size of 4 CPU and 8 GB of memory.",
      ],
    },
    {
      heading: "Updates",
      paragraphs: [
        "A release in progress will reserve the prepared computer while it moves to the latest supported official stable v4 release of Omarchy. Opening your existing computer does not trigger an upgrade. This has not yet been confirmed live, so check Launch for what is offered today.",
      ],
    },
    {
      heading: "Other computers",
      paragraphs: [
        "If you want a plain Ubuntu desktop that anyone can launch, see [Ubuntu Desktop](/docs/ubuntu-desktop). For a headless machine, see [Linux computer](/docs/linux-computer).",
      ],
    },
  ],
  next: ["ubuntu-desktop", "linux-computer", "plans-and-billing"],
};
