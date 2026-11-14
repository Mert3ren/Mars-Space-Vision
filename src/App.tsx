import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BatteryCharging,
  Camera, Check, ChevronDown, CircleAlert, Clock3, Compass, Database, Flag,
  FlaskConical, House, Layers3, Map, Minus, Mountain, Plus, RotateCcw, Route, Target, X,
} from 'lucide-react';
import { routeColor, TerrainMap } from './TerrainMap';
import type { LayerMode, MapScope } from './TerrainMap';
import { verticalExaggeration } from './terrainRelief';
import { ReturnReserve } from './ReturnReserve';
import galeOverview from './galeOverview.json';
import {
  cellAt, cellCenter, DEFAULT_RESERVE_SETTINGS, displayPosition, estimateReserve, inspectTerrain, localPoint,
  MAX_SLOPE, slopeGrid, STOP_MINUTES, walkMinutes,
} from './mission';
import type { Cell, Leg, LocalPoint, Terrain } from './mission';
import { arrivalMinutes, cameraStops, missionRoutes } from './galeRoutes';
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
  invalid_cell: `This point has missing terrain data or exceeds the ${MAX_SLOPE}° model threshold.`,
  same_cell: 'Choose a science stop in a different terrain cell.',
  no_path: 'No route connects these points under the current terrain model.',
};

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
  const [mapScope, setMapScope] = useState<MapScope>('crater');
  const [mapDimension, setMapDimension] = useState<'2D' | '3D'>('2D');
  const [section, setSection] = useState(() => window.location.hash);
  const [opacity, setOpacity] = useState(72);
  const [layersOpen, setLayersOpen] = useState(true);
  const [pickMode, setPickMode] = useState<'start' | 'target' | null>(null);
  const [inspection, setInspection] = useState<LocalPoint | null>(null);
  const [showRover, setShowRover] = useState(false);
  const [showStations, setShowStations] = useState(true);
  const [selectedRoute, setSelectedRoute] = useState<RouteId>('direct');
  const [coordinate, setCoordinate] = useState('');
  const [stopMinutes, setStopMinutes] = useState(STOP_MINUTES);
  const [delay, setDelay] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const [reserveSettings, setReserveSettings] = useState(DEFAULT_RESERVE_SETTINGS);
  const [steps, setSteps] = useState([false, false, false]);
  const [command, setCommand] = useState<{ id: number; type: 'in' | 'out' | 'reset' }>({ id: 0, type: 'reset' });
  const { options: routes, error: routeError } = useMemo(() => missionRoutes(terrain, slopes, start, target),
    [terrain, slopes, start, target]);
  const legs = routes.find((route) => route.id === selectedRoute) ?? routes[0];
  const activeLeg = legs?.[direction];
  const activeColor = legs?.id === 'direct' && mapDimension === '2D' ? routeColor[direction] : legs?.color;
  const distance = legs ? legs.out.distanceM + legs.back.distanceM : 0;
  const estimate = legs ? estimateReserve(distance, stopMinutes, delay, reserveSettings) : null;
  const isScience = sameCell(target, defaultTarget);
  const expandedMap = section === '#surface-map';

  useEffect(() => {
    const syncSection = () => setSection(window.location.hash);
    window.addEventListener('hashchange', syncSection);
    return () => window.removeEventListener('hashchange', syncSection);
  }, []);

  useEffect(() => {
    if (section === '#surface-map') window.scrollTo({ top: 0, behavior: 'instant' });
    if (section === '#mission' || section === '#reserve-panel' || section === '#field-science') {
      document.getElementById(section.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }, [section]);

  function moveMap(type: 'in' | 'out' | 'reset') {
    setCommand(({ id }) => ({ id: id + 1, type }));
  }

  function loadDemo() {
    setStart(defaultStart);
    setTarget(defaultTarget);
    setStopMinutes(STOP_MINUTES);
    setDelay(0);
    setReserveSettings(DEFAULT_RESERVE_SETTINGS);
    setDirection('out');
    setLayer('optical');
    setMapScope('traverse');
    setOpacity(72);
    setLayersOpen(true);
    setPickMode(null);
    setInspection(null);
    setShowRover(false);
    setShowStations(true);
    setSelectedRoute('direct');
    setSteps([false, false, false]);
    moveMap('reset');
  }

  function selectCell(cell: Cell) {
    if (pickMode === 'start') setStart(cell);
    if (pickMode === 'target') {
      setTarget(cell);
      setSteps([false, false, false]);
    }
    setSelectedRoute('direct');
    setPickMode(null);
  }

  function togglePick(mode: 'start' | 'target') {
    const next = pickMode === mode ? null : mode;
    setPickMode(next);
    if (next) setInspection(null);
    if (next && window.matchMedia('(max-width: 1120px)').matches) {
      document.getElementById('surface-map')?.scrollIntoView({ block: 'start' });
    }
    if (next) setMapScope('traverse');
  }

  function changeMapScope(scope: MapScope) {
    setMapScope(scope);
    setPickMode(null);
    setInspection(null);
  }

  useEffect(() => {
    if (!pickMode) return;
    function cancel(event: KeyboardEvent) {
      if (event.key === 'Escape') setPickMode(null);
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
    terrain, slopes, start, target, activeLeg, activeColor, activeDirection: direction,
    layer, scope: mapScope, opacity: opacity / 100, mode: pickMode, onPick: selectCell,
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
          <a href="#mission" aria-current={!section || section === '#mission' ? 'location' : undefined}><Compass size={15} /> Mission</a>
          <a href="#surface-map" aria-current={expandedMap ? 'location' : undefined}><Map size={15} /> Map</a>
          <a href="#reserve-panel" aria-current={section === '#reserve-panel' ? 'location' : undefined}><BatteryCharging size={15} /> Survival</a>
          <a href="#field-science" aria-current={section === '#field-science' ? 'location' : undefined}><FlaskConical size={15} /> Science</a>
        </nav>
        <div className="topbar-end">
          <button className="button button--ghost" onClick={() => setShowSources(true)}><Database size={15} /> Data sources</button>
        </div>
      </header>

      <main>
        <div className="mission-header" id="mission">
          <div className="mission-heading">
            <h1>Gale Crater<span> / </span>{expandedMap ? 'Map' : 'Surface Traverse'}</h1>
            <p><Compass size={13} /> {usingDemoEndpoints ? 'Mars · Bradbury Landing to Yellowknife Bay' : 'Mars · Custom route in the Gale study area'}</p>
          </div>
          <div className="mission-actions">
            <span className="mode-chip"><span /> EVA SIMULATION</span>
            <button className="button button--primary" onClick={loadDemo}><RotateCcw size={14} /> Load Gale demo</button>
          </div>
        </div>

        <div className={`dashboard${expandedMap ? ' dashboard--map' : ''}`}>
          <div className="primary-col">
            <section className="panel map-panel" id="surface-map" aria-labelledby="map-title">
              <div className="panel-title map-title">
                <div className="section-heading"><Map size={18} /><h2 id="map-title">Gale surface map</h2></div>
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
                  {expandedMap && mapScope === 'traverse' && <div className="leg-switch" role="group" aria-label="Map route leg">
                    <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}><ArrowUpRight size={13} /> Outbound</button>
                    <button aria-pressed={direction === 'back'} onClick={() => setDirection('back')}><ArrowDownLeft size={13} /> Return</button>
                  </div>}
                  {mapScope !== 'crater' && <button className="button rover-toggle" aria-pressed={showRover}
                    onClick={() => setShowRover(!showRover)}><Route size={13} /> Curiosity</button>}
                  {mapDimension === '2D' && mapScope !== 'crater' && <button className="button layer-toggle"
                    aria-pressed={showStations} onClick={() => setShowStations(!showStations)}>
                    <Flag size={13} /> Map pins
                  </button>}
                  {mapScope === 'traverse' && <button className="button layer-toggle" aria-controls={layersOpen ? 'map-layers' : undefined}
                    aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}><Layers3 size={14} /> Layers <ChevronDown size={13} className={layersOpen ? 'turned' : ''} /></button>}
                </div>
              </div>
              <div className={`map-stage${mapDimension === '3D' ? ' map-stage--relief' : ''}`}>
                {mapDimension === '3D' ? (
                  <Suspense fallback={<div className="relief-status" role="status">Loading 3D viewer…</div>}>
                    <ReliefMap key={mapScope} {...mapProps} routes={routes} selectedRoute={legs?.id}
                      stopTime={stopMinutes + delay} onSelectRoute={setSelectedRoute} onFallback={() => setMapDimension('2D')} />
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
                  <Target size={15} /> Click the map to place the {pickMode === 'start' ? 'base camp' : 'science stop'}.
                  <button aria-label="Cancel point selection" onClick={() => setPickMode(null)}><X size={16} /></button>
                </div>}
                <div className="layer-note">
                  {mapScope === 'crater' ? (
                    <span><i className="key low" /> Curiosity landing region</span>
                  ) : mapScope === 'region' ? (
                    <span><i className="key coverage-key" /> EVA study area · 1 km × 1 km</span>
                  ) : layer === 'slope' ? (
                    <><span><i className="key low" /> 0–8°</span><span><i className="key mid" /> &gt;8–18°</span>
                      <span><i className="key high" /> &gt;18°</span><span><i className="key unknown" /> No data</span></>
                  ) : layer === 'thermal' ? (
                    <><i className="thermal-ramp" /><span>Relative IR brightness · local contrast</span></>
                  ) : (
                    <><i className={`key route-key ${direction}`} style={{ color: activeColor }} /><span>{direction === 'out' ? 'Outbound route' : 'Return route'}</span></>
                  )}
                  {mapScope !== 'crater' && showRover && <span><i className="key rover-key" /> Curiosity · Sol 3–130</span>}
                  {mapDimension === '2D' && mapScope !== 'crater' && showStations && <span>
                    <Flag size={12} /> Simulated stations <Camera size={12} /> Archived photos
                  </span>}
                </div>
                {mapDimension === '3D' && <span className="relief-caption">Drag to orbit · Height ×{verticalExaggeration[mapScope]}</span>}
              </div>
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

            <section className="panel profile-panel" aria-labelledby="profile-title">
              <div className="panel-title">
                <div className="section-heading"><Activity size={18} /><h2 id="profile-title">Elevation profile</h2></div>
                <div className="leg-switch" aria-label="Route leg">
                  <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}><ArrowUpRight size={14} /> Outbound</button>
                  <button aria-pressed={direction === 'back'} onClick={() => setDirection('back')}><ArrowDownLeft size={14} /> Return</button>
                </div>
              </div>
              <ElevationChart leg={activeLeg} color={activeColor} />
              {activeLeg && <div className="profile-metrics">
                <div><span>Leg distance</span><b>{kilometers(activeLeg.distanceM)} km</b></div>
                <div><span>Ascent</span><b>+{meters(activeLeg.climbM)} m</b></div>
                <div><span>Descent</span><b>−{meters(activeLeg.descentM)} m</b></div>
                <div><span>Steepest step</span><b>{activeLeg.maxSlope.toFixed(1)}°</b></div>
              </div>}
            </section>
          </div>

          <aside className="left-col" aria-label="Mission planning">
            <section className="panel planner" aria-labelledby="planner-title">
              <div className="panel-title">
                <div className="section-heading"><Flag size={17} /><h2 id="planner-title">Mission route</h2></div>
                <ArrowLeftRight className="route-heading-icon" size={15} aria-label="Round trip" />
              </div>
              <div className="route-stops">
                <div className="stop">
                  <span className="stop-icon base"><House size={15} /></span>
                  <div><span>START / RETURN</span><strong>{sameCell(start, defaultStart) ? 'Bradbury Landing' : 'Custom base'}</strong></div>
                  <button className="icon-button choose-point" aria-label="Change base camp" aria-pressed={pickMode === 'start'}
                    title="Change base camp on map" onClick={() => togglePick('start')}><Target size={17} /></button>
                </div>
                <div className="stop">
                  <span className="stop-icon destination"><FlaskConical size={15} /></span>
                  <div><span>SCIENCE STOP</span><strong>{isScience ? 'Yellowknife Bay' : 'Custom science stop'}</strong></div>
                  <button className="icon-button choose-point" aria-label="Change science stop" aria-pressed={pickMode === 'target'}
                    title="Change science stop on map" onClick={() => togglePick('target')}><Target size={17} /></button>
                </div>
              </div>
              {routeError ? <div className="route-error" role="status"><CircleAlert size={17} />{ERROR_TEXT[routeError]}</div> : (
                <div className="route-totals">
                  <div><span>Total distance</span><b>{kilometers(distance)} <small>km</small></b></div>
                  <div><span>Mission time</span><b>{Math.round(estimate!.missionMinutes)} <small>min</small></b></div>
                </div>
              )}
              {routes.length > 0 && <div className="route-choices" role="group" aria-label="EVA route options">
                {routes.map((route) => <button key={route.id} aria-pressed={route.id === legs?.id}
                  onClick={() => setSelectedRoute(route.id)}>
                  <span className="route-code" style={{ color: route.color }}>{route.code}</span>
                  <span><strong>{route.name}</strong><small>Stop +{Math.round(arrivalMinutes(route, 'out'))} min</small></span>
                  <small>{kilometers(route.out.distanceM + route.back.distanceM)} km</small>
                </button>)}
              </div>}
            </section>

            <section className="panel timeline-panel" aria-labelledby="timeline-title">
              <div className="panel-title"><div className="section-heading"><Route size={17} /><h2 id="timeline-title">Traverse sequence</h2></div></div>
              <div className="timeline">
                <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}>
                  <ArrowUpRight size={15} /><span>Walk to stop</span><b>{legs ? `${Math.round(walkMinutes(legs.out.distanceM))} min` : '—'}</b>
                </button>
                <div><FlaskConical size={14} /><span>Fieldwork</span><b>{stopMinutes} min</b></div>
                {delay > 0 && <div className="timeline-delay"><Clock3 size={14} /><span>Added delay</span><b>+{delay} min</b></div>}
                <button aria-pressed={direction === 'back'} onClick={() => setDirection('back')}>
                  <ArrowDownLeft size={15} /><span>Walk to base</span><b>{legs ? `${Math.round(walkMinutes(legs.back.distanceM))} min` : '—'}</b>
                </button>
              </div>
            </section>
          </aside>

          <aside className="side-col" aria-label="Reserve and field science">
            <ReturnReserve route={legs} estimate={estimate} stopMinutes={stopMinutes} delay={delay}
              settings={reserveSettings} onStopChange={setStopMinutes} onDelayChange={setDelay}
              onSettingsChange={setReserveSettings} />

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
          </aside>
        </div>

        <footer className="footer">
          <span>Mars Space Vision · NASA Space Apps Challenge 2026</span>
          <span>Archived observations · Simulated resources</span>
        </footer>
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
