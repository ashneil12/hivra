// cron-friendly — translates between the raw 5-field cron strings the box
// scheduler consumes and a small, friendly schedule model the Task modal can
// drive with frequency buttons + a time picker (no cron typing required).
//
// The friendly model only covers the common shapes (hourly / daily / weekly /
// monthly at a fixed time). Anything more exotic (step minutes, specific
// months, etc.) is left to an advanced raw-cron escape hatch in the UI, so we
// never silently drop a schedule we can't represent.

export type Frequency = "hourly" | "daily" | "weekly" | "monthly";

export interface FriendlySchedule {
  frequency: Frequency;
  minute: number; // 0-59
  hour: number; // 0-23 (24h)
  daysOfWeek: number[]; // 0-6 (0 = Sunday), used when frequency === 'weekly'
  dayOfMonth: number; // 1-31, used when frequency === 'monthly'
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

export const DEFAULT_FRIENDLY_SCHEDULE: FriendlySchedule = {
  frequency: "daily",
  minute: 0,
  hour: 9,
  daysOfWeek: [1, 2, 3, 4, 5], // weekdays, used if they switch to weekly
  dayOfMonth: 1,
};

function parseSingleInt(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

// Parse a cron day-of-week field (lists + ranges, e.g. "1,3,5" or "1-5") into a
// sorted, de-duplicated array of 0-6 values. Cron treats both 0 and 7 as Sunday.
function parseDaysOfWeek(field: string): number[] | null {
  const days = new Set<number>();
  for (const token of field.split(",")) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || end > 7) return null;
      for (let d = start; d <= end; d++) days.add(d === 7 ? 0 : d);
      continue;
    }
    const single = parseSingleInt(token, 0, 7);
    if (single === null) return null;
    days.add(single === 7 ? 0 : single);
  }
  if (days.size === 0) return null;
  return Array.from(days).sort((a, b) => a - b);
}

// Build a raw cron string from the friendly model.
export function cronFromFriendly(s: FriendlySchedule): string {
  const m = clamp(s.minute, 0, 59);
  const h = clamp(s.hour, 0, 23);
  switch (s.frequency) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly": {
      const days = s.daysOfWeek.length > 0 ? [...s.daysOfWeek].sort((a, b) => a - b) : [1];
      return `${m} ${h} * * ${days.join(",")}`;
    }
    case "monthly":
      return `${m} ${h} ${clamp(s.dayOfMonth, 1, 31)} * *`;
  }
}

// Parse a raw cron string into the friendly model, or null if it doesn't fit
// one of the supported shapes (the caller then falls back to advanced cron).
export function friendlyFromCron(cron: string): FriendlySchedule | null {
  const fields = (cron || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mField, hField, domField, monField, dowField] = fields;

  const minute = parseSingleInt(mField, 0, 59);
  if (minute === null) return null;
  if (monField !== "*") return null; // specific months aren't modelled

  // Hourly: any hour, any day.
  if (hField === "*" && domField === "*" && dowField === "*") {
    return { ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "hourly", minute, hour: 0 };
  }

  const hour = parseSingleInt(hField, 0, 23);
  if (hour === null) return null;

  // Daily.
  if (domField === "*" && dowField === "*") {
    return { ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "daily", minute, hour };
  }

  // Weekly (day-of-week constrained, day-of-month open).
  if (domField === "*" && dowField !== "*") {
    const daysOfWeek = parseDaysOfWeek(dowField);
    if (!daysOfWeek) return null;
    return { ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "weekly", minute, hour, daysOfWeek };
  }

  // Monthly (day-of-month constrained, day-of-week open).
  if (dowField === "*" && domField !== "*") {
    const dayOfMonth = parseSingleInt(domField, 1, 31);
    if (dayOfMonth === null) return null;
    return { ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "monthly", minute, hour, dayOfMonth };
  }

  return null;
}

// 24h hour -> {hour12, meridiem}
export function to12Hour(hour24: number): { hour12: number; meridiem: "AM" | "PM" } {
  const meridiem = hour24 < 12 ? "AM" : "PM";
  const hour12 = ((hour24 + 11) % 12) + 1;
  return { hour12, meridiem };
}

// {hour12, meridiem} -> 24h hour
export function to24Hour(hour12: number, meridiem: "AM" | "PM"): number {
  const base = hour12 % 12; // 12 -> 0
  return meridiem === "PM" ? base + 12 : base;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function formatTime(hour24: number, minute: number): string {
  const { hour12, meridiem } = to12Hour(hour24);
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

// A short, plain-English summary of a friendly schedule for the UI readout.
export function describeFriendly(s: FriendlySchedule): string {
  switch (s.frequency) {
    case "hourly":
      return `Every hour at :${String(s.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${formatTime(s.hour, s.minute)}`;
    case "weekly": {
      const days = [...s.daysOfWeek].sort((a, b) => a - b);
      let label: string;
      if (days.length === 7) label = "every day";
      else if (days.length === 5 && days.join(",") === "1,2,3,4,5") label = "weekdays";
      else if (days.length === 2 && days.join(",") === "0,6") label = "weekends";
      else if (days.length === 0) label = "Mon";
      else label = days.map((d) => DAY_LABELS[d]).join(", ");
      return `Every ${label} at ${formatTime(s.hour, s.minute)}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(s.dayOfMonth)} at ${formatTime(s.hour, s.minute)}`;
  }
}
