import { ArrowDown, ArrowUp, Flag, Play, Plus, Target, Trash2, TriangleAlert } from 'lucide-react';
import { emptyStop, MAX_MISSION_STOPS } from './missionDraft';
import type { DraftStop, MissionDraft, MissionPreview } from './missionDraft';
import { cellCenter, displayPosition, MAX_SCENARIO_MINUTES, MAX_SLOPE, RESERVE_EPSILON } from './mission';
import type { Cell, RoutePriority, RoutingSettings, Terrain } from './mission';

export type MissionPick = 'base' | number;

const errors = {
  pick: 'Choose a point on the map.',
  outside_area: 'This point is outside the traverse area.',
  invalid_cell: 'The endpoint has missing terrain or exceeds the slope limit.',
  same_cell: 'This leg needs a destination in a different terrain cell.',
  no_path: 'No path under the selected slope limit.',
};

function formatMinutes(minutes: number) {
  return `${minutes.toFixed(1)} min`;
}

export function MissionBuilder({ draft, terrain, base, preview, routing, pick, loading, failed, returnReady, onDraft, onRouting, onPick, onSimulate }: {
  draft: MissionDraft;
  terrain: Terrain;
  base: Cell;
  preview: MissionPreview;
  routing: RoutingSettings;
  pick: MissionPick | null;
  loading: boolean;
  failed: boolean;
  returnReady: boolean;
  onDraft: (draft: MissionDraft) => void;
  onRouting: (routing: RoutingSettings) => void;
  onPick: (pick: MissionPick) => void;
  onSimulate: () => void;
}) {
  const valid = Boolean(draft.name.trim() && draft.stops.every((stop) => stop.task.trim()) && preview.reserve &&
    !loading && !failed && returnReady);
  const update = (index: number, stop: DraftStop) => onDraft({ ...draft,
    stops: draft.stops.map((current, i) => i === index ? stop : current) });
  function move(index: number, offset: number) {
    const stops = [...draft.stops];
    [stops[index], stops[index + offset]] = [stops[index + offset], stops[index]];
    onDraft({ ...draft, stops });
  }
  const reserve = preview.reserve;
  const below = Boolean(reserve && reserve.margin < -RESERVE_EPSILON);
  return <section className="panel mission-editor" aria-labelledby="mission-editor-title">
    <div className="panel-title"><div className="section-heading"><Flag size={16} /><h2 id="mission-editor-title">Create Mission</h2></div></div>
    <div className="mission-editor-content">
      <label className="mission-field">Mission name<input maxLength={60} value={draft.name} placeholder="Gale fieldwork"
        onChange={(event) => onDraft({ ...draft, name: event.target.value })} /></label>
      <div className="mission-editor-base">
        <div><strong>Base camp</strong><small>{displayPosition(terrain, cellCenter(terrain, base))}</small></div>
        <button className="button" aria-pressed={pick === 'base'} onClick={() => onPick('base')}><Target size={14} /> Pick base</button>
      </div>
      <div className="mission-editor-filters">
        <label className="mission-field">Route priority<select value={routing.priority}
          onChange={(event) => onRouting({ ...routing, priority: event.target.value as RoutePriority })}>
          <option value="balanced">Balanced</option><option value="shortest">Shortest</option><option value="gentler">Gentler</option>
        </select></label>
        <label className="mission-field">Max terrain slope<select value={routing.slopeLimit}
          onChange={(event) => onRouting({ ...routing, slopeLimit: Number(event.target.value) })}>
          {[8, 12, MAX_SLOPE].map((limit) => <option key={limit} value={limit}>{limit}°</option>)}
        </select></label>
      </div>
      {draft.stops.map((stop, index) => <fieldset key={index} className="mission-editor-stop">
        <legend>Stop {index + 1}</legend>
        <div className="mission-editor-stop-actions">
          <button className="button" aria-pressed={pick === index} onClick={() => onPick(index)}>
            <Target size={14} /> {stop.cell ? 'Change point' : 'Pick on map'}
          </button>
          <button className="icon-button" aria-label={`Move stop ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
          <button className="icon-button" aria-label={`Move stop ${index + 1} down`} disabled={index === draft.stops.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
          <button className="icon-button" aria-label={`Remove stop ${index + 1}`} disabled={draft.stops.length === 1}
            onClick={() => onDraft({ ...draft, stops: draft.stops.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>
        </div>
        {stop.cell && <small>{displayPosition(terrain, cellCenter(terrain, stop.cell))}</small>}
        <div className="mission-editor-filters">
          <label className="mission-field">Task<input value={stop.task} maxLength={80} placeholder="Inspect outcrop"
            onChange={(event) => update(index, { ...stop, task: event.target.value })} /></label>
          <label className="mission-field">Work (min)<input type="number" min={0} max={MAX_SCENARIO_MINUTES} step={1} value={stop.minutes}
            onChange={(event) => update(index, { ...stop, minutes: Math.max(0, Math.min(MAX_SCENARIO_MINUTES, Math.trunc(Number(event.target.value) || 0))) })} /></label>
        </div>
        {preview.stops[index] && <small>Walk {formatMinutes(preview.stops[index].leg.minutes)}</small>}
        {!loading && !failed && preview.error?.index === index && stop.cell && <p className="mission-editor-error" role="status">{errors[preview.error.reason]}</p>}
      </fieldset>)}
      <button className="button" disabled={draft.stops.length >= MAX_MISSION_STOPS}
        onClick={() => onDraft({ ...draft, stops: [...draft.stops, emptyStop()] })}><Plus size={15} /> Add stop</button>
      {preview.error?.index === draft.stops.length && <p className="mission-editor-error" role="status">
        Return to base · {errors[preview.error.reason]}
      </p>}
      {loading && <p className="muted" role="status">Calculating traverse…</p>}
      {failed && <p className="mission-editor-error" role="alert">Traverse analysis is unavailable.</p>}
      {reserve && preview.inbound && <div className="mission-estimate">
        <dl>
          <div><dt>Return leg</dt><dd>{formatMinutes(preview.inbound.minutes)}</dd></div>
          <div><dt>Walking</dt><dd>{formatMinutes(reserve.travelMinutes)}</dd></div>
          <div><dt>Work</dt><dd>{formatMinutes(preview.work)}</dd></div>
          {preview.delay > 0 && <div><dt>First stop delay</dt><dd>{formatMinutes(preview.delay)}</dd></div>}
          <div><dt>Total time</dt><dd>{formatMinutes(reserve.missionMinutes)}</dd></div>
          {reserve.resources.map(({ name, remaining }) => <div key={name}><dt>{name} at base</dt><dd>{Math.max(0, remaining).toFixed(1)}%</dd></div>)}
          <div><dt>Return reserve</dt><dd>{reserve.margin > RESERVE_EPSILON ? '+' : ''}{formatMinutes(reserve.margin)}</dd></div>
        </dl>
        {below && <p className="reserve-warning"><TriangleAlert size={13} /> Below reserve{reserve.missionMinutes > reserve.depletion.depletionMinutes ? ` · ${reserve.depletion.name} runs out` : ''}</p>}
      </div>}
      <button className="button button--primary" disabled={!valid} onClick={onSimulate}><Play size={15} /> Simulate Mission</button>
    </div>
  </section>;
}

export function MissionResult({ name, tasks, completed, minutes, resources, returned }: {
  name: string; tasks: string[]; completed: number; minutes: number;
  resources: { name: string; remaining: number }[]; returned: boolean;
}) {
  return <section className="panel mission-result" aria-labelledby="mission-result-title">
    <div className="panel-title"><div className="section-heading"><Flag size={16} /><h2 id="mission-result-title">Mission summary</h2></div></div>
    <div className="mission-editor-content">
      <strong>{name}</strong>
      <p>{returned ? 'Returned to base' : 'Resources depleted'} · {formatMinutes(minutes)} · {resources.map(({ name, remaining }) =>
        `${name} ${Math.max(0, remaining).toFixed(1)}%`).join(' · ')}</p>
      <ol>{tasks.map((task, index) => <li key={index}><span>{task}</span><b>{index < completed ? 'Completed' : 'Skipped'}</b></li>)}</ol>
    </div>
  </section>;
}
