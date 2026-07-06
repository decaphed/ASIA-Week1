// ─────────────────────────────────────────────────────────────────────────
// SystemHealthPanel.jsx — right-rail "System Health" panel (V2 Overview
// spec §06): service status rows, API latency, connection quality,
// stored-record count, last update. All values come straight from
// GET /api/health and GET /api/stats — nothing here is simulated.
// ─────────────────────────────────────────────────────────────────────────

import { computeServiceStatus, connectionQuality } from '../../utils/health.js';
import { formatTime } from '../../utils/formatters.js';
import { SENSORS } from '../../utils/constants.js';

const SENSOR_MAP = Object.fromEntries(SENSORS.map((s) => [s.key, s]));

function ServiceRow({ label, online, onlineText, offlineText = 'OFFLINE' }) {
  return (
    <div className="system-health-row">
      <span className="system-health-row__label">
        <span className={`system-health-row__dot${online ? ' system-health-row__dot--online' : ''}`} />
        {label}
      </span>
      <span className={`system-health-row__state${online ? ' system-health-row__state--online' : ''}`}>
        {online ? onlineText : offlineText}
      </span>
    </div>
  );
}

function StatRow({ label, children }) {
  return (
    <div className="system-health-stat">
      <span className="system-health-stat__label">{label}</span>
      <span className="system-health-stat__value">{children}</span>
    </div>
  );
}

// One line per metric that has drifted — only rendered for non-'stable'
// entries, so the panel stays quiet when nothing needs attention.
function DriftRow({ metric, entry }) {
  const sensor = SENSOR_MAP[metric];
  const arrow = entry.direction === 'rising' ? '▲' : '▼';
  const sign = entry.delta > 0 ? '+' : '';
  return (
    <div className="drift-row">
      <span className="drift-row__label">
        <span className="drift-row__arrow">{arrow}</span>
        {sensor.shortLabel}
      </span>
      <span className="drift-row__delta">
        {sign}{entry.delta.toFixed(sensor.prec)} {sensor.unit}
      </span>
    </div>
  );
}

export default function SystemHealthPanel({ health, healthError, stats, drift }) {
  const { backend, database, nodeRed } = computeServiceStatus(health, healthError);
  const quality = connectionQuality(stats?.apiLatencyMs);
  const lastUpdate = stats?.latestTimestamp ? formatTime(stats.latestTimestamp) : '--';

  // getDrift() returns null per metric until there's enough RUNNING history
  // to compare against (see driftService.js) — treat "every entry still
  // null" as "still collecting a baseline", not as "nothing to show".
  const driftEntries = drift ? Object.entries(drift).filter(([, d]) => d != null) : [];
  const driftingEntries = driftEntries.filter(([, d]) => d.direction !== 'stable');

  return (
    <div className="rail-panel rail-panel--grow">
      <div className="rail-panel__header">
        <span className="rail-panel__title">System Health</span>
      </div>
      <div className="system-health-body">
        <ServiceRow label="Express Backend" online={backend === 'online'} onlineText="ONLINE" />
        <ServiceRow label="Node-RED Feed"   online={nodeRed === 'online'}  onlineText="STREAMING" />
        <ServiceRow label="SQLite Store"    online={database === 'online'} onlineText="CONNECTED" />

        <div className="system-health-divider" />

        <StatRow label="API Latency">
          {stats?.apiLatencyMs != null ? `${stats.apiLatencyMs} ms` : '--'}
        </StatRow>
        <StatRow label="Connection Quality">
          <span className={`system-health-quality system-health-quality--${quality.bars}`}>
            <span className="system-health-quality__bars" aria-hidden="true">
              <span className="system-health-quality__bar" />
              <span className="system-health-quality__bar" />
              <span className="system-health-quality__bar" />
            </span>
            {quality.label}
          </span>
        </StatRow>
        <StatRow label="Stored Records">{stats?.totalRecords ?? '--'}</StatRow>
        <StatRow label="Last Update">{lastUpdate}</StatRow>

        <div className="system-health-divider" />

        <StatRow label="Condition Trend">
          {driftEntries.length === 0 ? (
            <span className="system-health-stat__value--muted">Collecting baseline…</span>
          ) : driftingEntries.length === 0 ? (
            <span className="system-health-stat__value--ok">Stable</span>
          ) : (
            <span className="system-health-stat__value--warn">
              {driftingEntries.length} drifting
            </span>
          )}
        </StatRow>
        {/* Always rendered at a fixed height (even with 0 rows) so the
            panel's size never changes as drift data refreshes — see
            .drift-row-list in index.css. */}
        <div className="drift-row-list">
          {driftingEntries.map(([metric, entry]) => (
            <DriftRow key={metric} metric={metric} entry={entry} />
          ))}
        </div>
      </div>
    </div>
  );
}
