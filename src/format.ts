import { RESERVE_EPSILON } from './mission.ts';

export function duration(minutes: number, roundUp = false) {
  const seconds = (roundUp ? Math.ceil : Math.floor)(minutes * 60 + (roundUp ? -1e-6 : 1e-6));
  return `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`;
}

export function percent(value: number) {
  return `${Math.max(0, value).toFixed(1)}%`;
}

export function marginLabel(value: number) {
  const absolute = Math.abs(value);
  if (absolute < RESERVE_EPSILON) return '0 min';
  return `${value < 0 ? '−' : '+'}${absolute < 1 ? '<1' : Math.round(absolute)} min`;
}
