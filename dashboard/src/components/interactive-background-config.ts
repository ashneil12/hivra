interface InteractiveBackgroundHints {
  width: number;
  height: number;
  coarsePointer?: boolean;
  prefersReducedMotion?: boolean;
  saveData?: boolean;
  densityMultiplier?: number;
  maxParticles?: number;
}

interface InteractiveBackgroundPauseHints {
  hidden?: boolean;
  prefersReducedMotion?: boolean;
  saveData?: boolean;
}

const DESKTOP_PARTICLE_CAP = 72;
const COARSE_POINTER_PARTICLE_CAP = 32;
const DESKTOP_PARTICLE_MIN = 18;
const COARSE_POINTER_PARTICLE_MIN = 12;
const DESKTOP_AREA_DIVISOR = 26000;
const COARSE_POINTER_AREA_DIVISOR = 42000;

export function getInteractiveBackgroundParticleCount({
  width,
  height,
  coarsePointer = false,
  prefersReducedMotion = false,
  saveData = false,
  densityMultiplier = 1,
  maxParticles,
}: InteractiveBackgroundHints) {
  if (prefersReducedMotion || saveData || width <= 0 || height <= 0) {
    return 0;
  }

  const area = width * height;
  const normalizedMultiplier = Number.isFinite(densityMultiplier)
    ? Math.max(0.25, densityMultiplier)
    : 1;
  const rawCount = Math.floor(
    (area / (coarsePointer ? COARSE_POINTER_AREA_DIVISOR : DESKTOP_AREA_DIVISOR)) *
      normalizedMultiplier
  );
  const min = coarsePointer ? COARSE_POINTER_PARTICLE_MIN : DESKTOP_PARTICLE_MIN;
  const defaultMax = coarsePointer ? COARSE_POINTER_PARTICLE_CAP : DESKTOP_PARTICLE_CAP;
  const resolvedMax = Number.isFinite(maxParticles ?? NaN)
    ? Math.max(min, Math.floor(maxParticles as number))
    : defaultMax;

  return Math.max(min, Math.min(resolvedMax, rawCount));
}

export function shouldPauseInteractiveBackground({
  hidden = false,
  prefersReducedMotion = false,
  saveData = false,
}: InteractiveBackgroundPauseHints) {
  return hidden || prefersReducedMotion || saveData;
}
