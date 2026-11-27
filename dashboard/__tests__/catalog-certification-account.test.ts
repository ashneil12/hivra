import { certificationEmail } from '../e2e/launch-sweep/standing-account';
import { selectedTargets } from '../e2e/launch-sweep/targets';

const baseUrl = 'https://canary.hermesos.cloud';
const email = 'fixture+clerk_test@example.com';
const env = { LAUNCH_SWEEP_CERTIFICATION: '1', CERTIFICATION_ACCOUNT_EMAIL: email };

test('standing account mode is opt-in and limited to exactly one catalog target on public Canary', () => {
  expect(certificationEmail({}, selectedTargets('it-tools'), baseUrl)).toBeUndefined();
  expect(certificationEmail(env, selectedTargets('it-tools'), baseUrl)).toBe(email);
  for (const targets of [selectedTargets('missing'), selectedTargets('it-tools,kroki'), selectedTargets('claude-code')]) {
    expect(() => certificationEmail(env, targets, baseUrl)).toThrow('exactly one catalog target');
  }
  expect(() => certificationEmail(env, selectedTargets('it-tools'), 'http://localhost:3000')).toThrow('public Canary');
});

test('certification requires its own test address and cannot opt out of teardown', () => {
  const targets = selectedTargets('it-tools');
  expect(() => certificationEmail({ ...env, CERTIFICATION_ACCOUNT_EMAIL: undefined, CANARY_QA_EMAIL: email }, targets, baseUrl)).toThrow('is not set');
  expect(() => certificationEmail({ ...env, CERTIFICATION_ACCOUNT_EMAIL: 'fixture@example.com' }, targets, baseUrl)).toThrow('not a Clerk test address');
  expect(() => certificationEmail({ ...env, LAUNCH_SWEEP_KEEP_FAILED: '1' }, targets, baseUrl)).toThrow('cannot leave computers running');
  expect(() => certificationEmail({ ...env, LAUNCH_SWEEP_KEEP_PASSED: 'it-tools' }, targets, baseUrl)).toThrow('cannot leave computers running');
});
