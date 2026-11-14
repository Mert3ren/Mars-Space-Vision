import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { gridOverlayImage, routeColor, routeOutline, slopeImage } from './TerrainMap';
import type { MapProps } from './TerrainMap';
import { cellAt, cellCenter, displayPosition, localPoint } from './mission';
import type { LocalPoint, Terrain } from './mission';
import { helmetPose, mapPoint, sampleElevation, terrainFrame, worldPoint } from './terrainRelief';
import type { ElevationGrid, OverviewElevation, TerrainFrame } from './terrainRelief';
import { helmetFrameInterval, helmetOpticalMaterial, helmetSky, helmetStep, helmetSurfaceDetail } from './helmetSurface';
import type { HelmetSurfaceData } from './helmetSurface';
import galeOverview from './galeOverview.json';
import curiosityTrack from './curiosityTrack.json';
import { arrivalMinutes, cameraLocation, cameraStops, stations } from './galeRoutes';
import type { RouteId, RouteOption } from './galeRoutes';
import { symbolGlyph } from './mapSymbols';
import type { SymbolKind } from './mapSymbols';
import { regionAsset, regionLabels } from './regionAssets';

const asset = (path: string) => `${import.meta.env.BASE_URL}gale/${path}`;
const panorama = { crater: galeOverview.image, region: galeOverview.region.image, traverse: 'optical.webp' };
const roverColor = '#cf9dff';
const pad = (value: number, length: number) => Math.min(length - 1, Math.max(0, value - 1));

function buildMesh(grid: ElevationGrid, frame: TerrainFrame) {
  // Samples are at cell centers. Duplicate the edge values out to the image bounds.
  const columns = grid.width + 2;
  const rows = grid.height + 2;
  const vertices = [];
  const uv = [];
  const valid = [];
  const faces = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const u = Math.min(1, Math.max(0, (col - 0.5) / grid.width));
      const v = Math.min(1, Math.max(0, (row - 0.5) / grid.height));
      const height = grid.elevationM[pad(row, grid.height) * grid.width + pad(col, grid.width)];
      vertices.push(...worldPoint(frame, {
        x: frame.min.x + u * frame.widthM,
        y: frame.max.y - v * frame.heightM,
      }, height ?? frame.reference));
      uv.push(u, 1 - v);
      valid.push(height !== null);
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < columns - 1; col++) {
      const a = row * columns + col;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      if (valid[a] && valid[b] && valid[c]) faces.push(a, c, b);
      if (valid[b] && valid[c] && valid[d]) faces.push(b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(faces);
  geometry.computeVertexNormals();
  return geometry;
}

function buildHelmetTerrain(grid: ElevationGrid, frame: TerrainFrame, material: THREE.Material) {
  // Shared vertices keep normals and texture coordinates continuous across culled tiles.
  const source = buildMesh(grid, frame);
  const terrain = new THREE.Group();
  const columns = grid.width + 2;
  const tileCells = 48;
  const tileColumns = Math.ceil((columns - 1) / tileCells);
  const position = source.getAttribute('position') as THREE.BufferAttribute;
  const normals = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const faces = source.index!.array;
  const tiles = new Map<number, { indices: number[]; bounds: THREE.Box3 }>();
  const point = new THREE.Vector3();
  for (let face = 0; face < faces.length; face += 3) {
    const a = faces[face];
    const b = faces[face + 1];
    const c = faces[face + 2];
    const row = Math.min(Math.floor(a / columns), Math.floor(b / columns), Math.floor(c / columns));
    const col = Math.min(a % columns, b % columns, c % columns);
    const key = Math.floor(row / tileCells) * tileColumns + Math.floor(col / tileCells);
    let tile = tiles.get(key);
    if (!tile) {
      tile = { indices: [], bounds: new THREE.Box3() };
      tiles.set(key, tile);
    }
    tile.indices.push(a, b, c);
    tile.bounds.expandByPoint(point.fromBufferAttribute(position, a));
    tile.bounds.expandByPoint(point.fromBufferAttribute(position, b));
    tile.bounds.expandByPoint(point.fromBufferAttribute(position, c));
  }
  for (const { indices, bounds } of tiles.values()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('uv', uv);
    geometry.setAttribute('normal', normals);
    geometry.setIndex(indices);
    geometry.boundingBox = bounds;
    geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    terrain.add(new THREE.Mesh(geometry, material));
  }
  source.dispose();
  return terrain;
}

function disposeDrawings(group: THREE.Group) {
  for (const item of [...group.children]) {
    if (item instanceof THREE.Mesh || item instanceof Line2) {
      item.geometry.dispose();
      item.material.dispose();
    }
    item.removeFromParent();
  }
}

type HelmetGrid = ElevationGrid & { cellM: number };
const helmetGrids = new Map<string, Promise<HelmetGrid>>();

function loadHelmetGrid(region: NonNullable<Terrain['region']>) {
  let load = helmetGrids.get(region);
  if (!load) {
    const checked = async (name: string) => {
      const response = await fetch(regionAsset(region, name));
      if (!response.ok) throw new Error('Helmet data missing');
      return response;
    };
    load = Promise.all([
      checked('helmet-grid.json').then((response) => response.json() as Promise<{width: number; height: number; cellM: number; reference: number}>),
      checked('helmet-elevation.bin').then((response) => response.arrayBuffer()),
    ]).then(([meta, buffer]) => {
      if (meta.width * meta.height * 2 !== buffer.byteLength) throw new Error('Invalid helmet elevation grid');
      const view = new DataView(buffer);
      const elevationM = Array.from({ length: meta.width * meta.height }, (_, i) => {
        const value = view.getInt16(i * 2, true);
        return value === -32768 ? null : meta.reference + value / 100;
      });
      return { ...meta, elevationM };
    }).catch((error) => { helmetGrids.delete(region); throw error; });
    helmetGrids.set(region, load);
  }
  return load;
}

export function HelmetView({ terrain, point, heading, relief, sun, shadowed, walking, distanceM, guide, onSurfaceData, onFallback }: {
  terrain: Terrain; point: LocalPoint; heading: LocalPoint; relief: boolean;
  sun: { east: number; north: number; up: number }; shadowed: boolean;
  walking: boolean; distanceM: number; guide?: LocalPoint;
  onSurfaceData: (data: HelmetSurfaceData) => void; onFallback: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const bearingReadout = useRef<HTMLSpanElement>(null);
  const guideMarker = useRef<HTMLSpanElement>(null);
  const redraw = useRef<(() => void) | null>(null);
  const live = useRef({ point, heading, sun, relief, shadowed, walking, distanceM, guide });
  live.current = { point, heading, sun, relief, shadowed, walking, distanceM, guide };
  const [detail, setDetail] = useState<HelmetGrid>();
  const region = terrain.region ?? 'gale';
  useEffect(() => {
    let current = true;
    loadHelmetGrid(region).then((grid) => { if (current) setDetail(grid); }).catch(() => {});
    return () => { current = false; };
  }, [region]);
  const grid = detail ?? terrain;
  const frame = useMemo(() => terrainFrame(terrain, 'traverse', grid, 1), [terrain, grid]);
  const [failure, setFailure] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    redraw.current?.();
  }, [point.x, point.y, heading.x, heading.y, sun.east, sun.north, sun.up, relief, shadowed, walking, distanceM, guide?.x, guide?.y, ready]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setFailure('');
    setReady(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailure('Helmet camera requires WebGL 2.');
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.19;
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', `Simulated first-person view of ${regionLabels[region]}`);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const fog = new THREE.Fog('#ae7c61', 100 * frame.northScale, 440 * frame.northScale);
    scene.fog = fog;
    const camera = new THREE.PerspectiveCamera(64, 1, 0.15 * frame.northScale, 850 * frame.northScale);
    camera.rotation.order = 'YXZ';
    camera.rotation.x = -0.17;
    const sky = helmetSky(camera.far);
    scene.add(sky);
    const ambient = new THREE.HemisphereLight('#f3e5d9', '#947057', 0.95);
    scene.add(ambient);
    const sunlight = new THREE.DirectionalLight('#ffe9cb', 1.7);
    scene.add(sunlight);
    const reliefMaterial = new THREE.MeshLambertMaterial({ color: '#ba9376', dithering: true });
    const anisotropy = renderer.capabilities.getMaxAnisotropy();
    const surfaceDetail = helmetSurfaceDetail(anisotropy);
    const opticalMaterial = helmetOpticalMaterial(surfaceDetail, 1 / frame.northScale);
    const terrainTiles = buildHelmetTerrain(grid, frame, opticalMaterial);
    scene.add(terrainTiles);
    let disposed = false;
    let contextLost = false;
    let texture: THREE.Texture | undefined;
    let frameRequest: number | null = null;
    let lastFrameTime: number | undefined;
    let nextFrameAt = 0;
    let positioned = false;
    let terrainMaterial: THREE.Material = opticalMaterial;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const dustDay = new THREE.Color('#ae7c61');
    const dustNight = new THREE.Color('#27202b');
    const loader = new THREE.TextureLoader();
    const projectedGuide = new THREE.Vector3();

    function positionGuide(guide: LocalPoint | undefined) {
      const marker = guideMarker.current;
      if (!marker || !guide) return;
      const elevation = sampleElevation(grid, frame, guide) ?? sampleElevation(terrain, frame, guide);
      if (elevation === null) {
        marker.hidden = true;
        return;
      }
      projectedGuide.set(...worldPoint(frame, guide, elevation + 0.35)).applyMatrix4(camera.matrixWorldInverse);
      if (projectedGuide.z >= -camera.near) {
        projectedGuide.set(projectedGuide.x < 0 ? -2 : 2, 0, 0);
      } else {
        projectedGuide.applyMatrix4(camera.projectionMatrix);
      }
      const { x, y } = projectedGuide;
      // Keep the direction cue clear of the compass and resource readouts.
      const clampedX = THREE.MathUtils.clamp(x, -0.82, 0.82);
      const clampedY = THREE.MathUtils.clamp(y, -0.28, 0.48);
      const edge = x !== clampedX || y !== clampedY;
      marker.hidden = false;
      marker.dataset.edge = String(edge);
      marker.style.left = `${50 + clampedX * 50}%`;
      marker.style.top = `${50 - clampedY * 50}%`;
      marker.style.setProperty('--guide-angle', `${edge ? Math.atan2(clampedY - y, (x - clampedX) * camera.aspect) : 0}rad`);
    }

    function requestFrame() {
      if (!disposed && !contextLost && frameRequest === null) frameRequest = window.requestAnimationFrame(render);
    }

    function render(time: number) {
      frameRequest = null;
      if (disposed || contextLost) return;
      if (time < nextFrameAt - 1) {
        requestFrame();
        return;
      }
      const { point, heading, sun, relief, shadowed, walking, distanceM } = live.current;
      if (!element?.clientWidth || !element.clientHeight) return;
      const pose = helmetPose(grid, frame, point, heading) ?? helmetPose(terrain, frame, point, heading);
      if (!pose) return;

      const daylight = THREE.MathUtils.smoothstep(sun.up, -0.12, 0.21);
      fog.color.copy(dustNight).lerp(dustDay, daylight);
      sky.material.uniforms.dustColor.value.copy(fog.color);
      sky.material.uniforms.daylight.value = daylight;
      sky.material.uniforms.sunDirection.value.set(sun.east, sun.up, -sun.north).normalize();
      ambient.intensity = relief ? 0.95 : 0.11 + 0.88 * daylight;
      sunlight.position.set(sun.east, sun.up, -sun.north);
      sunlight.intensity = sun.up > 0 ? (shadowed ? 0.18 : 2.2) * Math.sqrt(daylight) : 0;
      if (relief) {
        sunlight.position.set(-1, 0.67, 0.45);
        sunlight.intensity = 2.2;
      }
      const material = relief ? reliefMaterial : opticalMaterial;
      if (terrainMaterial !== material) {
        for (const tile of terrainTiles.children) (tile as THREE.Mesh).material = material;
        terrainMaterial = material;
      }

      const step = helmetStep(distanceM, walking && !reducedMotion.matches);
      camera.position.set(pose.position[0], pose.position[1] + step.height * frame.northScale, pose.position[2]);
      camera.rotation.z = step.roll;
      let turning = false;
      if (pose.yaw !== null) {
        const delta = pose.yaw - camera.rotation.y;
        const turn = Math.atan2(Math.sin(delta), Math.cos(delta));
        turning = positioned && !reducedMotion.matches && Math.abs(turn) > 0.002;
        const blend = turning ? 1 - Math.exp(-Math.min(100, time - (lastFrameTime ?? time)) / 135) : 1;
        camera.rotation.y += turn * blend;
      }
      positioned = true;
      sky.position.copy(camera.position);
      const bearing = THREE.MathUtils.euclideanModulo(Math.round(-THREE.MathUtils.radToDeg(camera.rotation.y)), 360);
      const readout = bearingReadout.current;
      if (readout && readout.dataset.bearing !== String(bearing)) {
        readout.dataset.bearing = String(bearing);
        readout.textContent = `${String(bearing).padStart(3, '0')}°`;
        readout.parentElement?.style.setProperty('--bearing-offset', `${(bearing % 10) * 1.2}px`);
      }
      renderer.render(scene, camera);
      positionGuide(live.current.guide);
      lastFrameTime = time;
      nextFrameAt = Math.max(nextFrameAt + helmetFrameInterval, time + helmetFrameInterval - 2);
      if (turning) requestFrame();
    }

    function useTerrainImage(loaded: THREE.Texture, imageryM: number) {
      if (disposed) {
        loaded.dispose();
        return;
      }
      texture?.dispose();
      texture = loaded;
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.anisotropy = anisotropy;
      opticalMaterial.map = loaded;
      opticalMaterial.color.set('#ffffff');
      opticalMaterial.needsUpdate = true;
      onSurfaceData({ elevationM: grid.cellM, imageryM });
      setReady(true);
      requestFrame();
    }

    const loadOverview = () => {
      if (disposed) return;
      loader.load(regionAsset(region, 'optical.webp'), (loaded) => useTerrainImage(loaded, 1), undefined, () => {
        if (disposed) return;
        onSurfaceData({ elevationM: grid.cellM, imageryM: null });
        setReady(true);
        requestFrame();
      });
    };
    if (detail) {
      loader.load(regionAsset(region, 'helmet-optical.webp'), (loaded) => useTerrainImage(loaded, 0.5), undefined, loadOverview);
    } else {
      loadOverview();
    }

    redraw.current = requestFrame;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight || contextLost) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      // Keep the square inset sharp on desktop without oversampling high-DPI devices.
      renderer.setPixelRatio(Math.min(2.5, 600 / Math.max(clientWidth, clientHeight), Math.max(1.75, window.devicePixelRatio)));
      renderer.setSize(clientWidth, clientHeight, false);
      requestFrame();
    });
    observer.observe(element);
    function lost(event: Event) {
      event.preventDefault();
      contextLost = true;
      setFailure('The helmet camera graphics context was lost.');
    }
    renderer.domElement.addEventListener('webglcontextlost', lost);
    reducedMotion.addEventListener('change', requestFrame);
    return () => {
      disposed = true;
      redraw.current = null;
      if (frameRequest !== null) window.cancelAnimationFrame(frameRequest);
      observer.disconnect();
      reducedMotion.removeEventListener('change', requestFrame);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      texture?.dispose();
      surfaceDetail.dispose();
      opticalMaterial.dispose();
      reliefMaterial.dispose();
      for (const tile of terrainTiles.children) (tile as THREE.Mesh).geometry.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [terrain, frame, grid, region, detail, onSurfaceData]);
  return <>
    <div className="helmet-scene" ref={container} />
    {failure && <div className="relief-status" role="alert"><span>{failure}</span><button className="button" onClick={onFallback}>Hide camera</button></div>}
    {!failure && !ready && <div className="relief-status" role="status">Loading helmet camera…</div>}
    {!failure && ready && <div className="helmet-hud">
      <div className="helmet-compass" title="Camera bearing clockwise from north">
        <span ref={bearingReadout} className="helmet-bearing" />
        <span className="helmet-compass-ticks" aria-hidden="true" />
      </div>
      <span className="helmet-crosshair" aria-hidden="true" />
      {guide && <span ref={guideMarker} className="helmet-guide" role="img" aria-label="Next point on the EVA route" hidden />}
    </div>}
  </>;
}

type Props = MapProps & {
  routes: RouteOption[];
  selectedRoute?: RouteId;
  stopTime: number;
  onSelectRoute: (route: RouteId) => void;
  onFallback: () => void;
};

type SceneHandle = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  drawings: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resize: () => void;
  reset: () => void;
};

let overviewRequest: Promise<OverviewElevation> | undefined;

function fetchOverview() {
  overviewRequest ??= fetch(asset('elevation-overview.json')).then((response) => {
    if (!response.ok) throw new Error('Elevation data unavailable');
    return response.json() as Promise<OverviewElevation>;
  }).catch((error) => {
    overviewRequest = undefined;
    throw error;
  });
  return overviewRequest;
}

export default function ReliefMap(props: Props) {
  const { terrain, scope, expanded, layer, opacity, slopes, slopeLimit, start, target, activeLeg, activeDirection, showRover,
    activeColor, activeDashed, evaPoint, evaPoints, shelterPins, missionPins, missionReturnPoints, reserveOverlay, shadowOverlay, heading, showStations,
    inspection, command, mode, onFallback, routes, selectedRoute, stopTime, onSelectRoute } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelElements = useRef(new Map<RouteId, HTMLButtonElement>());
  const symbolElements = useRef(new Map<string, HTMLDivElement>());
  const astronautElement = useRef<HTMLDivElement>(null);
  const astronautAnchor = useRef<THREE.Vector3 | null>(null);
  const [overview, setOverview] = useState<OverviewElevation>();
  const [failure, setFailure] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (scope === 'traverse' || overview) return;
    let cancelled = false;
    fetchOverview().then((data) => { if (!cancelled) setOverview(data); })
      .catch(() => { if (!cancelled) setFailure('Crater elevation could not be loaded.'); });
    return () => { cancelled = true; };
  }, [scope, overview]);

  const grid = scope === 'traverse' ? terrain : overview?.[scope];
  const frame = useMemo(() => grid ? terrainFrame(terrain, scope, grid) : null, [terrain, scope, grid]);
  const labels = useMemo(() => {
    if (scope !== 'traverse' || !grid || !frame) return [];
    return routes.flatMap((route) => {
      const point = route.waypoint ?? cellCenter(terrain, route.out.path[Math.floor(route.out.path.length / 2)]);
      const elevation = sampleElevation(grid, frame, point);
      if (elevation === null) return [];
      const position = new THREE.Vector3(...worldPoint(frame, point, elevation));
      position.y += 1.35;
      return [{ id: route.id, position }];
    });
  }, [scope, grid, frame, routes, terrain]);
  const labelAnchors = useRef(labels);
  labelAnchors.current = labels;
  const symbolLabels = useMemo(() => {
    if (scope === 'crater' || !grid || !frame) return [];
    const entries: { id: string; kind: SymbolKind; point: LocalPoint; name: string; number?: string; state?: string; link?: string }[] = [
      { id: 'base', kind: 'base', point: cellCenter(terrain, start), name: 'Base camp' },
    ];
    if (!missionPins) entries.push({ id: 'science', kind: 'science', point: cellCenter(terrain, target), name: 'Science stop' });
    missionPins?.forEach(({ id, point, label, status }) => entries.push({
      id: `stop-${id}`, kind: 'stop', point,
      name: `Stop ${id}${label === `Stop ${id}` ? '' : ` · ${label}`}${status === 'pending' ? '' : ` · ${status === 'complete' ? 'Completed' : 'Active'}`}`,
      number: id, state: status,
    }));
    shelterPins.forEach(({ id, point, selected }) => entries.push({
      id: `shelter-${id}`, kind: 'shelter', point, name: `Terrain cover candidate ${id}`, number: id, state: selected ? 'active' : 'pending',
    }));
    if (showStations && !mode) {
      if (terrain.region !== 'boxwork') stations.forEach(({ id, point, name }) => entries.push({ id, kind: 'station', point, name }));
      cameraStops.forEach((stop, index) => entries.push({
        id: `camera-${index}`, kind: 'camera', point: cameraLocation(terrain, stop), name: stop.name, link: stop.source,
      }));
    }
    return entries.flatMap((entry) => {
      const elevation = sampleElevation(grid, frame, entry.point);
      return elevation === null ? [] : [{ ...entry, position: new THREE.Vector3(...worldPoint(frame, entry.point, elevation)) }];
    });
  }, [shelterPins, missionPins, scope, grid, frame, terrain, start, target, showStations, mode]);
  const symbolAnchors = useRef(symbolLabels);
  symbolAnchors.current = symbolLabels;

  useEffect(() => {
    const element = container.current;
    if (!element || !grid || !frame) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailure('3D terrain requires WebGL 2 on this device.');
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D terrain. Drag to orbit and scroll to zoom.');
    renderer.domElement.setAttribute('tabindex', '0');
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.12;
    controls.minDistance = 24;
    controls.enablePan = false;
    controls.minTargetRadius = 0;
    scene.add(new THREE.HemisphereLight('#e8f0ff', '#9d7e70', 1.45));
    const sunlight = new THREE.DirectionalLight('#fff2da', 1.75);
    sunlight.position.set(-45, 72, -37);
    scene.add(sunlight);

    const mesh = new THREE.Mesh(buildMesh(grid, frame), new THREE.MeshLambertMaterial({ color: '#ad8876' }));
    scene.add(mesh);
    const drawings = new THREE.Group();
    scene.add(drawings);
    const render = () => renderer.render(scene, camera);
    mesh.geometry.computeBoundingBox();
    const terrainBounds = mesh.geometry.boundingBox!;
    const focus = terrainBounds.getCenter(new THREE.Vector3());
    const viewAxis = new THREE.Vector3(0.48, 0.70, 0.66).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(viewAxis).normalize();
    const up = new THREE.Vector3().crossVectors(viewAxis, right);
    const positions = mesh.geometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    const defaultPosition = new THREE.Vector3();
    const reset = () => {
      const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const vertical = halfFov * 0.94;
      const horizontal = halfFov * camera.aspect * 0.90;
      let distance = 0;
      // Fit the surface itself, including the high points that constrain this view.
      for (let i = 0; i < positions.count; i++) {
        vertex.fromBufferAttribute(positions, i).sub(focus);
        const depth = vertex.dot(viewAxis);
        distance = Math.max(distance, depth + Math.abs(vertex.dot(right)) / horizontal,
          depth + Math.abs(vertex.dot(up)) / vertical);
      }
      controls.maxDistance = distance * 2;
      camera.far = Math.max(900, distance * 3);
      camera.updateProjectionMatrix();
      controls.target.copy(focus);
      defaultPosition.copy(focus).addScaledVector(viewAxis, distance);
      camera.position.copy(defaultPosition);
      controls.update();
    };
    const resize = () => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      const aspect = width / height;
      const refit = aspect !== camera.aspect && camera.position.distanceToSquared(defaultPosition) < 1e-6 &&
        controls.target.distanceToSquared(focus) < 1e-6;
      camera.aspect = aspect;
      if (refit) reset();
      else camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    resize();
    reset();

    const ray = new THREE.Raycaster();
    const cursor = new THREE.Vector2();
    let pointerStart: { x: number; y: number } | null = null;
    function handleDown(event: PointerEvent) {
      pointerStart = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    }
    function handleUp(event: PointerEvent) {
      if (!event.isPrimary || !pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      pointerStart = null;
      const bounds = renderer.domElement.getBoundingClientRect();
      cursor.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
      ray.setFromCamera(cursor, camera);
      const hit = ray.intersectObject(mesh)[0];
      if (!hit || !frame) return;
      const point = mapPoint(frame, hit.point.x, hit.point.z);
      const current = callbacks.current;
      current.onCoordinate(displayPosition(terrain, point));
      if (current.mode && scope === 'traverse') current.onPick(cellAt(terrain, point));
      else current.onInspect(point);
    }
    function handleContextLost(event: Event) {
      event.preventDefault();
      setFailure('The 3D graphics context was lost.');
    }
    renderer.domElement.addEventListener('pointerdown', handleDown);
    renderer.domElement.addEventListener('pointerup', handleUp);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    handle.current = { mesh, drawings, camera, controls, resize, reset };
    setReady(true);
    const projected = new THREE.Vector3();
    function placeLabel(label: HTMLElement, position: THREE.Vector3) {
      projected.copy(position).project(camera);
      const x = (projected.x + 1) * element!.clientWidth / 2;
      const y = (1 - projected.y) * element!.clientHeight / 2;
      label.style.visibility = projected.z < 1 && projected.z > -1 &&
        x >= 0 && x <= element!.clientWidth && y >= 0 && y <= element!.clientHeight ? 'visible' : 'hidden';
      label.style.left = `${x}px`;
      label.style.top = `${y}px`;
    }
    renderer.setAnimationLoop(() => {
      controls.update();
      render();
      for (const { id, position } of labelAnchors.current) {
        const label = labelElements.current.get(id);
        if (label) placeLabel(label, position);
      }
      for (const { id, position } of symbolAnchors.current) {
        const label = symbolElements.current.get(id);
        if (label) placeLabel(label, position);
      }
      const astronaut = astronautElement.current;
      if (astronaut && astronautAnchor.current) {
        placeLabel(astronaut, astronautAnchor.current);
        const direction = callbacks.current.heading;
        if (direction && (direction.x || direction.y)) {
          const from = astronautAnchor.current.clone().project(camera);
          const to = astronautAnchor.current.clone().add(new THREE.Vector3(direction.x * frame.eastScale, 0,
            -direction.y * frame.northScale)).project(camera);
          astronaut.style.setProperty('--heading', `${Math.atan2((to.x - from.x) * camera.aspect, to.y - from.y)}rad`);
        }
      }
      else if (astronaut) astronaut.style.visibility = 'hidden';
    });

    return () => {
      handle.current = null;
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handleDown);
      renderer.domElement.removeEventListener('pointerup', handleUp);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      controls.dispose();
      disposeDrawings(drawings);
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [frame, grid, scope, terrain]);

  useEffect(() => {
    const scene = handle.current;
    if (!scene) return;
    scene.resize();
    scene.reset();
  }, [expanded]);

  useEffect(() => {
    const scene = handle.current;
    if (!scene || !frame) return;
    let disposed = false;
    let texture: THREE.CanvasTexture | undefined;
    const loader = new THREE.ImageLoader();
    const base = loader.loadAsync(scope === 'traverse' ? regionAsset(terrain.region ?? 'gale', 'optical.webp') : asset(panorama[scope]));
    const overlay = scope === 'traverse' && layer !== 'optical'
      ? loader.loadAsync(layer === 'thermal' ? asset('thermal.webp') : slopeImage(terrain, slopes, slopeLimit))
      : Promise.resolve(null);
    void Promise.all([base, overlay]).then(([image, extra]) => {
      if (disposed) return;
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Terrain texture could not be rendered');
      context.drawImage(image, 0, 0);
      if (extra) {
        context.globalAlpha = opacity;
        context.drawImage(extra, 0, 0, canvas.width, canvas.height);
      }
      context.globalAlpha = 1;
      if (scope === 'traverse' && shadowOverlay) context.drawImage(gridOverlayImage(shadowOverlay, 'shadow'), 0, 0, canvas.width, canvas.height);
      if (scope === 'traverse' && reserveOverlay) context.drawImage(gridOverlayImage(reserveOverlay, 'reserve'), 0, 0, canvas.width, canvas.height);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      scene.mesh.material.map = texture;
      scene.mesh.material.color.set('#ffffff');
      scene.mesh.material.needsUpdate = true;
    }).catch(() => { if (!disposed) setFailure('The 3D map texture could not be loaded.'); });
    return () => {
      disposed = true;
      if (texture) {
        if (scene.mesh.material.map === texture) scene.mesh.material.map = null;
        texture.dispose();
      }
    };
  }, [frame, scope, layer, terrain, slopes, slopeLimit, opacity, reserveOverlay, shadowOverlay]);

  useEffect(() => {
    const scene = handle.current;
    if (!scene || !frame || !grid) return;
    disposeDrawings(scene.drawings);
    function drape(point: LocalPoint, offset: number) {
      const height = sampleElevation(grid!, frame!, point);
      if (height === null) return null;
      const position = worldPoint(frame!, point, height);
      position[1] += offset;
      return position;
    }
    function pin(point: LocalPoint, color: string, radius: number) {
      const position = drape(point, radius);
      if (!position) return;
      const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10),
        new THREE.MeshBasicMaterial({ color }));
      marker.position.set(...position);
      scene!.drawings.add(marker);
    }
    function trace(points: LocalPoint[], color: string, dashed = false, width = 3.5, offset = 0.42, renderOrder = 0) {
      const positions: number[] = [];
      const addPoint = (point: LocalPoint) => {
        const position = drape(point, offset);
        if (position) positions.push(...position);
      };
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        for (const step of [0, 0.25, 0.5, 0.75]) {
          addPoint({ x: a.x + (b.x - a.x) * step, y: a.y + (b.y - a.y) * step });
        }
      }
      if (points.length) addPoint(points[points.length - 1]);
      if (positions.length < 6) return;
      const line = new Line2(new LineGeometry().setPositions(positions), new LineMaterial({
        color, linewidth: width, dashed, dashSize: 0.72, gapSize: 0.48, depthWrite: false,
      }));
      line.computeLineDistances();
      line.renderOrder = renderOrder;
      scene!.drawings.add(line);
    }
    if (showRover && scope !== 'crater') {
      for (const segment of curiosityTrack) {
        trace(segment.map(([longitude, latitude]) => localPoint(terrain, { longitude, latitude })), roverColor, true);
      }
    }
    if (scope === 'traverse') {
      if (!evaPoints) {
        for (const route of routes) {
          if (route.id === selectedRoute) continue;
          trace(route[activeDirection].path.map((cell) => cellCenter(terrain, cell)), route.color, true, 2.8);
        }
      }
      if (missionReturnPoints) {
        trace(missionReturnPoints, routeOutline, false, 6, 0.5);
        trace(missionReturnPoints, routeColor.back, true, 3, 0.5, 1);
      }
      const points = evaPoints ?? activeLeg?.path.map((cell) => cellCenter(terrain, cell));
      if (points) {
        trace(points, routeOutline, false, 8, 0.65, 1);
        trace(points, activeColor ?? routeColor[activeDirection], activeDashed, 4.6, 0.65, 2);
      }
    } else if (scope === 'crater') {
      pin(localPoint(terrain, terrain.positions.base), routeColor.out, 0.8);
      pin(localPoint(terrain, galeOverview.mountSharp), '#e0e8ff', 0.8);
    }
    if (inspection) pin(inspection, '#ffffff', 0.55);
  }, [frame, grid, terrain, activeLeg, activeDirection, activeColor, activeDashed, showRover, inspection, scope, routes, selectedRoute, evaPoints, missionReturnPoints]);

  useEffect(() => {
    astronautAnchor.current = null;
    if (!evaPoint || !frame || !grid || scope !== 'traverse') return;
    const elevation = sampleElevation(grid, frame, evaPoint);
    if (elevation === null) return;
    astronautAnchor.current = new THREE.Vector3(...worldPoint(frame, evaPoint, elevation));
  }, [frame, grid, scope, evaPoint]);

  useEffect(() => {
    const scene = handle.current;
    if (!scene || !command.id) return;
    if (command.type === 'reset') {
      scene.reset();
    } else if (command.type === 'locate') {
      if (!frame || !grid || scope !== 'traverse') return;
      const elevation = sampleElevation(grid, frame, command.point);
      if (elevation === null) return;
      const next = new THREE.Vector3(...worldPoint(frame, command.point, elevation));
      scene.camera.position.add(next.clone().sub(scene.controls.target));
      scene.controls.target.copy(next);
      scene.controls.update();
    } else {
      const offset = scene.camera.position.clone().sub(scene.controls.target);
      const distance = offset.length() * (command.type === 'in' ? 0.78 : 1.28);
      offset.setLength(THREE.MathUtils.clamp(distance, scene.controls.minDistance, scene.controls.maxDistance));
      scene.camera.position.copy(scene.controls.target).add(offset);
      scene.controls.update();
    }
  }, [command, frame, grid, scope]);

  return <>
    <div ref={container} className={`terrain-relief${mode ? ' terrain-map--pick' : ''}`} />
    {ready && !failure && !mode && !evaPoint && scope === 'traverse' && <div className="relief-route-labels">
      {routes.map((route) => {
        const minutes = arrivalMinutes(route, activeDirection, stopTime);
        const destination = activeDirection === 'out' ? 'Stop' : 'Base';
        return <button key={route.id} className="relief-route-label" ref={(element) => {
          if (element) labelElements.current.set(route.id, element);
          else labelElements.current.delete(route.id);
        }} aria-pressed={route.id === selectedRoute} onClick={() => onSelectRoute(route.id)}
          aria-label={`${route.name}. Estimated arrival at ${destination.toLowerCase()} +${Math.round(minutes)} minutes after departure.`}>
          <b style={{ color: route.color }}>{route.code}</b><span>{destination} ETA <strong>+{Math.round(minutes)} min</strong></span>
        </button>;
      })}
    </div>}
    {ready && !failure && evaPoint && scope === 'traverse' &&
      <div className="relief-map-symbol relief-map-astronaut" ref={astronautElement} role="img" aria-label="Astronaut">
        <span className="map-symbol map-symbol--astronaut" dangerouslySetInnerHTML={{ __html: symbolGlyph('astronaut') }} />
      </div>}
    {ready && !failure && symbolLabels.map(({ id, kind, name, number, state, link }) =>
      <div key={id} className="relief-map-symbol" role={link ? undefined : 'img'} aria-label={link ? undefined : name} title={name}
        ref={(element) => {
          if (element) symbolElements.current.set(id, element);
          else symbolElements.current.delete(id);
        }}>
        {link ? <a href={link} aria-label={name} target="_blank" rel="noreferrer" className="map-symbol map-symbol--camera"
          dangerouslySetInnerHTML={{ __html: symbolGlyph(kind) }} /> :
          <span className={`map-symbol map-symbol--${kind}`} data-state={state}>
            {kind === 'stop' && state !== 'complete' ? number : <>
              <i dangerouslySetInnerHTML={{ __html: symbolGlyph(kind) }} />
              {number && <b>{number}</b>}
            </>}
          </span>}
        {kind === 'stop' && state === 'active' && <span className="relief-stop-label">{name}</span>}
      </div>)}
    {failure ? <div className="relief-status" role="alert">
      <span>{failure}</span><button className="button" onClick={onFallback}>Back to 2D</button>
    </div> : !ready && <div className="relief-status" role="status">Loading 3D elevation…</div>}
  </>;
}
