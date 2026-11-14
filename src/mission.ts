export type Cell = { row: number; col: number };
export type LocalPoint = { x: number; y: number };
export type Position = { latitude: number; longitude: number; sol: number };

export type Source = {
  title: string;
  mission: string;
  resolution: string;
  role: string;
  limit: string;
  credit: string;
  product: string;
  url: string;
  dataUrl: string;
  challengeResource?: boolean;
};

export type Terrain = {
  bounds: { west: number; south: number; east: number; north: number };
  radiusM: number;
  width: number;
  height: number;
  cellM: number;
  elevationM: (number | null)[];
  positions: { base: Position; science: Position };
  retrievedAt: string;
  sources: Source[];
};

export type Leg = {
  path: Cell[];
  distanceM: number;
  climbM: number;
  descentM: number;
  maxSlope: number;
  profile: { distanceM: number; elevationM: number }[];
};

type PlanError = 'outside_area' | 'invalid_cell' | 'same_cell' | 'no_path';
export type Route = { out: Leg; back: Leg };
export type Plan = Route | { error: PlanError };
export const MAX_SLOPE = 18;
const DEG = 180 / Math.PI;
const offsets = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function localPoint(terrain: Terrain, position: Pick<Position, 'latitude' | 'longitude'>): LocalPoint {
  return {
    x: position.longitude * terrain.radiusM / DEG - terrain.bounds.west,
    y: position.latitude * terrain.radiusM / DEG - terrain.bounds.south,
  };
}

export function displayPosition(terrain: Terrain, point: LocalPoint) {
  const latitude = (terrain.bounds.south + point.y) * DEG / terrain.radiusM;
  const longitude = (terrain.bounds.west + point.x) * DEG / terrain.radiusM;
  return `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? 'W' : 'E'}`;
}

export function cellAt(terrain: Terrain, point: LocalPoint): Cell {
  return {
    col: Math.floor(point.x / terrain.cellM),
    row: Math.ceil(terrain.height - point.y / terrain.cellM) - 1,
  };
}

export function cellCenter(terrain: Terrain, cell: Cell): LocalPoint {
  return {
    x: (cell.col + 0.5) * terrain.cellM,
    y: (terrain.height - cell.row - 0.5) * terrain.cellM,
  };
}

function inside(terrain: Terrain, { row, col }: Cell) {
  return Number.isInteger(row) && Number.isInteger(col) &&
    row >= 0 && row < terrain.height && col >= 0 && col < terrain.width;
}

export function inspectTerrain(terrain: Terrain, slopes: (number | null)[], point: LocalPoint) {
  const cell = cellAt(terrain, point);
  if (!inside(terrain, cell)) return null;
  const index = cell.row * terrain.width + cell.col;
  return { elevationM: terrain.elevationM[index], slope: slopes[index] };
}

function eastScale(terrain: Terrain) {
  return Math.cos((terrain.bounds.south + terrain.bounds.north) / 2 / terrain.radiusM);
}

export function slopeGrid(terrain: Terrain): (number | null)[] {
  const { width, height, elevationM, cellM } = terrain;
  const eastCell = cellM * eastScale(terrain);
  return elevationM.map((elevation, index) => {
    const row = Math.floor(index / width);
    const col = index % width;
    if (elevation === null || row === 0 || col === 0 || row === height - 1 || col === width - 1) return null;
    const west = elevationM[index - 1];
    const east = elevationM[index + 1];
    const north = elevationM[index - width];
    const south = elevationM[index + width];
    if (west === null || east === null || north === null || south === null) return null;
    return Math.atan(Math.hypot((east - west) / (2 * eastCell), (north - south) / (2 * cellM))) * DEG;
  });
}

class MinHeap {
  private items: { index: number; priority: number }[] = [];

  push(item: { index: number; priority: number }) {
    const items = this.items;
    let position = items.length;
    items.push(item);
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (items[parent].priority <= item.priority) break;
      items[position] = items[parent];
      position = parent;
    }
    items[position] = item;
  }

  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (last && items.length) {
      let position = 0;
      while (2 * position + 1 < items.length) {
        let child = 2 * position + 1;
        if (child + 1 < items.length && items[child + 1].priority < items[child].priority) child++;
        if (items[child].priority >= last.priority) break;
        items[position] = items[child];
        position = child;
      }
      items[position] = last;
    }
    return first;
  }

  get size() { return this.items.length; }
}

export function planMission(terrain: Terrain, slopes: (number | null)[], start: Cell, end: Cell): Plan {
  const { width, height, elevationM, cellM } = terrain;
  const toIndex = ({ row, col }: Cell) => row * width + col;
  const fromIndex = (index: number) => ({ row: Math.floor(index / width), col: index % width });
  const passable = (cell: Cell) => {
    if (!inside(terrain, cell)) return false;
    const slope = slopes[toIndex(cell)];
    return slope != null && slope <= MAX_SLOPE && elevationM[toIndex(cell)] != null;
  };
  if (!inside(terrain, start) || !inside(terrain, end)) return { error: 'outside_area' };
  if (!passable(start) || !passable(end)) return { error: 'invalid_cell' };
  const first = toIndex(start);
  const target = toIndex(end);
  if (first === target) return { error: 'same_cell' };

  const eastCell = cellM * eastScale(terrain);
  const distance = (a: Cell, b: Cell) => Math.hypot((b.row - a.row) * cellM, (b.col - a.col) * eastCell);
  const elevation = (index: number) => elevationM[index] as number;
  const stepSlope = (rise: number, run: number) => Math.atan(Math.abs(rise) / run) * DEG;
  const costs = new Float64Array(width * height).fill(Infinity);
  const parents = new Int32Array(width * height).fill(-1);
  const visited = new Uint8Array(width * height);
  const candidates = new MinHeap();
  costs[first] = 0;
  candidates.push({ index: first, priority: distance(start, end) });

  while (candidates.size) {
    const { index } = candidates.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    if (index === target) break;
    const { row, col } = fromIndex(index);
    for (const [dr, dc] of offsets) {
      const next = { row: row + dr, col: col + dc };
      if (!passable(next)) continue;
      if (dr && dc && (!passable({ row: row + dr, col }) || !passable({ row, col: col + dc }))) continue;
      const nextIndex = toIndex(next);
      const run = distance({ row, col }, next);
      const slope = stepSlope(elevation(nextIndex) - elevation(index), run);
      if (slope > MAX_SLOPE) continue;
      const cost = costs[index] + run * (1 + 3 * (slope / MAX_SLOPE) ** 2);
      if (cost >= costs[nextIndex]) continue;
      costs[nextIndex] = cost;
      parents[nextIndex] = index;
      candidates.push({ index: nextIndex, priority: cost + distance(next, end) });
    }
  }

  if (parents[target] === -1) return { error: 'no_path' };
  const indexes: number[] = [];
  for (let position = target; position !== -1; position = parents[position]) indexes.push(position);
  indexes.reverse();

  function summarize(legIndexes: number[]): Leg {
    let distanceM = 0;
    let climbM = 0;
    let descentM = 0;
    let maxSlope = 0;
    const path = legIndexes.map(fromIndex);
    const profile = legIndexes.map((index, i) => {
      if (i > 0) {
        const run = distance(path[i - 1], path[i]);
        const rise = elevation(index) - elevation(legIndexes[i - 1]);
        distanceM += run;
        climbM += Math.max(0, rise);
        descentM += Math.max(0, -rise);
        maxSlope = Math.max(maxSlope, stepSlope(rise, run));
      }
      return { distanceM, elevationM: elevation(index) };
    });
    return { path, profile, distanceM, climbM, descentM, maxSlope };
  }

  // The policy and its edge costs are symmetric, so reversing produces an optimal return leg.
  return { out: summarize(indexes), back: summarize([...indexes].reverse()) };
}

export const RESERVE = 20;
export const START_CAPACITY = 48;
export const WALK_KPH = 2;
export const STOP_MINUTES = 15;
export const MAX_SCENARIO_MINUTES = 180;
export const RESOURCE_RATES = { oxygen: 18, battery: 24 } as const;
export type ReserveSettings = { oxygen: number; battery: number; minimum: number };
export const DEFAULT_RESERVE_SETTINGS: ReserveSettings = { oxygen: START_CAPACITY, battery: START_CAPACITY, minimum: RESERVE };
export const RESERVE_EPSILON = 1e-8;

export function walkMinutes(distanceM: number) {
  return distanceM / (WALK_KPH * 1000) * 60;
}

export function estimateReserve(
  distanceM: number,
  stopMinutes: number,
  delayMinutes: number,
  settings: ReserveSettings = DEFAULT_RESERVE_SETTINGS,
) {
  const travelMinutes = walkMinutes(distanceM);
  const missionMinutes = travelMinutes + stopMinutes + delayMinutes;
  const resources = [
    { name: 'Oxygen', start: settings.oxygen, rate: RESOURCE_RATES.oxygen },
    { name: 'Battery', start: settings.battery, rate: RESOURCE_RATES.battery },
  ].map(({ name, start, rate }) => {
    const availableMinutes = (start - settings.minimum) / rate * 60;
    const depletionMinutes = start / rate * 60;
    return {
      name, start, rate, availableMinutes, depletionMinutes,
      remaining: start - rate * missionMinutes / 60,
      margin: availableMinutes - missionMinutes,
    };
  });
  const limiting = resources.reduce((lowest, resource) => resource.margin < lowest.margin ? resource : lowest);
  const depletion = resources.reduce((first, resource) => resource.depletionMinutes < first.depletionMinutes ? resource : first);
  const fieldworkBudget = limiting.availableMinutes - travelMinutes - delayMinutes;
  return {
    travelMinutes, missionMinutes, resources, limiting, depletion, margin: limiting.margin,
    availableMinutes: limiting.availableMinutes,
    fieldworkBudget,
    maxFieldworkMinutes: fieldworkBudget < -RESERVE_EPSILON
      ? null
      : Math.min(MAX_SCENARIO_MINUTES, Math.max(0, Math.floor(fieldworkBudget + RESERVE_EPSILON))),
  };
}
