import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BatteryCharging,
  Camera, Check, ChevronDown, CircleAlert, Clock3, Compass, Crosshair, Database, Flag,
  FlaskConical, House, Layers3, Map, Maximize2, Minimize2, Minus, Mountain, Play, Plus, RotateCcw, Route, Target, Video, X,
} from 'lucide-react';
import { routeColor, TerrainMap } from './TerrainMap';
import type { LayerMode, MapCommand, MapScope } from './TerrainMap';
import { verticalExaggeration } from './terrainRelief';
import { ReturnReserve } from './ReturnReserve';
import { EvaPanel, EvaReserve } from './EvaPanel';
import { SpePanel } from './SpePanel';
import type { SpeTarget } from './SpePanel';
import { SHELTER_COLOR } from './shelters';
import type { ShelterOption } from './shelters';
import { activeEvaPath, advanceEva, createReturnPlanner, delayEva, divertEva, evaHeading, evaLocation, evaTelemetry, pathFromLocation, returnEva, startEva, startMissionEva } from './eva';
import type { EvaSession } from './eva';
import galeOverview from './galeOverview.json';
import {
  cellAt, cellCenter, DEFAULT_RESERVE_SETTINGS, DEFAULT_ROUTING, displayPosition, estimateTimedReserve, inspectTerrain, localPoint,
  MAX_SLOPE, RESERVE_EPSILON, slopeGrid, STOP_MINUTES,
} from './mission';
import type { Cell, Leg, LocalPoint, RoutePriority, Terrain } from './mission';
import { arrivalMinutes, cameraStops, compareRoutes, missionRoutes } from './galeRoutes';
import type { RouteId } from './galeRoutes';
import { MissionBuilder, MissionResult } from './MissionBuilder';
import type { MissionPick } from './MissionBuilder';
import { buildMission, readMissionDraft, saveMissionDraft } from './missionDraft';
import type { MissionDraft } from './missionDraft';
import type { MissionPin } from './mapSymbols';
import { lightStatus, liveSlope, marsSun, radDose, radioStatus } from './environment';
import { regionAsset, regionLabels } from './regionAssets';
import { useTerrainWorker } from './useTerrainWorker';
import 'leaflet/dist/leaflet.css';
import './style.css';

const asset = (name: string) => `${import.meta.env.BASE_URL}gale/${name}`;
const ReliefMap = lazy(() => import('./ReliefMap'));
const HelmetView = lazy(() => import('./ReliefMap').then(({ HelmetView }) => ({ default: HelmetView })));
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
  const valid = terrain.elevationM.filter((value): value is number => Number.isFinite(value));
  const relief = valid.length ? Math.max(...valid) - Math.min(...valid) : null;
  return (
    <dialog className="sources-dialog" ref={(dialog) => {
      if (dialog && !dialog.open) dialog.showModal();
    }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="sources-content">
        <div className="panel-title">
          <div className="section-heading"><Database size={18} /><h2>Data sources</h2></div>
          <button className="icon-button" onClick={close} aria-label="Close data sources"><X size={19} /></button>
        </div>
        <p className="muted">{regionLabels[terrain.region ?? 'gale']} · Archived mission products · Retrieved {terrain.retrievedAt}</p>
        <article className="source-card">
          <h3>Terrain coverage</h3>
          <p>DEM product spacing 1 m · Routing grid {terrain.cellM} m · Detailed helmet grid 2 m</p>
          <p>{(100 * valid.length / terrain.elevationM.length).toFixed(1)}% valid routing cells · Relief {relief === null ? 'unavailable' : `${relief.toFixed(1)} m`}</p>
          <p>Sample coverage and resolution describe the dataset. Mixed source resolution limits obstacle detection.</p>
        </article>
        <article className="source-card">
          <h3>Simulation reference models</h3>
          <p>RAD detector E reference dose in µGy · 265 µGy/day quiet baseline · 417 µGy/day September 2017 SPE average.</p>
          <p>Terrain cover is geometric. Suit dose and radiation protection are unverified. Radio uses a 300 m training scenario and terrain line of sight.</p>
          <div className="source-links">
            <a href="https://doi.org/10.1029/2018GL077760" target="_blank" rel="noreferrer">Curiosity RAD dose study <ArrowUpRight size={13} /></a>
            <a href="https://www.giss.nasa.gov/tools/mars24/help/algorithm.html" target="_blank" rel="noreferrer">NASA Mars24 solar position <ArrowUpRight size={13} /></a>
          </div>
        </article>
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
          <p>NASA/JPL-Caltech · {terrain.region === 'boxwork'
            ? 'Boxwork training corridor anchored to Curiosity waypoints from Sols 4580 and 4655.'
            : 'Archived geometry between the Sol 3 and Sol 130 waypoint positions.'}</p>
          <div className="source-links">
            <a href="https://science.nasa.gov/mission/msl-curiosity/location-map/" target="_blank" rel="noreferrer">NASA rover map <ArrowUpRight size={13} /></a>
            <a href={galeOverview.roverSource} target="_blank" rel="noreferrer">Original track <ArrowUpRight size={13} /></a>
          </div>
        </article>
        {(terrain.region ?? 'gale') === 'gale' && <article className="source-card">
          <div className="source-title"><h3>Curiosity camera stops</h3></div>
          <p>Historical camera locations taken from the NASA/JPL-Caltech waypoint archive.</p>
          <div className="source-links">
            {cameraStops.map((stop) => <a key={stop.name} href={stop.source} target="_blank" rel="noreferrer">
              {stop.name} <ArrowUpRight size={13} />
            </a>)}
          </div>
        </article>}
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

const noShelters: ShelterOption[] = [];
const noRoutes: ReturnType<typeof missionRoutes> = { options: [], error: null };
const noPreview: ReturnType<typeof buildMission> = { stops: [], error: { index: 0, reason: 'pick' } };
type Region = NonNullable<Terrain['region']>;
type MissionEvent = { minutes: number; label: string };

function MissionControl({ terrain, draft, setDraft, onRegion, loadingRegion, regionFailed }: {
  terrain: Terrain; onRegion: (region: Region) => void; loadingRegion: boolean; regionFailed: boolean;
  draft: MissionDraft; setDraft: Dispatch<SetStateAction<MissionDraft>>;
}) {
  const region = terrain.region ?? 'gale';
  const boxwork = region === 'boxwork';
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
  const [missionPick, setMissionPick] = useState<MissionPick | null>(null);
  const [helmetOpen, setHelmetOpen] = useState(true);
  const [helmetRelief, setHelmetRelief] = useState(false);
  const [showRange, setShowRange] = useState(false);
  const [showShadow, setShowShadow] = useState(false);
  const [eventStart, setEventStart] = useState<number | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [lowestReserve, setLowestReserve] = useState<number | null>(null);
  const previousStatus = useRef<{ radio: string; below: boolean; outcome: string | null } | null>(null);
  const [spe, setSpe] = useState<{ target: SpeTarget; selected: number; wasPaused: boolean } | null>(null);
  const [command, setCommand] = useState<MapCommand>({ id: 0, type: 'reset' });
  const missionName = eva?.plan.name;
  const customEva = Boolean(missionName);
  const builderOpen = section === '#create-mission' && !eva;
  const showMissionMap = builderOpen || customEva;
  const missionBase = draft.base ?? start;
  const missionRouting = draft.routing ?? routing;
  const mapSlopeLimit = showMissionMap ? missionRouting.slopeLimit : routing.slopeLimit;
  const mapDirection = eva ? eva.phase === 'inbound' ? 'back' : 'out' : direction;
  const base = showMissionMap ? missionBase : start;
  const reviewingSPE = spe !== null;
  const routeRequest = useMemo(() => ({ type: 'routes' as const, start, target, routing }), [start, target, routing]);
  const draftRequest = useMemo(() => builderOpen ? ({ type: 'draft' as const, base: missionBase, draft,
    routing: missionRouting, settings: reserveSettings, delay }) : null, [builderOpen, missionBase, draft, missionRouting, reserveSettings, delay]);
  const terrainWork = useTerrainWorker(terrain, slopes, eva, base, mapSlopeLimit, reviewingSPE, showRange, showShadow,
    routeRequest, draftRequest);
  const { options: routes, error: routeError } = terrainWork.routes ?? noRoutes;
  const missionPreview = terrainWork.draft ?? noPreview;
  const { options: routeComparison, recommended } = useMemo(
    () => compareRoutes(routes, stopMinutes, delay, reserveSettings, routing.priority),
    [routes, stopMinutes, delay, reserveSettings, routing.priority],
  );
  const selected = routeComparison.find(({ route }) => route.id === selectedRoute) ?? recommended ?? routeComparison[0];
  const legs = selected?.route;
  const activeLeg = showMissionMap ? undefined : legs?.[mapDirection];
  const returnPlanner = useMemo(() => terrainWork.tree ? createReturnPlanner(terrain, slopes, base, mapSlopeLimit, terrainWork.tree) :
    terrainWork.treeFailed ? createReturnPlanner(terrain, slopes, base, mapSlopeLimit) : () => null,
    [terrain, slopes, base, mapSlopeLimit, terrainWork.tree, terrainWork.treeFailed]);
  const location = eva ? evaLocation(eva) : null;
  const heading = eva ? evaHeading(eva) : undefined;
  const baseOption = eva && location && (!eva.outcome || eva.outcome === 'sheltered') && (eva.phase !== 'inbound' || spe)
    ? returnPlanner(location) : null;
  const telemetry = eva ? evaTelemetry(eva, baseOption) : null;
  const continuingMargin = telemetry?.continuePlan?.margin ?? telemetry?.returnNow?.margin;
  const drillOptions = terrainWork.spe ?? noShelters;
  const basePoint = useMemo(() => cellCenter(terrain, base), [terrain, base]);
  const sun = location && eva ? marsSun(terrain, location.point, eva.elapsed) : null;
  const radio = location ? radioStatus(terrain, location.point, basePoint) : 'Data unavailable';
  const grade = location && heading ? liveSlope(terrain, location.point, heading) : null;
  const environment = eva && location && sun ? {
    radio, light: lightStatus(terrain, location.point, sun), dose: radDose(eva.elapsed, eventStart), ...grade,
  } : null;
  const drillOption = spe ? drillOptions[spe.selected] : undefined;
  const drillBase = spe && baseOption && eva ? {
    distanceM: baseOption.distanceM, arrival: estimateTimedReserve(baseOption.minutes, 0, eva.elapsed, eva.plan.settings),
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
    : builderOpen ? 'Planned traverse'
    : customEva && eva?.phase === 'outbound' ? `To stop ${eva.stopIndex + 1}`
    : mapDirection === 'out' ? 'Outbound route' : 'Return route';
  const visiblePath = previewPath ?? evaPath;
  const evaPoints = useMemo(() => {
    if (visiblePath) return visiblePath.vertices.map(({ point }) => point);
    if (builderOpen) return missionPreview.stops.flatMap(({ leg }, i) =>
      leg.path.slice(i === 0 ? 0 : 1).map((cell) => cellCenter(terrain, cell)));
  }, [visiblePath, builderOpen, missionPreview, terrain]);
  const missionReturnPoints = useMemo(() => builderOpen ? missionPreview.inbound?.path.map((cell) => cellCenter(terrain, cell)) : undefined,
    [builderOpen, missionPreview, terrain]);
  const missionPins = useMemo<MissionPin[] | undefined>(() => showMissionMap ? draft.stops.flatMap(({ cell, task }, index) => {
    if (!cell) return [];
    const active = eva && (eva.phase === 'outbound' || eva.phase === 'stop') && !eva.outcome && eva.stopIndex === index;
    const completed = eva && index < eva.completedStops;
    return [{ point: cellCenter(terrain, cell), id: String(index + 1), label: task.trim() || `Stop ${index + 1}`,
      status: completed ? 'complete' : active || missionPick === index ? 'active' : 'pending' }];
  }) : undefined, [draft.stops, showMissionMap, eva?.phase, eva?.outcome, eva?.stopIndex, eva?.completedStops, missionPick, terrain]);
  const evaPlaying = Boolean(eva && !eva.paused && !eva.outcome && !spe);
  const evaSpeed = eva?.speed;
  const distance = selected?.distanceM ?? 0;
  const estimate = selected?.reserve ?? null;
  const belowReserve = Boolean(estimate && estimate.margin < -RESERVE_EPSILON);
  const isScience = !boxwork && sameCell(target, defaultTarget);
  const expandedMap = section === '#surface-map';
  const survivalOpen = section === '#reserve-panel';
  const scienceOpen = section === '#field-science';
  const routeOpen = !expandedMap && !survivalOpen && !scienceOpen && !builderOpen && !customEva;

  useEffect(() => {
    const syncSection = () => setSection(window.location.hash);
    window.addEventListener('hashchange', syncSection);
    return () => window.removeEventListener('hashchange', syncSection);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setPickMode(null);
    setMissionPick(null);
    setPickError('');
  }, [section]);


  useEffect(() => {
    if (!eva) {
      previousStatus.current = null;
      return;
    }
    const margin = continuingMargin ?? (eva.outcome === 'arrived' ? telemetry?.current.margin : undefined);
    const below = margin !== undefined && margin < -RESERVE_EPSILON;
    const current = { radio, below, outcome: eva.outcome };
    const prior = previousStatus.current;
    const labels: string[] = [];
    if (!prior) labels.push('EVA started');
    if ((!prior || prior.radio !== radio) && radio !== 'Connected') labels.push(`Radio · ${radio}`);
    if (prior && prior.radio !== radio && radio === 'Connected') labels.push('Radio reconnected');
    if (below && !prior?.below) labels.push('Below return reserve');
    if (eva.outcome && prior?.outcome !== eva.outcome) {
      labels.push(eva.outcome === 'arrived' ? 'Returned to base' : eva.outcome === 'sheltered' ? 'Reached terrain cover candidate' : 'Resource depleted');
    }
    previousStatus.current = current;
    if (labels.length) setEvents((entries) => [...entries, ...labels.map((label) => ({ minutes: eva.elapsed, label }))]);
    if (margin !== undefined) setLowestReserve((old) => old === null || margin < old ? margin : old);
  }, [eva?.phase, eva?.stopIndex, eva?.completedStops, eva?.outcome, eva?.elapsed, radio, continuingMargin, telemetry?.current.margin]);
  useEffect(() => {
    if (!builderOpen) return;
    setMapScope('traverse');
    setDraft((current) => current.base && current.routing ? current :
      { ...current, base: current.base ?? start, routing: current.routing ?? routing });
  }, [builderOpen, start, routing, setDraft]);

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

  function locateAstronaut() {
    if (!location) return;
    if (mapScope !== 'traverse') changeMapScope('traverse');
    const { point } = location;
    setCommand(({ id }) => ({ id: id + 1, type: 'locate', point }));
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
    window.location.hash = 'mission';
    setSteps([false, false, false]);
    moveMap('reset');
  }

  function selectCell(cell: Cell) {
    if (builderOpen && missionPick !== null) {
      const ground = inspectTerrain(terrain, slopes, cellCenter(terrain, cell));
      if (!ground || ground.slope === null || ground.slope > mapSlopeLimit) {
        setPickError(ground ? ERROR_TEXT.invalid_cell : ERROR_TEXT.outside_area);
        return;
      }
      setDraft((current) => missionPick === 'base' ? { ...current, base: cell } :
        { ...current, stops: current.stops.map((stop, index) => index === missionPick ? { ...stop, cell } : stop) });
      setMissionPick(null);
      setPickError('');
      if (window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('mission-editor-title')?.scrollIntoView({ block: 'start' });
      }
      return;
    }
    if (!pickMode || eva) return;
    const ground = inspectTerrain(terrain, slopes, cellCenter(terrain, cell));
    if (!ground || ground.slope === null || ground.slope > mapSlopeLimit ||
      sameCell(cell, pickMode === 'start' ? target : start)) {
      setPickError(!ground ? ERROR_TEXT.outside_area : ground.slope === null || ground.slope > mapSlopeLimit ?
        ERROR_TEXT.invalid_cell : ERROR_TEXT.same_cell);
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
    setMissionPick(null);
    setPickError('');
    setInspection(null);
  }

  function chooseRoute(id: RouteId) {
    if (eva) return;
    setSelectedRoute(id);
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  function beginEva() {
    if (!legs || eva || loadingRegion || (!terrainWork.tree && !terrainWork.treeFailed)) return;
    clearTracking();
    setEva(startEva(terrain, legs, stopMinutes + delay, reserveSettings));
    changeMapScope('traverse');
    moveMap('reset');
  }

  function beginMission() {
    if (eva || loadingRegion || !missionPreview.inbound || !draft.name.trim() || draft.stops.some(({ task }) => !task.trim()) ||
      (!terrainWork.tree && !terrainWork.treeFailed)) return;
    setEva(startMissionEva(terrain, draft.name.trim(), missionPreview.stops, missionPreview.inbound, reserveSettings, delay));
    clearTracking();
    setMapDimension('2D');
    changeMapScope('traverse');
    moveMap('reset');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function clearTracking() {
    setHelmetOpen(true);
    setEventStart(null);
    setEvents([]);
    setLowestReserve(null);
    previousStatus.current = null;
  }

  function pickMissionPoint(pick: MissionPick) {
    setMapScope('traverse');
    setMissionPick(missionPick === pick ? null : pick);
    setPickError('');
    setInspection(null);
    if (missionPick !== pick && window.matchMedia('(max-width: 900px)').matches) {
      document.getElementById('surface-map')?.scrollIntoView({ block: 'start' });
    }
  }

  function startDrill() {
    if (!eva || eva.outcome || spe) return;
    setSpe({ target: 5, selected: 0, wasPaused: eva.paused });
    setEva((current) => current && { ...current, paused: true });
    setEventStart((start) => start ?? eva.elapsed);
    setEvents((entries) => [...entries, { minutes: eva.elapsed, label: 'SPE drill triggered' }]);
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  function closeDrill() {
    if (!spe) return;
    setEva((current) => current && { ...current, paused: spe.wasPaused });
    setSpe(null);
  }

  function addEvaDelay() {
    if (!eva) return;
    const delayed = delayEva(eva);
    if (delayed === eva) return;
    setEva(delayed);
    setEvents((entries) => [...entries, {
      minutes: eva.elapsed, label: `Delay added · ${(delayed.elapsed - eva.elapsed).toFixed(1)} min elapsed`,
    }]);
  }

  function goToBase() {
    if (!eva) return;
    const returning = returnEva(eva, returnPlanner, reviewingSPE);
    setEva(returning);
    if (returning !== eva && !returning.returnError) {
      setSpe(null);
      setEvents((entries) => [...entries, { minutes: eva.elapsed, label: 'Return to base requested' }]);
    }
    if (mapScope !== 'traverse') changeMapScope('traverse');
  }

  useEffect(() => {
    if (!pickMode && missionPick === null) return;
    function cancel(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPickMode(null);
        setMissionPick(null);
        setPickError('');
      }
    }
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [pickMode, missionPick]);

  const layerModes = ([
    { type: 'optical', label: 'Optical', source: 'HiRISE / USGS', icon: Map },
    { type: 'slope', label: 'Terrain slope', source: 'Gale DEM · 10 m grid', icon: Mountain },
    { type: 'thermal', label: 'Thermal infrared', source: 'NASA Mars Trek · THEMIS', icon: Activity },
  ] as const).filter(({ type }) => type !== 'thermal' || !boxwork);
  const selectedLayer = layerModes.find(({ type }) => type === layer)!;
  const inspectedCell = inspection ? inspectTerrain(terrain, slopes, inspection) : null;
  const usingDemoEndpoints = sameCell(start, defaultStart) && isScience;
  const effectivePick = builderOpen ? missionPick !== null : Boolean(pickMode);
  const pickLabel = builderOpen ? missionPick === 'base' ? 'base camp' : `stop ${Number(missionPick) + 1}` :
    pickMode === 'start' ? 'base camp' : 'science stop';
  const mapProps = {
    terrain, slopes, start: base, target, activeLeg, activeColor, activeDashed, activeDirection: mapDirection,
    evaPoint: location?.point, evaPoints, shelterPins, missionPins, missionReturnPoints, heading,
    reserveOverlay: terrainWork.range, shadowOverlay: terrainWork.shadow,
    layer, slopeLimit: mapSlopeLimit, scope: mapScope, opacity: opacity / 100, mode: effectivePick, onPick: selectCell,
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
          <a href="#create-mission" aria-current={builderOpen || customEva ? 'location' : undefined}><Plus size={15} /> Create Mission</a>
          <a href="#surface-map" aria-current={expandedMap ? 'location' : undefined}><Map size={15} /> Map</a>
          <a href="#reserve-panel" aria-current={section === '#reserve-panel' ? 'location' : undefined}><BatteryCharging size={15} /> Survival</a>
          <a href="#field-science" aria-current={section === '#field-science' ? 'location' : undefined}><FlaskConical size={15} /> Science</a>
        </nav>
        <div className="topbar-end">
          <button className="button button--ghost" onClick={() => setShowSources(true)}><Database size={15} /> Data sources</button>
        </div>
      </header>

      <main>
        <section className="command-deck" id="mission" aria-label="Mission controls" hidden={Boolean(eva)}>
          {!eva && <div className="mission-header">
            <div className="mission-heading">
              <h1><Target size={17} /> {builderOpen && draft.name.trim() ? draft.name.trim() : regionLabels[region]}</h1>
              <p>{builderOpen ? 'Mission planning' : boxwork ? 'Curiosity Sol 4580 → Sol 4655' : usingDemoEndpoints ? 'Bradbury Landing → Yellowknife Bay' : 'Custom traverse'}</p>
            </div>
            {!builderOpen && estimate && legs && <dl className="mission-readouts" aria-label="Selected route summary">
              <div><dt>Route</dt><dd style={{ color: legs.color }}>{legs.code}</dd></div>
              <div><dt>Distance</dt><dd>{kilometers(distance)} <small>km</small></dd></div>
              <div><dt>Mission time</dt><dd>{Math.round(estimate.missionMinutes)} <small>min</small></dd></div>
              <div><dt>Return reserve</dt><dd data-low={belowReserve}>{signMinutes(estimate.margin)} <small>min</small>
                {belowReserve && <span className="reserve-warning">Below reserve</span>}
              </dd></div>
            </dl>}
            <div className="mission-actions">
              <select aria-label="Study region" value={region} disabled={loadingRegion}
                onChange={(event) => onRegion(event.target.value as Region)}>
                {Object.entries(regionLabels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <button className="button button--ghost" disabled={loadingRegion} onClick={loadDemo}><RotateCcw size={14} /> {boxwork ? 'Load Boxwork demo' : 'Load Gale demo'}</button>
              {!builderOpen && <button className="button button--primary" disabled={!legs || loadingRegion || (!terrainWork.tree && !terrainWork.treeFailed)} onClick={beginEva}><Play size={15} /> Start EVA</button>}
            </div>
          </div>}
          {loadingRegion && <p role="status" className="region-notice">Loading terrain…</p>}
          {regionFailed && <p role="alert" className="region-notice">The selected region could not be loaded. Choose it again to retry.</p>}
        </section>

        <div className={`dashboard${expandedMap ? ' dashboard--map' : survivalOpen || scienceOpen ? ' dashboard--tools' : ''}${spe ? ' dashboard--spe' : ''}${builderOpen ? ' dashboard--builder' : ''}${eva ? ' dashboard--simulation' : ''}`}>
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
                    {!boxwork && <button aria-pressed={mapScope === 'region'} onClick={() => changeMapScope('region')}>Landing region</button>}
                    <button aria-pressed={mapScope === 'traverse'} onClick={() => changeMapScope('traverse')}>Traverse</button>
                  </div>
                  {!boxwork && mapScope !== 'crater' && <button className="button rover-toggle" aria-pressed={showRover}
                    onClick={() => setShowRover(!showRover)}><Route size={13} /> Curiosity</button>}
                  {!boxwork && mapScope !== 'crater' && <button className="button layer-toggle"
                    aria-pressed={showStations} onClick={() => setShowStations(!showStations)}>
                    <Flag size={13} /> Map pins
                  </button>}
                  {mapScope === 'traverse' && <button className="button layer-toggle" aria-controls={layersOpen ? 'map-layers' : undefined}
                    aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}><Layers3 size={14} /> Layers <ChevronDown size={13} className={layersOpen ? 'turned' : ''} /></button>}
                  {eva && <button className="button" aria-pressed={helmetOpen} onClick={() => setHelmetOpen(!helmetOpen)}>
                    <Video size={15} /> Helmet Cam
                  </button>}
                  {!showMissionMap && <a className="icon-button map-expand" href={expandedMap ? '#mission' : '#surface-map'}
                    aria-label={expandedMap ? 'Close expanded map' : 'Expand map'} title={expandedMap ? 'Close expanded map' : 'Expand map'}>
                    {expandedMap ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </a>}
                </div>
              </div>
              <div className={`map-stage${mapDimension === '3D' ? ' map-stage--relief' : ''}${eva ? ' map-stage--live' : ''}`}>
                {mapDimension === '3D' ? (
                  <Suspense fallback={<div className="relief-status" role="status">Loading 3D viewer…</div>}>
                    <ReliefMap key={mapScope} {...mapProps} routes={showMissionMap ? [] : routes} selectedRoute={legs?.id}
                      stopTime={stopMinutes + delay} onSelectRoute={chooseRoute} onFallback={() => setMapDimension('2D')} />
                  </Suspense>
                ) : <TerrainMap {...mapProps} />}
                {eva && telemetry && environment && <EvaPanel session={eva} telemetry={telemetry} environment={environment} routeCode={legs?.code}
                  reviewingSPE={reviewingSPE} onSPE={startDrill}
                  onTogglePause={() => setEva((current) => current && { ...current, paused: !current.paused })}
                  onSpeed={(speed) => setEva((current) => current && { ...current, speed })}
                  onDelay={addEvaDelay}
                  onReturn={goToBase}
                  onReset={() => {
                    setEva(null);
                    setSpe(null);
                    if (customEva) {
                      window.location.hash = 'create-mission';
                      window.scrollTo({ top: 0, behavior: 'instant' });
                    }
                  }} />}
                {eva && helmetOpen && location && heading && sun && <section className="helmet-panel" aria-label="Helmet camera">
                  <div className="helmet-toolbar">
                    <span><Video size={13} /> Helmet Cam</span>
                    <button type="button" aria-pressed={helmetRelief} onClick={() => setHelmetRelief(!helmetRelief)}>Relief</button>
                    <button type="button" aria-label="Minimize helmet camera" onClick={() => setHelmetOpen(false)}><Minus size={14} /></button>
                  </div>
                  <div className="helmet-stage">
                    <Suspense fallback={<div className="relief-status" role="status">Loading helmet camera…</div>}>
                      <HelmetView terrain={terrain} point={location.point} heading={heading} sun={sun} relief={helmetRelief}
                        shadowed={environment?.light === 'In shadow'} grade={grade?.longitudinal}
                        onFallback={() => setHelmetOpen(false)} />
                    </Suspense>
                  </div>
                </section>}
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
                  <button className="button" aria-pressed={showShadow} onClick={() => setShowShadow(!showShadow)}>Sun &amp; shadow</button>
                  {eva && <button className="button" aria-pressed={showRange} onClick={() => setShowRange(!showRange)}>Return range</button>}
                </div>}
                <div className="map-corner">
                  {mapDimension === '2D' && <span className="north"><b>N</b><Compass size={19} /></span>}
                  <div className="map-controls">
                    <button aria-label="Zoom in" onClick={() => moveMap('in')}><Plus size={17} /></button>
                    <button aria-label="Zoom out" onClick={() => moveMap('out')}><Minus size={17} /></button>
                    <button aria-label="Reset map view" onClick={() => moveMap('reset')}><Target size={16} /></button>
                    {eva && <button aria-label="Locate astronaut" title="Locate astronaut" onClick={locateAstronaut}><Crosshair size={17} /></button>}
                  </div>
                </div>
                {effectivePick && <div className="pick-banner" role="status">
                  <Target size={15} /> {pickError || `Click the map to place ${pickLabel}.`}
                  <button aria-label="Cancel point selection" onClick={() => { setPickMode(null); setMissionPick(null); }}><X size={16} /></button>
                </div>}
                <div className="layer-note">
                  {mapScope === 'crater' ? (
                    <span><i className="key low" /> {boxwork ? 'Mount Sharp Boxwork' : 'Curiosity landing region'}</span>
                  ) : mapScope === 'region' ? (
                    <span><i className="key coverage-key" /> EVA study area · 1 km × 1 km</span>
                  ) : layer === 'slope' ? (
                    <><span><i className="key low" /> 0–8°</span>{mapSlopeLimit > 8 && <span><i className="key mid" /> &gt;8–{mapSlopeLimit}°</span>}
                      <span><i className="key high" /> &gt;{mapSlopeLimit}°</span><span><i className="key unknown" /> No data</span></>
                  ) : layer === 'thermal' ? (
                    <><i className="thermal-ramp" /><span>Relative IR brightness · local contrast</span></>
                  ) : null}
                  {mapScope === 'traverse' && (activeLeg || (evaPoints && evaPoints.length > 1)) && <span>
                    <i className="key route-key" data-dashed={activeDashed} style={{ color: activeColor }} /> {routeLabel}
                  </span>}
                  {mapScope === 'traverse' && missionReturnPoints && <span>
                    <i className="key route-key" data-dashed="true" style={{ color: routeColor.back }} /> Planned return
                  </span>}
                  {mapScope === 'traverse' && terrainWork.range && <span><i className="key low" /> Return range</span>}
                  {mapScope === 'traverse' && terrainWork.shadow && <>
                    <span><i className="key shadow-key" /> Shadow</span><span><i className="key no-shadow-data" /> Missing data</span>
                  </>}
                  {mapScope !== 'crater' && showRover && <span><i className="key rover-key" /> Curiosity · Sol 3–130</span>}
                  {!boxwork && mapScope !== 'crater' && showStations && <span>
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

            {!eva && !showMissionMap && !expandedMap && !scienceOpen && <section className="panel profile-panel" aria-labelledby="profile-title">
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

          {builderOpen && <aside className="workspace-col" aria-label="Mission editor">
            <MissionBuilder draft={draft} terrain={terrain} base={missionBase} preview={missionPreview} routing={missionRouting}
              loading={!terrainWork.draft && !terrainWork.draftFailed} failed={terrainWork.draftFailed}
              returnReady={!loadingRegion && Boolean(terrainWork.tree || terrainWork.treeFailed)}
              pick={missionPick} onDraft={(next) => {
                setDraft(next);
                if (next.stops.length !== draft.stops.length || next.stops.some((stop, index) => stop.cell !== draft.stops[index]?.cell)) {
                  setMissionPick(null);
                  setPickError('');
                }
              }} onRouting={(next) => setDraft((current) => ({ ...current, routing: next }))}
              onPick={pickMissionPoint} onSimulate={beginMission} />
          </aside>}

          {eva && telemetry && !spe && <aside className="workspace-col" aria-label="Simulation details">
            {(eva.outcome === 'arrived' || eva.outcome === 'depleted') && <MissionResult name={missionName ?? regionLabels[region]}
              tasks={eva.plan.stops.map(({ task }) => task)} completed={eva.completedStops}
              minutes={eva.elapsed} resources={telemetry.current.resources} returned={eva.outcome === 'arrived'} />}
            <EvaReserve session={eva} telemetry={telemetry} />
            <details className="panel mission-events" open>
              <summary>Mission log {lowestReserve !== null && <span>Lowest reserve {signMinutes(lowestReserve)} min</span>}</summary>
              <ol>{[...events, ...eva.workEvents.map(({ minutes, index, kind }) => ({
                minutes, label: kind === 'start' ? `Work started at stop ${index + 1}` : `Stop ${index + 1} completed`,
              }))].sort((a, b) => a.minutes - b.minutes).map(({ minutes, label }, i) => {
                const seconds = Math.floor(minutes * 60 + 1e-6);
                return <li key={i}><time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time>{label}</li>;
              })}</ol>
            </details>
          </aside>}

          {spe && eva && <aside className="workspace-col spe-response" aria-label="SPE response">
            <SpePanel cellM={terrain.cellM} target={spe.target} options={drillOptions} selected={spe.selected} base={drillBase}
              loading={!terrainWork.spe && !terrainWork.speFailed} failed={terrainWork.speFailed}
              urgent={continuingMargin !== undefined && continuingMargin < -RESERVE_EPSILON}
              onTarget={(value) => setSpe({ ...spe, target: value })}
              onSelect={(index) => {
                setSpe({ ...spe, selected: index });
                if (mapScope !== 'traverse') changeMapScope('traverse');
              }}
              onDivert={() => {
                if (!drillOption?.resourcesLast) return;
                const label = String(spe.selected + 1);
                const diverted = divertEva(eva, { label, path: drillOption.path });
                if (diverted === eva) return;
                setEva(diverted);
                setSpe(null);
                setEvents((entries) => [...entries, { minutes: eva.elapsed, label: `Diverted to candidate ${label}` }]);
                if (mapScope !== 'traverse') changeMapScope('traverse');
              }}
              onReturn={goToBase} onClose={closeDrill} />
          </aside>}

          {!spe && !eva && routeOpen && <aside className="workspace-col" aria-label="Mission planning">
            <section className="panel planner" aria-labelledby="planner-title">
              <div className="panel-title">
                <div className="section-heading"><Flag size={17} /><h2 id="planner-title">Mission route</h2></div>
                <ArrowLeftRight className="route-heading-icon" size={15} aria-label="Round trip" />
              </div>
              <div className="route-stops">
                <div className="stop">
                  <span className="stop-icon base"><House size={15} /></span>
                  <div><span>START / RETURN</span><strong>{sameCell(start, defaultStart) ? boxwork ? 'Boxwork Base · Sol 4580' : 'Bradbury Landing' : 'Custom base'}</strong></div>
                  {!eva && <button className="icon-button choose-point" aria-label="Change base camp" aria-pressed={pickMode === 'start'}
                    title="Change base camp on map" onClick={() => togglePick('start')}><Target size={17} /></button>}
                </div>
                <div className="stop">
                  <span className="stop-icon destination"><FlaskConical size={15} /></span>
                  <div><span>SCIENCE STOP</span><strong>{isScience ? 'Yellowknife Bay' : boxwork && sameCell(target, defaultTarget) ? 'Boxwork · Sol 4655' : 'Custom science stop'}</strong></div>
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
              {routeError && <div className="route-error" role="status"><CircleAlert size={17} />{ERROR_TEXT[routeError]}</div>}
              {!terrainWork.routes && <p className="reserve-empty" role="status">{terrainWork.routesFailed ? 'Route analysis is unavailable.' : 'Calculating routes…'}</p>}
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
              <div className="timeline">
                <button aria-pressed={mapDirection === 'out'} onClick={() => setDirection('out')}>
                  <ArrowUpRight size={15} /><span>Walk to stop</span><b>{legs ? `${Math.round(legs.out.minutes)} min` : '—'}</b>
                </button>
                <div><FlaskConical size={14} /><span>Fieldwork</span><b>{stopMinutes} min</b></div>
                {delay > 0 && <div className="timeline-delay"><Clock3 size={14} /><span>Added delay</span><b>+{delay} min</b></div>}
                <button aria-pressed={mapDirection === 'back'} onClick={() => setDirection('back')}>
                  <ArrowDownLeft size={15} /><span>Walk to base</span><b>{legs ? `${Math.round(legs.back.minutes)} min` : '—'}</b>
                </button>
              </div>
            </section>
          </aside>}

          {!spe && !eva && survivalOpen && <aside className="workspace-col" aria-label="Survival planning">
            {eva && telemetry ? <EvaReserve session={eva} telemetry={telemetry} /> :
              <ReturnReserve route={legs} estimate={estimate} stopMinutes={stopMinutes} delay={delay}
              settings={reserveSettings} onStopChange={setStopMinutes} onDelayChange={setDelay}
              onSettingsChange={setReserveSettings} />}
          </aside>}

          {!spe && !eva && scienceOpen && <aside className="workspace-col" aria-label="Science workspace">
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
  const [loadingRegion, setLoadingRegion] = useState(false);
  const [regionFailed, setRegionFailed] = useState(false);
  const [drafts, setDrafts] = useState(() => ({ gale: readMissionDraft('gale'), boxwork: readMissionDraft('boxwork') }));
  const draftSetters = useMemo(() => {
    const forRegion = (region: Region): Dispatch<SetStateAction<MissionDraft>> => (action) => {
      setDrafts((previous) => {
        const next = typeof action === 'function' ? action(previous[region]) : action;
        return next === previous[region] ? previous : { ...previous, [region]: next };
      });
    };
    return { gale: forRegion('gale'), boxwork: forRegion('boxwork') };
  }, []);
  useEffect(() => { saveMissionDraft(drafts.gale, 'gale'); }, [drafts.gale]);
  useEffect(() => { saveMissionDraft(drafts.boxwork, 'boxwork'); }, [drafts.boxwork]);
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
  async function changeRegion(region: Region) {
    setLoadingRegion(true);
    setRegionFailed(false);
    try {
      const response = await fetch(regionAsset(region, 'terrain.json'));
      if (!response.ok) throw new Error('Terrain unavailable');
      setTerrain({ ...await response.json() as Terrain, region });
    } catch {
      setRegionFailed(true);
    } finally {
      setLoadingRegion(false);
    }
  }
  const region = terrain.region ?? 'gale';
  return <MissionControl key={region} terrain={terrain} draft={drafts[region]}
    setDraft={draftSetters[region]} onRegion={changeRegion}
    loadingRegion={loadingRegion} regionFailed={regionFailed} />;
}
