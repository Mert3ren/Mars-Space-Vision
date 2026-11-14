import { cellCenter, estimateReserve, planMission, RESERVE_EPSILON, walkMinutes } from './mission.ts';
import type { Cell, Leg, LocalPoint, ReserveSettings, Terrain } from './mission.ts';
import type { MissionWork } from './missionDraft.ts';

type Vertex = { point: LocalPoint; distanceM: number; cell?: Cell };
type Endpoint = { vertex: Vertex; offsetM: number };
type Location = { point: LocalPoint; endpoints: Endpoint[] };
type Path = { vertices: Vertex[]; distanceM: number; origin?: Location };
type Estimate = ReturnType<typeof estimateReserve>;
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
  stopRemaining: number;
  stopIndex: number;
  completedStops: number;
  earlyReturn: Path | null;
  shelter: { label: string; path: Path } | null;
  returnError: boolean;
};

function pathFromLeg(terrain: Terrain, leg: Leg): Path {
  return {
    distanceM: leg.distanceM,
    vertices: leg.path.map((cell, index) => ({
      point: cellCenter(terrain, cell), distanceM: leg.profile[index].distanceM, cell,
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
  const { depletion } = estimateReserve(0, 0, 0, settings);
  return {
    plan: {
      stops: stops.map(({ leg, task, minutes }) => ({ path: pathFromLeg(terrain, leg), task, minutes })),
      inbound: pathFromLeg(terrain, inbound), name,
      settings: { ...settings },
      depletionMinutes: depletion.depletionMinutes,
    },
    phase: 'outbound', outcome: depletion.depletionMinutes <= 0 ? 'depleted' : null,
    paused: false, speed: name ? 60 : 120, elapsed: 0, distanceM: 0,
    stopRemaining: stops[0].minutes + delay, stopIndex: 0, completedStops: 0,
    earlyReturn: null, shelter: null, returnError: false,
  };
}

export function activeEvaPath(session: EvaSession): Path {
  if (session.phase === 'shelter' && session.shelter) return session.shelter.path;
  return session.phase === 'inbound' ? session.earlyReturn ?? session.plan.inbound : session.plan.stops[session.stopIndex].path;
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

export function evaLocation(session: EvaSession): Location {
  const { vertices, origin } = activeEvaPath(session);
  const distance = session.distanceM;
  if (origin && distance <= RESERVE_EPSILON) return origin;
  const aheadIndex = vertices.findIndex((vertex) => vertex.distanceM >= distance);
  const ahead = vertices[aheadIndex < 0 ? vertices.length - 1 : aheadIndex];
  if (aheadIndex <= 0 || ahead.distanceM - distance <= RESERVE_EPSILON) {
    return { point: ahead.point, endpoints: [{ vertex: ahead, offsetM: 0 }] };
  }
  const behind = vertices[aheadIndex - 1];
  const offsetM = distance - behind.distanceM;
  const fraction = offsetM / (ahead.distanceM - behind.distanceM);
  return {
    point: {
      x: behind.point.x + (ahead.point.x - behind.point.x) * fraction,
      y: behind.point.y + (ahead.point.y - behind.point.y) * fraction,
    },
    endpoints: origin && aheadIndex === 1 ? origin.endpoints.map((endpoint) => ({
      vertex: endpoint.vertex,
      offsetM: endpoint.vertex.cell?.row === ahead.cell?.row && endpoint.vertex.cell?.col === ahead.cell?.col
        ? ahead.distanceM - distance : endpoint.offsetM + distance,
    })) : [{ vertex: behind, offsetM }, { vertex: ahead, offsetM: ahead.distanceM - distance }],
  };
}

export function advanceEva(session: EvaSession, minutes: number): EvaSession {
  if (session.paused || session.outcome || minutes <= 0) return session;
  let next = { ...session };
  let remaining = minutes;
  for (;;) {
    const path = activeEvaPath(next);
    const untilStageEnd = next.phase === 'stop' ? next.stopRemaining : walkMinutes(path.distanceM - next.distanceM);
    const untilDepletion = Math.max(0, next.plan.depletionMinutes - next.elapsed);
    const spent = Math.min(remaining, untilStageEnd, untilDepletion);
    const stageComplete = spent + RESERVE_EPSILON >= untilStageEnd;
    next.elapsed += spent;
    remaining -= spent;
    if (next.phase === 'stop') {
      next.stopRemaining = stageComplete ? 0 : next.stopRemaining - spent;
    } else {
      next.distanceM = stageComplete ? path.distanceM : next.distanceM + spent / walkMinutes(1);
    }

    if (stageComplete && next.phase === 'stop') next.completedStops = next.stopIndex + 1;
    if (stageComplete && next.phase === 'inbound') return { ...next, outcome: 'arrived' };
    if (stageComplete && next.phase === 'shelter') return { ...next, outcome: 'sheltered' };
    if (spent + RESERVE_EPSILON >= untilDepletion) return { ...next, outcome: 'depleted' };
    if (!stageComplete) return next;
    if (next.phase === 'outbound') {
      next.phase = 'stop';
    } else {
      const following = next.plan.stops[next.stopIndex + 1];
      next = following ? { ...next, phase: 'outbound', stopIndex: next.stopIndex + 1,
        distanceM: 0, stopRemaining: following.minutes, returnError: false }
        : { ...next, phase: 'inbound', distanceM: 0, returnError: false };
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

type ReturnOption = { path: Path; offsetM: number; distanceM: number };

export function createReturnPlanner(terrain: Terrain, slopes: (number | null)[], destination: Cell, slopeLimit: number) {
  const paths = new Map<number, Path | null>();
  function fromCell(cell: Cell) {
    const index = cell.row * terrain.width + cell.col;
    if (!paths.has(index)) {
      const plan = planMission(terrain, slopes, cell, destination, { priority: 'shortest', slopeLimit });
      const path = 'error' in plan
        ? plan.error === 'same_cell' ? { distanceM: 0, vertices: [{ point: cellCenter(terrain, destination), cell: destination, distanceM: 0 }] } : null
        : pathFromLeg(terrain, plan.out);
      paths.set(index, path);
    }
    return paths.get(index);
  }

  return (location: ReturnType<typeof evaLocation>): ReturnOption | null => {
    let best: ReturnOption | null = null;
    for (const { vertex, offsetM } of location.endpoints) {
      const path = vertex.cell && fromCell(vertex.cell);
      if (!path) continue;
      const distanceM = path.distanceM + offsetM;
      if (!best || distanceM < best.distanceM) best = { path, offsetM, distanceM };
    }
    return best;
  };
}

export function pathFromLocation(location: Location, option: ReturnOption): Path {
  if (option.offsetM <= RESERVE_EPSILON) return option.path;
  return {
    distanceM: option.distanceM,
    origin: location,
    vertices: [
      { point: location.point, distanceM: 0 },
      ...option.path.vertices.map((vertex) => ({ ...vertex, distanceM: vertex.distanceM + option.offsetM })),
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
    ...session, phase: 'inbound', earlyReturn: path, paused: false, distanceM: 0, stopRemaining: 0,
    outcome: path.distanceM <= RESERVE_EPSILON ? 'arrived' : null, returnError: false, shelter: null,
  };
}

export function divertEva(session: EvaSession, shelter: { label: string; path: Path }): EvaSession {
  if (session.outcome || walkMinutes(shelter.path.distanceM) >= session.plan.depletionMinutes - session.elapsed - RESERVE_EPSILON) {
    return session;
  }
  return {
    ...session, phase: 'shelter', shelter, earlyReturn: null, stopRemaining: 0, distanceM: 0, paused: false,
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
  const current = estimateReserve(0, 0, elapsed, plan.settings);
  const remainingMinutes = walkMinutes(remainingM) + stationary;
  const continuePlan: Estimate | null = outcome || !followingPlan ? null
    : estimateReserve(remainingM, stationary, elapsed, plan.settings);
  const returnNow: Estimate | null = outcome && outcome !== 'sheltered' ? null : phase === 'inbound'
    ? estimateReserve(remainingM, 0, elapsed, plan.settings)
    : option ? estimateReserve(option.distanceM, 0, elapsed, plan.settings) : null;
  return { current, remainingM, remainingMinutes, continuePlan, returnNow };
}
