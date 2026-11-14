import { Activity, ArrowDownLeft, BatteryCharging, Droplets, Flag, Pause, Play, Radio, RotateCcw, Timer, TriangleAlert } from 'lucide-react';
import { EVA_DELAY_MINUTES, EVA_SPEEDS } from './eva';
import type { EvaSession, EvaSpeed, evaTelemetry } from './eva';
import { RESERVE_EPSILON } from './mission';

type Telemetry = ReturnType<typeof evaTelemetry>;

function duration(minutes: number, roundUp = false) {
  const seconds = (roundUp ? Math.ceil : Math.floor)(minutes * 60 + (roundUp ? -1e-6 : 1e-6));
  return `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`;
}

function percent(value: number) {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function marginLabel(value: number) {
  const absolute = Math.abs(value);
  if (absolute < RESERVE_EPSILON) return '0 min';
  return `${value < 0 ? '−' : '+'}${absolute < 1 ? '<1' : Math.round(absolute)} min`;
}

export function EvaPanel({ session, telemetry, routeCode, reviewingSPE, onSPE, onTogglePause, onSpeed, onDelay, onReturn, onReset }: {
  session: EvaSession;
  telemetry: Telemetry;
  routeCode: string;
  reviewingSPE: boolean;
  onSPE: () => void;
  onTogglePause: () => void;
  onSpeed: (speed: EvaSpeed) => void;
  onDelay: () => void;
  onReturn: () => void;
  onReset: () => void;
}) {
  const { phase, paused, speed, outcome, elapsed, earlyReturn } = session;
  const headline = reviewingSPE ? 'SPE drill · Paused'
    : outcome === 'arrived' ? 'Returned to base'
    : outcome === 'depleted' ? `${telemetry.current.depletion.name} depleted`
    : outcome === 'sheltered' ? `Candidate ${session.shelter?.label} reached`
    : phase === 'shelter' ? `Walking to candidate ${session.shelter?.label}`
    : phase === 'inbound' ? earlyReturn ? 'Early return to base' : 'Returning to base'
    : phase === 'stop' ? 'Science stop' : 'Walking to science stop';
  const reserve = telemetry.continuePlan ?? telemetry.returnNow ?? (outcome === 'arrived' ? telemetry.current : null);
  const belowReserve = Boolean(reserve && reserve.margin < -RESERVE_EPSILON);
  const belowReturn = Boolean(telemetry.returnNow && telemetry.returnNow.margin < -RESERVE_EPSILON);
  const canReturn = (!outcome || outcome === 'sheltered') && phase !== 'inbound';
  const followingPlan = phase === 'outbound' || phase === 'stop';
  return <section className="eva-panel" aria-label="EVA telemetry">
    <div className="eva-heading">
      <div className="section-heading"><Activity size={16} /><h3>EVA telemetry</h3></div>
      <span className="simulation-chip">Route {routeCode} · Simulated</span>
      <strong className="eva-phase" role="status" data-state={outcome ?? (paused || reviewingSPE ? 'paused' : 'running')}>
        {headline}{!outcome && paused && !reviewingSPE && ' · Paused'}
      </strong>
      {(belowReserve || belowReturn) && <span className="reserve-warning reserve-warning--badge" role="status">
        <TriangleAlert size={13} /> Below reserve
      </span>}
    </div>
    <dl className="eva-stats">
      <div><dt>Elapsed</dt><dd>{duration(elapsed)} <small>m:s</small></dd></div>
      <div><dt>Distance left</dt><dd>{outcome === 'depleted' ? '—' : `${Math.round(telemetry.remainingM)} m`}</dd></div>
      <div><dt>{phase === 'shelter' ? 'Candidate ETA' : 'Base ETA'}</dt><dd>{outcome === 'depleted' ? '—' : <>{duration(telemetry.remainingMinutes, true)} <small>m:s</small></>}</dd></div>
      {telemetry.current.resources.map((resource) => {
        const Icon = resource.name === 'Oxygen' ? Droplets : BatteryCharging;
        return <div key={resource.name}>
          <dt><Icon size={12} />{resource.name}</dt>
          <dd data-low={resource.remaining < session.plan.settings.minimum}>{percent(resource.remaining)}</dd>
        </div>;
      })}
      <div className="eva-reserve-readout">
        <dt>{followingPlan && !outcome ? 'Continue reserve' : 'Base reserve'}</dt>
        <dd data-low={belowReserve}>{reserve ? marginLabel(reserve.margin) : '—'}</dd>
      </div>
      {canReturn && followingPlan && <div className="eva-reserve-readout">
        <dt>Return now</dt>
        <dd data-low={belowReturn}>
          {telemetry.returnNow ? marginLabel(telemetry.returnNow.margin) : 'No path'}
        </dd>
      </div>}
    </dl>
    <div className="eva-controls">
      {!outcome && !reviewingSPE && <>
        <button className="button" onClick={onTogglePause}>
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
        </button>
        <div className="leg-switch" role="group" aria-label="EVA playback speed">
          {EVA_SPEEDS.map((rate) => <button key={rate} aria-pressed={rate === speed} onClick={() => onSpeed(rate)}>{rate}×</button>)}
        </div>
        {followingPlan && <button className="button" onClick={onDelay}><Timer size={14} /> Add {EVA_DELAY_MINUTES} min delay</button>}
        {phase !== 'shelter' && <button className="button spe-trigger" onClick={onSPE}><Radio size={14} /> Simulate SPE</button>}
      </>}
      {canReturn && !reviewingSPE &&
        <button className="button eva-return-button" data-urgent={belowReserve || belowReturn} onClick={onReturn}><ArrowDownLeft size={15} /> Return to Base</button>}
      <button className="button button--ghost eva-reset" onClick={onReset}><RotateCcw size={14} /> Reset EVA</button>
    </div>
    {session.returnError && !outcome && <p className="eva-route-error" role="alert">No path to base under the selected slope limit. The current mission stays active.</p>}
  </section>;
}

export function EvaReserve({ session, telemetry }: {
  session: EvaSession; telemetry: Telemetry;
}) {
  const { current, continuePlan, returnNow } = telemetry;
  const { outcome, phase, plan } = session;
  const estimates = outcome === 'depleted' ? [] : outcome === 'arrived'
    ? [{ label: 'Arrived at base', estimate: current }]
    : phase === 'inbound' ? [{ label: 'Projected at base', estimate: returnNow }]
    : phase === 'shelter' ? [{ label: 'Return to base from current position', estimate: returnNow }]
    : [{ label: 'Continue mission', estimate: continuePlan }, { label: 'Return now', estimate: returnNow }];
  return <section id="reserve-panel" className="panel reserve-panel eva-reserve"
    aria-labelledby="eva-reserve-title">
    <div className="panel-title">
      <div className="section-heading"><Flag size={16} /><h2 id="eva-reserve-title">Return reserve</h2></div>
      <span className="simulation-chip">{plan.settings.minimum}% minimum</span>
    </div>
    {outcome === 'depleted'
      ? <p className="eva-reserve-empty">{current.depletion.name} reached 0% before arrival.</p>
      : <div className="eva-projections">
        {estimates.map(({ label, estimate }) => {
          const below = estimate ? estimate.margin < -RESERVE_EPSILON : false;
          const depletes = estimate ? estimate.missionMinutes > estimate.depletion.depletionMinutes + RESERVE_EPSILON : false;
          return <article key={label} data-below={below}>
            <h3>{label}</h3>
            {estimate ? <>
              <strong>{marginLabel(estimate.margin)}</strong>
              {below && <b className="reserve-warning">Below reserve</b>}
              <span>{depletes ? `${estimate.depletion.name} runs out` : `O₂ ${percent(estimate.resources[0].remaining)} · Battery ${percent(estimate.resources[1].remaining)}`}</span>
            </> : <span>No path to base</span>}
          </article>;
        })}
      </div>}
  </section>;
}
