export const MICRODOLLARS_PER_USD = 1_000_000;
export const MICRODOLLARS_PER_CENT = 10_000;

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function centsToMicrodollars(cents: number): number {
  assertNonNegativeInteger(cents, "cents");
  return cents * MICRODOLLARS_PER_CENT;
}

export function multiplyMicrodollarsByRatio(
  amountMicroUsd: number,
  numerator: number,
  denominator: number
): number {
  assertNonNegativeInteger(amountMicroUsd, "amountMicroUsd");
  assertPositiveInteger(numerator, "numerator");
  assertPositiveInteger(denominator, "denominator");

  return Math.ceil((amountMicroUsd * numerator) / denominator);
}

export function microdollarsToDisplayDollars(
  amountMicroUsd: number,
  fractionDigits = 4
): string {
  assertNonNegativeInteger(amountMicroUsd, "amountMicroUsd");
  assertNonNegativeInteger(fractionDigits, "fractionDigits");

  return `$${(amountMicroUsd / MICRODOLLARS_PER_USD).toFixed(fractionDigits)}`;
}
