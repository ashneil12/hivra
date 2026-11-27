type Tier = {
  name: string;
  monthlyCents: number | null;
  cpu: number;
  ramGb: number;
  disk: string;
  ai: string | null;
  sleeps?: string;
  wake?: string;
};

export type HostedCompetitor = {
  slug: string;
  name: string;
  offering: string;
  description: string;
  checked: string;
  pricingSource: string;
  cpuLabel?: "CPU";
  uptimeSource?: string;
  tradeoff: string;
  agents: { label: string; source?: string }[];
  environment: { label: string; source?: string };
  valuePairs: { competitorTier: number; hivraSize: number }[];
  tiers: Tier[];
};

const agent37Personal = "https://www.agent37.com/personal";
const xCloudOpenClaw = "https://xcloud.host/openclaw-hosting/";

export const HOSTED_COMPETITORS: readonly HostedCompetitor[] = [
  {
    slug: "agent37",
    name: "Agent 37",
    offering: "Personal agent hosting",
    description: "Compare Hivra Cloud with Agent 37 Personal by price, CPU, RAM, disk, idle sleep, wake behavior and included AI.",
    checked: "2026-11-27",
    pricingSource: agent37Personal,
    tradeoff: "Agent 37 publishes disk sizes, offers a free tier that sleeps, and bundles AI models with usage caps on Plus and above.",
    agents: ["Hermes", "OpenClaw", "Claude Code", "Codex", "OpenCode", "Grok"].map((label) => ({ label })),
    environment: { label: "Isolated container" },
    valuePairs: [{ competitorTier: 2, hivraSize: 0 }, { competitorTier: 3, hivraSize: 1 }],
    tiers: [
      { name: "Free", monthlyCents: 0, cpu: 1, ramGb: 4, disk: "2 GB", ai: "$0.20 starter credit", sleeps: "Sleeps after 15 minutes idle", wake: "Wakes when you message it. Messaging app integrations start on Basic" },
      { name: "Basic", monthlyCents: 399, cpu: 1, ramGb: 4, disk: "8 GB", ai: "$1/month in AI credits" },
      { name: "Plus", monthlyCents: 999, cpu: 1, ramGb: 4, disk: "12 GB", ai: "GPT-6 Luna and DeepSeek V4.1 Flash with usage caps. The plan lists everything in Basic but does not restate the $1/month credit." },
      { name: "Pro", monthlyCents: 2999, cpu: 2, ramGb: 8, disk: "20 GB", ai: "$5/month in AI credits plus bundled models with usage caps" },
      { name: "Max", monthlyCents: 9999, cpu: 4, ramGb: 16, disk: "40 GB", ai: "$20/month in AI credits plus bundled models with usage caps" },
    ],
  },
  {
    slug: "xcloud",
    name: "xCloud",
    offering: "Managed OpenClaw hosting",
    description: "Compare Hivra Cloud with xCloud’s managed OpenClaw VPS tiers by monthly price, CPU, RAM, NVMe storage and AI billing.",
    checked: "2026-11-27",
    pricingSource: xCloudOpenClaw,
    tradeoff: "xCloud publishes NVMe disk sizes and offers larger VM sizes.",
    agents: [{ label: "OpenClaw" }, { label: "Hermes (separate setup)", source: "https://xcloud.host/hermes-agent-hosting/" }],
    environment: { label: "Dedicated managed virtual machine" },
    valuePairs: [{ competitorTier: 0, hivraSize: 1 }],
    tiers: [
      { name: "Cloud VPS 6 GB", monthlyCents: 2499, cpu: 4, ramGb: 6, disk: "100 GB NVMe SSD", ai: null },
      { name: "Cloud VPS 16 GB", monthlyCents: 5999, cpu: 6, ramGb: 16, disk: "200 GB NVMe SSD", ai: null },
      { name: "Cloud VPS 24 GB", monthlyCents: 8499, cpu: 8, ramGb: 24, disk: "300 GB NVMe SSD", ai: null },
      { name: "Cloud VPS 48 GB", monthlyCents: 13999, cpu: 12, ramGb: 48, disk: "400 GB NVMe SSD", ai: null },
      { name: "Cloud VPS 64 GB", monthlyCents: 21999, cpu: 16, ramGb: 64, disk: "500 GB NVMe SSD", ai: null },
      { name: "Cloud VPS 120 GB", monthlyCents: 37999, cpu: 24, ramGb: 120, disk: "600 GB NVMe SSD", ai: null },
    ],
  },
  {
    slug: "lobsterland",
    name: "Lobsterland",
    offering: "Managed agent hosting",
    description: "Compare Hivra Cloud with Lobsterland’s managed OpenClaw and Hermes tiers by price, CPU, RAM, storage and AI billing.",
    checked: "2026-11-27",
    pricingSource: "https://lobsterland.ing/pricing/",
    cpuLabel: "CPU",
    uptimeSource: "https://lobsterland.ing/",
    tradeoff: "Lobsterland publishes disk sizes and offers runtime-only plans for Hermes and OpenClaw if you don't need a full virtual machine.",
    agents: [{ label: "OpenClaw" }, { label: "Hermes" }],
    environment: { label: "Managed Kubernetes container", source: "https://lobsterland.ing/" },
    valuePairs: [{ competitorTier: 0, hivraSize: 0 }, { competitorTier: 1, hivraSize: 1 }],
    tiers: [
      { name: "Light", monthlyCents: 690, cpu: 1, ramGb: 3, disk: "20 GB", ai: "None; model-provider charges are separate with your own key" },
      { name: "Medium", monthlyCents: 1490, cpu: 2, ramGb: 8, disk: "80 GB", ai: "None; model-provider charges are separate with your own key" },
      { name: "Large", monthlyCents: 2990, cpu: 4, ramGb: 16, disk: "160 GB", ai: "None; model-provider charges are separate with your own key" },
    ],
  },
  {
    slug: "myclaw",
    name: "MyClaw",
    offering: "Managed agent hosting",
    description: "Compare Hivra Cloud with MyClaw’s hosted agent plans, including their compute, storage and model credits.",
    checked: "2026-11-27",
    pricingSource: "https://myclaw.ai/pricing",
    tradeoff: "MyClaw publishes disk sizes and includes its own AI credit units. Those credits do not have a comparable dollar value.",
    agents: [{ label: "OpenClaw", source: "https://myclaw.ai/" }, { label: "Hermes", source: "https://myclaw.ai/" }],
    environment: { label: "Isolated server (vendor says it is not a container; VM type not specified)", source: "https://myclaw.ai/blog/ai-agent-security-crisis-architecture-matters" },
    valuePairs: [{ competitorTier: 0, hivraSize: 1 }],
    tiers: [
      { name: "Pro", monthlyCents: 2000, cpu: 4, ramGb: 8, disk: "80 GB", ai: "4,000 MyClaw credits/month" },
      { name: "Max", monthlyCents: 4000, cpu: 8, ramGb: 16, disk: "160 GB", ai: "8,000 MyClaw credits/month at the base credit bundle" },
      { name: "Ultra", monthlyCents: 20000, cpu: 16, ramGb: 32, disk: "320 GB", ai: "40,000 MyClaw credits/month at the base credit bundle" },
      { name: "Enterprise", monthlyCents: null, cpu: 64, ramGb: 128, disk: "1.28 TB", ai: "Custom credits", sleeps: "Not specified for this tier", wake: "Not specified for this tier" },
    ],
  },
];

export const HOSTED_COMPARISON_PATH = "/compare";

export function hostedComparisonPath(slug: string): string {
  return `${HOSTED_COMPARISON_PATH}/${slug}`;
}
