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
  region?: 'gale' | 'boxwork';
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
  minutes: number;
  climbM: number;
  descentM: number;
  maxSlope: number;
  profile: { distanceM: number; elevationM: number; minutes: number }[];
};

type PlanError = 'outside_area' | 'invalid_cell' | 'same_cell' | 'no_path';
export type Route = { out: Leg; back: Leg };
export type Plan = Route | { error: PlanError };
export const MAX_SLOPE = 18;
export type RoutePriority = 'balanced' | 'shortest' | 'gentler';
export type RoutingSettings = { priority: RoutePriority; slopeLimit: number };
export const DEFAULT_ROUTING: RoutingSettings = { priority: 'balanced', slopeLimit: MAX_SLOPE };
const slopeWeights: Record<RoutePriority, number> = { balanced: 3, shortest: 0, gentler: 18 };
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

export function eastScale(terrain: Terrain) {
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

export function terrainGradient(terrain: Terrain, { row, col }: Cell) {
  if (row < 1 || col < 1 || row >= terrain.height - 1 || col >= terrain.width - 1) return null;
  const { elevationM, width, cellM } = terrain;
  const i = row * width + col;
  const west = elevationM[i - 1];
  const east = elevationM[i + 1];
  const north = elevationM[i - width];
  const south = elevationM[i + width];
  if (west == null || east == null || north == null || south == null) return null;
  return { east: (east - west) / (2 * cellM * eastScale(terrain)), north: (north - south) / (2 * cellM) };
}

export function edgeSlope(terrain: Terrain, from: Cell, to: Cell) {
  const { elevationM, width, cellM } = terrain;
  const east = (to.col - from.col) * cellM * eastScale(terrain);
  const north = (from.row - to.row) * cellM;
  const distance = Math.hypot(east, north);
  const a = elevationM[from.row * width + from.col];
  const b = elevationM[to.row * width + to.col];
  const ga = terrainGradient(terrain, from);
  const gb = terrainGradient(terrain, to);
  if (!distance || a == null || b == null || !ga || !gb) return null;
  const longitudinal = Math.atan2(b - a, distance) * DEG;
  const crossGrade = Math.max(Math.abs(ga.east * north - ga.north * east), Math.abs(gb.east * north - gb.north * east)) / distance;
  const cross = Math.atan(crossGrade) * DEG;
  const minutes = walkMinutes(distance) * (1 + 0.6 * Math.max(0, longitudinal) / 18 +
    0.3 * Math.max(0, -longitudinal) / 12 + 0.2 * cross / 10);
  return { distance, longitudinal, cross, minutes };
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

type SearchOptions = {
  target?: Cell;
  reverse?: boolean;
  maxMinutes?: number;
};

export function traverseSearch(terrain: Terrain, slopes: (number | null)[],
  origins: { cell: Cell; minutes: number }[], { priority, slopeLimit }: RoutingSettings,
  { target, reverse = false, maxMinutes = Infinity }: SearchOptions = {}) {
  const { width, height, elevationM, cellM } = terrain;
  const slopeWeight = slopeWeights[priority];
  const toIndex = ({ row, col }: Cell) => row * width + col;
  const fromIndex = (index: number) => ({ row: Math.floor(index / width), col: index % width });
  const passable = (cell: Cell) => {
    if (!inside(terrain, cell)) return false;
    const slope = slopes[toIndex(cell)];
    return slope != null && slope <= slopeLimit && elevationM[toIndex(cell)] != null;
  };
  const eastCell = cellM * eastScale(terrain);
  const distance = (a: Cell, b: Cell) => Math.hypot((b.row - a.row) * cellM, (b.col - a.col) * eastCell);
  const targetIndex = target ? toIndex(target) : -1;
  const heuristic = (cell: Cell) => target ? walkMinutes(distance(cell, target)) : 0;
  const costs = new Float64Array(width * height).fill(Infinity);
  const parents = new Int32Array(width * height).fill(-1);
  const visited = new Uint8Array(width * height);
  const candidates = new MinHeap();
  for (const { cell, minutes } of origins) {
    if (!passable(cell) || minutes > maxMinutes) continue;
    const index = toIndex(cell);
    if (minutes >= costs[index]) continue;
    costs[index] = minutes;
    candidates.push({ index, priority: minutes + heuristic(cell) });
  }

  while (candidates.size) {
    const { index } = candidates.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    if (index === targetIndex) break;
    const { row, col } = fromIndex(index);
    for (const [dr, dc] of offsets) {
      const next = { row: row + dr, col: col + dc };
      if (!passable(next)) continue;
      if (dr && dc && (!passable({ row: row + dr, col }) || !passable({ row, col: col + dc }))) continue;
      const nextIndex = toIndex(next);
      const cell = { row, col };
      const grade = reverse ? edgeSlope(terrain, next, cell) : edgeSlope(terrain, cell, next);
      if (!grade || !gradeAllowed(grade, slopeLimit)) continue;
      const slope = Math.max(Math.abs(grade.longitudinal), grade.cross);
      const cost = costs[index] + grade.minutes * (1 + slopeWeight * (slope / MAX_SLOPE) ** 2);
      if (cost > maxMinutes || cost >= costs[nextIndex]) continue;
      costs[nextIndex] = cost;
      parents[nextIndex] = index;
      candidates.push({ index: nextIndex, priority: cost + heuristic(next) });
    }
  }

  return { costs, parents, toIndex, fromIndex };
}

export type PathTree = Pick<ReturnType<typeof traverseSearch>, 'costs' | 'parents'>;

export function restoreSearch(terrain: Terrain, tree: PathTree) {
  return { ...tree, toIndex: ({ row, col }: Cell) => row * terrain.width + col,
    fromIndex: (index: number) => ({ row: Math.floor(index / terrain.width), col: index % terrain.width }) };
}

export function gradeAllowed(grade: NonNullable<ReturnType<typeof edgeSlope>>, slopeLimit: number) {
  return grade.longitudinal <= Math.min(18, slopeLimit) &&
    grade.longitudinal >= -Math.min(12, slopeLimit) && grade.cross <= Math.min(10, slopeLimit);
}

export function searchPath(search: ReturnType<typeof traverseSearch>, destination: Cell) {
  const index = search.toIndex(destination);
  if (!Number.isFinite(search.costs[index])) return null;
  const path = [];
  for (let cursor = index; cursor !== -1; cursor = search.parents[cursor]) path.push(search.fromIndex(cursor));
  return path.reverse();
}

export function summarizeLeg(terrain: Terrain, path: Cell[]): Leg {
  let distanceM = 0;
  let minutes = 0;
  let climbM = 0;
  let descentM = 0;
  let maxSlope = 0;
  const elevation = (cell: Cell) => terrain.elevationM[cell.row * terrain.width + cell.col] as number;
  const profile = path.map((cell, i) => {
    if (i > 0) {
      const edge = edgeSlope(terrain, path[i - 1], cell)!;
      const rise = elevation(cell) - elevation(path[i - 1]);
      distanceM += edge.distance;
      minutes += edge.minutes;
      climbM += Math.max(0, rise);
      descentM += Math.max(0, -rise);
      maxSlope = Math.max(maxSlope, Math.abs(edge.longitudinal));
    }
    return { distanceM, elevationM: elevation(cell), minutes };
  });
  return { path, profile, distanceM, minutes, climbM, descentM, maxSlope };
}

export function planLeg(terrain: Terrain, slopes: (number | null)[], start: Cell, end: Cell,
  routing: RoutingSettings = DEFAULT_ROUTING): Leg | { error: PlanError } {
  if (!inside(terrain, start) || !inside(terrain, end)) return { error: 'outside_area' };
  if ([start, end].some((cell) => {
    const index = cell.row * terrain.width + cell.col;
    const slope = slopes[index];
    return terrain.elevationM[index] == null || slope == null || slope > routing.slopeLimit;
  })) return { error: 'invalid_cell' };
  if (start.row === end.row && start.col === end.col) return { error: 'same_cell' };
  const search = traverseSearch(terrain, slopes, [{ cell: start, minutes: 0 }], routing, { target: end });
  const path = searchPath(search, end);
  return path ? summarizeLeg(terrain, path) : { error: 'no_path' };
}

export function planMission(terrain: Terrain, slopes: (number | null)[], start: Cell, end: Cell,
  routing: RoutingSettings = DEFAULT_ROUTING): Plan {
  const out = planLeg(terrain, slopes, start, end, routing);
  if ('error' in out) return out;
  const back = planLeg(terrain, slopes, end, start, routing);
  return 'error' in back ? back : { out, back };
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
  return estimateTimedReserve(walkMinutes(distanceM), stopMinutes, delayMinutes, settings);
}

export function estimateTimedReserve(travelMinutes: number, stopMinutes: number, delayMinutes: number,
  settings: ReserveSettings = DEFAULT_RESERVE_SETTINGS) {
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
