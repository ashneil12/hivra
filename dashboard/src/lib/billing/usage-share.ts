// What-if arithmetic for the operator usage and margins report: given who pays,
// what the servers cost and how many hours each agent type really worked, how
// would a share of what is left be split by use? Pure and read-only. Nothing
// here bills, pays or stores anything.

export interface UsageShareSubscriber {
  userId: string;
  /** What this person pays per month, in minor units (cents). 0 when comped. */
  priceMinor: number;
  /** Pays through an app store, which takes its own cut in place of the card fee. */
  viaAppStore?: boolean;
}

export interface UsageShareUsageRow {
  userId: string;
  agentType: string;
  agents: number;
  activeHours: number;
  inferenceRequests: number;
  inferenceChargedMicroUsd: number;
  inferenceCostMicroUsd: number;
  runEvents: number;
}

export interface UsageShareAssumptions {
  /** Percent of what is left after fees and servers that would be shared. 0 to 100. */
  sharePercent: number;
  /** Payment fee, percent of each payment. */
  feePercent: number;
  /** Payment fee, fixed part per payment, in minor units. */
  feeFixedMinor: number;
  /** App store cut, percent of each payment made through one. The card fee when left out. */
  appStoreFeePercent?: number;
  /** All servers for the month, in minor units. */
  serverCostMinor: number;
}

export interface UsageShareTypeRow {
  agentType: string;
  agents: number;
  people: number;
  payingPeople: number;
  activeHours: number;
  /** This type's part of all measured hours, 0 to 1. */
  hoursShare: number;
  inferenceRequests: number;
  inferenceChargedMicroUsd: number;
  inferenceCostMicroUsd: number;
  runEvents: number;
  /** What this type would receive, in minor units. */
  shareMinor: number;
}

export interface UsageSharePreview {
  payingPeople: number;
  payingPeopleWithUsage: number;
  /** Paying people who pay through an app store. */
  appStorePeople: number;
  revenueMinor: number;
  feesMinor: number;
  serverCostMinor: number;
  netMinor: number;
  /** The part of net that would be shared. */
  poolMinor: number;
  /** The part of the pool that reached an agent type. */
  assignedMinor: number;
  /** The part of the pool from paying people with no measured use. */
  unassignedMinor: number;
  totalActiveHours: number;
  byType: UsageShareTypeRow[];
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finiteOrZero(value)));
}

/**
 * Split a share of net revenue by use. Each paying person's part of the pool
 * (in proportion to what they pay) is divided between the agent types they
 * used, in proportion to the hours each type worked for them. A paying person
 * with no measured use leaves their part unassigned.
 */
export function computeUsageSharePreview(
  subscribers: UsageShareSubscriber[],
  usage: UsageShareUsageRow[],
  assumptions: UsageShareAssumptions,
): UsageSharePreview {
  const sharePercent = clamp(assumptions.sharePercent, 0, 100);
  const feePercent = clamp(assumptions.feePercent, 0, 100);
  const feeFixedMinor = Math.max(0, finiteOrZero(assumptions.feeFixedMinor));
  const appStoreFeePercent = assumptions.appStoreFeePercent === undefined ? null : clamp(assumptions.appStoreFeePercent, 0, 100);
  const serverCostMinor = Math.max(0, finiteOrZero(assumptions.serverCostMinor));

  // One price per person; the highest wins if a person appears twice.
  const priceByUser = new Map<string, number>();
  const appStoreUsers = new Set<string>();
  for (const subscriber of subscribers) {
    const price = Math.max(0, finiteOrZero(subscriber.priceMinor));
    const known = priceByUser.get(subscriber.userId);
    if (known !== undefined && known >= price) continue;
    priceByUser.set(subscriber.userId, price);
    if (subscriber.viaAppStore) appStoreUsers.add(subscriber.userId);
    else appStoreUsers.delete(subscriber.userId);
  }
  const paying = [...priceByUser.entries()].filter(([, price]) => price > 0);
  const revenue = paying.reduce((sum, [, price]) => sum + price, 0);
  const fees = paying.reduce((sum, [userId, price]) => {
    if (appStoreFeePercent !== null && appStoreUsers.has(userId)) return sum + (price * appStoreFeePercent) / 100;
    return sum + (price * feePercent) / 100 + feeFixedMinor;
  }, 0);
  const net = revenue - fees - serverCostMinor;
  const pool = (Math.max(0, net) * sharePercent) / 100;

  const hoursByUser = new Map<string, number>();
  for (const row of usage) {
    hoursByUser.set(row.userId, (hoursByUser.get(row.userId) ?? 0) + Math.max(0, finiteOrZero(row.activeHours)));
  }
  const totalActiveHours = [...hoursByUser.values()].reduce((sum, hours) => sum + hours, 0);

  interface Running extends Omit<UsageShareTypeRow, "people" | "payingPeople" | "hoursShare" | "shareMinor"> {
    users: Set<string>;
    payingUsers: Set<string>;
    share: number;
  }
  const byType = new Map<string, Running>();
  for (const row of usage) {
    const hours = Math.max(0, finiteOrZero(row.activeHours));
    const entry = byType.get(row.agentType) ?? {
      agentType: row.agentType, agents: 0, activeHours: 0, inferenceRequests: 0,
      inferenceChargedMicroUsd: 0, inferenceCostMicroUsd: 0, runEvents: 0,
      users: new Set<string>(), payingUsers: new Set<string>(), share: 0,
    };
    entry.agents += Math.max(0, finiteOrZero(row.agents));
    entry.activeHours += hours;
    entry.inferenceRequests += finiteOrZero(row.inferenceRequests);
    entry.inferenceChargedMicroUsd += finiteOrZero(row.inferenceChargedMicroUsd);
    entry.inferenceCostMicroUsd += finiteOrZero(row.inferenceCostMicroUsd);
    entry.runEvents += finiteOrZero(row.runEvents);
    entry.users.add(row.userId);

    const price = priceByUser.get(row.userId) ?? 0;
    const userHours = hoursByUser.get(row.userId) ?? 0;
    if (price > 0) entry.payingUsers.add(row.userId);
    if (price > 0 && revenue > 0 && userHours > 0 && hours > 0) {
      entry.share += ((pool * price) / revenue) * (hours / userHours);
    }
    byType.set(row.agentType, entry);
  }

  const rows: UsageShareTypeRow[] = [...byType.values()]
    .map(({ users, payingUsers, share, ...rest }) => ({
      ...rest,
      people: users.size,
      payingPeople: payingUsers.size,
      hoursShare: totalActiveHours > 0 ? rest.activeHours / totalActiveHours : 0,
      shareMinor: Math.round(share),
    }))
    .sort((a, b) => b.shareMinor - a.shareMinor || b.activeHours - a.activeHours || a.agentType.localeCompare(b.agentType));

  const poolMinor = Math.round(pool);
  const assignedMinor = Math.min(poolMinor, rows.reduce((sum, row) => sum + row.shareMinor, 0));
  return {
    payingPeople: paying.length,
    payingPeopleWithUsage: paying.filter(([userId]) => (hoursByUser.get(userId) ?? 0) > 0).length,
    appStorePeople: paying.filter(([userId]) => appStoreUsers.has(userId)).length,
    revenueMinor: Math.round(revenue),
    feesMinor: Math.round(fees),
    serverCostMinor: Math.round(serverCostMinor),
    netMinor: Math.round(net),
    poolMinor,
    assignedMinor,
    unassignedMinor: poolMinor - assignedMinor,
    totalActiveHours,
    byType: rows,
  };
}
