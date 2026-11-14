import { reserveRange, shadowGrid } from './environment';
import type { EvaSession } from './eva';
import { traverseSearch } from './mission';
import type { Cell, PathTree, ReserveSettings, RoutingSettings, Terrain } from './mission';
import { findShelterCandidates, shelterOptions } from './shelters';
import type { ShelterOption } from './shelters';
import { missionRoutes } from './galeRoutes';
import { buildMission } from './missionDraft';
import type { MissionDraft, MissionPreview } from './missionDraft';

export type GridOverlay = { width: number; height: number; values: Uint8Array };
export type TerrainRequest =
  | { type: 'init'; terrain: Terrain; slopes: (number | null)[] }
  | { type: 'spe'; id: number; session: EvaSession; slopeLimit: number }
  | { type: 'routes'; id: number; start: Cell; target: Cell; routing: RoutingSettings }
  | { type: 'draft'; id: number; base: Cell; draft: MissionDraft; routing: RoutingSettings; settings: ReserveSettings; delay: number }
  | { type: 'return'; id: number; base: Cell; slopeLimit: number }
  | { type: 'range'; id: number; session: EvaSession; slopeLimit: number; base: Cell }
  | { type: 'shadow'; id: number; minutes: number };
export type TerrainResponse =
  | { type: 'spe'; id: number; options: ShelterOption[] }
  | { type: 'routes'; id: number; result: ReturnType<typeof missionRoutes> }
  | { type: 'draft'; id: number; result: MissionPreview }
  | { type: 'return'; id: number; tree: PathTree }
  | { type: 'range' | 'shadow'; id: number; grid: GridOverlay }
  | { type: 'error'; id: number; request: Exclude<TerrainRequest['type'], 'init'> };

let terrain: Terrain;
let slopes: (number | null)[];
let inbound: { key: string; tree: PathTree } | null = null;
const cover = new Map<number, ReturnType<typeof findShelterCandidates>>();

function returnTree(base: Cell, slopeLimit: number) {
  const key = `${base.row}:${base.col}:${slopeLimit}`;
  if (inbound?.key === key) return inbound.tree;
  const { costs, parents } = traverseSearch(terrain, slopes, [{ cell: base, minutes: 0 }],
    { priority: 'shortest', slopeLimit }, { reverse: true });
  const tree = { costs, parents };
  inbound = { key, tree };
  return tree;
}

self.onmessage = ({ data }: MessageEvent<TerrainRequest>) => {
  if (data.type === 'init') {
    ({ terrain, slopes } = data);
    cover.clear();
    inbound = null;
    return;
  }
  let response: TerrainResponse;
  try {
    if (data.type === 'spe') {
      let candidates = cover.get(data.slopeLimit);
      if (!candidates) {
        candidates = findShelterCandidates(terrain, slopes, data.slopeLimit);
        cover.set(data.slopeLimit, candidates);
      }
      response = { type: 'spe', id: data.id, options: shelterOptions(terrain, slopes, data.slopeLimit, candidates, data.session) };
    } else if (data.type === 'routes') {
      response = { type: 'routes', id: data.id, result: missionRoutes(terrain, slopes, data.start, data.target, data.routing) };
    } else if (data.type === 'draft') {
      response = { type: 'draft', id: data.id,
        result: buildMission(terrain, slopes, data.base, data.draft, data.routing, data.settings, data.delay) };
    } else if (data.type === 'return') {
      response = { type: 'return', id: data.id, tree: returnTree(data.base, data.slopeLimit) };
    } else if (data.type === 'range') {
      const { base, session, slopeLimit } = data;
      const result = reserveRange(terrain, slopes, base, session, slopeLimit, returnTree(base, slopeLimit).costs);
      response = { type: 'range', id: data.id, grid: { width: terrain.width, height: terrain.height, values: result.cells } };
    } else {
      response = { type: 'shadow', id: data.id, grid: shadowGrid(terrain, data.minutes) };
    }
  } catch {
    response = { type: 'error', id: data.id, request: data.type };
  }
  self.postMessage(response);
};
