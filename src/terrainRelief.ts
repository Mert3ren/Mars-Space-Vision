import { localPoint } from './mission.ts';
import type { LocalPoint, Terrain } from './mission';
import galeOverview from './galeOverview.json' with { type: 'json' };
import type { MapScope } from './TerrainMap';

export type ElevationGrid = {
  width: number;
  height: number;
  elevationM: (number | null)[];
};

export type OverviewElevation = Record<'crater' | 'region', ElevationGrid>;
export const verticalExaggeration = { crater: 2, region: 3, traverse: 4 };

export function terrainFrame(terrain: Terrain, scope: MapScope, grid: ElevationGrid, exaggeration = verticalExaggeration[scope]) {
  const area = scope === 'crater' ? galeOverview :
    scope === 'region' ? galeOverview.region : null;
  const min = area ? localPoint(terrain, {
    latitude: area.bounds.south, longitude: area.bounds.west,
  }) : { x: 0, y: 0 };
  const max = area ? localPoint(terrain, {
    latitude: area.bounds.north, longitude: area.bounds.east,
  }) : { x: terrain.width * terrain.cellM, y: terrain.height * terrain.cellM };
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
  const widthM = max.x - min.x;
  const heightM = max.y - min.y;
  const northScale = 100 / Math.max(widthM, heightM);
  const eastScale = northScale * Math.cos((center.y + terrain.bounds.south) / terrain.radiusM);
  let low = Infinity;
  let high = -Infinity;
  for (const elevation of grid.elevationM) {
    if (elevation === null) continue;
    low = Math.min(low, elevation);
    high = Math.max(high, elevation);
  }
  if (!Number.isFinite(low)) throw new Error('No elevation data for this scale');
  const reference = (low + high) / 2;
  return { min, max, center, widthM, heightM, eastScale, northScale, exaggeration, reference };
}

export type TerrainFrame = ReturnType<typeof terrainFrame>;

export const sampleElevation = (grid: ElevationGrid, frame: TerrainFrame, point: LocalPoint) => {
  if (point.x < frame.min.x || point.x > frame.max.x || point.y < frame.min.y || point.y > frame.max.y) return null;
  const { width, height, elevationM } = grid;
  const x = Math.max(0, Math.min(width - 1, (point.x - frame.min.x) / frame.widthM * width - 0.5));
  const y = Math.max(0, Math.min(height - 1, (frame.max.y - point.y) / frame.heightM * height - 0.5));
  const col = Math.min(width - 2, Math.floor(x));
  const row = Math.min(height - 2, Math.floor(y));
  const dx = x - col;
  const dy = y - row;
  const a = elevationM[row * width + col];
  const b = elevationM[row * width + col + 1];
  const c = elevationM[(row + 1) * width + col];
  const d = elevationM[(row + 1) * width + col + 1];
  // Use the same diagonal and triangular interpolation as the rendered mesh.
  const triangle = dx + dy <= 1
    ? [[a, 1 - dx - dy], [b, dx], [c, dy]] as const
    : [[d, dx + dy - 1], [b, 1 - dy], [c, 1 - dx]] as const;
  let elevation = 0;
  let totalWeight = 0;
  for (const [sample, weight] of triangle) {
    if (weight <= 1e-8) continue;
    if (sample === null) return null;
    if (weight >= 1 - 1e-8) return sample;
    elevation += sample * weight;
    totalWeight += weight;
  }
  return elevation / totalWeight;
};

export function worldPoint(frame: TerrainFrame, point: LocalPoint, elevationM: number): [number, number, number] {
  return [
    (point.x - frame.center.x) * frame.eastScale,
    (elevationM - frame.reference) * frame.northScale * frame.exaggeration,
    (frame.center.y - point.y) * frame.northScale,
  ];
}

export function mapPoint(frame: TerrainFrame, x: number, z: number): LocalPoint {
  return { x: frame.center.x + x / frame.eastScale, y: frame.center.y - z / frame.northScale };
}

export function helmetPose(grid: ElevationGrid, frame: TerrainFrame, point: LocalPoint, heading: LocalPoint) {
  const elevation = sampleElevation(grid, frame, point);
  if (elevation === null) return null;
  const position = worldPoint(frame, point, elevation + 1.7);
  const direction = { x: heading.x * frame.eastScale, z: -heading.y * frame.northScale };
  const yaw = direction.x || direction.z ? Math.atan2(-direction.x, -direction.z) : null;
  return { position, yaw };
}
