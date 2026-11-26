import { readCanaryQaEmail } from '../canary-qa/config';
import type { SweepTarget } from './targets';

export function certificationEmail(env: Record<string, string | undefined>, targets: SweepTarget[], baseUrl: string): string | undefined {
  if (env.LAUNCH_SWEEP_KEEP_FAILED === '1' || env.LAUNCH_SWEEP_KEEP_PASSED?.trim()) {
    throw new Error('[launch-sweep] standing-account runs cannot leave computers running.');
  }
  if (env.LAUNCH_SWEEP_CERTIFICATION !== '1') return undefined;
  if (baseUrl !== 'https://canary.hermesos.cloud' || targets.length !== 1 || !targets[0].catalog) {
    throw new Error('[launch-sweep] certification requires exactly one catalog target on public Canary');
  }
  if (!env.CERTIFICATION_ACCOUNT_EMAIL?.trim()) {
    throw new Error('[launch-sweep] CERTIFICATION_ACCOUNT_EMAIL is not set.');
  }
  return readCanaryQaEmail({ CANARY_QA_EMAIL: env.CERTIFICATION_ACCOUNT_EMAIL });
}
