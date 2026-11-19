import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "omarchy",
  section: "computers",
  title: "Omarchy (prepared computer)",
  metaTitle: "Omarchy (prepared computer) on Hivra",
  metaDescription: "Omarchy is an Arch and Hyprland desktop for development and AI work. Hivra supports existing prepared computers; new claims are paused.",
  summary: "An Arch and Hyprland desktop for existing owners. New claims are paused.",
  lastReviewed: "2026-11-19",
  status: "condition",
  blocks: [
    {
      heading: "What it is and who it is for",
      paragraphs: [
        "Omarchy is an opinionated Arch Linux and Hyprland desktop made for development and AI work. Hivra lists it as **Omarchy (prepared computer)**. It is an operating system, not an agent. There is no chat tab and no AI model to connect.",
        "It suits developers and AI power users who already like a tiling Hyprland desktop on Arch and want one they can open in a browser tab, without installing it on their own machine.",
        "Hivra is not affiliated with the Omarchy project or its maintainers. Hivra's catalog pins the upstream v4.0.2 release (MIT licensed) as the version the prepared computer was built from.",
        "If you want a plain Ubuntu desktop that anyone with a paid plan can launch as many times as the plan has room for, read [Ubuntu Desktop](/docs/ubuntu-desktop) instead. For a headless machine, see [Linux computer](/docs/linux-computer).",
      ],
    },
    {
      heading: "New claims are paused",
      paragraphs: [
        "If you already have a prepared Omarchy computer, open it from Computers. Hivra is not assigning prepared Omarchy computers again until a clean reset or rebuild can be verified. For a new desktop, use [Ubuntu Desktop](/docs/ubuntu-desktop).",
      ],
    },
    {
      heading: "What you get",
      paragraphs: [
        "| Item | Value |\n| --- | --- |\n| Operating system | Arch Linux with Hyprland, upstream Omarchy |\n| Pinned upstream release | v4.0.2 |\n| Size | 4 CPU and 8 GB of memory, fixed |\n| Where it runs | Hivra Cloud only |\n| Access | **Desktop** view opened from Computers, plus **Manage** |\n| Browser toggle | None. That switch belongs to agents |",
        "The size is fixed at 4 CPU and 8 GB; Manage cannot resize it.",
        "Hivra does not show a disk size for the prepared computer, so this page does not promise one.",
        "What you install, sign in to and save on the prepared computer does not touch your laptop.",
      ],
    },
    {
      heading: "Open and use it",
      paragraphs: [
        "Open the computer from **Computers** or from Home. Omarchy always lists Desktop and Manage. When the computer is running and its workspace connection is up, Terminal and Files can also appear. The views you will use are:\n\n| View | What it is |\n| --- | --- |\n| **Desktop** | The Omarchy desktop, opened in your browser |\n| **Manage** | Power, usage, updates and removal. Labelled **Settings** in the sidebar |",
        "The Desktop view only loads while the computer is running. A stopped computer does not open a desktop: open **Manage** and press Start.",
        "Desktop opens behind your Hivra sign-in. If it fails, use Retry on the Desktop view. Hivra's catalog still lists in-browser streaming of Omarchy's Hyprland desktop as not fully accepted, so the Desktop view can show the messages in the troubleshooting table below. Treat this as a prepared computer with a condition, not a guaranteed smooth desktop.",
        "Day to day, treat it like any Omarchy install. Use its own menus and terminal for your software, and keep anything you cannot recreate copied somewhere you control.",
      ],
    },
    {
      heading: "Manage: power, usage and updates",
      paragraphs: [
        "Open the computer and choose **Manage**. For Omarchy the Manage side nav shows **Overview**, **Agents**, **Resources**, **Updates** and **Advanced**. There is no Recovery section because prepared computers have no restore points yet, and no Private network section. **Agents** lists agents on the computer, but adding one is not offered on Omarchy.",
        "- **Power.** Start, Stop and Restart live on **Overview**. Each is disabled with a reason when it cannot apply.\n- **Force off.** Prepared computers are one of the kinds that offer a force off for when a computer will not shut down in time. It switches the machine off at once, so unsaved work in open apps is lost. Use it only when the computer is stuck.\n- **Resources.** Fixed, as described above. There is no resize.\n- **Delete.** Removing the claim ends your access without destroying the VM. Back up anything you want to keep before deleting. You cannot claim it again while new claims are paused.",
        "Omarchy has no restore points yet, and Manage has no Recovery section for it. Hivra does not promise backups of what is on the computer.",
      ],
    },
    {
      heading: "Updates and refresh",
      paragraphs: [
        "There are two different things called an update here, and they are easy to mix up.",
        "**Updating Omarchy yourself.** Open the Omarchy menu on the desktop and choose Update, then Omarchy. You have admin (sudo) on this computer, so it does not ask for a password. Every Omarchy 4 release works here; a new major version needs Hivra to check it first. Hivra's desktop connection updates itself and is installed the next time you open Desktop. **Manage**, then **Updates** shows this too. Opening your existing computer never triggers an upgrade.",
        "**An already-reserved refresh.** Desktop stays blocked until the release, migrations and rebooted kernel are verified. Refresh is not a guest reset.",
        "If a refresh fails, the computer is kept for inspection rather than retried automatically, and nothing grants you Desktop on a guess.",
      ],
    },
    {
      heading: "When something goes wrong",
      paragraphs: [
        "| What you see | What it means and what to do |\n| --- | --- |\n| No Omarchy tile in Launch | New claims are paused. Choose another computer, such as [Ubuntu Desktop](/docs/ubuntu-desktop). |\n| This prepared computer no longer matches the setup Hivra has on record, so its power controls are off. Contact support. | Hivra cannot confirm the computer is the configured one, so it turned the power controls off. Restart and Force off will not work. Contact support. |\n| \"Desktop is still opening\" | The computer answered but the desktop has not finished. Wait, then retry. |\n| \"Desktop couldn’t open\" with Retry | The desktop runtime did not start. Retry. A retry can repair the runtime. |\n| \"Desktop couldn’t open right now\" | Preparing the desktop is paused for now. Try again later. |\n| \"This computer needs a current launch\" | The computer's desktop setup is out of date for this site. If it is the prepared computer, contact support. |\n| \"Stream disconnected\" | Only the stream dropped. Your desktop and its apps are still running. Reconnect. |",
        "If the computer will not respond at all, open **Manage**, read the status, and use Restart. If it stays stuck, **Force off** under **Advanced**, then Start. If the power controls are off with a message about the setup on record, Restart and Force off are not available and you need to contact support. For problems that are not specific to Omarchy, see [Troubleshooting](/docs/troubleshooting).",
      ],
    },
    {
      heading: "What Hivra does and does not do",
      paragraphs: [
        "- Hivra does not build a fresh Omarchy computer for each customer.\n- Hivra does not run Omarchy on a server you connected. It runs on Hivra Cloud only, and every Hivra Cloud computer needs a paid plan.\n- Hivra does not resize it. The size is fixed at 4 CPU and 8 GB.\n- Hivra does not promise backups, and a separate computer is a boundary, not a guarantee that what runs on it is safe. See [security and access](/docs/security-and-access).",
      ],
    },
  ],
  faqs: [
    {
      q: "Why is there no Omarchy tile for me?",
      a: "New Omarchy claims are paused. Existing owners can still open their computer from Computers. For a new desktop, choose Ubuntu Desktop.",
    },
    {
      q: "Can I run Omarchy on my own server?",
      a: "No. Prepared Omarchy runs on Hivra Cloud only. A server you connect can run other computers, but not this one.",
    },
    {
      q: "Can I make the Omarchy computer bigger?",
      a: "No. It has a fixed size of 4 CPU and 8 GB of memory.",
    },
    {
      q: "Will opening Omarchy start a refresh?",
      a: "No. Opening an existing computer does not start an upgrade. You can update Omarchy yourself from its own menu.",
    },
    {
      q: "Is Hivra affiliated with the Omarchy project?",
      a: "No. Hivra is not affiliated with Omarchy or its maintainers. Hivra offers a prepared computer built from the upstream release it pins.",
    },
  ],
  next: ["ubuntu-desktop", "linux-computer", "plans-and-billing"],
};
