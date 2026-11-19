/** Prints tonight's rotating sample as LAUNCH_SWEEP_ONLY (comma-separated profile ids). */
import { pickNightlySample } from '../e2e/launch-sweep/targets';

// eslint-disable-next-line no-console -- the script's only output
console.log(pickNightlySample().map((target) => target.profileId).join(','));
