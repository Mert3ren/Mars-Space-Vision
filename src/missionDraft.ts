import { estimateReserve, MAX_SCENARIO_MINUTES, MAX_SLOPE, planMission } from './mission.ts';
import type { Cell, Leg, ReserveSettings, RoutingSettings, Terrain } from './mission.ts';

export type DraftStop = { cell: Cell | null; task: string; minutes: number };
export type MissionDraft = { name: string; base: Cell | null; stops: DraftStop[]; routing?: RoutingSettings };
export type MissionWork = { task: string; minutes: number; leg: Leg };
const STORAGE_KEY = 'mars-space-vision.mission-draft';
export const MAX_MISSION_STOPS = 3;
export const emptyStop = (): DraftStop => ({ cell: null, task: '', minutes: 5 });

function validCell(value: unknown): value is Cell {
  return Boolean(value && typeof value === 'object' && 'row' in value && 'col' in value &&
    Number.isInteger(value.row) && Number.isInteger(value.col));
}

export function readMissionDraft(): MissionDraft {
  try {
    const saved: Partial<MissionDraft> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof saved?.name === 'string' && Array.isArray(saved.stops) && saved.stops.length) {
      const routing = saved.routing;
      const validRouting = routing && ['balanced', 'shortest', 'gentler'].includes(routing.priority) &&
        [8, 12, MAX_SLOPE].includes(routing.slopeLimit);
      return {
        name: saved.name.slice(0, 60), base: validCell(saved.base) ? saved.base : null,
        routing: validRouting ? routing : undefined,
        stops: saved.stops.slice(0, MAX_MISSION_STOPS).map((stop) => ({
          cell: validCell(stop?.cell) ? stop.cell : null,
          task: typeof stop?.task === 'string' ? stop.task.slice(0, 80) : '',
          minutes: Number.isInteger(stop?.minutes) && stop.minutes >= 0 && stop.minutes <= MAX_SCENARIO_MINUTES ? stop.minutes : 5,
        })),
      };
    }
  } catch {
    // The editor remains usable when storage is unavailable.
  }
  return { name: '', base: null, stops: [emptyStop()] };
}

export function saveMissionDraft(draft: MissionDraft) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Keep the in-memory draft available.
  }
}

export function buildMission(terrain: Terrain, slopes: (number | null)[], base: Cell, draft: MissionDraft,
  routing: RoutingSettings, settings: ReserveSettings, delay: number) {
  const stops: MissionWork[] = [];
  let from = base;
  for (const [index, stop] of draft.stops.entries()) {
    if (!stop.cell) return { stops, error: { index, reason: 'pick' as const } };
    const result = planMission(terrain, slopes, from, stop.cell, routing);
    if ('error' in result) return { stops, error: { index, reason: result.error } };
    stops.push({ task: stop.task.trim(), minutes: stop.minutes, leg: result.out });
    from = stop.cell;
  }
  if (!stops.length) return { stops, error: { index: 0, reason: 'pick' as const } };
  const result = planMission(terrain, slopes, from, base, routing);
  if ('error' in result) return { stops, error: { index: stops.length, reason: result.error } };
  const distance = stops.reduce((total, stop) => total + stop.leg.distanceM, result.out.distanceM);
  const work = stops.reduce((total, stop) => total + stop.minutes, 0);
  return { stops, inbound: result.out, distance, work, delay, reserve: estimateReserve(distance, work, delay, settings) };
}

export type MissionPreview = ReturnType<typeof buildMission>;
