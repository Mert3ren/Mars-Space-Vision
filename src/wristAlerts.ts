import { RESERVE_EPSILON } from './mission.ts';

// Training thresholds for the simulated wrist display. They only decide when to warn;
// the mission, resource and environment models stay unchanged.
/** Percentage points above the reserve minimum where a resource counts as low. */
export const LOW_RESOURCE_BUFFER = 10;
/** Remaining reserve margin, in minutes, that triggers a caution. */
export const RESERVE_CAUTION_MINUTES = 5;
/** Degrees below the selected slope limit where terrain counts as steep. */
export const STEEP_MARGIN_DEG = 3;
/** Work time left, in minutes, that announces the end of a task. */
export const TASK_FINISHING_MINUTES = 1;

export type WristAlertLevel = 'critical' | 'caution' | 'info';
export type WristAlert = { id: string; level: WristAlertLevel; message: string };

export type WristInput = {
  outcome: 'arrived' | 'depleted' | 'sheltered' | null;
  resources: { name: string; remaining: number }[];
  /** Reserve minimum in percent. */
  minimum: number;
  /** Projected margin if the planned mission continues; null when no plan is being followed. */
  continueMargin: number | null;
  /** Projected margin when returning to base now; null when unavailable. */
  returnMargin: number | null;
  speActive: boolean;
  radio: string;
  light: string;
  grade?: number;
  cross?: number;
  slopeLimit: number;
  /** Work time left at the current stop; null while not working. */
  stopRemaining: number | null;
};

const rank: Record<WristAlertLevel, number> = { critical: 0, caution: 1, info: 2 };

const radioMessages: Record<string, string> = {
  'Out of range': 'Radio link lost — out of range',
  'Terrain blocked': 'Terrain blocking radio',
};

export function wristAlerts(input: WristInput): WristAlert[] {
  if (input.outcome === 'arrived') return [];
  const alerts: WristAlert[] = [];
  const add = (id: string, level: WristAlertLevel, message: string) => alerts.push({ id, level, message });
  const depleted = input.outcome === 'depleted';

  if (input.speActive) add('spe', 'critical', 'Solar particle event — seek cover');

  for (const { name, remaining } of input.resources) {
    const key = name.toLowerCase();
    if (depleted && remaining <= RESERVE_EPSILON) add(`${key}-depleted`, 'critical', `${name} depleted`);
    else if (remaining < input.minimum - RESERVE_EPSILON) add(`${key}-reserve`, 'critical', `${name} below reserve`);
    else if (remaining < input.minimum + LOW_RESOURCE_BUFFER - RESERVE_EPSILON) add(`${key}-low`, 'caution', `${name} low`);
  }

  if (!depleted) {
    const margin = input.continueMargin ?? input.returnMargin;
    if (input.returnMargin !== null && input.returnMargin < -RESERVE_EPSILON) {
      add('return-reserve', 'critical', 'Return reserve exhausted — return now');
    } else if (input.continueMargin !== null && input.continueMargin < -RESERVE_EPSILON) {
      add('plan-reserve', 'critical', 'Mission plan exceeds reserve — return or shorten work');
    } else if (margin !== null && margin < RESERVE_CAUTION_MINUTES) {
      add('reserve-margin', 'caution', `Reserve margin under ${RESERVE_CAUTION_MINUTES} min`);
    }
  }

  if (input.radio !== 'Connected') {
    add(`radio-${input.radio.toLowerCase().replace(/\s+/g, '-')}`, 'caution',
      radioMessages[input.radio] ?? 'Radio status unavailable');
  }

  if (input.grade !== undefined) {
    const steepest = Math.max(Math.abs(input.grade), Math.abs(input.cross ?? 0));
    if (steepest >= input.slopeLimit - STEEP_MARGIN_DEG) add('steep', 'caution', 'Steep terrain ahead');
  }

  if (input.light === 'In shadow') add('shadow', 'info', 'Entering shadow');
  else if (input.light === 'Night') add('night', 'info', 'Night — low light');

  if (input.stopRemaining !== null && input.stopRemaining > RESERVE_EPSILON && input.stopRemaining < TASK_FINISHING_MINUTES) {
    add('task-finishing', 'info', 'Task finishing');
  }

  // Array.prototype.sort is stable, so rules keep their order within a level.
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Alerts that were not active in the previous evaluation. */
export function freshAlerts(previous: ReadonlySet<string>, alerts: WristAlert[]) {
  return alerts.filter(({ id }) => !previous.has(id));
}

/** Critical alerts stay visible while their condition lasts; the others can be acknowledged. */
export function visibleAlerts(alerts: WristAlert[], acknowledged: ReadonlySet<string>) {
  return alerts.filter(({ id, level }) => level === 'critical' || !acknowledged.has(id));
}

/** Forget acknowledgements of alerts that cleared, so they show again if they return. */
export function pruneAcknowledged(acknowledged: ReadonlySet<string>, alerts: WristAlert[]): ReadonlySet<string> {
  const active = new Set(alerts.map(({ id }) => id));
  const kept = [...acknowledged].filter((id) => active.has(id));
  return kept.length === acknowledged.size ? acknowledged : new Set(kept);
}
