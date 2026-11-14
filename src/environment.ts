import { cellAt, cellCenter, eastScale, estimateTimedReserve, terrainGradient, traverseSearch } from './mission.ts';
import type { Cell, LocalPoint, Terrain } from './mission.ts';
import { evaLocation, evaSearchSeeds } from './eva.ts';
import type { EvaSession } from './eva.ts';

const DEG = Math.PI / 180;
const REV = 2 * Math.PI;
const RAD_QUIET = 265;
const RAD_EVENT = 417;
const RADIO_RANGE = 300;
// Fixed morning start for both training regions.
const SUN_EPOCH = Date.UTC(2025, 8, 15, 0);

export function radDose(minutes: number, eventStart: number | null) {
  const eventMinutes = eventStart === null ? 0 : Math.max(0, minutes - eventStart);
  return (RAD_QUIET * (minutes - eventMinutes) + RAD_EVENT * eventMinutes) / 1440;
}

function height(terrain: Terrain, point: LocalPoint) {
  const { row, col } = cellAt(terrain, point);
  if (row < 0 || col < 0 || row >= terrain.height || col >= terrain.width) return null;
  return terrain.elevationM[row * terrain.width + col] ?? null;
}

export function radioStatus(terrain: Terrain, point: LocalPoint, base: LocalPoint) {
  const distance = Math.hypot((base.x - point.x) * eastScale(terrain), base.y - point.y);
  if (distance > RADIO_RANGE) return 'Out of range';
  const a = height(terrain, point);
  const b = height(terrain, base);
  if (a === null || b === null) return 'Data unavailable';
  const steps = Math.ceil(distance / (terrain.cellM / 2));
  let missing = false;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const z = height(terrain, { x: point.x + (base.x - point.x) * t, y: point.y + (base.y - point.y) * t });
    if (z === null) missing = true;
    else if (z > a + 1.7 + (b + 3 - a - 1.7) * t) return 'Terrain blocked';
  }
  return missing ? 'Data unavailable' : 'Connected';
}

// NASA GISS Mars24, solar longitude, equation of time and local topocentric position.
export function marsSun(terrain: Terrain, point: LocalPoint, minutes: number,
  epoch = SUN_EPOCH, ttOffsetMs = 69_184) {
  const day = (epoch + minutes * 60_000 + ttOffsetMs) / 86_400_000 + 2440587.5 - 2451545;
  const anomaly = (19.3871 + 0.52402073 * day) * DEG;
  const mean = 270.3871 + 0.524038496 * day;
  const perturbations = [[0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173],
    [0.0039, 1.1177, 191.837], [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704],
    [0.002, 2.4694, 95.528], [0.0018, 32.8493, 49.095]];
  const pbs = perturbations.reduce((sum, [a, tau, phase]) => sum + a * Math.cos((0.985626 * day / tau + phase) * DEG), 0);
  const center = (10.691 + 3e-7 * day) * Math.sin(anomaly) + 0.623 * Math.sin(2 * anomaly) +
    0.05 * Math.sin(3 * anomaly) + 0.005 * Math.sin(4 * anomaly) + 0.0005 * Math.sin(5 * anomaly) + pbs;
  const ls = (mean + center) * DEG;
  const eot = 2.861 * Math.sin(2 * ls) - 0.071 * Math.sin(4 * ls) + 0.002 * Math.sin(6 * ls) - center;
  const msd = (day - 4.5) / 1.0274912517 + 44796 - 0.0009626;
  const dec = Math.asin(0.42565 * Math.sin(ls)) + 0.25 * DEG * Math.sin(ls);
  const lon = (terrain.bounds.west + point.x) / terrain.radiusM;
  const lat = (terrain.bounds.south + point.y) / terrain.radiusM;
  const hourAngle = REV * (msd - Math.floor(msd) - 0.5) + lon + eot * DEG;
  const east = -Math.cos(dec) * Math.sin(hourAngle);
  const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hourAngle);
  const up = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
  return { east, north, up, elevation: Math.asin(up) / DEG, azimuth: (Math.atan2(east, north) + REV) % REV / DEG };
}

export function lightStatus(terrain: Terrain, point: LocalPoint, sun: ReturnType<typeof marsSun>) {
  if (sun.up <= 0) return 'Night';
  const z = height(terrain, point);
  if (z === null) return 'Data unavailable';
  const horizontal = Math.hypot(sun.east, sun.north);
  if (horizontal < 1e-4) return 'Sunlit';
  const sampleStep = terrain.cellM;
  let missing = false;
  for (let d = sampleStep; d <= 150; d += sampleStep) {
    const sample = height(terrain, { x: point.x + sun.east * d / (horizontal * eastScale(terrain)),
      y: point.y + sun.north * d / horizontal });
    if (sample === null) missing = true;
    else if (sample > z + 1.7 + sun.up * d / horizontal) return 'In shadow';
  }
  return missing ? 'Data unavailable' : 'Sunlit';
}

export function liveSlope(terrain: Terrain, point: LocalPoint, heading: LocalPoint) {
  const gradient = terrainGradient(terrain, cellAt(terrain, point));
  const east = heading.x * eastScale(terrain);
  const run = Math.hypot(east, heading.y);
  if (!gradient || !run) return null;
  return { longitudinal: Math.atan((gradient.east * east + gradient.north * heading.y) / run) / DEG,
    cross: Math.atan(Math.abs(gradient.east * heading.y - gradient.north * east) / run) / DEG };
}

export function reserveRange(terrain: Terrain, slopes: (number | null)[], base: Cell, session: EvaSession, slopeLimit: number,
  cachedInbound?: Float64Array) {
  const routing = { priority: 'shortest' as const, slopeLimit };
  const budget = estimateTimedReserve(0, 0, session.elapsed, session.plan.settings).margin;
  const cells = new Uint8Array(terrain.width * terrain.height);
  if (budget < 0) return { cells, inbound: cachedInbound };
  const inbound = cachedInbound ?? traverseSearch(terrain, slopes, [{ cell: base, minutes: 0 }], routing, { reverse: true }).costs;
  const outward = traverseSearch(terrain, slopes, evaSearchSeeds(terrain, evaLocation(session), slopeLimit), routing, { maxMinutes: budget }).costs;
  for (let i = 0; i < cells.length; i++) if (outward[i] + inbound[i] <= budget) cells[i] = 1;
  return { cells, inbound };
}

export function shadowGrid(terrain: Terrain, minutes: number) {
  const step = Math.max(1, Math.ceil(Math.max(terrain.width, terrain.height) / 100));
  const width = Math.ceil(terrain.width / step);
  const height = Math.ceil(terrain.height / step);
  const values = new Uint8Array(width * height);
  for (let i = 0; i < values.length; i++) {
    const point = cellCenter(terrain, { row: Math.floor(i / width) * step, col: (i % width) * step });
    const status = lightStatus(terrain, point, marsSun(terrain, point, minutes));
    values[i] = status === 'Data unavailable' ? 2 : status === 'Sunlit' ? 0 : 1;
  }
  return { width, height, values };
}
