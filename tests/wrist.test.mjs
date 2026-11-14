import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshAlerts, LOW_RESOURCE_BUFFER, pruneAcknowledged, RESERVE_CAUTION_MINUTES, STEEP_MARGIN_DEG, visibleAlerts, wristAlerts } from '../src/wristAlerts.ts';

const nominal = () => ({
  outcome: null,
  resources: [{ name: 'Oxygen', remaining: 45 }, { name: 'Battery', remaining: 44 }],
  minimum: 20,
  continueMargin: 27,
  returnMargin: 35,
  speActive: false,
  radio: 'Connected',
  light: 'Sunlit',
  grade: 2,
  cross: 1,
  slopeLimit: 18,
  stopRemaining: null,
});
const ids = (input) => wristAlerts(input).map(({ id }) => id);
const only = (input, id) => wristAlerts(input).find((alert) => alert.id === id);

test('a nominal EVA raises no wrist alerts', () => {
  assert.deepEqual(wristAlerts(nominal()), []);
});

test('resources warn when low and turn critical below the reserve minimum', () => {
  const low = { ...nominal(), resources: [{ name: 'Oxygen', remaining: 45 }, { name: 'Battery', remaining: 20 + LOW_RESOURCE_BUFFER - 0.5 }] };
  assert.deepEqual(only(low, 'battery-low'), { id: 'battery-low', level: 'caution', message: 'Battery low' });
  const edge = { ...nominal(), resources: [{ name: 'Oxygen', remaining: 20 + LOW_RESOURCE_BUFFER }, { name: 'Battery', remaining: 44 }] };
  assert.deepEqual(ids(edge), []);
  const below = { ...nominal(), resources: [{ name: 'Oxygen', remaining: 19.5 }, { name: 'Battery', remaining: 44 }] };
  assert.deepEqual(only(below, 'oxygen-reserve'), { id: 'oxygen-reserve', level: 'critical', message: 'Oxygen below reserve' });
  assert.equal(only(below, 'oxygen-low'), undefined);
});

test('reserve margins escalate from caution to critical', () => {
  assert.equal(only({ ...nominal(), continueMargin: RESERVE_CAUTION_MINUTES - 1 }, 'reserve-margin').level, 'caution');
  assert.equal(only({ ...nominal(), continueMargin: RESERVE_CAUTION_MINUTES }, 'reserve-margin'), undefined);
  assert.deepEqual(ids({ ...nominal(), continueMargin: -13, returnMargin: 12 }), ['plan-reserve']);
  assert.deepEqual(ids({ ...nominal(), continueMargin: -13, returnMargin: -2 }), ['return-reserve']);
  // Inbound: no plan to continue, the return projection drives the caution.
  assert.deepEqual(ids({ ...nominal(), continueMargin: null, returnMargin: 3 }), ['reserve-margin']);
  assert.deepEqual(ids({ ...nominal(), continueMargin: null, returnMargin: null }), []);
});

test('SPE, radio, terrain, light and task rules trigger only in their conditions', () => {
  assert.equal(only({ ...nominal(), speActive: true }, 'spe').level, 'critical');
  assert.equal(only({ ...nominal(), radio: 'Out of range' }, 'radio-out-of-range').message, 'Radio link lost — out of range');
  assert.equal(only({ ...nominal(), radio: 'Terrain blocked' }, 'radio-terrain-blocked').message, 'Terrain blocking radio');
  assert.equal(only({ ...nominal(), radio: 'Data unavailable' }, 'radio-data-unavailable').level, 'caution');
  assert.equal(only({ ...nominal(), grade: -(18 - STEEP_MARGIN_DEG) }, 'steep').level, 'caution');
  assert.equal(only({ ...nominal(), grade: 2, cross: 16 }, 'steep').level, 'caution');
  assert.equal(only({ ...nominal(), grade: 18 - STEEP_MARGIN_DEG - 0.1 }, 'steep'), undefined);
  assert.equal(only({ ...nominal(), grade: undefined, cross: undefined }, 'steep'), undefined);
  assert.equal(only({ ...nominal(), light: 'In shadow' }, 'shadow').level, 'info');
  assert.equal(only({ ...nominal(), light: 'Night' }, 'night').level, 'info');
  assert.equal(only({ ...nominal(), stopRemaining: 0.5 }, 'task-finishing').level, 'info');
  assert.equal(only({ ...nominal(), stopRemaining: 1.5 }, 'task-finishing'), undefined);
  assert.equal(only({ ...nominal(), stopRemaining: 0 }, 'task-finishing'), undefined);
});

test('alerts are ordered critical, caution, info', () => {
  const alerts = wristAlerts({ ...nominal(), light: 'In shadow', radio: 'Out of range', speActive: true, continueMargin: 2 });
  assert.deepEqual(alerts.map(({ level }) => level), ['critical', 'caution', 'caution', 'info']);
  assert.equal(alerts[0].id, 'spe');
});

test('finished missions: arrival clears alerts, depletion names the empty resource', () => {
  assert.deepEqual(wristAlerts({ ...nominal(), outcome: 'arrived', speActive: true, continueMargin: -5 }), []);
  const depleted = wristAlerts({ ...nominal(), outcome: 'depleted', continueMargin: null, returnMargin: null,
    resources: [{ name: 'Oxygen', remaining: 4 }, { name: 'Battery', remaining: 0 }] });
  assert.deepEqual(depleted.map(({ id }) => id), ['oxygen-reserve', 'battery-depleted']);
});

test('critical alerts cannot be acknowledged; others hide until they clear', () => {
  const alerts = wristAlerts({ ...nominal(), speActive: true, radio: 'Out of range' });
  const acknowledged = new Set(['spe', 'radio-out-of-range']);
  assert.deepEqual(visibleAlerts(alerts, acknowledged).map(({ id }) => id), ['spe']);
  const cleared = wristAlerts({ ...nominal(), speActive: true });
  assert.deepEqual([...pruneAcknowledged(acknowledged, cleared)], ['spe']);
  const unchanged = new Set(['spe']);
  assert.equal(pruneAcknowledged(unchanged, cleared), unchanged);
});

test('only alerts that were not active before count as fresh', () => {
  const first = wristAlerts({ ...nominal(), radio: 'Out of range' });
  assert.deepEqual(freshAlerts(new Set(), first).map(({ id }) => id), ['radio-out-of-range']);
  const next = wristAlerts({ ...nominal(), radio: 'Out of range', light: 'In shadow' });
  assert.deepEqual(freshAlerts(new Set(first.map(({ id }) => id)), next).map(({ id }) => id), ['shadow']);
});
