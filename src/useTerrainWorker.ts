import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvaSession } from './eva';
import type { Cell, Terrain } from './mission';
import type { TerrainRequest, TerrainResponse } from './terrainWorker';

type Work = Exclude<TerrainRequest, { type: 'init' }>;
type WorkType = Work['type'];
type WorkerResults = Partial<Record<WorkType, TerrainResponse>>;

export function useTerrainWorker(terrain: Terrain, slopes: (number | null)[], eva: EvaSession | null,
  base: Cell, slopeLimit: number, spe: boolean, range: boolean, shadow: boolean,
  routes: Omit<Extract<Work, { type: 'routes' }>, 'id'>,
  draft: Omit<Extract<Work, { type: 'draft' }>, 'id'> | null) {
  const [results, setResults] = useState<WorkerResults>({});
  const worker = useRef<Worker | null>(null);
  const latest = useRef(eva);
  latest.current = eva;
  const serial = useRef(0);
  const pending = useRef<Partial<Record<WorkType, number>>>({});
  const terrainId = terrain.region ?? 'gale';
  const [unavailable, setUnavailable] = useState(false);
  const rangeBucket = eva ? Math.floor(eva.elapsed * 6) : 0;
  const shadowBucket = Math.floor((eva?.elapsed ?? 0) / 5);
  const rangeActive = Boolean(eva && range && !eva.outcome);
  const rangeRefresh = useRef<number | null>(null);

  useEffect(() => {
    try {
      worker.current = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      setUnavailable(true);
      return;
    }
    const instance = worker.current;
    instance.onmessage = ({ data }: MessageEvent<TerrainResponse>) => {
      const type = data.type === 'error' ? data.request : data.type;
      if (pending.current[type] !== data.id) return;
      delete pending.current[type];
      setResults((previous) => ({ ...previous, [type]: data }));
    };
    instance.onerror = () => { pending.current = {}; setUnavailable(true); };
    instance.postMessage({ type: 'init', terrain, slopes } satisfies TerrainRequest);
    return () => {
      instance.terminate();
      worker.current = null;
      pending.current = {};
    };
  }, [terrain, slopes]);

  useEffect(() => {
    const id = ++serial.current;
    pending.current.routes = id;
    setResults((previous) => ({ ...previous, routes: undefined }));
    worker.current?.postMessage({ ...routes, id } satisfies Work);
    return () => { delete pending.current.routes; };
  }, [routes]);

  useEffect(() => {
    if (!draft) return;
    const id = ++serial.current;
    pending.current.draft = id;
    setResults((previous) => ({ ...previous, draft: undefined }));
    worker.current?.postMessage({ ...draft, id } satisfies Work);
    return () => { delete pending.current.draft; };
  }, [draft]);

  useEffect(() => {
    const id = ++serial.current;
    pending.current.return = id;
    setResults((previous) => ({ ...previous, return: undefined }));
    worker.current?.postMessage({ type: 'return', id, base, slopeLimit } satisfies Work);
    return () => { delete pending.current.return; };
  }, [base, slopeLimit]);

  useEffect(() => {
    if (!spe || !latest.current) return;
    const id = ++serial.current;
    pending.current.spe = id;
    setResults((previous) => ({ ...previous, spe: undefined }));
    worker.current?.postMessage({ type: 'spe', id, session: latest.current, slopeLimit } satisfies Work);
    return () => { delete pending.current.spe; setResults((previous) => ({ ...previous, spe: undefined })); };
  }, [spe, terrainId, slopeLimit]);

  useEffect(() => {
    if (!rangeActive || !latest.current || pending.current.range !== undefined || rangeRefresh.current === rangeBucket) return;
    const id = ++serial.current;
    pending.current.range = id;
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
    pending.current.shadow = id;
    worker.current?.postMessage({ type: 'shadow', id, minutes: shadowBucket * 5 } satisfies Work);
    return () => { delete pending.current.shadow; };
  }, [shadow, shadowBucket, terrainId]);

  return useMemo(() => ({
    routes: results.routes?.type === 'routes' ? results.routes.result : undefined,
    routesFailed: unavailable || results.routes?.type === 'error',
    draft: results.draft?.type === 'draft' ? results.draft.result : undefined,
    draftFailed: unavailable || results.draft?.type === 'error',
    tree: results.return?.type === 'return' ? results.return.tree : undefined,
    treeFailed: unavailable || results.return?.type === 'error',
    spe: spe && results.spe?.type === 'spe' ? results.spe.options : undefined,
    speFailed: unavailable || results.spe?.type === 'error',
    range: rangeActive && results.range?.type === 'range' ? results.range.grid : undefined,
    shadow: shadow && results.shadow?.type === 'shadow' ? results.shadow.grid : undefined,
  }), [spe, results, unavailable, rangeActive, shadow]);
}
