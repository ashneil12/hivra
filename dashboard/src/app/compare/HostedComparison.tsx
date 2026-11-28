import Link from "next/link";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import ComparisonTable from "@/components/public-editorial/ComparisonTable";
import StructuredData from "@/components/StructuredData";
import { getCardTrialOffer } from "@/lib/billing/card-trial";
import { hostedComparisonPath, HOSTED_COMPETITORS, type HostedCompetitor } from "@/lib/compare/hosted-competitors";
import { CLOSING } from "@/lib/compare/shared-copy";
import { paidKvmSleepAvailable } from "@/lib/hivra/paid-kvm-sleep-availability";
import { SITE_URL } from "@/lib/seo-urls";
import { buildHostedProducts, formatPricesAsOf, HOSTED_AI, HOSTED_DISK, hostedSizes, type HostedSize } from "../pricing/pricing-content";
import styles from "@/components/public-editorial/secondary-site.module.css";
import compare from "./compare.module.css";
import Inline from "./Inline";

const money = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;
const sizeLabel = (size: HostedSize) => `Hivra Cloud · ${size.cpu} vCPU, ${size.ramGb} GB`;
const hivraAgents = "Hermes, OpenClaw, Claude Code, Codex, Agent Zero, Aeon and DeepSeek Harness (alpha)";

export function HostedComparisonDirectory({ sizes }: { sizes: HostedSize[] }) {
  return (
    <section className={compare.hostedDirectory} aria-labelledby="hosted-pricing">
      <h2 id="hosted-pricing">Compare personal agent hosting by plan</h2>
      <p>
        {sizes.map((size, i) => (
          <span key={size.planKey}>
            {i > 0 ? " or " : null}
            <Link href={`/pricing#cloud-${size.planKey}`}>{size.price}/month for {size.cpu} vCPU and {size.ramGb} GB of RAM</Link>
          </span>
        ))}. Compare those Hivra Cloud sizes with managed alternatives and see where the extra spend makes sense.
      </p>
      <ul className={compare.hostedLinks}>
        {HOSTED_COMPETITORS.map((provider) => (
          <li key={provider.slug}>
            <Link href={hostedComparisonPath(provider.slug)}>Hivra vs {provider.name}</Link>
            <p>{provider.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Source({ label, href }: { label: string; href: string }) {
  return <a href={href}>{label}</a>;
}

function ValueSummary({ provider, sizes }: { provider: HostedCompetitor; sizes: HostedSize[] }) {
  return <ul className={compare.hostedLinks}>
    {provider.valuePairs.map(({ competitorTier, hivraSize }) => {
      const tier = provider.tiers[competitorTier];
      const size = sizes[hivraSize];
      if (tier.monthlyCents === null) return null;
      const savings = tier.monthlyCents - size.monthlyCents;
      const cpuRatio = size.cpu / tier.cpu;
      const cpuLabel = provider.cpuLabel ?? "vCPU";
      const advantage = [
        cpuRatio === 2 ? "twice the listed CPU count" : cpuRatio > 1 ? "a higher listed CPU count" : "",
        size.ramGb > tier.ramGb ? "more RAM" : size.ramGb === tier.ramGb ? "the same RAM" : "",
      ].filter(Boolean).join(" and ");
      return <li key={tier.name}>
        <p>
          <strong>{size.price}/month for {size.cpu} vCPU and {size.ramGb} GB of RAM</strong>{" "}
          on Hivra Cloud vs <Source label={`${money(tier.monthlyCents)}/month for ${tier.cpu} ${cpuLabel} and ${tier.ramGb} GB of RAM`} href={provider.pricingSource} /> on {provider.name} {tier.name}.
          {savings >= 0 && advantage && cpuRatio >= 1 && size.ramGb >= tier.ramGb ? ` Hivra gives you ${advantage}${savings > 0 ? ` for ${money(savings)} less per month` : " at the same monthly price"}.` : null}
        </p>
      </li>;
    })}
  </ul>;
}

export default function HostedComparison({ provider }: { provider: HostedCompetitor }) {
  const entryMonthlyCents = getCardTrialOffer()?.monthlyCents;
  const sizes = hostedSizes(entryMonthlyCents);
  const sleep = paidKvmSleepAvailable();
  const path = hostedComparisonPath(provider.slug);
  const cite = (label: string, href = provider.pricingSource) => <Source label={label} href={href} />;
  return (
    <PublicSite className={styles.page} data-page="compare-detail">
      <StructuredData schema={{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
              { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` },
              { "@type": "ListItem", position: 3, name: provider.name, item: `${SITE_URL}${path}` },
            ],
          },
          ...buildHostedProducts(SITE_URL, entryMonthlyCents),
        ],
      }} />
      <main className={`${styles.main} ${compare.main}`} id="main-content">
        <Breadcrumbs items={[{ label: "Compare", href: "/compare" }, { label: provider.name }]} />
        <header className={compare.masthead}>
          <h1>Hivra vs {provider.name}: hosted agent pricing</h1>
          <p className={compare.hostedIntro}>{provider.description}</p>
        </header>
        <div className={compare.hostedDetail}>
          <section aria-labelledby="value-heading">
            <h2 id="value-heading">What your monthly budget buys</h2>
            <ValueSummary provider={provider} sizes={sizes} />
            <p>
              Hivra gives you a full VM for the agent and its tools. {cite(provider.tradeoff)}
            </p>
            <p>
              Compared with {cite(`${provider.name} ${provider.offering}`)}. Source checked <time dateTime={provider.checked}>{formatPricesAsOf(provider.checked)}</time>.
              {" "}Prices are USD for one month, before tax or discounts, and may have changed. The RAM and CPU ratios use listed resources, not measured performance. AI value is shown separately, not subtracted from hosting prices.
            </p>
            <p>Hivra CPU and memory are totals for the plan. Storage persists, but the plan does not publish a fixed GB allowance, so disk value cannot be ranked.</p>
          </section>
          <nav aria-label="Jump to a tier">
            <ul className={compare.tierLinks}>
              {provider.tiers.map((tier, i) => <li key={tier.name}><Link href={`#tier-${i + 1}`}>{tier.name}</Link></li>)}
            </ul>
          </nav>
          {provider.tiers.map((tier, i) => (
            <section key={tier.name} id={`tier-${i + 1}`} aria-labelledby={`tier-title-${i + 1}`}>
              <h2 id={`tier-title-${i + 1}`}>{provider.name} {tier.name} vs Hivra Cloud</h2>
              <ComparisonTable
                caption={`${provider.name} ${tier.name} vs Hivra Cloud`}
                rowHeading="Feature"
                columns={[...sizes.map(sizeLabel), { label: `${provider.name} ${tier.name}`, note: <time dateTime={provider.checked}>Checked {formatPricesAsOf(provider.checked)}</time> }]}
                rows={[
                  { label: "Monthly price", cells: [...sizes.map((size) => `${size.price} for ${size.cpu} vCPU and ${size.ramGb} GB`), cite(tier.monthlyCents === null ? "Contact sales" : money(tier.monthlyCents))] },
                  { label: "CPU", cells: [...sizes.map((size) => `${size.cpu} vCPU`), cite(`${tier.cpu} ${provider.cpuLabel ?? "vCPU"}`)] },
                  { label: "RAM", cells: [...sizes.map((size) => `${size.ramGb} GB`), cite(`${tier.ramGb} GB`)] },
                  { label: "Disk storage", cells: [HOSTED_DISK, HOSTED_DISK, cite(tier.disk)] },
                  { label: "Computer", cells: ["Full virtual machine", "Full virtual machine", cite(provider.environment.label, provider.environment.source)] },
                  { label: "Uptime", cells: [...sizes.map(() => sleep ? "Stays on by default; optional idle sleep on eligible paid VMs" : "Stays on; closing your browser does not stop it"), cite(tier.sleeps ?? "Always on", provider.uptimeSource)] },
                  { label: "Wake behavior", cells: [...sizes.map(() => sleep ? "Supported owner access wakes a sleeping VM with its files intact" : "No idle wake needed"), cite(tier.wake ?? "No idle wake needed", provider.uptimeSource)] },
                  { label: "Supported agents", cells: [...sizes.map((size) => <Link key={size.planKey} href="/agents">{hivraAgents}</Link>), provider.agents.map((agent, index) => <span key={agent.label}>{index > 0 ? ", " : null}{cite(agent.label, agent.source)}</span>)] },
                  { label: "AI credits and models", cells: [HOSTED_AI, HOSTED_AI, cite(tier.ai ?? "No AI credit advertised on this plan page")] },
                  { label: "Monthly price per GB of RAM", cells: [...sizes.map((size) => money(size.monthlyCents / size.ramGb)), cite(tier.monthlyCents ? money(tier.monthlyCents / tier.ramGb) : "Not comparable")] },
                  { label: "Monthly price per listed CPU", cells: [...sizes.map((size) => money(size.monthlyCents / size.cpu)), cite(tier.monthlyCents ? money(tier.monthlyCents / tier.cpu) : "Not comparable")] },
                ]}
              />
            </section>
          ))}
        </div>
        <section className={compare.closing} aria-labelledby="closing-heading">
          <div>
            <h2 id="closing-heading">{CLOSING.heading}</h2>
            <p><Inline text={CLOSING.text} /></p>
          </div>
          <ActionLinks items={CLOSING.links} />
        </section>
      </main>
    </PublicSite>
  );
}
