import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { Cell, Leg, LocalPoint, Terrain } from './mission';
import type { ShelterPin } from './shelters';
import { createMapSymbol } from './mapSymbols';
import type { MissionPin, SymbolKind } from './mapSymbols';
import { cellAt, cellCenter, displayPosition, localPoint } from './mission';
import { cameraLocation, cameraStops, stations } from './galeRoutes';
import galeOverview from './galeOverview.json';
import curiosityTrack from './curiosityTrack.json';

export type LayerMode = 'optical' | 'slope' | 'thermal';
export type MapScope = 'crater' | 'region' | 'traverse';
export const routeColor = { out: '#62e7d2', back: '#d6e4f2' };
export const routeOutline = '#101821';
const roverColor = '#cf9dff';

const pointToLatLng = ({ x, y }: LocalPoint): L.LatLngTuple => [y, x];

function markerIcon(kind: SymbolKind, id?: string, state?: string) {
  return L.divIcon({
    className: `map-symbol-icon map-symbol-icon--${kind}`,
    iconSize: [27, 27],
    html: createMapSymbol(kind, id, state),
  });
}

export function slopeImage(terrain: Terrain, slopes: (number | null)[], slopeLimit: number) {
  const canvas = document.createElement('canvas');
  canvas.width = terrain.width;
  canvas.height = terrain.height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(terrain.width, terrain.height);
  slopes.forEach((slope, index) => {
    const color = slope === null ? [114, 109, 124, 210] :
      slope > slopeLimit ? [242, 73, 75, 219] :
      slope > 8 ? [246, 162, 73, 210] : [48, 161, 129, 107];
    image.data.set(color, index * 4);
  });
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export type MapProps = {
  terrain: Terrain;
  slopes: (number | null)[];
  start: Cell;
  target: Cell;
  activeLeg?: Leg;
  activeColor?: string;
  activeDashed: boolean;
  activeDirection: 'out' | 'back';
  evaPoint?: LocalPoint;
  evaPoints?: LocalPoint[];
  heading?: LocalPoint;
  shelterPins: ShelterPin[];
  missionPins?: MissionPin[];
  missionReturnPoints?: LocalPoint[];
  layer: LayerMode;
  slopeLimit: number;
  scope: MapScope;
  expanded: boolean;
  opacity: number;
  mode: boolean;
  inspection: LocalPoint | null;
  showRover: boolean;
  showStations: boolean;
  onPick: (cell: Cell) => void;
  onInspect: (point: LocalPoint) => void;
  onChangeScope: (scope: MapScope) => void;
  onCoordinate: (value: string) => void;
  command: { id: number; type: 'in' | 'out' | 'reset' };
};

const asset = (path: string) => `${import.meta.env.BASE_URL}gale/${path}`;

function geographicBounds(terrain: Terrain, { west, south, east, north }: typeof galeOverview.bounds) {
  return L.latLngBounds(
    pointToLatLng(localPoint(terrain, { longitude: west, latitude: south })),
    pointToLatLng(localPoint(terrain, { longitude: east, latitude: north })),
  );
}

function fitScope(map: L.Map, bounds: L.LatLngBounds) {
  const size = map.getSize();
  const padding = Math.max(12, Math.round(Math.min(size.x, size.y) * 0.045));
  map.fitBounds(bounds, { padding: [padding, padding], animate: false });
}

function scopeMarker(point: L.LatLng, label: string, open: () => void) {
  const marker = L.marker(point, {
    title: label,
    icon: L.divIcon({
      className: 'map-scope-marker',
      iconSize: [20, 20],
      html: '<span aria-hidden="true"></span>',
    }),
  });
  return marker
    .bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'base-label' })
    .on('click', open);
}

function namedPlace(point: L.LatLngTuple, name: string, direction: 'left' | 'right' | 'top') {
  return L.circleMarker(point, {
    radius: 4, color: '#f5f8ff', fillColor: '#9eb3cd', fillOpacity: 1, weight: 2, interactive: false,
  }).bindTooltip(name, { permanent: true, direction, offset: [0, direction === 'top' ? -7 : 0], className: 'place-label' });
}

function assetPin(kind: 'station' | 'camera', name: string, point: L.LatLngTuple) {
  return L.marker(point, {
    title: name, alt: name, bubblingMouseEvents: false,
    icon: markerIcon(kind),
  });
}

function assetPopup(name: string, category: string, detail: string) {
  const card = document.createElement('div');
  card.className = 'map-asset-popup';
  const heading = document.createElement('strong');
  heading.textContent = name;
  const type = document.createElement('small');
  type.textContent = category;
  const description = document.createElement('p');
  description.textContent = detail;
  card.append(type, heading, description);
  return card;
}

export function TerrainMap(props: MapProps) {
  const { terrain, slopes, start, target, activeLeg, activeColor, activeDashed, activeDirection, layer, slopeLimit, scope, expanded, opacity,
    evaPoint, evaPoints, shelterPins, missionPins, missionReturnPoints, heading, mode, inspection, showRover, showStations, command } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map | null>(null);
  const overlay = useRef<L.ImageOverlay | null>(null);
  const drawing = useRef<L.LayerGroup | null>(null);
  const inspectorDrawing = useRef<L.LayerGroup | null>(null);
  const roverDrawing = useRef<L.LayerGroup | null>(null);
  const assetDrawing = useRef<L.LayerGroup | null>(null);
  const evaMarker = useRef<L.Marker | null>(null);
  const viewBounds = useRef<Record<MapScope, L.LatLngBounds> | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const extent = L.latLngBounds(
      [0, 0],
      [terrain.height * terrain.cellM, terrain.width * terrain.cellM],
    );
    const map = L.map(element.current, {
      crs: L.CRS.Simple,
      zoomControl: false,
      attributionControl: false,
      minZoom: -12,
      maxZoom: 3,
      maxBoundsViscosity: 0.9,
      zoomSnap: 0,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 130,
    });
    const scopes = {
      crater: geographicBounds(terrain, galeOverview.bounds),
      region: geographicBounds(terrain, galeOverview.region.bounds),
      traverse: extent,
    };
    viewBounds.current = scopes;
    instance.current = map;
    const images = {
      crater: { image: galeOverview.image, alt: 'Mars Trek mosaic covering Gale Crater' },
      region: { image: galeOverview.region.image, alt: 'Mars Trek CTX mosaic around Curiosity’s landing site' },
      traverse: { image: 'optical.webp', alt: 'HiRISE imagery of the EVA study area' },
    };
    for (const type of ['crater', 'region', 'traverse'] as const) {
      const pane = map.createPane(`${type}Imagery`);
      pane.style.zIndex = '220';
      pane.style.display = type === callbacks.current.scope ? '' : 'none';
      pane.style.pointerEvents = 'none';
      L.imageOverlay(asset(images[type].image), scopes[type], {
        alt: images[type].alt,
        className: 'optical-imagery',
        pane: `${type}Imagery`,
      }).addTo(map);
    }
    roverDrawing.current = L.layerGroup().addTo(map);
    drawing.current = L.layerGroup().addTo(map);
    assetDrawing.current = L.layerGroup().addTo(map);
    inspectorDrawing.current = L.layerGroup().addTo(map);

    fitScope(map, scopes[callbacks.current.scope]);
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      map.invalidateSize({ animate: false, pan: false });
      fitScope(map, scopes[callbacks.current.scope]);
    });
    observer.observe(element.current);
    map.on('click', (event: L.LeafletMouseEvent) => {
      const point = { x: event.latlng.lng, y: event.latlng.lat };
      if (callbacks.current.scope === 'traverse' && callbacks.current.mode) {
        callbacks.current.onPick(cellAt(terrain, point));
      } else {
        callbacks.current.onInspect(point);
      }
    });
    map.on('mousemove', (event: L.LeafletMouseEvent) => {
      callbacks.current.onCoordinate(displayPosition(terrain, { x: event.latlng.lng, y: event.latlng.lat }));
    });
    const initialCell = cellCenter(terrain, callbacks.current.target);
    callbacks.current.onCoordinate(displayPosition(terrain, initialCell));
    const scale = L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 110 });
    const eastScale = Math.cos((terrain.bounds.south + terrain.bounds.north) / 2 / terrain.radiusM);
    map.distance = (a: L.LatLng, b: L.LatLng) => Math.hypot((a.lng - b.lng) * eastScale, a.lat - b.lat);
    scale.addTo(map);
    return () => {
      observer.disconnect();
      map.remove();
      instance.current = null;
      overlay.current = null;
      drawing.current = null;
      roverDrawing.current = null;
      assetDrawing.current = null;
      inspectorDrawing.current = null;
      evaMarker.current = null;
      viewBounds.current = null;
    };
  }, [terrain]);

  useEffect(() => {
    const map = instance.current;
    const extent = viewBounds.current?.[scope];
    if (!map || !extent) return;
    for (const type of ['crater', 'region', 'traverse'] as const) {
      map.getPane(`${type}Imagery`)!.style.display = scope === type ? '' : 'none';
    }
    map.setMaxBounds(extent.pad(0.12));
    map.invalidateSize({ animate: false, pan: false });
    fitScope(map, extent);
  }, [scope, expanded, terrain]);

  useEffect(() => {
    const map = instance.current;
    const extent = viewBounds.current?.traverse;
    if (!map || !extent) return;
    overlay.current?.remove();
    overlay.current = null;
    if (layer === 'optical' || scope !== 'traverse') return;
    const url = layer === 'slope' ? slopeImage(terrain, slopes, slopeLimit) : asset('thermal.webp');
    overlay.current = L.imageOverlay(url, extent, { opacity: callbacks.current.opacity, zIndex: 2 }).addTo(map);
  }, [layer, scope, terrain, slopes, slopeLimit]);

  useEffect(() => {
    overlay.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    const group = drawing.current;
    const scopes = viewBounds.current;
    if (!group || !scopes) return;
    group.clearLayers();
    if (scope === 'crater') {
      namedPlace(pointToLatLng(localPoint(terrain, galeOverview.mountSharp)), 'Mount Sharp', 'right').addTo(group);
      scopeMarker(scopes.traverse.getCenter(), 'Curiosity landing region',
        () => callbacks.current.onChangeScope('region')).addTo(group);
      return;
    }
    L.rectangle(scopes.traverse, {
      color: '#a4f8e8', weight: 1.5, dashArray: '5 5', opacity: 0.9,
      fill: false, interactive: false,
    }).addTo(group);
    if (scope === 'region') {
      namedPlace(pointToLatLng(localPoint(terrain, terrain.positions.base)), 'Bradbury Landing', 'left').addTo(group);
      namedPlace(pointToLatLng(localPoint(terrain, terrain.positions.science)), 'Yellowknife Bay', 'top').addTo(group);
      scopeMarker(scopes.traverse.getCenter(), 'EVA study area',
        () => callbacks.current.onChangeScope('traverse')).addTo(group);
      return;
    }
    const basePoint = pointToLatLng(cellCenter(terrain, start));
    const goalPoint = pointToLatLng(cellCenter(terrain, target));
    const points = evaPoints?.map(pointToLatLng) ?? activeLeg?.path.map((cell) => pointToLatLng(cellCenter(terrain, cell)));
    if (missionReturnPoints && missionReturnPoints.length > 1) {
      L.polyline(missionReturnPoints.map(pointToLatLng), { color: routeOutline, weight: 7, interactive: false }).addTo(group);
      L.polyline(missionReturnPoints.map(pointToLatLng), { color: routeColor.back, weight: 3, dashArray: '7 6', interactive: false }).addTo(group);
    }
    if (points && points.length > 1) {
      const color = activeColor ?? routeColor[activeDirection];
      L.polyline(points, { color: routeOutline, weight: 9, opacity: 0.98, interactive: false }).addTo(group);
      L.polyline(points, { color, weight: 5, opacity: 1, interactive: false,
        dashArray: activeDashed ? '8 6' : undefined }).addTo(group);
      const index = Math.floor(points.length * 0.57);
      const [y, x] = points[index];
      const [ey, ex] = points[Math.min(index + 1, points.length - 1)];
      const angle = Math.atan2(y - ey, ex - x) * 180 / Math.PI;
      L.marker(points[index], {
        interactive: false,
        icon: L.divIcon({
          className: 'map-arrow', iconSize: [26, 26],
          html: `<span style="transform:rotate(${angle}deg);color:${color}">➜</span>`,
        }),
      }).addTo(group);
    }
    L.marker(basePoint, { icon: markerIcon('base'), interactive: false, keyboard: false })
      .addTo(group).bindTooltip('Base camp', { permanent: true, direction: 'top', offset: [0, -16], className: 'base-label' });
    if (!missionPins) L.marker(goalPoint, { icon: markerIcon('science'), interactive: false, keyboard: false })
      .addTo(group).bindTooltip('Science stop', { permanent: true, direction: 'top', offset: [0, -16], className: 'target-label' });
    for (const { id, point, label, status } of missionPins ?? []) {
      const marker = L.marker(pointToLatLng(point), {
        interactive: !mode, keyboard: !mode, zIndexOffset: status === 'active' ? 810 : 740,
        icon: markerIcon('stop', id, status),
      }).addTo(group);
      const name = `Stop ${id}${label === `Stop ${id}` ? '' : ` · ${label}`}${status === 'pending' ? '' : ` · ${status === 'complete' ? 'Completed' : 'Active'}`}`;
      const tip = document.createElement('span');
      tip.textContent = name;
      marker.bindTooltip(tip, { permanent: status === 'active', direction: 'top', offset: [0, -15], className: 'target-label' });
      marker.getElement()?.setAttribute('aria-label', name);
    }
    for (const { id, point, selected } of shelterPins) {
      const marker = L.marker(pointToLatLng(point), {
        interactive: false, keyboard: false, zIndexOffset: 800,
        icon: markerIcon('shelter', id, selected ? 'active' : 'pending'),
      }).addTo(group);
      marker.getElement()?.setAttribute('role', 'img');
      marker.getElement()?.setAttribute('aria-label', `Terrain cover candidate ${id}`);
    }
  }, [terrain, start, target, activeLeg, activeColor, activeDashed, activeDirection, scope, evaPoints, shelterPins, missionPins, missionReturnPoints, mode]);

  useEffect(() => {
    const map = instance.current;
    if (!map || !evaPoint || scope === 'crater') {
      evaMarker.current?.remove();
      evaMarker.current = null;
      return;
    }
    const position = pointToLatLng(evaPoint);
    if (evaMarker.current) {
      evaMarker.current.setLatLng(position);
    } else {
      evaMarker.current = L.marker(position, {
        interactive: false, keyboard: false, zIndexOffset: 1000, icon: markerIcon('astronaut'),
      }).addTo(map);
      evaMarker.current.getElement()?.setAttribute('aria-label', 'Astronaut');
    }
    if (heading && (heading.x || heading.y)) evaMarker.current.getElement()?.style.setProperty('--heading',
      `${Math.atan2(heading.x, heading.y)}rad`);
  }, [terrain, evaPoint, scope, heading]);

  useEffect(() => {
    const group = roverDrawing.current;
    if (!group) return;
    group.clearLayers();
    if (scope === 'crater' || !showRover) return;
    const segments = curiosityTrack.map((segment) => segment.map(([longitude, latitude]) =>
      pointToLatLng(localPoint(terrain, { longitude, latitude }))));
    L.polyline(segments, { color: '#171222', weight: 6, opacity: 0.9, interactive: false }).addTo(group);
    L.polyline(segments, { color: roverColor, weight: 3, dashArray: '4 7', interactive: false }).addTo(group);
  }, [terrain, scope, showRover]);

  useEffect(() => {
    const group = assetDrawing.current;
    if (!group) return;
    group.clearLayers();
    if (!showStations || scope === 'crater' || mode) return;
    for (const station of stations) {
      assetPin('station', station.name, pointToLatLng(station.point))
        .bindTooltip(station.name, { permanent: scope === 'traverse', direction: 'bottom', offset: [0, 11], className: 'place-label' })
        .bindPopup(assetPopup(station.name, 'SIMULATED EVA STATION', station.detail))
        .addTo(group);
    }
    for (const stop of cameraStops) {
      const card = assetPopup(stop.name, 'ARCHIVED ROVER VIEWPOINT', stop.detail);
      if ('image' in stop) {
        const image = document.createElement('img');
        image.src = asset(stop.image);
        image.alt = 'Rocknest photographed by Curiosity on Sol 52';
        image.loading = 'lazy';
        card.append(image);
      }
      const link = document.createElement('a');
      link.textContent = 'Open NASA image';
      link.href = stop.source;
      link.target = '_blank';
      link.rel = 'noreferrer';
      card.append(link);
      assetPin('camera', stop.name, pointToLatLng(cameraLocation(terrain, stop)))
        .bindTooltip(stop.name)
        .bindPopup(card)
        .addTo(group);
    }
  }, [terrain, scope, showStations, mode]);

  useEffect(() => {
    const group = inspectorDrawing.current;
    if (!group) return;
    group.clearLayers();
    if (inspection) {
      L.circleMarker(pointToLatLng(inspection), {
        radius: 6, color: '#f1f7ff', fill: false, weight: 2, interactive: false,
      }).addTo(group);
    }
  }, [terrain, inspection]);

  useEffect(() => {
    const map = instance.current;
    const extent = viewBounds.current?.[callbacks.current.scope];
    if (!command.id || !map || !extent) return;
    if (command.type === 'reset') {
      fitScope(map, extent);
    } else {
      map.setZoom(map.getZoom() + (command.type === 'in' ? 0.5 : -0.5));
    }
  }, [command, terrain]);

  return <div ref={element} className={`terrain-map${mode ? ' terrain-map--pick' : ''}`} aria-label="Interactive map of the Gale Crater study area" />;
}
