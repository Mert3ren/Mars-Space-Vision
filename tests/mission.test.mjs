import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellAt, cellCenter, DEFAULT_RESERVE_SETTINGS, estimateReserve, inspectTerrain, localPoint, planMission, slopeGrid, walkMinutes } from '../src/mission.ts';
import { mapPoint, sampleElevation, terrainFrame, worldPoint } from '../src/terrainRelief.ts';
import { arrivalMinutes, cameraLocation, cameraStops, compareRoutes, missionRoutes, stations } from '../src/galeRoutes.ts';
import { activeEvaPath, advanceEva, createReturnPlanner, delayEva, divertEva, evaLocation, evaTelemetry, returnEva, startEva } from '../src/eva.ts';
import { findShelterCandidates, MIN_SKY_COVER, shelterOptions } from '../src/shelters.ts';

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

test('route priorities trade off distance and grade on the real Gale grid', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const stop = cellAt(gale, localPoint(gale, gale.positions.science));
  const slopes = slopeGrid(gale);
  const shortest = planMission(gale, slopes, start, stop, { priority: 'shortest', slopeLimit: 18 });
  const gentler = planMission(gale, slopes, start, stop, { priority: 'gentler', slopeLimit: 18 });
  assert.ok(!('error' in shortest) && !('error' in gentler));
  assert.ok(gentler.out.distanceM > shortest.out.distanceM);
  assert.ok(gentler.out.maxSlope < shortest.out.maxSlope);
});

test('slope cap applies to endpoint cells and each edge', () => {
  const terrain = flatTerrain();
  const slopes = Array(terrain.width * terrain.height).fill(null);
  const start = fixed(2, 2);
  const stop = fixed(2, 3);
  const from = start.row * terrain.width + start.col;
  slopes[from] = 0;
  slopes[from + 1] = 0;
  terrain.elevationM[from + 1] += 2;
  assert.equal(planMission(terrain, slopes, start, stop, { priority: 'balanced', slopeLimit: 8 }).error, 'no_path');
  assert.ok(!('error' in planMission(terrain, slopes, start, stop, { priority: 'balanced', slopeLimit: 12 })));
  slopes[from + 1] = 13;
  assert.equal(planMission(terrain, slopes, start, stop, { priority: 'balanced', slopeLimit: 12 }).error, 'invalid_cell');
});

test('route recommendations follow the priority and exclude options below the current reserve', () => {
  const start = cellAt(gale, localPoint(gale, gale.positions.base));
  const stop = cellAt(gale, localPoint(gale, gale.positions.science));
  const { options } = missionRoutes(gale, slopeGrid(gale), start, stop);
  const compare = (delay, priority) => compareRoutes(options, 15, delay, DEFAULT_RESERVE_SETTINGS, priority);
  assert.equal(compare(0, 'balanced').recommended.route.code, 'A');
  assert.equal(compare(0, 'gentler').recommended.route.code, 'C');
  assert.equal(compare(16, 'gentler').recommended.route.code, 'A');
  assert.equal(compare(40, 'balanced').recommended, undefined);
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

test('EVA clock pauses movement and resources, then carries time through a science stop and planned return', () => {
  const terrain = flatTerrain();
  const base = fixed(2, 2);
  const goal = fixed(2, 5);
  const route = planMission(terrain, slopeGrid(terrain), base, goal);
  const settings = { ...DEFAULT_RESERVE_SETTINGS };
  const started = startEva(terrain, route, 15 + 4, settings);
  const walking = advanceEva(started, 0.5);
  assert.equal(walking.phase, 'outbound');
  assert.ok(walking.distanceM > 0);
  const paused = { ...walking, paused: true };
  assert.equal(advanceEva(paused, 3), paused);
  assert.deepEqual(evaTelemetry(paused, null).current, evaTelemetry(walking, null).current);
  const fieldwork = advanceEva({ ...paused, paused: false }, 2);
  assert.equal(fieldwork.phase, 'stop');
  assert.deepEqual(evaLocation(fieldwork).point, cellCenter(terrain, goal));
  assert.ok(Math.abs(fieldwork.stopRemaining - 17.4) < 1e-8);
  const arrived = advanceEva(fieldwork, 30);
  assert.equal(arrived.outcome, 'arrived');
  assert.ok(Math.abs(arrived.elapsed - 20.8) < 1e-8);
  assert.deepEqual(evaLocation(arrived).point, cellCenter(terrain, base));
  assert.equal(evaTelemetry(arrived, null).remainingM, 0);
  assert.equal(evaTelemetry(arrived, null).current.resources[1].remaining, estimateReserve(60, 15, 4).resources[1].remaining);
  const restarted = startEva(terrain, route, 19, settings);
  assert.equal(restarted.elapsed, 0);
  assert.deepEqual(evaLocation(restarted).point, cellCenter(terrain, base));
});

test('Gale Route B diverges from its planned reserve after a Station 1 delay and returns from between cells', () => {
  const base = cellAt(gale, localPoint(gale, gale.positions.base));
  const goal = cellAt(gale, localPoint(gale, gale.positions.science));
  const slopes = slopeGrid(gale);
  const route = missionRoutes(gale, slopes, base, goal).options.find(({ code }) => code === 'B');
  const station = cellAt(gale, stations[0].point);
  const index = route.out.path.findIndex(({ row, col }) => row === station.row && col === station.col);
  const betweenCells = (route.out.profile[index - 1].distanceM + route.out.profile[index].distanceM) / 2;
  const planReturn = createReturnPlanner(gale, slopes, base, 18);
  const walking = advanceEva(startEva(gale, route, 15, DEFAULT_RESERVE_SETTINGS), walkMinutes(betweenCells));
  const position = evaLocation(walking);
  assert.equal(position.endpoints.length, 2);
  const delayed = delayEva(walking);
  assert.equal(delayed.elapsed, walking.elapsed + 40);
  assert.equal(delayed.paused, true);
  assert.deepEqual(evaLocation(delayed), position);
  const candidates = position.endpoints.map(({ vertex, offsetM }) => offsetM +
    planMission(gale, slopes, vertex.cell, base, { priority: 'shortest', slopeLimit: 18 }).out.distanceM);
  const option = planReturn(position);
  assert.ok(Math.abs(option.distanceM - Math.min(...candidates)) < 1e-8);
  const telemetry = evaTelemetry(delayed, option);
  assert.ok(Math.abs(telemetry.continuePlan.margin - -19.34) < 1);
  assert.ok(Math.abs(telemetry.returnNow.margin - 18.39) < 1);
  const returning = returnEva(delayed, planReturn);
  assert.equal(returning.phase, 'inbound');
  assert.equal(returning.paused, false);
  assert.equal(returning.stopRemaining, 0);
  assert.deepEqual(evaLocation(returning).point, position.point);
  assert.equal(activeEvaPath(returning).distanceM, option.distanceM);
  const arrived = advanceEva(returning, 30);
  assert.equal(arrived.outcome, 'arrived');
  assert.deepEqual(evaLocation(arrived).point, cellCenter(gale, base));
  assert.ok(Math.abs(evaTelemetry(arrived, null).current.margin - telemetry.returnNow.margin) < 1e-8);
});

test('EVA shows an unavailable return without changing course and can finish a zero-distance return at base', () => {
  const terrain = flatTerrain();
  const slopes = slopeGrid(terrain);
  const base = fixed(2, 2);
  const route = planMission(terrain, slopes, base, fixed(2, 5));
  const started = startEva(terrain, route, 15, DEFAULT_RESERVE_SETTINGS);
  const planReturn = createReturnPlanner(terrain, slopes, base, 18);
  assert.equal(returnEva(started, planReturn).outcome, 'arrived');
  const walking = advanceEva(started, 0.45);
  const blocked = createReturnPlanner(terrain, slopes.map(() => null), base, 18);
  assert.deepEqual(returnEva(walking, blocked), { ...walking, returnError: true });
  assert.equal(evaTelemetry(walking, blocked(evaLocation(walking))).returnNow, null);
});

test('EVA stops at first depletion while walking or adding a delay, and permits arrival at the same instant', () => {
  const terrain = flatTerrain();
  const route = planMission(terrain, slopeGrid(terrain), fixed(2, 2), fixed(2, 5));
  const settings = { ...DEFAULT_RESERVE_SETTINGS, battery: 0.2 };
  const started = startEva(terrain, route, 0, settings);
  const walking = advanceEva(started, 2);
  assert.equal(walking.outcome, 'depleted');
  assert.equal(walking.elapsed, 0.5);
  assert.ok(walking.distanceM < route.out.distanceM);
  const delayed = delayEva(started);
  assert.equal(delayed.outcome, 'depleted');
  assert.equal(delayed.elapsed, 0.5);
  assert.deepEqual(evaLocation(delayed).point, evaLocation(started).point);
  const exact = startEva(terrain, route, 0, { ...settings, battery: walkMinutes(60) * 0.4 });
  assert.equal(advanceEva(exact, 2).outcome, 'arrived');
});

test('SPE terrain screening finds cover below a ridge and rejects flat or incomplete horizons', () => {
  const terrain = flatTerrain(41, 41);
  assert.deepEqual(findShelterCandidates(terrain, slopeGrid(terrain), 18), []);
  for (let row = 0; row < terrain.height; row++) {
    terrain.elevationM[row * terrain.width + 25] += 22;
  }
  const ridge = findShelterCandidates(terrain, slopeGrid(terrain), 18);
  const candidate = ridge.find(({ cell }) => cell.row === 20 && cell.col === 20);
  assert.ok(candidate && candidate.cover >= MIN_SKY_COVER);
  terrain.elevationM[20 * terrain.width + 25] = null;
  assert.ok(!findShelterCandidates(terrain, slopeGrid(terrain), 18)
    .some(({ cell }) => cell.row === 20 && cell.col === 20));
});

test('SPE drill uses real Gale routes and supports diversion and return without a position jump', () => {
  const base = cellAt(gale, localPoint(gale, gale.positions.base));
  const goal = cellAt(gale, localPoint(gale, gale.positions.science));
  const slopes = slopeGrid(gale);
  const route = missionRoutes(gale, slopes, base, goal).options.find(({ code }) => code === 'B');
  const sites = findShelterCandidates(gale, slopes, 18);
  const initial = startEva(gale, route, 15, DEFAULT_RESERVE_SETTINGS);
  assert.deepEqual(shelterOptions(gale, slopes, 18, sites, initial), []);
  const walking = advanceEva(initial, 5.81);
  const [option] = shelterOptions(gale, slopes, 18, sites, walking);
  assert.ok(option && option.eta < 3 && option.resourcesLast);
  assert.ok(option.candidate.cover >= MIN_SKY_COVER && option.candidate.cover < 5);
  const diverted = divertEva(walking, { label: '1', path: option.path });
  assert.equal(diverted.phase, 'shelter');
  assert.deepEqual(evaLocation(diverted), evaLocation(walking));
  const planReturn = createReturnPlanner(gale, slopes, base, 18);
  const prefix = walkMinutes(option.path.vertices[1].distanceM);
  const midEdge = advanceEva(diverted, prefix / 2);
  assert.equal(evaLocation(midEdge).endpoints.filter(({ vertex }) => vertex.cell).length, 2);
  const back = returnEva(midEdge, planReturn);
  assert.deepEqual(evaLocation(back).point, evaLocation(midEdge).point);
  assert.equal(advanceEva(back, 50).outcome, 'arrived');
  const sheltered = advanceEva(diverted, option.eta + 2);
  assert.equal(sheltered.outcome, 'sheltered');
  assert.deepEqual(evaLocation(sheltered).point, option.candidate.point);
  assert.equal(advanceEva(returnEva(sheltered, planReturn), 50).outcome, 'arrived');
  const nearlyDepleted = { ...walking, elapsed: walking.plan.depletionMinutes - 0.1 };
  assert.ok(shelterOptions(gale, slopes, 18, sites, nearlyDepleted).every(({ resourcesLast }) => !resourcesLast));
  assert.equal(divertEva(nearlyDepleted, { label: '1', path: option.path }), nearlyDepleted);
});
