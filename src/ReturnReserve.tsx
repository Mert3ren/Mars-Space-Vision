import { useState } from 'react';
import { ArrowRight, BatteryCharging, ChevronDown, Clock3, Droplets, RotateCcw, Shield, TriangleAlert } from 'lucide-react';
import {
  estimateReserve, MAX_SCENARIO_MINUTES, RESERVE_EPSILON, RESOURCE_RATES, WALK_KPH, walkMinutes,
} from './mission';
import type { ReserveSettings } from './mission';
import type { RouteOption } from './galeRoutes';

type ReserveResult = ReturnType<typeof estimateReserve>;
type Props = {
  route?: RouteOption;
  estimate: ReserveResult | null;
  stopMinutes: number;
  delay: number;
  settings: ReserveSettings;
  onStopChange: (minutes: number) => void;
  onDelayChange: (minutes: number) => void;
  onSettingsChange: (settings: ReserveSettings) => void;
};

function NumberField({ label, value, max, unit, onChange }: {
  label: string; value: number; max: number; unit: string; onChange: (value: number) => void;
}) {
  return (
    <label className="reserve-input">
      <span>{label}</span>
      <span className="duration-input">
        <input type="number" min={0} max={max} step={1} value={value}
          onChange={(event) => onChange(Math.min(max, Math.max(0, Math.trunc(Number(event.target.value) || 0))))} />
        <span aria-hidden="true">{unit}</span>
      </span>
    </label>
  );
}

function marginText(value: number) {
  if (Math.abs(value) <= RESERVE_EPSILON) return '0';
  if (Math.abs(value) < 1) return value < 0 ? '−<1' : '+<1';
  return `${value < 0 ? '−' : '+'}${Math.round(Math.abs(value))}`;
}

function percent(value: number) {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function ReserveTimeline({ route, estimate, stopMinutes, delay }: {
  route: RouteOption; estimate: ReserveResult; stopMinutes: number; delay: number;
}) {
  const outbound = walkMinutes(route.out.distanceM);
  const inbound = walkMinutes(route.back.distanceM);
  const stages = [
    { id: 'outbound', name: 'Outbound', minutes: outbound },
    { id: 'fieldwork', name: 'Stop', minutes: stopMinutes },
    { id: 'delay', name: 'Delay', minutes: delay },
    { id: 'inbound', name: 'Return', minutes: inbound },
  ].filter(({ minutes }) => minutes > 0);
  const scale = Math.max(estimate.availableMinutes, estimate.missionMinutes, 1);
  const threshold = Math.max(0, Math.min(100, estimate.availableMinutes / scale * 100));
  return (
    <div className="reserve-timeline">
      <div className="reserve-section-label"><span>Mission time</span><b>{Math.round(estimate.missionMinutes)} min</b></div>
      <div className="reserve-timeline-track" aria-hidden="true">
        {stages.map(({ id, minutes }) => <span key={id} data-phase={id} style={{ width: `${minutes / scale * 100}%` }} />)}
        <i style={{ left: `${threshold}%` }} />
      </div>
      <div className="reserve-timeline-legend">
        {stages.map(({ id, name, minutes }) => <span key={id} data-phase={id}>{name} <b>{Math.round(minutes)}m</b></span>)}
        <span data-phase="limit">Reserve limit <b>{Math.max(0, Math.floor(estimate.availableMinutes + RESERVE_EPSILON))}m</b></span>
      </div>
    </div>
  );
}

function ReserveResources({ resources, minimum }: {
  resources: ReserveResult['resources']; minimum: number;
}) {
  return (
    <div className="reserve-resources">
      <div className="reserve-section-label"><span>Projected at base</span><b>{minimum}% minimum</b></div>
      {resources.map((resource) => {
        const Icon = resource.name === 'Oxygen' ? Droplets : BatteryCharging;
        const below = resource.margin < -RESERVE_EPSILON;
        const remaining = Math.max(0, resource.remaining);
        return (
          <div key={resource.name} className="reserve-resource" data-below={below}>
            <div className="reserve-resource-title">
              <Icon size={14} /><span>{resource.name}</span><small>{resource.start}% start</small><b>{percent(remaining)}</b>
            </div>
            <div className="reserve-meter" role="meter" aria-label={`${resource.name} at base`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}
              aria-valuetext={`${percent(remaining)}, ${below ? 'below' : 'at or above'} the ${minimum}% reserve`}>
              <span className="reserve-meter-start" style={{ width: `${resource.start}%` }} />
              <span className="reserve-meter-remaining" style={{ width: `${remaining}%` }} />
              <i style={{ left: `${minimum}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ReturnReserve({
  route, estimate, stopMinutes, delay, settings, onStopChange, onDelayChange, onSettingsChange,
}: Props) {
  const [showModel, setShowModel] = useState(false);
  const margin = estimate?.margin ?? 0;
  const below = margin < -RESERVE_EPSILON;
  const depleted = estimate ? estimate.missionMinutes > 0 &&
    estimate.missionMinutes >= estimate.depletion.depletionMinutes - RESERVE_EPSILON : false;
  const atLimit = Math.abs(margin) <= RESERVE_EPSILON;
  const status = depleted ? 'Resource runs out' : below ? 'Below reserve' : atLimit ? 'At reserve limit' : 'Within reserve';
  const state = below ? 'alert' : atLimit ? 'limit' : 'ok';
  const StatusIcon = below ? TriangleAlert : Shield;
  const maxStop = estimate?.maxFieldworkMinutes ?? null;
  const extra = Math.max(0, Math.floor(margin + RESERVE_EPSILON));
  const canRemoveDelay = delay > 0 && estimate && delay + margin >= -RESERVE_EPSILON;

  return (
    <section id="reserve-panel" className="panel reserve-panel" data-state={estimate ? state : undefined} aria-labelledby="reserve-title">
      <div className="panel-title">
        <div className="section-heading"><BatteryCharging size={18} /><h2 id="reserve-title">Return reserve</h2></div>
        <span className="simulation-chip">Simulated</span>
      </div>
      {estimate && route ? <div className="reserve-content">
        <div className="reserve-route"><b>ROUTE {route.code}</b><span>{route.name}</span></div>
        <div className="reserve-summary" role="status" aria-live="polite">
          <span className="reserve-status"><StatusIcon size={13} />{status}</span>
          <div className="reserve-margin"><strong>{marginText(margin)}</strong><span>min margin</span></div>
          <p>{depleted
            ? `${estimate.depletion.name} reaches 0% around minute ${Math.round(estimate.depletion.depletionMinutes)}.`
            : `${estimate.limiting.name} sets the ${settings.minimum}% return limit.`}</p>
        </div>
        <ReserveTimeline route={route} estimate={estimate} stopMinutes={stopMinutes} delay={delay} />
        <ReserveResources resources={estimate.resources} minimum={settings.minimum} />
        <div className="reserve-scenario">
          <div className="reserve-section-label"><span><Clock3 size={13} /> What if?</span></div>
          <NumberField label="Science stop" value={stopMinutes} max={MAX_SCENARIO_MINUTES} unit="min" onChange={onStopChange} />
          <NumberField label="Unexpected delay" value={delay} max={MAX_SCENARIO_MINUTES} unit="min" onChange={onDelayChange} />
          <button className={`button delay-button${delay === 40 ? ' delay-button--active' : ''}`}
            onClick={() => onDelayChange(delay === 40 ? 0 : 40)}>
            {delay === 40 ? <RotateCcw size={13} /> : <Clock3 size={13} />}
            {delay === 40 ? 'Remove 40 min delay' : 'Simulate 40 min delay'} <ArrowRight size={14} />
          </button>
        </div>
        <div className="reserve-advice">
          {maxStop === null ? <p>{canRemoveDelay
            ? 'Remove the delay to recover this plan.'
            : 'Even with no science stop, the modeled plan is below reserve.'}</p>
            : below ? <p>Reduce the science stop by <b>{stopMinutes - maxStop} min</b> to reach the modeled reserve.</p>
            : extra > 0 ? <p>Up to <b>{extra} extra min</b> of fieldwork at this pace.</p>
              : <p>Less than one extra minute of fieldwork remains at this pace.</p>}
          {below && maxStop !== null && <button className="button reserve-recovery"
            onClick={() => onStopChange(maxStop)}>Set stop to {maxStop} min <ArrowRight size={13} /></button>}
          {below && maxStop === null && canRemoveDelay && delay !== 40 && <button className="button reserve-recovery"
            onClick={() => onDelayChange(0)}>Clear delay <ArrowRight size={13} /></button>}
        </div>
      </div> : <p className="reserve-empty">A reachable route is needed to estimate resources.</p>}
      <button className="model-toggle" onClick={() => setShowModel(!showModel)} aria-expanded={showModel}>
        Model settings <ChevronDown size={14} className={showModel ? 'turned' : ''} />
      </button>
      {showModel && <div className="reserve-settings">
        <NumberField label="Starting oxygen" value={settings.oxygen} max={100} unit="%"
          onChange={(oxygen) => onSettingsChange({ ...settings, oxygen })} />
        <NumberField label="Starting battery" value={settings.battery} max={100} unit="%"
          onChange={(battery) => onSettingsChange({ ...settings, battery })} />
        <NumberField label="Minimum at return" value={settings.minimum} max={100} unit="%"
          onChange={(minimum) => onSettingsChange({ ...settings, minimum })} />
        <p>Example pace {WALK_KPH} km/h. Oxygen drops {RESOURCE_RATES.oxygen} and battery {RESOURCE_RATES.battery} percentage points per hour, including stops and delays.</p>
      </div>}
    </section>
  );
}
