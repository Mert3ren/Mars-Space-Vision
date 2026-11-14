import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvaSession } from './eva';
import type { Cell, Terrain } from './mission';
import type { TerrainRequest, TerrainResponse } from './terrainWorker';

type Work = Exclude<TerrainRequest, { type: 'init' }>;
type WorkType = Work['type'];
type WorkInput = {
  [Type in WorkType]: Omit<Extract<Work, { type: Type }>, 'id'>
};
type WorkerResults = Partial<Record<WorkType, { input?: WorkInput[WorkType]; response: TerrainResponse }>>;

export function useTerrainWorker(terrain: Terrain, slopes: (number | null)[], eva: EvaSession | null,
  base: Cell, slopeLimit: number, spe: boolean, range: boolean, shadow: boolean,
  routes: WorkInput['routes'], draft: WorkInput['draft'] | null) {
  const [results, setResults] = useState<WorkerResults>({});
  const worker = useRef<Worker | null>(null);
  const latest = useRef(eva);
  latest.current = eva;
  const serial = useRef(0);
  const pending = useRef<Partial<Record<WorkType, { id: number; input?: WorkInput[WorkType] }>>>({});
  const terrainId = terrain.region ?? 'gale';
  const [failedTerrain, setFailedTerrain] = useState<Terrain | null>(null);
  const unavailable = failedTerrain === terrain;
  const returnRequest = useMemo(() => ({ type: 'return' as const, base, slopeLimit }), [base, slopeLimit]);
  const rangeBucket = eva ? Math.floor(eva.elapsed * 6) : 0;
  const shadowBucket = Math.floor((eva?.elapsed ?? 0) / 5);
  const rangeActive = Boolean(eva && range && !eva.outcome);
  const rangeRefresh = useRef<number | null>(null);

  useEffect(() => {
    try {
      worker.current = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      setFailedTerrain(terrain);
      return;
    }
    const instance = worker.current;
    instance.onmessage = ({ data }: MessageEvent<TerrainResponse>) => {
      const type = data.type === 'error' ? data.request : data.type;
      const request = pending.current[type];
      if (worker.current !== instance || request?.id !== data.id) return;
      delete pending.current[type];
      setResults((previous) => ({ ...previous, [type]: { input: request.input, response: data } }));
    };
    instance.onerror = () => {
      instance.terminate();
      worker.current = null;
      pending.current = {};
      setFailedTerrain(terrain);
    };
    instance.postMessage({ type: 'init', terrain, slopes } satisfies TerrainRequest);
    return () => {
      instance.terminate();
      worker.current = null;
      pending.current = {};
    };
  }, [terrain, slopes]);

  useEffect(() => {
    const id = ++serial.current;
    pending.current.routes = { id, input: routes };
    worker.current?.postMessage({ ...routes, id } satisfies Work);
    return () => { delete pending.current.routes; };
  }, [terrain, slopes, routes]);

  useEffect(() => {
    if (!draft) return;
    const id = ++serial.current;
    const timer = window.setTimeout(() => {
      pending.current.draft = { id, input: draft };
      worker.current?.postMessage({ ...draft, id } satisfies Work);
    }, 150);
    return () => {
      window.clearTimeout(timer);
      delete pending.current.draft;
    };
  }, [terrain, slopes, draft]);

  useEffect(() => {
    const id = ++serial.current;
    pending.current.return = { id, input: returnRequest };
    worker.current?.postMessage({ ...returnRequest, id } satisfies Work);
    return () => { delete pending.current.return; };
  }, [terrain, slopes, returnRequest]);

  useEffect(() => {
    if (!spe || !latest.current) return;
    const id = ++serial.current;
    pending.current.spe = { id };
    setResults((previous) => ({ ...previous, spe: undefined }));
    worker.current?.postMessage({ type: 'spe', id, session: latest.current, slopeLimit } satisfies Work);
    return () => { delete pending.current.spe; setResults((previous) => ({ ...previous, spe: undefined })); };
  }, [spe, terrainId, slopeLimit]);

  useEffect(() => {
    if (!rangeActive || !latest.current || pending.current.range !== undefined || rangeRefresh.current === rangeBucket) return;
    const id = ++serial.current;
    pending.current.range = { id };
    rangeRefresh.current = rangeBucket;
    worker.current?.postMessage({ type: 'range', id, session: latest.current, base, slopeLimit } satisfies Work);
  }, [rangeActive, rangeBucket, base, slopeLimit, terrainId, results.range]);

  useEffect(() => {
    if (rangeActive) return;
    delete pending.current.range;
    rangeRefresh.current = null;
    setResults((previous) => previous.range ? { ...previous, range: undefined } : previous);
  }, [rangeActive]);

  useEffect(() => {
    if (!shadow) return;
    const id = ++serial.current;
    pending.current.shadow = { id };
    worker.current?.postMessage({ type: 'shadow', id, minutes: shadowBucket * 5 } satisfies Work);
    return () => { delete pending.current.shadow; };
  }, [shadow, shadowBucket, terrainId]);

  const routeResult = results.routes?.input === routes ? results.routes.response : undefined;
  const draftResult = draft && results.draft?.input === draft ? results.draft.response : undefined;
  const treeResult = results.return?.input === returnRequest ? results.return.response : undefined;
  const speResult = results.spe?.response;
  const rangeResult = results.range?.response;
  const shadowResult = results.shadow?.response;
  return {
    routes: routeResult?.type === 'routes' ? routeResult.result : undefined,
    routesFailed: unavailable || routeResult?.type === 'error',
    draft: draftResult?.type === 'draft' ? draftResult.result : undefined,
    draftFailed: unavailable || draftResult?.type === 'error',
    tree: treeResult?.type === 'return' ? treeResult.tree : undefined,
    treeFailed: unavailable || treeResult?.type === 'error',
    spe: spe && speResult?.type === 'spe' ? speResult.options : undefined,
    speFailed: unavailable || speResult?.type === 'error',
    range: rangeActive && rangeResult?.type === 'range' ? rangeResult.grid : undefined,
    shadow: shadow && shadowResult?.type === 'shadow' ? shadowResult.grid : undefined,
  };
}
