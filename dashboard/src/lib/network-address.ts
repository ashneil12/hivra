export function isIpv4Literal(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}
