import { cellAt, localPoint, planMission, walkMinutes } from './mission.ts';
import type { Cell, Leg, LocalPoint, Route, Terrain } from './mission.ts';

export const stations = [
  { id: 'station-1', name: 'Ground Station 1', point: { x: 445, y: 655 }, detail: 'Scenario checkpoint north of the direct traverse.' },
  { id: 'station-2', name: 'Ground Station 2', point: { x: 655, y: 325 }, detail: 'Scenario checkpoint south of the direct traverse.' },
] as const;

export const cameraStops = [
  {
    name: 'Curiosity · Rocknest view', latitude: -4.59006187, longitude: 137.4479003,
    detail: 'Sol 52 · Mastcam · PIA16204. The marker shows the rover viewpoint.',
    source: 'https://science.nasa.gov/photojournal/rocknest-from-sol-52-location/',
    image: 'rocknest.webp',
  },
  {
    name: 'Curiosity · Yellowknife Bay', latitude: -4.58946286, longitude: 137.4492584,
    detail: 'Sol 133 · Navcam · Site 5, drive 1858. Historical photo stop.',
    source: 'https://science.nasa.gov/resource/sol-0133-left-navigation-camera-cylindrical-perspective/',
  },
] as const;

export type RouteId = 'direct' | (typeof stations)[number]['id'];
export type RouteOption = Route & {
  id: RouteId;
  code: 'A' | 'B' | 'C';
  name: string;
  color: string;
  waypoint?: LocalPoint;
};

export function arrivalMinutes(route: Route, destination: 'out' | 'back', stopTime = 0) {
  if (destination === 'out') return walkMinutes(route.out.distanceM);
  return walkMinutes(route.out.distanceM + route.back.distanceM) + stopTime;
}

function joinLegs(first: Leg, second: Leg): Leg {
  return {
    path: [...first.path, ...second.path.slice(1)],
    distanceM: first.distanceM + second.distanceM,
    climbM: first.climbM + second.climbM,
    descentM: first.descentM + second.descentM,
    maxSlope: Math.max(first.maxSlope, second.maxSlope),
    profile: [...first.profile, ...second.profile.slice(1).map((point) => ({
      ...point, distanceM: point.distanceM + first.distanceM,
    }))],
  };
}

export function missionRoutes(terrain: Terrain, slopes: (number | null)[], start: Cell, target: Cell) {
  const direct = planMission(terrain, slopes, start, target);
  if ('error' in direct) return { error: direct.error, options: [] as RouteOption[] };
  const options: RouteOption[] = [{ ...direct, id: 'direct', code: 'A', name: 'Direct route', color: '#62e7d2' }];
  const profiles = [{ code: 'B', color: '#78b9ff' }, { code: 'C', color: '#ffab70' }] as const;

  stations.forEach((station, index) => {
    const via = cellAt(terrain, station.point);
    const first = planMission(terrain, slopes, start, via);
    const second = planMission(terrain, slopes, via, target);
    if ('error' in first || 'error' in second) return;

    const out = joinLegs(first.out, second.out);
    const key = ({ row, col }: Cell) => row * terrain.width + col;
    const used = new Set(out.path.map(key));
    if (used.size !== out.path.length) return; // A checkpoint detour should not double back.
    // Require at least 20% new cells compared with each shorter listed option.
    const distinct = options.every((option) =>
      option.out.path.filter((cell) => used.has(key(cell))).length / Math.min(out.path.length, option.out.path.length) < 0.8);
    if (!distinct) return;

    options.push({
      id: station.id, name: `Via ${station.name}`, waypoint: station.point, ...profiles[index],
      out, back: joinLegs(second.back, first.back),
    });
  });
  return { options, error: null };
}

export function cameraLocation(terrain: Terrain, stop: (typeof cameraStops)[number]) {
  return localPoint(terrain, stop);
}
