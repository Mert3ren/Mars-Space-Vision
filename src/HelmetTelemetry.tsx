import { duration, evaPhaseLabel, marginLabel, percent } from './EvaPanel';
import type { EvaEnvironment, Telemetry } from './EvaPanel';
import type { EvaSession } from './eva';
import type { HelmetSurfaceData } from './helmetSurface';
import { RESERVE_EPSILON } from './mission';

type Props = {
  session: EvaSession;
  telemetry: Telemetry;
  environment: EvaEnvironment;
  reviewingSPE: boolean;
};

export function HelmetVitals({ session, telemetry, environment, reviewingSPE }: Props) {
  const { phase, outcome } = session;
  const { current, returnNow, continuePlan, remainingMinutes } = telemetry;
  const atBase = outcome === 'arrived';
  const depleted = outcome === 'depleted';
  const hasNoPath = (!outcome || outcome === 'sheltered') && !returnNow;
  const belowReturn = Boolean(returnNow && returnNow.margin < -RESERVE_EPSILON);
  const belowPlan = Boolean(continuePlan && continuePlan.margin < -RESERVE_EPSILON);
  const candidate = phase === 'shelter';
  const eta = depleted ? null : atBase ? 0 : candidate ? remainingMinutes : returnNow?.travelMinutes;
  const reserve = atBase ? current : returnNow;
  const warnings = [
    depleted ? `${current.depletion.name} depleted` : null,
    reviewingSPE ? 'SPE drill' : null,
    hasNoPath ? 'No path to base' : belowReturn ? 'Below return reserve' : belowPlan ? 'Plan below reserve' : null,
  ].filter(Boolean);

  return <div className="helmet-vitals" aria-label="Helmet vitals · simulated EVA">
    <dl className="helmet-vitals-resources">
      {current.resources.map(({ name, remaining }) => <div key={name} data-low={remaining < session.plan.settings.minimum}>
        <dt aria-label={name}>{name === 'Oxygen' ? 'O₂' : name}</dt><dd>{percent(remaining)}</dd>
      </div>)}
    </dl>
    <div className="helmet-vitals-bottom">
      {warnings.length > 0 && <div className="helmet-warnings" role="status">{warnings.join(' · ')}</div>}
      <dl className="helmet-vitals-nav">
        <div data-low={belowReturn || hasNoPath}>
          <dt>{atBase ? 'Base reserve' : 'Return now'}</dt><dd>{reserve ? marginLabel(reserve.margin) : '—'}</dd>
        </div>
        <div>
          <dt title={candidate ? 'Time to the selected terrain cover candidate' : 'Time to base if returning now'}>
            {candidate ? 'Candidate ETA' : 'Base ETA'}
          </dt><dd>{eta == null ? '—' : duration(eta, true)}</dd>
        </div>
        <div className="helmet-radio" data-low={environment.radio !== 'Connected'}>
          <dt>Radio</dt><dd>{environment.radio}</dd>
        </div>
      </dl>
    </div>
  </div>;
}

export function HelmetDetails({ session, telemetry, environment, reviewingSPE, surfaceData }: Props & {
  surfaceData: HelmetSurfaceData | null;
}) {
  const { phase, outcome, paused, elapsed, plan, stopIndex, stopRemaining } = session;
  return <section className="helmet-details" id="helmet-details" aria-label="Helmet telemetry details">
    <strong>{evaPhaseLabel(session, telemetry, reviewingSPE)}{paused && !outcome && !reviewingSPE && ' · Paused'}</strong>
    <dl>
      <div><dt>Elapsed</dt><dd>{duration(elapsed)}</dd></div>
      <div><dt>Distance left</dt><dd>{outcome === 'depleted' ? '—' : `${Math.round(telemetry.remainingM)} m`}</dd></div>
      {!outcome && (phase === 'outbound' || phase === 'stop') && <div className="helmet-detail-wide">
        <dt>{phase === 'stop' ? 'Current task' : 'Next task'}</dt>
        <dd>{plan.stops[stopIndex].task}{phase === 'stop' && ` · ${duration(stopRemaining, true)} left`}</dd>
      </div>}
      <div><dt>Grade / cross-slope</dt><dd>{environment.longitudinal === undefined || environment.cross === undefined
        ? '—' : `${environment.longitudinal.toFixed(1)}° / ${environment.cross.toFixed(1)}°`}</dd></div>
      <div><dt>Lighting</dt><dd>{environment.light}</dd></div>
      <div><dt>Continue reserve</dt><dd>{telemetry.continuePlan ? marginLabel(telemetry.continuePlan.margin) : '—'}</dd></div>
      <div><dt>RAD reference dose</dt><dd>{environment.dose.toFixed(2)} µGy</dd></div>
      {surfaceData && <div className="helmet-detail-wide">
        <dt>Camera terrain</dt>
        <dd>{surfaceData.elevationM} m elevation · {surfaceData.imageryM === null
          ? 'Optical imagery unavailable' : `${surfaceData.imageryM} m/px optical`}</dd>
        <dd>Simulated close-up texture</dd>
      </div>}
    </dl>
  </section>;
}
