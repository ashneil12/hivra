"use client";

import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";

// Fixed relaunch snapshot, verified against hivra.cloud/api/stats/agents-deployed
// on 2026-09-15. Same public total on every homepage; no polling/daily delta.
export const RELAUNCH_AGENTS_TOTAL = 2034;

export default function AgentsDeployedStatClient() {
  const { copy, locale } = useLocale();
  const t = copy.stats.hero;
  return <Link href="/stats" className="agents-deployed-stat"
    aria-label={`${RELAUNCH_AGENTS_TOTAL.toLocaleString(locale)} ${t.label}, as of 15 September 2026. ${t.fullStats.replace("→", "").trim()}`}
    style={{ display:"inline-flex", alignItems:"center", gap:12, flexWrap:"wrap", padding:"10px 16px", border:"1px solid var(--etched-border)", background:"var(--hivra-red-soft)", textDecoration:"none", color:"var(--ink-black)" }}>
    <span className="serif" style={{fontSize:"1.55rem",fontWeight:700,lineHeight:1,letterSpacing:"-.01em"}}>{RELAUNCH_AGENTS_TOTAL.toLocaleString(locale)}</span>
    <span style={{fontSize:".9rem",color:"var(--text-secondary)",fontWeight:500}}>{t.label}<small style={{display:"block"}}>As of 15 September 2026</small></span>
    <span className="mono" style={{marginLeft:"auto",fontSize:10,letterSpacing:".12em",fontWeight:700,color:"var(--text-muted)",whiteSpace:"nowrap"}}>{t.fullStats}</span>
  </Link>;
}
