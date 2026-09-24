import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "hermes-agent-skills-guide",
  title: "Hermes Agent skills: how they work, how to create them, and what's on the Skills Hub",
  metaDescription:
    "A complete guide to Hermes Agent skills. Covers the YAML/Markdown skill format, how the agent self-creates and improves skills, the agentskills.io Skills Hub marketplace, hermes skills commands, and how Hermes skills compare to OpenClaw plugins.",
  publishedDate: "2026-04-17",
  lastModified: "2026-09-24",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Skills are Hermes's extension system. The agent writes them for itself — but you can write them too.",
  intro:
    "Skills are Hermes Agent's equivalent of plugins — reusable capabilities the agent can call on demand. What separates them from every other plugin system is that Hermes writes skills for itself. When it solves a problem it will face again, it packages the solution into a skill and improves it over subsequent uses. This guide covers the format, the self-improvement loop, the community marketplace, and when to write your own.",
  sections: [
    {
      heading: "What a skill actually is",
      paragraphs: [
        "A Hermes skill is a Markdown file with YAML frontmatter stored in `~/.hermes/skills/`. The frontmatter describes the skill — name, description, when to use it. The body contains instructions in natural language. No compiled code required to write a basic skill.",
        "The agent reads skills into context when they are relevant. It decides which skills to load based on the description field in the frontmatter. A skill for 'deploy a Next.js app to Vercel' loads when you ask about Vercel deployments and stays out of context for unrelated tasks. Skills can also include executable code (Python, JavaScript, bash) that runs inside the agent's Docker sandbox — functioning as mini-programs the agent can invoke when the natural language instructions call for it.",
      ],
    },
    {
      heading: "The skill file format",
      paragraphs: [
        "Skills live in `~/.hermes/skills/` with a `.md` extension. Key YAML frontmatter fields:\n\n```yaml\n---\nname: deploy-vercel\ndescription: Deploy a Next.js or React application to Vercel. Use when user asks to deploy, push to Vercel, or set up Vercel hosting.\nversion: 1.2\nauthor: your-handle\ntags: [deployment, vercel, nextjs]\nplatforms: [telegram, discord, cli]\n---\n\n# Deploy to Vercel\n\nWhen deploying to Vercel:\n1. Check that vercel CLI is installed: `vercel --version`\n   - If missing, install: `npm i -g vercel`\n2. Run `vercel login` if not authenticated\n3. From the project root, run: `vercel --prod`\n4. Copy the deployment URL and confirm with the user\n```",
        "The description field is the most important — it determines when the agent loads this skill. Write it as a trigger condition: 'Use when...' or 'When the user asks about...'. A vague description loader gets triggered for unrelated tasks and wastes context tokens. A description that is too narrow means the skill gets missed when it should apply. Specific trigger language is worth the extra time to write.\n\nKey fields: `name` (internal identifier used in CLI commands), `description` (natural language trigger, critical), `version` (used for updates and rollback), `author` (shown on Skills Hub if published), `tags` (for `hermes skills list` filtering), `platforms` (which gateways can use this skill — defaults to all if omitted).",
      ],
    },
    {
      heading: "How Hermes self-creates and improves skills",
      paragraphs: [
        "When the agent successfully completes a complex task it is likely to face again, it can write the procedure as a new skill in `~/.hermes/skills/`. On the next occurrence: load the skill, follow the documented procedure, and if the procedure runs better or differently, update the skill file. This is the feature that distinguishes Hermes from most AI agents — no other mainstream agent framework in 2026 has a working equivalent.",
        "In practice: ask Hermes to set up a new Python project with a specific structure — a venv, pytest, linting config. It works through the steps, succeeds, and writes a `create-python-project.md` skill. Next time you ask for the same setup, it loads the skill and executes faster. If you later change your preferred structure, update the skill to match.\n\nThis does not happen automatically for every task — the agent decides when a procedure is worth codifying. You can also prompt it explicitly: 'Package what you just did as a skill so you can do it faster next time.' Skill versioning means the agent can roll back an update that broke something.",
      ],
    },
    {
      heading: "The Skills Hub — agentskills.io",
      paragraphs: [
        "The Skills Hub at agentskills.io is Hermes's community skill marketplace. Skills are submitted by community members and installable directly from the CLI:\n\n```bash\nhermes skills list              # browse installed skills\nhermes skills search vercel     # search the Hub\nhermes skills install deploy-vercel  # install by name\nhermes skills update            # update all installed skills\nhermes skills update deploy-vercel   # update specific skill\n```\n\nCategories on the Hub include: development tools (deployment, testing, CI), productivity (email management, calendar, task tracking), data processing (scraping, file conversion), system administration, API integrations (Stripe, GitHub, Notion), and lifestyle (personal finance, health tracking).",
        "Not all skills undergo security review. The same caution applies as installing any third-party package: read the skill file before running it in an environment with credentials or shell access. A skill calling a remote URL on your behalf, running shell commands with elevated permissions, or reading sensitive files deserves scrutiny before you install it. Check the author's publish history, read the implementation, and do not install anything touching your data from an author with no track record.",
      ],
    },
    {
      heading: "Hermes skills vs OpenClaw plugins",
      paragraphs: [
        "OpenClaw uses a plugin system hosted on ClawHub. The structural differences:\n\n| Feature | Hermes Skills | OpenClaw Plugins |\n|---------|--------------|------------------|\n| Format | Markdown + YAML | TypeScript/JavaScript module |\n| Self-creation | Yes | No |\n| Self-improvement | Yes | No |\n| Marketplace | agentskills.io | clawhub.io |\n| Security record | No public CVEs | 400+ malicious plugins reported |\n| Installation | `hermes skills install` | `openclaw plugins install` |",
        "The OpenClaw plugin system is more powerful for developers who want to write full TypeScript modules with complex logic. Hermes skills are more accessible — most users can write a working skill in 5 minutes without writing code. The self-creation feature has no OpenClaw equivalent. The 400+ malicious plugin figure comes from OpenClaw's own ClawHub community disclosures. The Hermes Skills Hub has not had a comparable public incident, partly because it is newer and smaller.",
      ],
    },
    {
      heading: "Writing your first skill",
      paragraphs: [
        "Create a skill file directly:\n\n```bash\nmkdir -p ~/.hermes/skills\nnano ~/.hermes/skills/my-first-skill.md\n```\n\nMinimal working example — a skill that formats Git commit messages:\n\n```markdown\n---\nname: git-commit-format\ndescription: Format a Git commit message following conventional commits spec. Use when user asks to commit changes or write a commit message.\nversion: 1.0\nauthor: your-handle\ntags: [git, development]\n---\n\n# Git Commit Format\n\nWhen writing a commit message:\n1. Use conventional commits format: `type(scope): description`\n2. Types: feat, fix, docs, style, refactor, test, chore\n3. Keep the first line under 72 characters\n4. Add a blank line before the body if explanation is needed\n5. Body explains WHY, not what (code shows what)\n\nExamples:\n- `feat(auth): add OAuth2 Google login`\n- `fix(api): handle null response from upstream provider`\n- `docs(readme): add self-hosting section`\n```\n\nTest it:\n\n```bash\nhermes -m 'Help me write a commit message for the changes I made to the authentication flow'\n```\n\nThe agent loads the skill because 'commit message' matches the trigger description.",
        "For skills with code execution, add a code block with a language tag:\n\n```python\n# This runs in the Docker sandbox when the agent invokes it\nimport subprocess\nresult = subprocess.run(['git', 'log', '--oneline', '-10'], capture_output=True, text=True)\nprint(result.stdout)\n```\n\nMake the intent for code blocks explicit in your prose instructions — the agent decides when to execute vs. use them as reference.",
      ],
    },
    {
      heading: "Managing and sharing skills",
      paragraphs: [
        "Useful skills commands:\n\n```bash\nhermes skills list                     # list all installed skills with versions\nhermes skills list --tag development   # filter by tag\nhermes skills info git-commit-format   # show skill metadata\nhermes skills edit git-commit-format   # open skill in $EDITOR\nhermes skills remove git-commit-format # uninstall\nhermes skills export git-commit-format # export as .tar.gz for sharing\nhermes skills import skill.tar.gz      # import from file\n```\n\nSkills are included in profile exports (`hermes profile export <name>`), making them portable between machines. When migrating from OpenClaw with `hermes claw migrate`, Hermes-compatible OpenClaw plugins convert to the skill format automatically where possible. Plugin types requiring TypeScript compilation fall back to stubs that describe what the original plugin did — those need manual rewriting.",
        "On Hivra, skills work the same way as when you self-host: they are stored on the agent's computer and survive restarts. The self-creation loop is particularly useful here: an agent you have been using for six months accumulates a skill library tuned to your exact working patterns. That library lives on the agent's computer and is included in profile exports.",
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need to know programming to write Hermes skills?",
      a: "No. Basic skills are plain Markdown with YAML frontmatter — natural language instructions the agent follows. Code is only needed if you want the skill to execute programs directly. Most useful skills (workflow guides, deployment checklists, formatting rules) are pure text.",
    },
    {
      q: "Can Hermes Agent write skills for itself?",
      a: "Yes. When it solves a repeatable problem, it packages the procedure as a skill in ~/.hermes/skills/ and improves it over subsequent uses. You can also prompt it explicitly: 'Package what you just did as a skill.'",
    },
    {
      q: "How is the Hermes Skills Hub different from ClawHub?",
      a: "The Skills Hub (agentskills.io) hosts Hermes Agent skills in Markdown format. ClawHub hosts OpenClaw plugins in TypeScript/JavaScript. Hermes skills are more accessible to non-developers. ClawHub has reported 400+ malicious plugins in its history; the Skills Hub is newer, smaller, and has not had a comparable incident.",
    },
    {
      q: "How do I know which skill the agent is using?",
      a: "Run Hermes with the debug flag: hermes --debug -m 'your question'. The output shows which skills were loaded. If the agent loaded a skill you didn't expect, the description is probably too broad.",
    },
    {
      q: "What happens to my skills if I move to a different server?",
      a: "Skills are stored in ~/.hermes/skills/ and included in profile exports: hermes profile export <name>. Import on the new server with hermes profile import <file>.",
    },
    {
      q: "How many skills can Hermes have installed?",
      a: "No hard limit. But skills loaded per context have a soft ceiling based on your model's context window — more installed skills means more potential tokens consumed. Well-scoped trigger descriptions keep loading efficient because irrelevant skills do not get loaded.",
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
    { slug: "hermes-agent-memory-system-explained", title: "Hermes Agent memory explained: SOUL.md, MEMORY.md, sessions, and Honcho" },
    { slug: "hermes-agent-telegram-discord-setup", title: "Hermes Agent gateway setup: Telegram, Discord, and 13 more" },
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: a direct comparison" },
  ],
};
