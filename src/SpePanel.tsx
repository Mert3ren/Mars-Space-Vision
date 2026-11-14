import { ArrowDownLeft, Radio, Shield, X } from 'lucide-react';
import { MIN_SKY_COVER, SPE_TARGETS } from './shelters';
import type { ShelterOption } from './shelters';
import { estimateReserve, RESERVE_EPSILON } from './mission';

export type SpeTarget = (typeof SPE_TARGETS)[number];
type Projection = ReturnType<typeof estimateReserve>;

function arrivalDetails(estimate: Projection) {
  if (estimate.missionMinutes > estimate.depletion.depletionMinutes + RESERVE_EPSILON) {
    return `${estimate.depletion.name} runs out before arrival`;
  }
  return estimate.resources.map(({ name, remaining }) =>
    `${name === 'Oxygen' ? 'O₂' : name} ${Math.max(0, remaining).toFixed(1)}%`).join(' · ');
}

function arrivalTime(minutes: number) {
  const seconds = Math.max(0, Math.ceil((minutes - RESERVE_EPSILON) * 60));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SpePanel({ cellM, target, options, selected, base, urgent, onTarget, onSelect, onDivert, onReturn, onClose }: {
  cellM: number;
  target: SpeTarget;
  options: ShelterOption[];
  selected: number;
  base: { distanceM: number; arrival: Projection } | null;
  urgent: boolean;
  onTarget: (target: SpeTarget) => void;
  onSelect: (index: number) => void;
  onDivert: () => void;
  onReturn: () => void;
  onClose: () => void;
}) {
  const withinTarget = options.some((option) => option.resourcesLast && option.eta <= target + RESERVE_EPSILON);
  const active = options[selected];
  const belowBaseReserve = Boolean(base && base.arrival.margin < -RESERVE_EPSILON);
  return <section className="spe-panel panel" aria-labelledby="spe-title">
    <div className="panel-title">
      <div className="section-heading"><Radio size={16} /><h2 id="spe-title">Solar particle event drill</h2></div>
      <span className="simulation-chip">Simulated</span>
      <button className="icon-button" aria-label="Close SPE drill" onClick={onClose}><X size={16} /></button>
    </div>
    <div className="spe-content">
      <div className="spe-target">
        <span>Target arrival</span>
        <div className="leg-switch" role="group" aria-label="Drill target">
          {SPE_TARGETS.map((minutes) => <button key={minutes} aria-pressed={target === minutes}
            onClick={() => onTarget(minutes)}>{minutes} min</button>)}
        </div>
      </div>
      {!withinTarget && <p className="spe-empty" role="status">No reachable candidate meets the {target}-minute drill target.</p>}
      {options.length > 0 && <div className="spe-options" role="group" aria-label="Natural cover candidates">
        {options.map((option, index) => <button className="spe-option" key={`${option.candidate.cell.row}:${option.candidate.cell.col}`}
          aria-pressed={selected === index} onClick={() => onSelect(index)}>
          <b><Shield size={13} /> Candidate {index + 1}</b>
          <strong>{arrivalTime(option.eta)}</strong>
          <span>{Math.round(option.path.distanceM)} m · {option.candidate.cover.toFixed(1)}% sky blocked · {option.candidate.slope.toFixed(1)}° at site</span>
          <small>{option.eta > target + RESERVE_EPSILON && 'Outside target · '}{arrivalDetails(option.arrival)}</small>
        </button>)}
      </div>}
      {active?.resourcesLast && <button className="button spe-trigger" onClick={onDivert}><Shield size={15} /> Walk to candidate {selected + 1}</button>}
      <div className="spe-base">
        <div><b>Base camp</b>
          {base ? <><span>{arrivalTime(base.arrival.travelMinutes)} · {Math.round(base.distanceM)} m{base.arrival.travelMinutes > target + RESERVE_EPSILON ? ' · Outside target' : ''}</span>
            <small>{arrivalDetails(base.arrival)}</small>
            {belowBaseReserve && <b className="reserve-warning">Below reserve</b>}</> : <small>No path under the selected slope limit</small>}
        </div>
        {base && <div className="spe-base-actions">
          <button className="button" aria-pressed={selected === -1 || options.length === 0} onClick={() => onSelect(-1)}>Preview base route</button>
          <button className="button eva-return-button" data-urgent={urgent || belowBaseReserve} onClick={onReturn}><ArrowDownLeft size={14} /> Return to Base</button>
        </div>}
      </div>
      <p className="spe-method">Terrain geometry only · {cellM} m elevation grid · {MIN_SKY_COVER}% minimum sky obstruction for this drill. Radiation dose and protection unverified.</p>
    </div>
  </section>;
}
