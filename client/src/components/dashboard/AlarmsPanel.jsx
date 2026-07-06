// ─────────────────────────────────────────────────────────────────────────
// AlarmsPanel.jsx — right-rail "Alarms & Events" list (V2 Overview spec §06).
// Rows are derived live from the current reading's alarm/warn state — there
// is no persisted event log, so this always reflects what's true right now.
// ─────────────────────────────────────────────────────────────────────────

import { buildAlarmFeed } from '../../utils/health.js';
import { formatTime } from '../../utils/formatters.js';
import { FaultIcon, WarnIcon, CheckIcon, InfoIcon } from '../ui/Icons.jsx';

const ICONS = { alarm: FaultIcon, warn: WarnIcon, ok: CheckIcon, info: InfoIcon };

export default function AlarmsPanel({ reading }) {
  const timeLabel = reading?.timestamp ? formatTime(reading.timestamp) : '--';
  const rows = buildAlarmFeed(reading, timeLabel);
  const activeCount = rows.filter((row) => row.severity === 'alarm' || row.severity === 'warn').length;

  return (
    <div className="rail-panel">
      <div className="rail-panel__header">
        <span className="rail-panel__title">Alarms &amp; Events</span>
        <span className={`rail-panel__badge rail-panel__badge--${activeCount > 0 ? 'active' : 'clear'}`}>
          {activeCount > 0 ? activeCount : 'CLEAR'}
        </span>
      </div>
      <div className="rail-panel__rows">
        {rows.map((row) => {
          const Icon = ICONS[row.severity] ?? InfoIcon;
          return (
            <div key={row.key} className={`alarm-row alarm-row--${row.severity}`}>
              <span className="alarm-row__icon"><Icon /></span>
              <div className="alarm-row__body">
                <div className="alarm-row__title">{row.title}</div>
                <div className="alarm-row__meta">{row.meta}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
