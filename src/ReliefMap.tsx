import { useEffect, useMemo, useRef, useState } from 'react';
import { PersonStanding } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { routeColor, routeOutline, slopeImage } from './TerrainMap';
import type { MapProps } from './TerrainMap';
import { cellAt, cellCenter, displayPosition, localPoint } from './mission';
import type { LocalPoint } from './mission';
import { mapPoint, sampleElevation, terrainFrame, worldPoint } from './terrainRelief';
import type { ElevationGrid, OverviewElevation, TerrainFrame } from './terrainRelief';
import galeOverview from './galeOverview.json';
import curiosityTrack from './curiosityTrack.json';
import { arrivalMinutes } from './galeRoutes';
import type { RouteId, RouteOption } from './galeRoutes';

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

function disposeDrawings(group: THREE.Group) {
  for (const item of [...group.children]) {
    if (item instanceof THREE.Mesh || item instanceof Line2) {
      item.geometry.dispose();
      item.material.dispose();
    }
    item.removeFromParent();
  }
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
    activeColor, activeDashed, evaPoint, evaPoints, shelterPins, inspection, command, mode, onFallback, routes, selectedRoute, stopTime, onSelectRoute } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelElements = useRef(new Map<RouteId, HTMLButtonElement>());
  const shelterElements = useRef(new Map<string, HTMLDivElement>());
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
  const shelterLabels = useMemo(() => {
    if (scope !== 'traverse' || !grid || !frame) return [];
    return shelterPins.flatMap(({ id, point }) => {
      const elevation = sampleElevation(grid, frame, point);
      return elevation === null ? [] : [{ id, position: new THREE.Vector3(...worldPoint(frame, point, elevation)) }];
    });
  }, [shelterPins, scope, grid, frame]);
  const shelterAnchors = useRef(shelterLabels);
  shelterAnchors.current = shelterLabels;

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
    const reset = () => {
      const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.83;
      const horizontal = vertical * camera.aspect;
      let distance = 0;
      for (const x of [terrainBounds.min.x, terrainBounds.max.x]) {
        for (const y of [terrainBounds.min.y, terrainBounds.max.y]) {
          for (const z of [terrainBounds.min.z, terrainBounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z).sub(focus);
            const depth = corner.dot(viewAxis);
            distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / horizontal,
              depth + Math.abs(corner.dot(up)) / vertical);
          }
        }
      }
      controls.maxDistance = distance * 2;
      camera.far = Math.max(900, distance * 3);
      camera.updateProjectionMatrix();
      controls.target.copy(focus);
      camera.position.copy(focus).addScaledVector(viewAxis, distance);
      controls.update();
    };
    const resize = () => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
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
      for (const { id, position } of shelterAnchors.current) {
        const label = shelterElements.current.get(id);
        if (label) placeLabel(label, position);
      }
      const astronaut = astronautElement.current;
      if (astronaut && astronautAnchor.current) placeLabel(astronaut, astronautAnchor.current);
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
    const base = loader.loadAsync(asset(panorama[scope]));
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
  }, [frame, scope, layer, terrain, slopes, slopeLimit, opacity]);

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
      for (const route of routes) {
        if (route.waypoint) pin(route.waypoint, route.color, 0.65);
      }
      const points = evaPoints ?? activeLeg?.path.map((cell) => cellCenter(terrain, cell));
      if (points) {
        trace(points, routeOutline, false, 8, 0.65, 1);
        trace(points, activeColor ?? routeColor[activeDirection], activeDashed, 4.6, 0.65, 2);
      }
      pin(cellCenter(terrain, start), routeColor.out, 1);
      pin(cellCenter(terrain, target), routeColor.back, 1);
    } else {
      pin(localPoint(terrain, terrain.positions.base), routeColor.out, scope === 'crater' ? 0.8 : 0.65);
      if (scope === 'crater') pin(localPoint(terrain, galeOverview.mountSharp), '#e0e8ff', 0.8);
      if (scope === 'region') pin(localPoint(terrain, terrain.positions.science), routeColor.back, 0.65);
    }
    if (inspection) pin(inspection, '#ffffff', 0.55);
  }, [frame, grid, terrain, start, target, activeLeg, activeDirection, activeColor, activeDashed, showRover, inspection, scope, routes, selectedRoute, evaPoints]);

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
    } else {
      const offset = scene.camera.position.clone().sub(scene.controls.target);
      const distance = offset.length() * (command.type === 'in' ? 0.78 : 1.28);
      offset.setLength(THREE.MathUtils.clamp(distance, scene.controls.minDistance, scene.controls.maxDistance));
      scene.camera.position.copy(scene.controls.target).add(offset);
      scene.controls.update();
    }
  }, [command]);

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
      <div className="eva-map-pin eva-map-pin--relief" ref={astronautElement} role="img" aria-label="Astronaut">
        <span><PersonStanding aria-hidden="true" /></span>
      </div>}
    {ready && !failure && scope === 'traverse' && shelterPins.map(({ id, selected }) =>
      <div key={id} className="shelter-pin shelter-pin--relief" role="img" aria-label={`Terrain cover candidate ${id}`}
        ref={(element) => {
          if (element) shelterElements.current.set(id, element);
          else shelterElements.current.delete(id);
        }}>
        <span data-selected={selected}>{id}</span>
      </div>)}
    {failure ? <div className="relief-status" role="alert">
      <span>{failure}</span><button className="button" onClick={onFallback}>Back to 2D</button>
    </div> : !ready && <div className="relief-status" role="status">Loading 3D elevation…</div>}
  </>;
}
