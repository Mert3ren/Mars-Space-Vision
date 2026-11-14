import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BatteryCharging,
  Camera, Check, ChevronDown, CircleAlert, Clock3, Compass, Database, Flag,
  FlaskConical, House, Layers3, Map, Maximize2, Minimize2, Minus, Mountain, Play, Plus, RotateCcw, Route, Target, X,
} from 'lucide-react';
import { routeColor, TerrainMap } from './TerrainMap';
import type { LayerMode, MapScope } from './TerrainMap';
import { verticalExaggeration } from './terrainRelief';
import { ReturnReserve } from './ReturnReserve';
import { EvaPanel, EvaReserve } from './EvaPanel';
import { SpePanel } from './SpePanel';
import type { SpeTarget } from './SpePanel';
import { findShelterCandidates, SHELTER_COLOR, shelterOptions } from './shelters';
import { activeEvaPath, advanceEva, createReturnPlanner, delayEva, divertEva, evaLocation, evaTelemetry, pathFromLocation, returnEva, startEva } from './eva';
import type { EvaSession } from './eva';
import galeOverview from './galeOverview.json';
import {
  cellAt, cellCenter, DEFAULT_RESERVE_SETTINGS, DEFAULT_ROUTING, displayPosition, estimateReserve, inspectTerrain, localPoint,
  MAX_SLOPE, planMission, RESERVE_EPSILON, slopeGrid, STOP_MINUTES, walkMinutes,
} from './mission';
import type { Cell, Leg, LocalPoint, RoutePriority, Terrain } from './mission';
import { arrivalMinutes, cameraStops, compareRoutes, missionRoutes } from './galeRoutes';
import type { RouteId } from './galeRoutes';
import 'leaflet/dist/leaflet.css';
import './style.css';

const asset = (name: string) => `${import.meta.env.BASE_URL}gale/${name}`;
const ReliefMap = lazy(() => import('./ReliefMap'));
const sameCell = (a: Cell, b: Cell) => a.row === b.row && a.col === b.col;
const kilometers = (meters: number) => (meters / 1000).toFixed(2);
const meters = (value: number) => Math.round(value).toLocaleString('en-US');
const scienceSource = 'https://science.nasa.gov/photojournal/spherules-in-yellowknife-bay/';
const ERROR_TEXT = {
  outside_area: 'That point is outside the Gale study area.',
  invalid_cell: 'An endpoint has missing terrain data or exceeds the selected slope limit.',
  same_cell: 'Base and science stop must be in different terrain cells.',
  no_path: 'No route connects these points under the selected slope limit.',
};
const priorities: { id: RoutePriority; label: string; detail: string }[] = [
  { id: 'balanced', label: 'Balanced', detail: 'Weighs distance and step slope.' },
  { id: 'shortest', label: 'Shortest', detail: 'Minimizes distance within the slope limit.' },
  { id: 'gentler', label: 'Gentler', detail: 'Adds a stronger penalty for steep steps.' },
];
const signMinutes = (value: number) => Math.abs(value) < RESERVE_EPSILON ? '0' :
  `${value < 0 ? '−' : '+'}${Math.abs(value) < 1 ? '<1' : Math.round(Math.abs(value))}`;

function ElevationChart({ leg, color = routeColor.out }: { leg?: Leg; color?: string }) {
  const profile = leg?.profile;
  if (!leg || !profile || profile.length < 2) {
    return <div className="empty-chart">Select two reachable points to see the elevation profile.</div>;
  }
  const low = Math.floor(Math.min(...profile.map((p) => p.elevationM)) / 10) * 10 - 5;
  const high = Math.ceil(Math.max(...profile.map((p) => p.elevationM)) / 10) * 10 + 5;
  const width = 710;
  const top = 13;
  const bottom = 104;
  const left = 58;
  const right = 690;
  const points = profile.map((point) => [
    left + (right - left) * point.distanceM / leg.distanceM,
    top + (bottom - top) * (high - point.elevationM) / (high - low),
  ]);
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  return (
    <svg className="profile-chart" viewBox={`0 0 ${width} 132`} role="img"
      aria-label={`Elevation from ${Math.round(profile[0].elevationM)} to ${Math.round(profile.at(-1)!.elevationM)} meters over ${meters(leg.distanceM)} meters`}>
      <defs>
        <linearGradient id="chart-fill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop stopColor={color} stopOpacity=".23" />
          <stop offset="1" stopColor={color} stopOpacity=".02" />
        </linearGradient>
      </defs>
      {[0, 1, 2].map((tick) => {
        const y = top + (bottom - top) * tick / 2;
        return <g key={tick}>
          <line x1={left} y1={y} x2={right} y2={y} stroke="var(--line)" strokeDasharray="4 4" />
          <text x={left - 9} y={y + 4} textAnchor="end">{meters(high - (high - low) * tick / 2)} m</text>
        </g>;
      })}
      <path d={`${path} L ${right},${bottom} L ${left},${bottom} Z`} fill="url(#chart-fill)" />
      <path d={path} fill="none" stroke={color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
      <circle cx={points[0][0]} cy={points[0][1]} r="3.5" fill={color} />
      <circle cx={points.at(-1)![0]} cy={points.at(-1)![1]} r="3.5" fill={color} />
      {[0, 1, 2, 3, 4].map((tick) => <text key={tick} x={left + (right - left) * tick / 4}
        y="125" textAnchor={tick === 0 ? 'start' : tick === 4 ? 'end' : 'middle'}>
        {meters(leg.distanceM * tick / 4)} m
      </text>)}
    </svg>
  );
}

function SourcesDialog({ terrain, close }: { terrain: Terrain; close: () => void }) {
  return (
    <dialog className="sources-dialog" ref={(dialog) => {
      if (dialog && !dialog.open) dialog.showModal();
    }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="sources-content">
        <div className="panel-title">
          <div className="section-heading"><Database size={18} /><h2>Data sources</h2></div>
          <button className="icon-button" onClick={close} aria-label="Close data sources"><X size={19} /></button>
        </div>
        <p className="muted">Gale study area · Archived mission products · Retrieved {terrain.retrievedAt}</p>
        <article className="source-card">
          <div className="source-title"><h3>Gale Crater overview</h3><span className="source-tag">Challenge resource</span></div>
          <p>NASA JPL Mars Trek · MRO CTX mosaic and MOLA / HRSC shaded relief</p>
          <p>Crater-scale context. The relief fills areas outside the optical mosaic coverage.</p>
          <div className="source-links">
            <a href={galeOverview.optical.catalog} target="_blank" rel="noreferrer">CTX product <ArrowUpRight size={13} /></a>
            <a href={galeOverview.relief.catalog} target="_blank" rel="noreferrer">MOLA / HRSC product <ArrowUpRight size={13} /></a>
            <a href="https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m"
              target="_blank" rel="noreferrer">3D elevation grid <ArrowUpRight size={13} /></a>
            <a href="https://planetarynames.wr.usgs.gov/Feature/15000" target="_blank" rel="noreferrer">Mount Sharp <ArrowUpRight size={13} /></a>
          </div>
        </article>
        <article className="source-card">
          <div className="source-title"><h3>Curiosity historical traverse</h3></div>
          <p>NASA/JPL-Caltech · Archived geometry between the Sol 3 and Sol 130 waypoint positions.</p>
          <div className="source-links">
            <a href="https://science.nasa.gov/mission/msl-curiosity/location-map/" target="_blank" rel="noreferrer">NASA rover map <ArrowUpRight size={13} /></a>
            <a href={galeOverview.roverSource} target="_blank" rel="noreferrer">Original track <ArrowUpRight size={13} /></a>
          </div>
        </article>
        <article className="source-card">
          <div className="source-title"><h3>Curiosity camera stops</h3></div>
          <p>Historical camera locations taken from the NASA/JPL-Caltech waypoint archive.</p>
          <div className="source-links">
            {cameraStops.map((stop) => <a key={stop.name} href={stop.source} target="_blank" rel="noreferrer">
              {stop.name} <ArrowUpRight size={13} />
            </a>)}
          </div>
        </article>
        {terrain.sources.map((source) => (
          <article key={source.product} className="source-card">
            <div className="source-title">
              <h3>{source.title}</h3>
              {source.challengeResource && <span className="source-tag">Challenge resource</span>}
            </div>
            <p>{source.mission} · {source.resolution}</p>
            <p>{source.role}. {source.limit}</p>
            <small>{source.product} · {source.credit}</small>
            <div className="source-links">
              <a href={source.url} target="_blank" rel="noreferrer">Product details <ArrowUpRight size={13} /></a>
              <a href={source.dataUrl} target="_blank" rel="noreferrer">Original data <ArrowUpRight size={13} /></a>
            </div>
          </article>
        ))}
        <a className="subtle-link" href={scienceSource} target="_blank" rel="noreferrer">
          Mastcam image PIA16706 · NASA/JPL-Caltech/MSSS <ArrowUpRight size={14} />
        </a>
      </div>
    </dialog>
  );
}

function MissionControl({ terrain }: { terrain: Terrain }) {
  const defaultStart = useMemo(() => cellAt(terrain, localPoint(terrain, terrain.positions.base)), [terrain]);
  const defaultTarget = useMemo(() => cellAt(terrain, localPoint(terrain, terrain.positions.science)), [terrain]);
  const slopes = useMemo(() => slopeGrid(terrain), [terrain]);
  const [start, setStart] = useState(defaultStart);
  const [target, setTarget] = useState(defaultTarget);
  const [direction, setDirection] = useState<'out' | 'back'>('out');
  const [layer, setLayer] = useState<LayerMode>('optical');
  const [mapScope, setMapScope] = useState<MapScope>('traverse');
  const [mapDimension, setMapDimension] = useState<'2D' | '3D'>('2D');
  const [section, setSection] = useState(() => window.location.hash);
  const [opacity, setOpacity] = useState(72);
  const [layersOpen, setLayersOpen] = useState(false);
  const [pickMode, setPickMode] = useState<'start' | 'target' | null>(null);
  const [pickError, setPickError] = useState('');
  const [inspection, setInspection] = useState<LocalPoint | null>(null);
  const [showRover, setShowRover] = useState(false);
  const [showStations, setShowStations] = useState(true);
  const [selectedRoute, setSelectedRoute] = useState<RouteId>('direct');
  const [routing, setRouting] = useState(DEFAULT_ROUTING);
  const [coordinate, setCoordinate] = useState('');
  const [stopMinutes, setStopMinutes] = useState(STOP_MINUTES);
  const [delay, setDelay] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const [reserveSettings, setReserveSettings] = useState(DEFAULT_RESERVE_SETTINGS);
  const [steps, setSteps] = useState([false, false, false]);
  const [eva, setEva] = useState<EvaSession | null>(null);
  const [spe, setSpe] = useState<{ target: SpeTarget; selected: number; wasPaused: boolean } | null>(null);
  const [command, setCommand] = useState<{ id: number; type: 'in' | 'out' | 'reset' }>({ id: 0, type: 'reset' });
  const { options: routes, error: routeError } = useMemo(() => missionRoutes(terrain, slopes, start, target, routing),
    [terrain, slopes, start, target, routing]);
  const { options: routeComparison, recommended } = useMemo(
    () => compareRoutes(routes, stopMinutes, delay, reserveSettings, routing.priority),
    [routes, stopMinutes, delay, reserveSettings, routing.priority],
  );
  const selected = routeComparison.find(({ route }) => route.id === selectedRoute) ?? recommended ?? routeComparison[0];
  const legs = selected?.route;
  const mapDirection = eva ? eva.phase === 'inbound' ? 'back' : 'out' : direction;
  const activeLeg = legs?.[mapDirection];
  const returnPlanner = useMemo(() => createReturnPlanner(terrain, slopes, start, routing.slopeLimit),
    [terrain, slopes, start, routing.slopeLimit]);
  const location = eva ? evaLocation(eva) : null;
  const baseOption = eva && location && (!eva.outcome || eva.outcome === 'sheltered') && (eva.phase !== 'inbound' || spe)
    ? returnPlanner(location) : null;
  const telemetry = eva ? evaTelemetry(eva, baseOption) : null;
  const continuingMargin = telemetry?.continuePlan?.margin ?? telemetry?.returnNow?.margin;
  const reviewingSPE = spe !== null;
  const candidates = useMemo(() => reviewingSPE ? findShelterCandidates(terrain, slopes, routing.slopeLimit) : [],
    [reviewingSPE, terrain, slopes, routing.slopeLimit]);
  const drillOptions = useMemo(() => reviewingSPE && eva ? shelterOptions(terrain, slopes, routing.slopeLimit, candidates, eva) : [],
    [reviewingSPE, terrain, slopes, routing.slopeLimit, candidates, eva]);
  const drillOption = spe ? drillOptions[spe.selected] : undefined;
  const drillBase = spe && baseOption && eva ? {
    distanceM: baseOption.distanceM, arrival: estimateReserve(baseOption.distanceM, 0, eva.elapsed, eva.plan.settings),
  } : null;
  const activeShelter = eva?.shelter;
  const shelterPins = useMemo(() => activeShelter
    ? [{ id: activeShelter.label, point: activeShelter.path.vertices.at(-1)!.point, selected: true }]
    : drillOptions.map(({ candidate }, index) => ({
      id: String(index + 1), point: candidate.point, selected: index === spe?.selected,
    })), [drillOptions, spe?.selected, activeShelter]);
  const candidateLabel = activeShelter?.label ?? (spe && drillOption ? String(spe.selected + 1) : null);
  const evaPath = eva ? activeEvaPath(eva) : null;
  const previewPath = useMemo(() => {
    if (!spe || !eva) return null;
    if (drillOption) return drillOption.path;
    const origin = evaLocation(eva);
    const base = returnPlanner(origin);
    return base ? pathFromLocation(origin, base) : null;
  }, [spe, eva, drillOption, returnPlanner]);
  const routeToBase = Boolean(spe && previewPath && !drillOption);
  const activeColor = candidateLabel ? SHELTER_COLOR : routeToBase ? routeColor.back : routeColor[mapDirection];
  const activeDashed = Boolean(candidateLabel) || routeToBase || mapDirection === 'back';
  const routeLabel = candidateLabel ? `To candidate ${candidateLabel}`
    : routeToBase ? 'Route to base'
    : eva?.earlyReturn ? 'Early return route'
    : mapDirection === 'out' ? 'Outbound route' : 'Return route';
  const visiblePath = previewPath ?? evaPath;
  const evaPoints = useMemo(() => visiblePath?.vertices.map(({ point }) => point), [visiblePath]);
  const evaPlaying = Boolean(eva && !eva.paused && !eva.outcome && !spe);
  const evaSpeed = eva?.speed;
  const distance = selected?.distanceM ?? 0;
  const estimate = selected?.reserve ?? null;
  const belowReserve = Boolean(estimate && estimate.margin < -RESERVE_EPSILON);
  const isScience = sameCell(target, defaultTarget);
  const expandedMap = section === '#surface-map';
  const survivalOpen = section === '#reserve-panel';
  const scienceOpen = section === '#field-science';
  const routeOpen = !expandedMap && !survivalOpen && !scienceOpen;
  const phaseLabel = (phase: EvaSession['phase']) => eva?.phase === phase && !eva.outcome ? 'step' : undefined;

  useEffect(() => {
    const syncSection = () => setSection(window.location.hash);
    window.addEventListener('hashchange', syncSection);
    return () => window.removeEventListener('hashchange', syncSection);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [section]);

  useEffect(() => {
    if (!evaPlaying || !evaSpeed) return;
    const rate = evaSpeed;
    let timer: number | undefined;
    function syncClock() {
      window.clearInterval(timer);
      if (document.hidden) return;
      let previous = performance.now();
      timer = window.setInterval(() => {
        if (document.hidden) return;
        const now = performance.now();
        const minutes = (now - previous) * rate / 60_000;
        previous = now;
        setEva((current) => current && current.speed === rate ? advanceEva(current, minutes) : current);
      }, 50);
    }
    syncClock();
    document.addEventListener('visibilitychange', syncClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', syncClock);
    };
  }, [evaPlaying, evaSpeed]);

  function moveMap(type: 'in' | 'out' | 'reset') {
    setCommand(({ id }) => ({ id: id + 1, type }));
  }

  function loadDemo() {
    setEva(null);
    setSpe(null);
    setStart(defaultStart);
    setTarget(defaultTarget);
    setStopMinutes(STOP_MINUTES);
    setDelay(0);
    setReserveSettings(DEFAULT_RESERVE_SETTINGS);
    setRouting(DEFAULT_ROUTING);
    setDirection('out');
    setLayer('optical');
    setMapScope('traverse');
    setOpacity(72);
    setLayersOpen(false);
    setPickMode(null);
    setPickError('');
    setInspection(null);
    setShowRover(false);
    setShowStations(true);
    setSelectedRoute('direct');
    setSteps([false, false, false]);
    moveMap('reset');
  }

  function selectCell(cell: Cell) {
    if (!pickMode || eva) return;
    const trial = planMission(terrain, slopes, pickMode === 'start' ? cell : start,
      pickMode === 'target' ? cell : target, routing);
    if ('error' in trial) {
      setPickError(ERROR_TEXT[trial.error]);
      return;
    }
    if (pickMode === 'start') setStart(cell);
    if (pickMode === 'target') {
      setTarget(cell);
      setSteps([false, false, false]);
    }
    setSelectedRoute('direct');
    setPickMode(null);
    setPickError('');
  }

  function togglePick(mode: 'start' | 'target') {
    if (eva) return;
    const next = pickMode === mode ? null : mode;
    setPickMode(next);
    setPickError('');
    if (next) setInspection(null);
    if (next && window.matchMedia('(max-width: 900px)').matches) {
      document.getElementById('surface-map')?.scrollIntoView({ block: 'start' });
    }
    if (next) setMapScope('traverse');
  }

  function changeMapScope(scope: MapScope) {
    setMapScope(scope);
    setPickMode(null);
    setPickError('');
    setInspection(null);
  }

  function chooseRoute(id: RouteId) {
    if (eva) return;
    setSelectedRoute(id);
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  function beginEva() {
    if (!legs || eva) return;
    setEva(startEva(terrain, legs, stopMinutes + delay, reserveSettings));
    changeMapScope('traverse');
    moveMap('reset');
  }

  function startDrill() {
    if (!eva || eva.outcome || spe) return;
    setSpe({ target: 5, selected: 0, wasPaused: eva.paused });
    setEva((current) => current && { ...current, paused: true });
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  function closeDrill() {
    if (!spe) return;
    setEva((current) => current && { ...current, paused: spe.wasPaused });
    setSpe(null);
  }

  function goToBase() {
    if (!eva) return;
    const returning = returnEva(eva, returnPlanner, reviewingSPE);
    setEva(returning);
    if (!returning.returnError) setSpe(null);
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  useEffect(() => {
    if (!pickMode) return;
    function cancel(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPickMode(null);
        setPickError('');
      }
    }
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [pickMode]);

  const layerModes = [
    { type: 'optical', label: 'Optical', source: 'HiRISE / USGS', icon: Map },
    { type: 'slope', label: 'Terrain slope', source: 'Gale DEM · 10 m grid', icon: Mountain },
    { type: 'thermal', label: 'Thermal infrared', source: 'NASA Mars Trek · THEMIS', icon: Activity },
  ] as const;
  const selectedLayer = layerModes.find(({ type }) => type === layer)!;
  const inspectedCell = inspection ? inspectTerrain(terrain, slopes, inspection) : null;
  const usingDemoEndpoints = sameCell(start, defaultStart) && isScience;
  const mapProps = {
    terrain, slopes, start, target, activeLeg, activeColor, activeDashed, activeDirection: mapDirection,
    evaPoint: location?.point, evaPoints, shelterPins,
    layer, slopeLimit: routing.slopeLimit, scope: mapScope, opacity: opacity / 100, mode: pickMode, onPick: selectCell,
    inspection, onInspect: setInspection, showRover, showStations, onChangeScope: changeMapScope,
    onCoordinate: setCoordinate, command, expanded: expandedMap,
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}mars.svg`} alt="" />
          <div>MARS SPACE <b>VISION</b><small>MISSION CONTROL</small></div>
        </div>
        <nav className="console-nav" aria-label="Mission control">
          <a href="#mission" aria-current={routeOpen ? 'location' : undefined}><Compass size={15} /> Mission</a>
          <a href="#surface-map" aria-current={expandedMap ? 'location' : undefined}><Map size={15} /> Map</a>
          <a href="#reserve-panel" aria-current={section === '#reserve-panel' ? 'location' : undefined}><BatteryCharging size={15} /> Survival</a>
          <a href="#field-science" aria-current={section === '#field-science' ? 'location' : undefined}><FlaskConical size={15} /> Science</a>
        </nav>
        <div className="topbar-end">
          <button className="button button--ghost" onClick={() => setShowSources(true)}><Database size={15} /> Data sources</button>
        </div>
      </header>

      <main>
        <section className="command-deck" id="mission" aria-label="Mission controls">
          {!eva && <div className="mission-header">
            <div className="mission-heading">
              <h1><Target size={17} /> Gale Crater</h1>
              <p>{usingDemoEndpoints ? 'Bradbury Landing → Yellowknife Bay' : 'Custom traverse'}</p>
            </div>
            {estimate && legs && <dl className="mission-readouts" aria-label="Selected route summary">
              <div><dt>Route</dt><dd style={{ color: legs.color }}>{legs.code}</dd></div>
              <div><dt>Distance</dt><dd>{kilometers(distance)} <small>km</small></dd></div>
              <div><dt>Mission time</dt><dd>{Math.round(estimate.missionMinutes)} <small>min</small></dd></div>
              <div><dt>Return reserve</dt><dd data-low={belowReserve}>{signMinutes(estimate.margin)} <small>min</small>
                {belowReserve && <span className="reserve-warning">Below reserve</span>}
              </dd></div>
            </dl>}
            <div className="mission-actions">
              <button className="button button--ghost" onClick={loadDemo}><RotateCcw size={14} /> Load Gale demo</button>
              <button className="button button--primary" disabled={!legs} onClick={beginEva}><Play size={15} /> Start EVA</button>
            </div>
          </div>}
          {eva && telemetry && legs && <EvaPanel session={eva} telemetry={telemetry} routeCode={legs.code}
            reviewingSPE={reviewingSPE} onSPE={startDrill}
            onTogglePause={() => setEva((current) => current && { ...current, paused: !current.paused })}
            onSpeed={(speed) => setEva((current) => current && { ...current, speed })}
            onDelay={() => setEva((current) => current && delayEva(current))}
            onReturn={goToBase}
            onReset={() => { setEva(null); setSpe(null); }} />}
        </section>

        <div className={`dashboard${expandedMap ? ' dashboard--map' : survivalOpen || scienceOpen ? ' dashboard--tools' : ''}${spe ? ' dashboard--spe' : ''}`}>
          <div className="primary-col">
            <section className="panel map-panel" id="surface-map" aria-labelledby="map-title">
              <div className="panel-title map-title">
                <div className="section-heading"><Map size={17} /><h2 id="map-title">Surface map</h2></div>
                <div className="map-view-controls">
                  <div className="leg-switch map-dimension" role="group" aria-label="Map perspective">
                    <button aria-pressed={mapDimension === '2D'} onClick={() => setMapDimension('2D')}>2D</button>
                    <button aria-pressed={mapDimension === '3D'} onClick={() => setMapDimension('3D')}><Mountain size={13} /> 3D</button>
                  </div>
                  <div className="leg-switch" role="group" aria-label="Map coverage">
                    <button aria-pressed={mapScope === 'crater'} onClick={() => changeMapScope('crater')}>Full crater</button>
                    <button aria-pressed={mapScope === 'region'} onClick={() => changeMapScope('region')}>Landing region</button>
                    <button aria-pressed={mapScope === 'traverse'} onClick={() => changeMapScope('traverse')}>Traverse</button>
                  </div>
                  {mapScope !== 'crater' && <button className="button rover-toggle" aria-pressed={showRover}
                    onClick={() => setShowRover(!showRover)}><Route size={13} /> Curiosity</button>}
                  {mapDimension === '2D' && mapScope !== 'crater' && <button className="button layer-toggle"
                    aria-pressed={showStations} onClick={() => setShowStations(!showStations)}>
                    <Flag size={13} /> Map pins
                  </button>}
                  {mapScope === 'traverse' && <button className="button layer-toggle" aria-controls={layersOpen ? 'map-layers' : undefined}
                    aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}><Layers3 size={14} /> Layers <ChevronDown size={13} className={layersOpen ? 'turned' : ''} /></button>}
                  <a className="icon-button map-expand" href={expandedMap ? '#mission' : '#surface-map'}
                    aria-label={expandedMap ? 'Close expanded map' : 'Expand map'} title={expandedMap ? 'Close expanded map' : 'Expand map'}>
                    {expandedMap ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </a>
                </div>
              </div>
              <div className={`map-stage${mapDimension === '3D' ? ' map-stage--relief' : ''}`}>
                {mapDimension === '3D' ? (
                  <Suspense fallback={<div className="relief-status" role="status">Loading 3D viewer…</div>}>
                    <ReliefMap key={mapScope} {...mapProps} routes={routes} selectedRoute={legs?.id}
                      stopTime={stopMinutes + delay} onSelectRoute={chooseRoute} onFallback={() => setMapDimension('2D')} />
                  </Suspense>
                ) : <TerrainMap {...mapProps} />}
                {mapScope === 'traverse' && layersOpen && <div className="layer-deck" id="map-layers" aria-label="Map layer">
                  {layerModes.map(({ type, label, source, icon: Icon }) =>
                    <button key={type} data-layer={type} className="layer-choice" aria-pressed={layer === type} onClick={() => setLayer(type)}>
                      <span className="layer-glyph"><Icon size={15} /></span>
                      <span><strong>{label}</strong><small>{source}</small></span>
                      <i aria-hidden="true">{layer === type && <Check size={11} />}</i>
                    </button>
                  )}
                  {layer !== 'optical' && <label className="layer-opacity">
                    <span>Overlay opacity <b>{opacity}%</b></span>
                    <input type="range" min={10} max={100} value={opacity}
                      onChange={(event) => setOpacity(Number(event.target.value))} />
                  </label>}
                </div>}
                <div className="map-corner">
                  {mapDimension === '2D' && <span className="north"><b>N</b><Compass size={19} /></span>}
                  <div className="map-controls">
                    <button aria-label="Zoom in" onClick={() => moveMap('in')}><Plus size={17} /></button>
                    <button aria-label="Zoom out" onClick={() => moveMap('out')}><Minus size={17} /></button>
                    <button aria-label="Reset map view" onClick={() => moveMap('reset')}><Target size={16} /></button>
                  </div>
                </div>
                {pickMode && <div className="pick-banner" role="status">
                  <Target size={15} /> {pickError || `Click the map to place the ${pickMode === 'start' ? 'base camp' : 'science stop'}.`}
                  <button aria-label="Cancel point selection" onClick={() => setPickMode(null)}><X size={16} /></button>
                </div>}
                <div className="layer-note">
                  {mapScope === 'crater' ? (
                    <span><i className="key low" /> Curiosity landing region</span>
                  ) : mapScope === 'region' ? (
                    <span><i className="key coverage-key" /> EVA study area · 1 km × 1 km</span>
                  ) : layer === 'slope' ? (
                    <><span><i className="key low" /> 0–8°</span>{routing.slopeLimit > 8 && <span><i className="key mid" /> &gt;8–{routing.slopeLimit}°</span>}
                      <span><i className="key high" /> &gt;{routing.slopeLimit}°</span><span><i className="key unknown" /> No data</span></>
                  ) : layer === 'thermal' ? (
                    <><i className="thermal-ramp" /><span>Relative IR brightness · local contrast</span></>
                  ) : null}
                  {mapScope === 'traverse' && (activeLeg || evaPoints) && <span>
                    <i className="key route-key" data-dashed={activeDashed} style={{ color: activeColor }} /> {routeLabel}
                  </span>}
                  {mapScope !== 'crater' && showRover && <span><i className="key rover-key" /> Curiosity · Sol 3–130</span>}
                  {mapDimension === '2D' && mapScope !== 'crater' && showStations && <span>
                    <Flag size={12} /> Simulated stations <Camera size={12} /> Archived photos
                  </span>}
                </div>
                {mapDimension === '3D' && <span className="relief-caption">Drag to orbit · Height ×{verticalExaggeration[mapScope]}</span>}
              </div>
              {!eva && expandedMap && mapScope === 'traverse' && <div className="map-leg-tools">
                <div className="leg-switch" role="group" aria-label="Map route leg">
                  <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}><ArrowUpRight size={13} /> Outbound</button>
                  <button aria-pressed={direction === 'back'} onClick={() => setDirection('back')}><ArrowDownLeft size={13} /> Return</button>
                </div>
              </div>}
              {!eva && expandedMap && mapScope === 'traverse' && routeComparison.length > 0 && <div className="map-route-strip" role="group" aria-label="Routes in the map">
                {routeComparison.map(({ route, reserve }) => <button key={route.id} className="button"
                  aria-pressed={route.id === legs?.id} onClick={() => chooseRoute(route.id)}>
                  <b style={{ color: route.color }}>{route.code}</b>
                  <span>{route.name}</span>
                  <small data-below={reserve.margin < -RESERVE_EPSILON}>{signMinutes(reserve.margin)} min reserve</small>
                </button>)}
              </div>}
              {mapDimension === '3D' && mapScope !== 'traverse' && <div className="route-map-prompt">
                <span>Compare routes and arrival times in the EVA area.</span>
                <button className="button" onClick={() => changeMapScope('traverse')}>Open Traverse <ArrowRight size={13} /></button>
              </div>}
              {inspection && <section className="map-inspector" aria-label="Selected point details">
                <div className="inspection-location">
                  <Target size={15} />
                  <div><strong>Selected point</strong><span className="coordinates">{displayPosition(terrain, inspection)}</span></div>
                </div>
                {inspectedCell ? <dl>
                  <div><dt>Elevation</dt><dd>{inspectedCell.elevationM === null ? 'No data' : `${meters(inspectedCell.elevationM)} m`}</dd></div>
                  <div><dt>Slope</dt><dd>{inspectedCell.slope === null ? 'No data' : `${inspectedCell.slope.toFixed(1)}°`}</dd></div>
                </dl> : <p>Outside the EVA terrain grid. Coordinates only.</p>}
                <button className="icon-button" aria-label="Clear selected point" onClick={() => setInspection(null)}><X size={15} /></button>
              </section>}
              <div className="map-footer">
                <span><Layers3 size={14} /> {mapScope === 'crater'
                  ? `Mars Trek · CTX / MOLA–HRSC · Gale ≈ ${galeOverview.diameterKm} km across`
                  : mapScope === 'region' ? 'Mars Trek · MRO CTX · 8 km × 8 km'
                  : `${layer === 'thermal' ? 'Mars Trek · THEMIS day IR · ~100 m/px' : selectedLayer.source} · 1 km × 1 km`}</span>
                <span className="coordinates">{mapDimension === '3D' && mapScope !== 'traverse' ? 'Elevation: USGS MOLA / HRSC' : coordinate}</span>
              </div>
            </section>

            {expandedMap && !spe && eva && telemetry && <EvaReserve session={eva} telemetry={telemetry} />}
            {!expandedMap && !scienceOpen && <section className="panel profile-panel" aria-labelledby="profile-title">
              <div className="panel-title">
                <div className="section-heading"><Activity size={18} /><h2 id="profile-title">{eva ? 'Planned elevation profile' : 'Elevation profile'}</h2></div>
                {!eva && <div className="leg-switch" aria-label="Route leg">
                  <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}><ArrowUpRight size={14} /> Outbound</button>
                  <button aria-pressed={direction === 'back'} onClick={() => setDirection('back')}><ArrowDownLeft size={14} /> Return</button>
                </div>}
              </div>
              <ElevationChart leg={activeLeg} color={routeColor[mapDirection]} />
              {activeLeg && <div className="profile-metrics">
                <div><span>Leg distance</span><b>{kilometers(activeLeg.distanceM)} km</b></div>
                <div><span>Ascent</span><b>+{meters(activeLeg.climbM)} m</b></div>
                <div><span>Descent</span><b>−{meters(activeLeg.descentM)} m</b></div>
                <div><span>Steepest step</span><b>{activeLeg.maxSlope.toFixed(1)}°</b></div>
              </div>}
            </section>}
          </div>

          {spe && eva && <aside className="workspace-col" aria-label="SPE response">
            <SpePanel cellM={terrain.cellM} target={spe.target} options={drillOptions} selected={spe.selected} base={drillBase}
              urgent={continuingMargin !== undefined && continuingMargin < -RESERVE_EPSILON}
              onTarget={(value) => setSpe({ ...spe, target: value })}
              onSelect={(index) => {
                setSpe({ ...spe, selected: index });
                if (mapScope !== 'traverse') changeMapScope('traverse');
              }}
              onDivert={() => {
                if (!drillOption?.resourcesLast) return;
                setEva(divertEva(eva, { label: String(spe.selected + 1), path: drillOption.path }));
                setSpe(null);
                if (mapScope !== 'traverse') changeMapScope('traverse');
              }}
              onReturn={goToBase} onClose={closeDrill} />
          </aside>}

          {!spe && routeOpen && <aside className="workspace-col" aria-label="Mission planning">
            {eva && telemetry && <EvaReserve session={eva} telemetry={telemetry} />}
            <section className="panel planner" aria-labelledby="planner-title">
              <div className="panel-title">
                <div className="section-heading"><Flag size={17} /><h2 id="planner-title">Mission route</h2></div>
                <ArrowLeftRight className="route-heading-icon" size={15} aria-label="Round trip" />
              </div>
              <div className="route-stops">
                <div className="stop">
                  <span className="stop-icon base"><House size={15} /></span>
                  <div><span>START / RETURN</span><strong>{sameCell(start, defaultStart) ? 'Bradbury Landing' : 'Custom base'}</strong></div>
                  {!eva && <button className="icon-button choose-point" aria-label="Change base camp" aria-pressed={pickMode === 'start'}
                    title="Change base camp on map" onClick={() => togglePick('start')}><Target size={17} /></button>}
                </div>
                <div className="stop">
                  <span className="stop-icon destination"><FlaskConical size={15} /></span>
                  <div><span>SCIENCE STOP</span><strong>{isScience ? 'Yellowknife Bay' : 'Custom science stop'}</strong></div>
                  {!eva && <button className="icon-button choose-point" aria-label="Change science stop" aria-pressed={pickMode === 'target'}
                    title="Change science stop on map" onClick={() => togglePick('target')}><Target size={17} /></button>}
                </div>
              </div>
              {!eva && <div className="route-settings">
                <div className="route-priorities" role="group" aria-label="Routing priority">
                  {priorities.map(({ id, label, detail }) => <button key={id} aria-pressed={routing.priority === id}
                    title={detail} onClick={() => setRouting({ ...routing, priority: id })}>{label}</button>)}
                </div>
                <p>{priorities.find(({ id }) => id === routing.priority)?.detail}</p>
                <label>Max terrain slope
                  <select value={routing.slopeLimit} onChange={(event) => {
                    setRouting({ ...routing, slopeLimit: Number(event.target.value) });
                    setPickError('');
                  }}>
                    {[8, 12, MAX_SLOPE].map((limit) => <option key={limit} value={limit}>{limit}°</option>)}
                  </select>
                </label>
              </div>}
              {eva && legs && <div className="active-route-summary">
                <span className="route-code" style={{ color: legs.color }}>{legs.code}</span>
                <strong>{legs.name}</strong>
                <span>{routing.slopeLimit}° slope limit</span>
              </div>}
              {routeError && <div className="route-error" role="status"><CircleAlert size={17} />{ERROR_TEXT[routeError]}</div>}
              {!eva && routeComparison.length > 0 && <>
                <div className="route-choices" role="group" aria-label="EVA route options">
                  {routeComparison.map(({ route, distanceM, reserve, maxSlope }) => (
                    <button key={route.id} aria-pressed={route.id === legs?.id} onClick={() => chooseRoute(route.id)}>
                      <span className="route-code" style={{ color: route.color }}>{route.code}</span>
                      <span className="route-choice-label"><strong>{route.name}</strong><small>
                        Stop +{Math.round(arrivalMinutes(route, 'out'))} min · {kilometers(distanceM)} km · {maxSlope.toFixed(1)}°
                      </small></span>
                      <span className="route-choice-end">
                        {route.id === recommended?.route.id && <small>Suggested</small>}
                        <strong data-below={reserve.margin < -RESERVE_EPSILON}>{signMinutes(reserve.margin)} min</strong>
                        <small>reserve</small>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="route-choice-note" role="status">{recommended
                  ? `Route ${recommended.route.code}: ${routing.priority === 'gentler' ? 'lowest peak step slope' : 'most return margin'} among routes within reserve.`
                  : 'All routes are below the current return reserve.'}</p>
              </>}
            </section>

            <section className="panel timeline-panel" aria-labelledby="timeline-title">
              <div className="panel-title"><div className="section-heading"><Route size={17} /><h2 id="timeline-title">Traverse sequence</h2></div></div>
              {eva ? <div className="timeline">
                <div aria-current={phaseLabel('outbound')}><ArrowUpRight size={15} /><span>Outbound</span></div>
                <div aria-current={phaseLabel('stop')}><FlaskConical size={14} /><span>Fieldwork</span></div>
                <div aria-current={phaseLabel('inbound')}><ArrowDownLeft size={15} /><span>{eva.earlyReturn ? 'Early return' : 'Return to base'}</span></div>
                {eva.shelter && <div aria-current={phaseLabel('shelter')}><Flag size={15} /><span>Candidate {eva.shelter.label}</span></div>}
              </div> : <div className="timeline">
                <button aria-pressed={mapDirection === 'out'} onClick={() => setDirection('out')}>
                  <ArrowUpRight size={15} /><span>Walk to stop</span><b>{legs ? `${Math.round(walkMinutes(legs.out.distanceM))} min` : '—'}</b>
                </button>
                <div><FlaskConical size={14} /><span>Fieldwork</span><b>{stopMinutes} min</b></div>
                {delay > 0 && <div className="timeline-delay"><Clock3 size={14} /><span>Added delay</span><b>+{delay} min</b></div>}
                <button aria-pressed={mapDirection === 'back'} onClick={() => setDirection('back')}>
                  <ArrowDownLeft size={15} /><span>Walk to base</span><b>{legs ? `${Math.round(walkMinutes(legs.back.distanceM))} min` : '—'}</b>
                </button>
              </div>}
            </section>
          </aside>}

          {!spe && survivalOpen && <aside className="workspace-col" aria-label="Survival planning">
            {eva && telemetry ? <EvaReserve session={eva} telemetry={telemetry} /> :
              <ReturnReserve route={legs} estimate={estimate} stopMinutes={stopMinutes} delay={delay}
              settings={reserveSettings} onStopChange={setStopMinutes} onDelayChange={setDelay}
              onSettingsChange={setReserveSettings} />}
          </aside>}

          {!spe && scienceOpen && <aside className="workspace-col" aria-label="Science workspace">
            <section className="panel science-panel" id="field-science" aria-labelledby="science-title">
              <div className="panel-title">
                <div className="section-heading"><FlaskConical size={17} /><h2 id="science-title">Field science</h2></div>
                {isScience && <a className="icon-button" aria-label="Open the NASA Mastcam source" href={scienceSource} target="_blank" rel="noreferrer"><ArrowUpRight size={16} /></a>}
              </div>
              {isScience ? <>
                <div className="science-photo">
                  <img src={asset('sheepbed.webp')} alt="Curiosity Mastcam view of spherules in Yellowknife Bay mudstone" />
                  <span><Camera size={11} /> CURIOSITY MASTCAM · SOL 139</span>
                </div>
                <div className="science-body">
                  <h3>Sheepbed mudstone</h3>
                  <p>What do these fine-grained sediments reveal about ancient water?</p>
                  <div className="checklist">
                    {['Photograph the outcrop', 'Record visible layering', 'Flag a sample candidate'].map((step, index) =>
                      <label key={step} className={steps[index] ? 'done' : ''}>
                        <input type="checkbox" checked={steps[index]} onChange={() =>
                          setSteps((items) => items.map((item, i) => i === index ? !item : item))} />
                        <span className="step-box">{steps[index] && <Check size={12} />}</span>{step}
                      </label>
                    )}
                  </div>
                </div>
              </> : <p className="reserve-empty">Custom waypoint. Select the Gale demo to restore the sourced Yellowknife Bay science stop.</p>}
            </section>
          </aside>}
        </div>

      </main>
      {showSources && <SourcesDialog terrain={terrain} close={() => setShowSources(false)} />}
    </div>
  );
}

export function App() {
  const [terrain, setTerrain] = useState<Terrain>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(asset('terrain.json'), { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error('Terrain data unavailable');
      return response.json() as Promise<Terrain>;
    }).then(setTerrain).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  if (!terrain) return <main className="loading" role={failed ? 'alert' : 'status'}>
    {failed ? 'Gale data could not be loaded. Refresh to try again.' : 'Loading Gale terrain…'}
  </main>;
  return <MissionControl terrain={terrain} />;
}
