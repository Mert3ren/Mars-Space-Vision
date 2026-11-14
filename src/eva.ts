import { cellCenter, edgeSlope, estimateTimedReserve, gradeAllowed, RESERVE_EPSILON, restoreSearch, summarizeLeg, traverseSearch, searchPath } from './mission.ts';
import type { Cell, Leg, LocalPoint, PathTree, ReserveSettings, Terrain } from './mission.ts';
import type { MissionWork } from './missionDraft.ts';

type Vertex = { point: LocalPoint; distanceM: number; minutes: number; cell?: Cell };
type Endpoint = { vertex: Vertex; offsetM: number; fraction: number };
export type EvaLocation = { point: LocalPoint; endpoints: Endpoint[]; edge?: [Cell, Cell] };
type Path = { vertices: Vertex[]; distanceM: number; minutes: number; origin?: EvaLocation };
type Estimate = ReturnType<typeof estimateTimedReserve>;
type Phase = 'outbound' | 'stop' | 'inbound' | 'shelter';
type Outcome = 'arrived' | 'depleted' | 'sheltered';

export const EVA_SPEEDS = [1, 60, 120] as const;
export type EvaSpeed = (typeof EVA_SPEEDS)[number];
export const EVA_DELAY_MINUTES = 40;

type SessionPlan = {
  stops: { path: Path; task: string; minutes: number }[];
  inbound: Path;
  name?: string;
  settings: ReserveSettings;
  depletionMinutes: number;
};

export type EvaSession = {
  plan: SessionPlan;
  phase: Phase;
  outcome: Outcome | null;
  paused: boolean;
  speed: EvaSpeed;
  elapsed: number;
  distanceM: number;
  legMinutes: number;
  stopRemaining: number;
  stopIndex: number;
  completedStops: number;
  workEvents: { minutes: number; index: number; kind: 'start' | 'finish' }[];
  earlyReturn: Path | null;
  shelter: { label: string; path: Path } | null;
  returnError: boolean;
};

function pathFromLeg(terrain: Terrain, leg: Leg): Path {
  return {
    distanceM: leg.distanceM,
    minutes: leg.minutes,
    vertices: leg.path.map((cell, index) => ({
      point: cellCenter(terrain, cell), distanceM: leg.profile[index].distanceM, minutes: leg.profile[index].minutes, cell,
    })),
  };
}

export function startEva(terrain: Terrain, route: { out: Leg; back: Leg }, stationaryMinutes: number,
  settings: ReserveSettings): EvaSession {
  return createEva(terrain, [{ leg: route.out, task: 'Science stop', minutes: stationaryMinutes }], route.back, settings, 0);
}

export function startMissionEva(terrain: Terrain, name: string, stops: MissionWork[], inbound: Leg,
  settings: ReserveSettings, delay: number): EvaSession {
  return createEva(terrain, stops, inbound, settings, delay, name);
}

function createEva(terrain: Terrain, stops: MissionWork[], inbound: Leg, settings: ReserveSettings,
  delay: number, name?: string): EvaSession {
  const { depletion } = estimateTimedReserve(0, 0, 0, settings);
  return {
    plan: {
      stops: stops.map(({ leg, task, minutes }) => ({ path: pathFromLeg(terrain, leg), task, minutes })),
      inbound: pathFromLeg(terrain, inbound), name,
      settings: { ...settings },
      depletionMinutes: depletion.depletionMinutes,
    },
    phase: 'outbound', outcome: depletion.depletionMinutes <= 0 ? 'depleted' : null,
    paused: false, speed: 1, elapsed: 0, distanceM: 0, legMinutes: 0,
    stopRemaining: stops[0].minutes + delay, stopIndex: 0, completedStops: 0, workEvents: [],
    earlyReturn: null, shelter: null, returnError: false,
  };
}

export function activeEvaPath(session: EvaSession): Path {
  if (session.phase === 'shelter' && session.shelter) return session.shelter.path;
  return session.phase === 'inbound' ? session.earlyReturn ?? session.plan.inbound : session.plan.stops[session.stopIndex].path;
}

export function evaGuidePoint(session: EvaSession): LocalPoint | undefined {
  if (session.outcome || session.phase === 'stop') return;
  const { distanceM } = activeEvaPath(session);
  if (distanceM - session.distanceM < 1) return;
  return evaLocation({ ...session, distanceM: Math.min(distanceM, session.distanceM + 18) }).point;
}

export function evaHeading(session: EvaSession): LocalPoint {
  const { vertices } = activeEvaPath(session);
  const point = evaLocation(session).point;
  const ahead = vertices.find((vertex) => vertex.distanceM > session.distanceM + 0.25);
  const behind = !ahead ? vertices[Math.max(0, vertices.length - 2)] : undefined;
  const from = ahead || !behind ? point : behind.point;
  const to = ahead?.point ?? point;
  return { x: to.x - from.x, y: to.y - from.y };
}

export function evaLocation(session: EvaSession): EvaLocation {
  const { vertices, origin } = activeEvaPath(session);
  const distance = session.distanceM;
  if (origin && distance <= RESERVE_EPSILON) return origin;
  const aheadIndex = vertices.findIndex((vertex) => vertex.distanceM >= distance);
  const ahead = vertices[aheadIndex < 0 ? vertices.length - 1 : aheadIndex];
  if (aheadIndex <= 0 || ahead.distanceM - distance <= RESERVE_EPSILON) {
    return { point: ahead.point, endpoints: [{ vertex: ahead, offsetM: 0, fraction: 0 }] };
  }
  const behind = vertices[aheadIndex - 1];
  const offsetM = distance - behind.distanceM;
  const fraction = offsetM / (ahead.distanceM - behind.distanceM);
  return {
    point: {
      x: behind.point.x + (ahead.point.x - behind.point.x) * fraction,
      y: behind.point.y + (ahead.point.y - behind.point.y) * fraction,
    },
    edge: origin && aheadIndex === 1 ? origin.edge : [behind.cell!, ahead.cell!],
    endpoints: origin && aheadIndex === 1 ? origin.endpoints.map((endpoint) => {
      const toward = endpoint.vertex.cell === ahead.cell ||
        (endpoint.vertex.cell?.row === ahead.cell?.row && endpoint.vertex.cell?.col === ahead.cell?.col);
      const edgeDistance = origin.endpoints.reduce((sum, end) => sum + end.offsetM, 0);
      const offsetM = toward ? ahead.distanceM - distance : endpoint.offsetM + distance;
      return { vertex: endpoint.vertex, offsetM, fraction: offsetM / edgeDistance };
    }) : [{ vertex: behind, offsetM, fraction }, { vertex: ahead, offsetM: ahead.distanceM - distance, fraction: 1 - fraction }],
  };
}

function distanceAtTime(path: Path, minutes: number) {
  const index = path.vertices.findIndex((vertex) => vertex.minutes > minutes);
  if (index < 1) return path.distanceM;
  const a = path.vertices[index - 1];
  const b = path.vertices[index];
  return a.distanceM + (b.distanceM - a.distanceM) * (minutes - a.minutes) / (b.minutes - a.minutes);
}

export function advanceEva(session: EvaSession, minutes: number): EvaSession {
  if (session.paused || session.outcome || minutes <= 0) return session;
  let next = { ...session };
  let remaining = minutes;
  for (;;) {
    const path = activeEvaPath(next);
    const untilStageEnd = next.phase === 'stop' ? next.stopRemaining : Math.max(0, path.minutes - next.legMinutes);
    const untilDepletion = Math.max(0, next.plan.depletionMinutes - next.elapsed);
    const spent = Math.min(remaining, untilStageEnd, untilDepletion);
    const stageComplete = spent + RESERVE_EPSILON >= untilStageEnd;
    next.elapsed += spent;
    remaining -= spent;
    if (next.phase === 'stop') {
      next.stopRemaining = stageComplete ? 0 : next.stopRemaining - spent;
    } else {
      next.legMinutes = stageComplete ? path.minutes : next.legMinutes + spent;
      next.distanceM = stageComplete ? path.distanceM : distanceAtTime(path, next.legMinutes);
    }

    if (stageComplete && next.phase === 'stop') {
      next.completedStops = next.stopIndex + 1;
      next.workEvents = [...next.workEvents, { minutes: next.elapsed, index: next.stopIndex, kind: 'finish' }];
    }
    if (stageComplete && next.phase === 'inbound') return { ...next, outcome: 'arrived' };
    if (stageComplete && next.phase === 'shelter') return { ...next, outcome: 'sheltered' };
    if (spent + RESERVE_EPSILON >= untilDepletion) return { ...next, outcome: 'depleted' };
    if (!stageComplete) return next;
    if (next.phase === 'outbound') {
      next.workEvents = [...next.workEvents, { minutes: next.elapsed, index: next.stopIndex, kind: 'start' }];
      next.phase = 'stop';
    } else {
      const following = next.plan.stops[next.stopIndex + 1];
      next = following ? { ...next, phase: 'outbound', stopIndex: next.stopIndex + 1,
        distanceM: 0, legMinutes: 0, stopRemaining: following.minutes, returnError: false }
        : { ...next, phase: 'inbound', distanceM: 0, legMinutes: 0, returnError: false };
    }
  }
}

export function delayEva(session: EvaSession): EvaSession {
  if (session.outcome || (session.phase !== 'outbound' && session.phase !== 'stop')) return session;
  const elapsed = Math.min(session.elapsed + EVA_DELAY_MINUTES, session.plan.depletionMinutes);
  return {
    ...session, elapsed, paused: true,
    outcome: elapsed >= session.plan.depletionMinutes ? 'depleted' : null,
  };
}

type ReturnOption = { path: Path; offsetM: number; offsetMinutes: number; distanceM: number; minutes: number };

export function evaSearchSeeds(terrain: Terrain, location: EvaLocation, slopeLimit: number) {
  return location.endpoints.flatMap(({ vertex, offsetM, fraction }) => {
    const cell = vertex.cell;
    if (!cell) return [];
    if (!location.edge || offsetM <= RESERVE_EPSILON) return [{ cell, minutes: 0, offsetM }];
    const [a, b] = location.edge;
    const isA = a.row === cell.row && a.col === cell.col;
    const grade = edgeSlope(terrain, isA ? b : a, cell);
    return grade && gradeAllowed(grade, slopeLimit) ? [{ cell, minutes: grade.minutes * fraction, offsetM }] : [];
  });
}

export function createReturnPlanner(terrain: Terrain, slopes: (number | null)[], destination: Cell, slopeLimit: number, tree?: PathTree) {
  const paths = new Map<number, Path | null>();
  const search = tree ? restoreSearch(terrain, tree) : traverseSearch(terrain, slopes, [{ cell: destination, minutes: 0 }],
    { priority: 'shortest', slopeLimit }, { reverse: true });
  function fromCell(cell: Cell) {
    const index = cell.row * terrain.width + cell.col;
    if (!paths.has(index)) {
      const route = searchPath(search, cell);
      const path = route ? pathFromLeg(terrain, summarizeLeg(terrain, route.reverse())) : null;
      paths.set(index, path);
    }
    return paths.get(index);
  }

  return (location: EvaLocation): ReturnOption | null => {
    let best: ReturnOption | null = null;
    for (const { cell, minutes: offsetMinutes, offsetM } of evaSearchSeeds(terrain, location, slopeLimit)) {
      const path = fromCell(cell);
      if (!path) continue;
      const distanceM = path.distanceM + offsetM;
      const minutes = path.minutes + offsetMinutes;
      if (!best || minutes < best.minutes) best = { path, offsetM, offsetMinutes, distanceM, minutes };
    }
    return best;
  };
}

export function pathFromSearch(terrain: Terrain, location: EvaLocation, cells: Cell[],
  seed: { minutes: number; offsetM: number }) {
  const path = pathFromLeg(terrain, summarizeLeg(terrain, cells));
  return pathFromLocation(location, { path, offsetM: seed.offsetM, offsetMinutes: seed.minutes,
    minutes: path.minutes + seed.minutes, distanceM: path.distanceM + seed.offsetM });
}

export function pathFromLocation(location: EvaLocation, option: ReturnOption): Path {
  if (option.offsetM <= RESERVE_EPSILON) return option.path;
  return {
    distanceM: option.distanceM,
    minutes: option.minutes,
    origin: location,
    vertices: [
      { point: location.point, distanceM: 0, minutes: 0 },
      ...option.path.vertices.map((vertex) => ({ ...vertex, distanceM: vertex.distanceM + option.offsetM,
        minutes: vertex.minutes + option.offsetMinutes })),
    ],
  };
}

export function returnEva(session: EvaSession, planReturn: ReturnType<typeof createReturnPlanner>, reroute = false): EvaSession {
  if ((session.outcome && session.outcome !== 'sheltered') || (session.phase === 'inbound' && !reroute)) return session;
  const location = evaLocation(session);
  const option = planReturn(location);
  if (!option) return { ...session, returnError: true };
  const path = pathFromLocation(location, option);
  return {
    ...session, phase: 'inbound', earlyReturn: path, paused: false, distanceM: 0, legMinutes: 0, stopRemaining: 0,
    outcome: path.distanceM <= RESERVE_EPSILON ? 'arrived' : null, returnError: false, shelter: null,
  };
}

export function divertEva(session: EvaSession, shelter: { label: string; path: Path }): EvaSession {
  if (session.outcome || shelter.path.minutes >= session.plan.depletionMinutes - session.elapsed - RESERVE_EPSILON) {
    return session;
  }
  return {
    ...session, phase: 'shelter', shelter, earlyReturn: null, stopRemaining: 0, distanceM: 0, legMinutes: 0, paused: false,
    outcome: shelter.path.distanceM <= RESERVE_EPSILON ? 'sheltered' : null, returnError: false,
  };
}

export function evaTelemetry(session: EvaSession, option: ReturnOption | null) {
  const { phase, plan, elapsed, outcome, stopRemaining } = session;
  const remainingLegM = Math.max(0, activeEvaPath(session).distanceM - session.distanceM);
  const followingPlan = phase === 'outbound' || phase === 'stop';
  const future = followingPlan ? plan.stops.slice(session.stopIndex + 1) : [];
  const remainingM = remainingLegM + (followingPlan ? plan.inbound.distanceM : 0) +
    future.reduce((sum, stop) => sum + stop.path.distanceM, 0);
  const stationary = stopRemaining + future.reduce((sum, stop) => sum + stop.minutes, 0);
  const remainingTravel = Math.max(0, activeEvaPath(session).minutes - session.legMinutes) +
    (followingPlan ? plan.inbound.minutes : 0) + future.reduce((sum, stop) => sum + stop.path.minutes, 0);
  const current = estimateTimedReserve(0, 0, elapsed, plan.settings);
  const remainingMinutes = remainingTravel + stationary;
  const continuePlan: Estimate | null = outcome || !followingPlan ? null
    : estimateTimedReserve(remainingTravel, stationary, elapsed, plan.settings);
  const returnNow: Estimate | null = outcome && outcome !== 'sheltered' ? null : phase === 'inbound'
    ? estimateTimedReserve(remainingTravel, 0, elapsed, plan.settings)
    : option ? estimateTimedReserve(option.minutes, 0, elapsed, plan.settings) : null;
  return { current, remainingM, remainingMinutes, continuePlan, returnNow };
}
