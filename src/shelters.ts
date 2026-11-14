import { cellCenter, estimateReserve, RESERVE_EPSILON, walkMinutes } from './mission.ts';
import type { Cell, LocalPoint, Terrain } from './mission.ts';
import { createReturnPlanner, evaLocation, pathFromLocation } from './eva.ts';
import type { EvaSession } from './eva.ts';

export const SHELTER_RADIUS_M = 150;
export const MIN_SKY_COVER = 3;
export const SPE_TARGETS = [3, 4, 5] as const;
export const SHELTER_COLOR = '#ffbf70';

const DIRECTION_COUNT = 16;
const EYE_HEIGHT_M = 1.7;
const MIN_SEPARATION_M = 30;
const MAX_SEARCH_MINUTES = 5;

export type ShelterCandidate = { cell: Cell; point: LocalPoint; cover: number; slope: number; concavity: number };

export function findShelterCandidates(terrain: Terrain, slopes: (number | null)[], slopeLimit: number) {
  const { width, height, cellM, elevationM } = terrain;
  const eastCell = cellM * Math.cos((terrain.bounds.south + terrain.bounds.north) / 2 / terrain.radiusM);
  const rays = Array.from({ length: DIRECTION_COUNT }, (_, sector) => {
    const angle = sector * 2 * Math.PI / DIRECTION_COUNT;
    const samples = [];
    for (let radius = cellM; radius <= SHELTER_RADIUS_M; radius += cellM) {
      const dr = Math.round(Math.cos(angle) * radius / cellM);
      const dc = Math.round(Math.sin(angle) * radius / eastCell);
      samples.push({ dr, dc, run: Math.hypot(dr * cellM, dc * eastCell) });
    }
    return samples;
  });

  function coverAt(cell: Cell, elevation: number) {
    let sum = 0;
    for (const ray of rays) {
      let tangent = 0;
      for (const { dr, dc, run } of ray) {
        const row = cell.row + dr;
        const col = cell.col + dc;
        if (row < 0 || row >= height || col < 0 || col >= width) return null;
        const sample = elevationM[row * width + col];
        if (sample == null) return null;
        tangent = Math.max(tangent, (sample - elevation - EYE_HEIGHT_M) / run);
      }
      // For a uniform azimuth sector the blocked fraction of the upper hemisphere is sin(horizon angle).
      sum += tangent / Math.hypot(1, tangent);
    }
    return 100 * sum / DIRECTION_COUNT;
  }

  const ranked: ShelterCandidate[] = [];
  for (let index = 0; index < elevationM.length; index++) {
    const elevation = elevationM[index];
    const slope = slopes[index];
    if (elevation == null || slope == null || slope > slopeLimit) continue;
    const cell = { row: Math.floor(index / width), col: index % width };
    const cover = coverAt(cell, elevation);
    if (cover === null || cover < MIN_SKY_COVER) continue;
    const west = elevationM[index - 1]!;
    const east = elevationM[index + 1]!;
    const north = elevationM[index - width]!;
    const south = elevationM[index + width]!;
    const concavity = (west + east - 2 * elevation) / eastCell ** 2 + (north + south - 2 * elevation) / cellM ** 2;
    ranked.push({ cell, point: cellCenter(terrain, cell), cover, slope, concavity });
  }
  return ranked;
}

export function shelterOptions(terrain: Terrain, slopes: (number | null)[], slopeLimit: number,
  candidates: ShelterCandidate[], session: EvaSession) {
  const location = evaLocation(session);
  const eastScale = Math.cos((terrain.bounds.south + terrain.bounds.north) / 2 / terrain.radiusM);
  const distance = (a: LocalPoint, b: LocalPoint) => Math.hypot((a.x - b.x) * eastScale, a.y - b.y);
  const options = [];
  for (const candidate of candidates) {
    if (walkMinutes(distance(candidate.point, location.point)) > MAX_SEARCH_MINUTES + RESERVE_EPSILON) continue;
    const option = createReturnPlanner(terrain, slopes, candidate.cell, slopeLimit)(location);
    if (!option) continue;
    const eta = walkMinutes(option.distanceM);
    if (eta > MAX_SEARCH_MINUTES + RESERVE_EPSILON) continue;
    const arrival = estimateReserve(option.distanceM, 0, session.elapsed, session.plan.settings);
    const resourcesLast = arrival.missionMinutes < arrival.depletion.depletionMinutes - RESERVE_EPSILON;
    options.push({ candidate, path: pathFromLocation(location, option), eta, arrival, resourcesLast });
  }
  options.sort((a, b) => Number(b.resourcesLast) - Number(a.resourcesLast) || a.eta - b.eta ||
    b.candidate.cover - a.candidate.cover || b.candidate.concavity - a.candidate.concavity);
  const distinct: typeof options = [];
  for (const option of options) {
    if (distinct.some((prior) => distance(prior.candidate.point, option.candidate.point) < MIN_SEPARATION_M)) continue;
    distinct.push(option);
    if (distinct.length === 3) break;
  }
  return distinct;
}

export type ShelterOption = ReturnType<typeof shelterOptions>[number];
export type ShelterPin = { id: string; point: LocalPoint; selected: boolean };
