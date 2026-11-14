import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellAt, cellCenter, estimateReserve, inspectTerrain, localPoint, planMission, slopeGrid } from '../src/mission.ts';
import { mapPoint, sampleElevation, terrainFrame, worldPoint } from '../src/terrainRelief.ts';
import { arrivalMinutes, cameraLocation, cameraStops, missionRoutes, stations } from '../src/galeRoutes.ts';

const gale = JSON.parse(readFileSync(new URL('../public/gale/terrain.json', import.meta.url), 'utf8'));
const fixed = (row, col) => ({ row, col });
const overview = JSON.parse(readFileSync(new URL('../src/galeOverview.json', import.meta.url), 'utf8'));
const roverTrack = JSON.parse(readFileSync(new URL('../src/curiosityTrack.json', import.meta.url), 'utf8'));
const overviewElevation = JSON.parse(readFileSync(new URL('../public/gale/elevation-overview.json', import.meta.url), 'utf8'));

test('reserve budget recommends the longest whole-minute stop at or above the threshold', () => {
  const baseline = estimateReserve(934, 15, 40);
  assert.equal(baseline.maxFieldworkMinutes, 1);
  assert.equal(baseline.availableMinutes, 70);
  assert.ok(estimateReserve(934, baseline.maxFieldworkMinutes, 40).margin >= 0);
  assert.ok(estimateReserve(934, baseline.maxFieldworkMinutes + 1, 40).margin < 0);
  assert.equal(estimateReserve(934, 0, 45).maxFieldworkMinutes, null);
});

test('starting levels and minimum return percentage can shift the limiting resource', () => {
  const settings = { oxygen: 32, battery: 80, minimum: 25 };
  const result = estimateReserve(500, 8, 0, settings);
  assert.equal(result.limiting.name, 'Oxygen');
  assert.equal(result.limiting.remaining, 25.1);
  assert.equal(result.maxFieldworkMinutes, 8);
  assert.ok(Math.abs(estimateReserve(500, 5, 0, { oxygen: 26, battery: 28, minimum: 20 }).margin) < 1e-8);
  assert.equal(estimateReserve(500, 0, 0, { ...settings, minimum: 40 }).maxFieldworkMinutes, null);
});

test('the first resource to run out can differ from the one that sets the reserve', () => {
  const result = estimateReserve(1000, 15, 60, { oxygen: 29, battery: 37, minimum: 20 });
  assert.equal(result.limiting.name, 'Oxygen');
  assert.equal(result.depletion.name, 'Battery');
  assert.ok(result.missionMinutes > result.depletion.depletionMinutes);
});

test('Gale alternatives are distinct valid round trips through different scenario stations', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const stop = cellAt(gale, localPoint(gale, gale.positions.science));
  const slopes = slopeGrid(gale);
  const { options, error } = missionRoutes(gale, slopes, start, stop);
  assert.equal(error, null);
  assert.deepEqual(options.map(({ code }) => code), ['A', 'B', 'C']);
  assert.deepEqual(options.map((route) => Math.round(arrivalMinutes(route, 'out'))), [14, 17, 20]);
  assert.deepEqual(options.map((route) => Math.round(arrivalMinutes(route, 'back', 15))), [43, 49, 56]);
  assert.deepEqual(options.map((route) => Math.round(arrivalMinutes(route, 'back', 55))), [83, 89, 96]);
  for (const [i, route] of options.entries()) {
    assert.deepEqual(route.out.path[0], start);
    assert.deepEqual(route.out.path.at(-1), stop);
    assert.deepEqual(route.back.path, [...route.out.path].reverse());
    assert.ok(route.out.maxSlope <= 18);
    assert.equal(route.out.profile.length, route.out.path.length);
    assert.equal(route.out.profile.at(-1).distanceM, route.out.distanceM);
    if (i > 0) {
      const checkpoint = cellAt(gale, stations[i - 1].point);
      assert.ok(route.out.path.some((cell) => cell.row === checkpoint.row && cell.col === checkpoint.col));
    }
  }
});

test('unreachable station detours are omitted and rover camera pins fall inside the EVA area', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const stop = cellAt(gale, localPoint(gale, gale.positions.science));
  const slopes = slopeGrid(gale);
  const firstStation = cellAt(gale, stations[0].point);
  slopes[firstStation.row * gale.width + firstStation.col] = null;
  assert.deepEqual(missionRoutes(gale, slopes, start, stop).options.map(({ code }) => code), ['A', 'C']);
  for (const camera of cameraStops) assert.ok(inspectTerrain(gale, slopes, cameraLocation(gale, camera)));
});

test('3D elevation is present at all three scales and round trips through the map projection', () => {
  for (const [scope, grid] of Object.entries({ ...overviewElevation, traverse: gale })) {
    assert.equal(grid.elevationM.length, grid.width * grid.height);
    assert.ok(grid.elevationM.every(Number.isFinite));
    assert.ok(Math.max(...grid.elevationM) - Math.min(...grid.elevationM) > 25);
    const frame = terrainFrame(gale, scope, grid);
    const base = localPoint(gale, gale.positions.base);
    const height = sampleElevation(grid, frame, base);
    assert.ok(height !== null && height < -4000 && height > -4800);
    const [x, , z] = worldPoint(frame, base, height);
    const clicked = mapPoint(frame, x, z);
    assert.ok(Math.hypot(clicked.x - base.x, clicked.y - base.y) < 0.000001);
    assert.equal(sampleElevation(grid, frame, { x: frame.min.x - 1, y: base.y }), null);
  }
});

test('EVA route vertices use their elevations from the same mesh grid', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const stop = cellAt(gale, localPoint(gale, gale.positions.science));
  const mission = planMission(gale, slopeGrid(gale), start, stop);
  assert.ok(!('error' in mission));
  const frame = terrainFrame(gale, 'traverse', gale);
  for (const [index, cell] of mission.out.path.entries()) {
    assert.equal(sampleElevation(gale, frame, cellCenter(gale, cell)), mission.out.profile[index].elevationM);
  }
});

test('all three map views cover the EVA trail and the archived rover trace has the expected endpoints', () => {
  const first = roverTrack[0][0];
  const last = roverTrack.at(-1).at(-1);
  for (const [i, waypoint] of [gale.positions.base, gale.positions.science].entries()) {
    const [lon, lat] = i === 0 ? first : last;
    assert.ok(Math.abs(lon - waypoint.longitude) < 0.000001);
    assert.ok(Math.abs(lat - waypoint.latitude) < 0.000001);
  }
  for (const [lon, lat] of roverTrack.flat()) {
    const point = localPoint(gale, { longitude: lon, latitude: lat });
    assert.ok(inspectTerrain(gale, [], point));
    for (const { west, south, east, north } of [overview.bounds, overview.region.bounds]) {
      assert.ok(lon > west && lon < east && lat > south && lat < north);
    }
  }
});

test('map inspection reports missing data at the edge and rejects points outside the EVA grid', () => {
  const terrain = flatTerrain();
  const slopes = slopeGrid(terrain);
  assert.deepEqual(inspectTerrain(terrain, slopes, { x: 25, y: 25 }), { elevationM: -4500, slope: 0 });
  assert.deepEqual(inspectTerrain(terrain, slopes, { x: 5, y: 5 }), { elevationM: -4500, slope: null });
  assert.equal(inspectTerrain(terrain, slopes, { x: -1, y: 25 }), null);
});

function flatTerrain(width = 8, height = 8) {
  return {
    ...gale,
    bounds: { west: 0, south: -height * 5, east: width * 10, north: height * 5 },
    width,
    height,
    elevationM: Array(width * height).fill(-4500),
  };
}

test('flat terrain gives correct distance and a reversed return leg', () => {
  const terrain = flatTerrain();
  const plan = planMission(terrain, slopeGrid(terrain), fixed(2, 2), fixed(2, 5));
  assert.equal(plan.out.distanceM, 30);
  assert.equal(plan.out.maxSlope, 0);
  assert.equal(plan.out.climbM, 0);
  assert.deepEqual(plan.back.path, [...plan.out.path].reverse());
});

test('invalid coordinates, missing data and same-cell picks are explicit errors', () => {
  const terrain = flatTerrain();
  terrain.elevationM[2 * terrain.width + 2] = null;
  const slopes = slopeGrid(terrain);
  assert.equal(slopes[2 * terrain.width + 2], null);
  assert.equal(slopes[2 * terrain.width + 3], null);
  assert.equal(planMission(terrain, slopes, fixed(-1, 2), fixed(5, 5)).error, 'outside_area');
  assert.equal(planMission(terrain, slopes, fixed(2, 2), fixed(5, 5)).error, 'invalid_cell');
  assert.equal(planMission(terrain, slopes, fixed(5, 5), fixed(5, 5)).error, 'same_cell');
});

test('a blocked diagonal cannot cross the corner of two blocked cells', () => {
  const terrain = flatTerrain(4, 4);
  const slopes = Array(16).fill(null);
  slopes[5] = 0;
  slopes[10] = 0;
  assert.equal(planMission(terrain, slopes, fixed(1, 1), fixed(2, 2)).error, 'no_path');
});

test('a steep edge blocks an otherwise passable move', () => {
  const terrain = flatTerrain(4, 4);
  terrain.elevationM[6] += 6;
  const slopes = Array(16).fill(null);
  slopes[5] = 0;
  slopes[6] = 0;
  assert.equal(planMission(terrain, slopes, fixed(1, 1), fixed(1, 2)).error, 'no_path');
});

test('NASA waypoints are on valid Gale terrain, and the delay changes the return decision', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const goal = cellAt(gale, localPoint(gale, gale.positions.science));
  assert.deepEqual(cellAt(gale, cellCenter(gale, start)), start);
  assert.deepEqual(cellAt(gale, cellCenter(gale, goal)), goal);
  const plan = planMission(gale, slopeGrid(gale), start, goal);
  assert.ok(!('error' in plan), JSON.stringify(plan));
  assert.ok(plan.out.distanceM >= 450 && plan.out.distanceM < 800);
  const distance = plan.out.distanceM + plan.back.distanceM;
  const baseline = estimateReserve(distance, 15, 0);
  const delayed = estimateReserve(distance, 15, 40);
  assert.ok(baseline.margin > 0);
  assert.ok(delayed.margin < 0);
  assert.equal(delayed.limiting.name, 'Battery');
  assert.ok(delayed.limiting.remaining < 20);
  assert.ok(Math.abs(baseline.margin - delayed.margin - 40) < 0.00001);
});
