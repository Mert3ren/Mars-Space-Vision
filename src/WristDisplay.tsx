import { useEffect, useRef, useState } from 'react';
import { BatteryCharging, Check, Droplets, Hammer, Info, Moon, Mountain, Navigation, OctagonAlert, Radiation, Radio, Sun, TriangleAlert, Watch } from 'lucide-react';
import type { EvaSession } from './eva';
import type { Environment, Telemetry } from './EvaPanel';
import { duration, marginLabel, percent } from './format';
import { RESERVE_EPSILON } from './mission';
import { freshAlerts, pruneAcknowledged, visibleAlerts } from './wristAlerts';
import type { WristAlert, WristAlertLevel } from './wristAlerts';

const alertIcons: Record<WristAlertLevel, typeof Info> = { critical: OctagonAlert, caution: TriangleAlert, info: Info };
const levelLabels: Record<WristAlertLevel, string> = { critical: 'Critical', caution: 'Caution', info: 'Info' };

/**
 * Tracks which alerts are new and which the astronaut acknowledged. Lives in the parent so the
 * state survives when the display moves between the simulation and SPE columns.
 */
export function useWristAlerts(alerts: WristAlert[] | null, onFresh: (alerts: WristAlert[]) => void) {
  const seen = useRef<ReadonlySet<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const key = alerts ? alerts.map(({ id }) => id).join('|') : null;
  useEffect(() => {
    if (!alerts) {
      seen.current = new Set();
      setAcknowledged((current) => current.size ? new Set() : current);
      return;
    }
    const fresh = freshAlerts(seen.current, alerts);
    seen.current = new Set(alerts.map(({ id }) => id));
    setAcknowledged((current) => pruneAcknowledged(current, alerts));
    if (fresh.length) onFresh(fresh);
  }, [key]);
  return {
    visible: alerts ? visibleAlerts(alerts, acknowledged) : [],
    hidden: alerts ? alerts.length - visibleAlerts(alerts, acknowledged).length : 0,
    acknowledge: (id: string) => setAcknowledged((current) => new Set(current).add(id)),
  };
}

function AlertLine({ alert, onAcknowledge, banner = false }: { alert: WristAlert; onAcknowledge: (id: string) => void; banner?: boolean }) {
  const Icon = alertIcons[alert.level];
  return <div className={banner ? 'wrist-banner' : 'wrist-alert'} data-level={alert.level}
    role={alert.level === 'critical' ? 'alert' : 'status'}>
    <Icon size={banner ? 16 : 13} aria-hidden="true" />
    <span><b>{levelLabels[alert.level]}</b> {alert.message}</span>
    {alert.level !== 'critical' && <button type="button" onClick={() => onAcknowledge(alert.id)}
      aria-label={`Acknowledge: ${alert.message}`}><Check size={12} /> {banner ? 'Acknowledge' : 'OK'}</button>}
  </div>;
}

export function WristDisplay({ session, telemetry, environment, alerts, hidden, onAcknowledge }: {
  session: EvaSession;
  telemetry: Telemetry;
  environment: Environment;
  alerts: WristAlert[];
  hidden: number;
  onAcknowledge: (id: string) => void;
}) {
  const { phase, outcome, plan } = session;
  const followingPlan = phase === 'outbound' || phase === 'stop';
  const reserve = telemetry.continuePlan ?? telemetry.returnNow ?? (outcome === 'arrived' ? telemetry.current : null);
  const task = plan.name && followingPlan && !outcome ? plan.stops[session.stopIndex].task : null;
  const [top, ...rest] = alerts;
  const LightIcon = environment.light === 'Night' ? Moon : Sun;
  return <section className="panel wrist-display" aria-labelledby="wrist-title">
    <div className="wrist-case">
      <div className="wrist-head">
        <h2 id="wrist-title"><Watch size={14} /> Wrist display</h2>
        <span className="simulation-chip">Simulated</span>
      </div>
      <div className="wrist-screen">
        <div className="wrist-clock" aria-label="Elapsed time">
          <span>MET</span><strong>{duration(session.elapsed)}</strong>
        </div>
        {top ? <AlertLine alert={top} onAcknowledge={onAcknowledge} banner />
          : <div className="wrist-banner" data-level="nominal" role="status"><Check size={16} aria-hidden="true" />
            <span><b>Nominal</b> {hidden ? `${hidden} acknowledged` : 'No active alerts'}</span></div>}
        {rest.length > 0 && <div className="wrist-alerts">
          {rest.map((alert) => <AlertLine key={alert.id} alert={alert} onAcknowledge={onAcknowledge} />)}
        </div>}
        <dl className="wrist-gauges">
          {telemetry.current.resources.map(({ name, remaining }) => {
            const Icon = name === 'Oxygen' ? Droplets : BatteryCharging;
            return <div key={name} data-low={remaining < plan.settings.minimum}>
              <dt><Icon size={12} />{name === 'Oxygen' ? 'O₂' : 'BATT'}</dt>
              <dd>{percent(remaining)}</dd>
              <span aria-hidden="true"><i style={{ width: percent(Math.min(100, remaining)) }} /></span>
            </div>;
          })}
        </dl>
        <dl className="wrist-readouts">
          <div><dt>Reserve</dt><dd data-low={Boolean(reserve && reserve.margin < -RESERVE_EPSILON)}>{reserve ? marginLabel(reserve.margin) : '—'}</dd></div>
          <div><dt>{phase === 'shelter' ? 'Cover ETA' : 'Base ETA'}</dt><dd>{outcome === 'depleted' ? '—' : duration(telemetry.remainingMinutes, true)}</dd></div>
          <div><dt><Navigation size={11} /> Dist</dt><dd>{outcome === 'depleted' ? '—' : `${Math.round(telemetry.remainingM)} m`}</dd></div>
          <div><dt><Radio size={11} /> Radio</dt><dd data-low={environment.radio !== 'Connected'}>{environment.radio}</dd></div>
          <div><dt><LightIcon size={11} /> Light</dt><dd>{environment.light}</dd></div>
          <div><dt><Mountain size={11} /> Grade</dt><dd>{environment.longitudinal === undefined ? '—' : `${environment.longitudinal.toFixed(1)}°`}</dd></div>
          <div><dt><Radiation size={11} /> Dose</dt><dd>{environment.dose.toFixed(1)} µGy</dd></div>
          {task && <div className="wrist-task"><dt><Hammer size={11} /> {phase === 'stop' ? 'Task' : 'Next'}</dt>
            <dd>{task}{phase === 'stop' && <small> · {duration(session.stopRemaining, true)} left</small>}</dd></div>}
        </dl>
      </div>
    </div>
  </section>;
}
