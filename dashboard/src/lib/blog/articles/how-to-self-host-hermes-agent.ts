import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Sources fetched 2026-11-19:
// https://hermes-agent.nousresearch.com/docs/getting-started/installation
// https://hermes-agent.nousresearch.com/install.sh
// https://hermes-agent.nousresearch.com/docs/user-guide/docker
// https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways
// https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram
// https://hermes-agent.nousresearch.com/docs/user-guide/backup-and-transfer
// https://hermes-agent.nousresearch.com/docs/reference/cli-commands
// https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals
// https://docs.docker.com/reference/cli/docker/compose/down/
// https://docs.docker.com/engine/containers/start-containers-automatically/
// https://raw.githubusercontent.com/ashneil12/hivra/8b1892fdd765a59a9062b594f98ea94a84cf6275/docs/STATUS.md
// https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/backup.py
// https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/backup_keep_host.py
// https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/gateway_setup_service.py
export const article: BlogArticle = {
  slug: "how-to-self-host-hermes-agent",
  title: "How to self-host Hermes Agent: install, verify, and restore",
  metaTitle: "Self-host Hermes Agent: setup, checks and recovery",
  metaDescription:
    "Run Hermes Agent on a Linux server or in Docker. Verify the gateway after logout, check persistent storage, and back up before an upgrade.",
  publishedDate: "2026-04-11",
  lastModified: "2026-11-19",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "A working prompt is the start. A server you can restart and restore is the goal.",
  intro:
    "This walkthrough is for Hermes Agent on a server you control. Pick a host install or a container, prove that the gateway survives a disconnected SSH session, then protect the state before upgrading. A running container is not a backup, and a successful install is not a recovery plan.",
  shortAnswer:
    "To self-host Hermes Agent, install it as a Linux user or run the official Docker image with persistent storage at /opt/data. Configure a model provider and gateway, then verify operation after SSH logout and restart. Before upgrading, create a private backup and know how to restore it. Docker is optional for host installs.",
  sections: [
    {
      heading: "Choose a host install or a container",
      paragraphs: [
        "There are two separate Docker decisions in Nous's [Docker guide](https://hermes-agent.nousresearch.com/docs/user-guide/docker). You can run the entire agent in `nousresearch/hermes-agent`, or install Hermes on the host and use Docker only as its terminal backend. The latter sandboxes shell commands, not the whole agent. Docker is optional for host installs; it is needed if you choose the Docker terminal backend or the container route.",
        [
          "| Route | Where Hermes runs | What you maintain |",
          "|---|---|---|",
          "| Host install | Under a Linux user account | OS, Hermes install, gateway service, data directory |",
          "| Official Docker image | Inside the container, with user data mounted at `/opt/data` | OS, Docker, image version, persistent mount, gateway configuration |",
        ].join("\n"),
        "Choose one route for this walkthrough. Do not start a host gateway and a container gateway with the same bot credentials. For a broader hosting comparison, use [Hermes Agent in the cloud](/blog/hermes-agent-cloud); this page stays with deployment checks and recovery.",
      ],
    },
    {
      heading: "Before you start: access, workload, and ownership",
      paragraphs: [
        "Self-hosting fits better when you want the disk and update schedule under your control, need your own server, or are willing to diagnose Linux services and storage. It also makes you responsible for credentials, OS maintenance, recovery, and deciding what tools the agent may use.",
        "Have SSH access, a dedicated non-root Linux account, and credentials for your chosen model provider. Follow the [installation prerequisites](https://hermes-agent.nousresearch.com/docs/getting-started/installation) for your OS. Run the installer as the account that will own Hermes, not as root and then copy its installation into another user's home.",
        "Size the server for your workload rather than treating a RAM figure as a guarantee. Browser tools, concurrent work, the terminal sandbox, and local model inference need different headroom. Treat community server sizes as starting points, not guarantees. The [Hermes VPS comparison](/blog/best-vps-for-hermes-agent) owns provider and sizing comparisons. Setup time, maintenance effort, and model usage costs depend on your workload and experience; this guide does not promise a fixed bill or completion time.",
        "Do not open an inbound port just to follow the container example. Publish a service only when you intend to use it and have configured its access controls. Telegram alone does not require publishing the container's API or dashboard ports.",
      ],
    },
    {
      heading: "Host route: install as the service user",
      paragraphs: [
        "From the intended Linux account, use Nous's source installer:\n\n```\ncurl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\n```\n\nFollow its shell/PATH instructions, then configure the provider and tools:\n\n```\nhermes setup\nhermes doctor\n```\n\nResolve the diagnostics that apply to your chosen setup before installing a background gateway. A Docker warning is not a reason to switch deployment routes without understanding which terminal backend you selected.",
        "Use the installed `hermes` launcher rather than a hardcoded virtual-environment path. The [service-user installation notes](https://hermes-agent.nousresearch.com/docs/getting-started/installation) explain launcher ownership and system prerequisites. If you choose the Docker terminal backend, install Docker using its supported instructions before enabling that backend. It is a separate choice from running the whole agent in Docker.",
      ],
    },
    {
      heading: "Container route: make the data mount explicit",
      paragraphs: [
        "Nous's example uses a host directory at `~/.hermes` mounted inside the container at `/opt/data`. The image is stateless; config, API keys, sessions, skills, and memories belong in that persistent mount. Run interactive setup first:\n\n```\nmkdir -p ~/.hermes\ndocker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup\n```",
        "Then start the gateway with the same mount:\n\n```\ndocker run -d --name hermes --restart unless-stopped -v ~/.hermes:/opt/data nousresearch/hermes-agent gateway run\n```\n\nNo ports are published here. The [official Docker guide](https://hermes-agent.nousresearch.com/docs/user-guide/docker) explains the optional API and dashboard configuration. Stable and development image channels are different; record the image version or digest you use before changing it.",
        "Before replacing a container, inspect its mount configuration in your Docker tooling. Confirm that the destination is `/opt/data`, the source is the host directory or named volume you intended, and that it contains the existing Hermes state. Reuse that same source when recreating the container. An empty but valid mount can produce an empty agent without an obvious startup failure.",
        "`docker compose down` does not inherently erase a named volume. Docker's [Compose down reference](https://docs.docker.com/reference/cli/docker/compose/down/) says named volumes are removed with `--volumes`; anonymous volumes are not automatically reattached by a subsequent `up`. Use an explicit bind mount or named volume for persistent data, and do not use volume-removal options as part of a routine upgrade.",
      ],
    },
    {
      heading: "Connect Telegram without duplicating the whole setup",
      paragraphs: [
        "Configure the gateway's Telegram token and user authorization before relying on it. Nous documents `TELEGRAM_ALLOWED_USERS` and [DM pairing as an authorization option](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram); do not infer the bot's access policy from one missing environment variable. Verify that your intended account can send a message and that an unauthorized account cannot start an agent conversation. Never paste bot tokens into screenshots or support logs.",
        "Use the dedicated [Hermes Telegram setup guide](/blog/how-to-set-up-hermes-agent-telegram) for bot creation and account setup. Here, the acceptance check is that the gateway answers the right person after the server session ends.",
      ],
    },
    {
      heading: "Install the service, then prove it survives disconnects",
      paragraphs: [
        "For the host route, install and start the managed gateway from the same account that owns the installation:\n\n```\nhermes gateway install\nhermes gateway start\n```\n\nA Linux user service needs lingering to run without a login. The installation guide gives this administrator command; replace `SERVICE_USER` with the actual account:\n\n```\nsudo loginctl enable-linger SERVICE_USER\n```\n\nSee [managed gateway services](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways) for service types and platform-specific behavior. Do not assume a manually launched terminal process is a managed service.",
        "For the container route, the example's `--restart unless-stopped` is the [container restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/). It does not mean an intentionally stopped container will start itself again. Check both the container and gateway, not just whether Docker is running.",
        "Use this acceptance checklist before leaving the server unattended:\n\n- Send a representative request and confirm a reply from the intended gateway.\n- Disconnect SSH completely and send another request from your chat client.\n- Reconnect and check the service manager or container state and gateway logs. Investigate repeated restarts instead of treating a running status as success.\n- During a maintenance window, restart the service or container and repeat the request.\n- If reboot recovery matters, perform a planned server reboot, then verify a reply without first logging into the service account.\n- Confirm the same profile and expected conversation or memory are present after each restart.\n\nA failed check is a reason to inspect service ownership, lingering, authorization, provider errors, and the persistent mount before moving on.",
      ],
    },
    {
      heading: "Back up before upgrading, and rehearse a restore",
      paragraphs: [
        "Nous's [Backup & Transfer guide](https://hermes-agent.nousresearch.com/docs/user-guide/backup-and-transfer) documents a full-home backup:\n\n```\nhermes backup -o my-agent.zip\n```\n\nRun it in the Hermes environment you actually use. For a container deployment, that means the installation using the mounted `/opt/data`, not an unrelated host installation. Store a private copy off the server before upgrading; a zip left only on the same disk is not protection against losing that disk.",
        "The archive includes every profile, memory, persona, skills, conversations, scheduled jobs, settings, and keys and logins such as `.env` and `auth.json`. Treat it as a credential-bearing secret. Do not commit it, attach it to an issue, or upload it to a public file-sharing link.",
        "The documented restore command is:\n\n```\nhermes import my-agent.zip\n```\n\nPlain `hermes import` is an overlay: it overwrites matching files from the archive but leaves destination-only files in place. It is not an exact mirror or a full replacement. Import may start a gateway service that is already installed for the destination, even if it was stopped; it does not install a missing service. For a rehearsal, use a fresh isolated destination with no gateway service installed, then inspect the restored files and state before intentionally installing or starting one. Do not assume a profile-only export includes the credentials of a full-home backup.",
        "For a Hermes Cloud transfer, upstream documents a separate replacement workflow using `hermes import my-agent.zip --keep-host --messaging-off`. That workflow removes eligible destination files absent from the archive while preserving the host-owned items listed in the guide; its imported messaging bots are switched off. This is not the behavior of plain `hermes import` and is not a generic exact-replacement shortcut for a self-hosted restore. Read the option's keep list and printed undo point before using it. After import, run `hermes doctor`, verify the persistent mount again if using Docker, start only the intended gateway, and repeat the disconnect/restart checklist. Check expected state as well as the ability to get a fresh reply.",
      ],
    },
    {
      heading: "Upgrade with a recovery point, not just an old image",
      paragraphs: [
        "Save the backup and record the current installation or image version first. On the host path, use the upstream update instructions. On the container path, recreate with the selected image and the same persistent mount. Recheck diagnostics, logs, authorization, and expected state afterward.",
        "An old image and a data backup solve different problems. Reverting an image alone does not undo changes already written to the data directory, and an older runtime may not understand newer state. If the upgrade fails, stop and consult the release's recovery guidance before choosing an image rollback or a state restore. The [older self-hosting notes](/blog/self-hosting-hermes-guide) cover broader failure patterns; this checklist is the install and recovery path.",
      ],
    },
    {
      heading: "The Hivra alternative and its current availability",
      paragraphs: [
        "Hermes on Hivra runs in Hivra Cloud only, not on My cloud or My server. Existing Hermes agents keep their current setup. The official-installer setup below is in testing and is not on hivra.cloud yet.",
        "In that setup, Hivra creates a private computer, runs Hermes's own installer, and opens Hermes's own web UI behind Hivra sign-in. Owners update it with `hermes update` or the Update Hermes button on the agent's Manage tab. Hivra is not affiliated with Nous Research.",
        `Every Hivra Cloud computer needs a paid plan. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. This is the managed-computer alternative if you do not want to maintain the server. Self-hosting fits better if you need your own infrastructure or want direct control of the disk, service configuration, and recovery process.`,
        "See [the managed Hermes option and its current availability](/agents/hermes).",
      ],
    },
  ],
  faqs: [
    {
      q: "Does self-hosting Hermes Agent require Docker?",
      a: "No. Docker is optional for a host installation. It is required if you choose the official container image or Docker as the terminal backend. Those are separate choices: the backend sandboxes shell commands while Hermes itself can remain on the host.",
    },
    {
      q: "What is the cheapest server that can actually run Hermes Agent?",
      a: "There is no guaranteed cheapest server for every workload. Compare current provider prices and availability, including tax, IPv4, storage, and model usage. Size for the tools you intend to run rather than treating a community configuration as a guaranteed minimum.",
    },
    {
      q: "How long does the setup actually take?",
      a: "There is no reliable fixed duration. Linux experience, provider setup, chat authorization, and the tools you enable change the work involved. Budget time for logout and restart checks and a restore rehearsal, not just the installer finishing.",
    },
    {
      q: "Does docker compose down delete Hermes memory?",
      a: "Not inherently. Named volumes are removed with the --volumes option, while anonymous volumes are not automatically reattached by a subsequent up. Use a persistent bind mount or named volume at /opt/data, verify the source before recreating, and keep a private backup outside the server.",
    },
    {
      q: "What should I save before a Hermes upgrade?",
      a: "Create a full backup with hermes backup -o my-agent.zip, keep it private because it includes credentials, and save a copy off the server. Record the current image or installation version and persistent mount. Rehearse hermes import on a private destination before depending on recovery.",
    },
    {
      q: "Can Hermes on Hivra run on my own server?",
      a: "No. Hermes on Hivra is Hivra Cloud only. Existing agents keep their current setup; the official-installer setup is in testing and is not on hivra.cloud yet. For a server you control, use the upstream self-hosting route described here.",
    },
  ],
  relatedArticles: [
    { slug: "hermes-agent-cloud", title: "How to run Hermes Agent in the cloud: VPS, Docker, Nous Hermes Cloud or a computer of its own" },
    { slug: "self-hosting-hermes-guide", title: "Self-hosting Hermes Agent: steps, costs and what breaks" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "how-to-set-up-hermes-agent-telegram", title: "How to set up Hermes Agent on Telegram" },
    { slug: "hermes-agent-memory-system-explained", title: "Hermes Agent memory and persistent state" },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
  ],
  relatedComparisons: [
    { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
};
