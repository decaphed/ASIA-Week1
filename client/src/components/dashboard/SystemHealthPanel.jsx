// ─────────────────────────────────────────────────────────────────────────
// SystemHealthPanel.jsx — right-rail "System Health" panel (V2 Overview
// spec §06): service status rows, API latency, connection quality,
// stored-record count, last update. All values come straight from
// GET /api/health and GET /api/stats — nothing here is simulated.
// ─────────────────────────────────────────────────────────────────────────

import { computeServiceStatus, connectionQuality } from '../../utils/health.js';
import { formatTime } from '../../utils/formatters.js';

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

export default function SystemHealthPanel({ health, healthError, stats }) {
  const { backend, database, nodeRed } = computeServiceStatus(health, healthError);
  const quality = connectionQuality(stats?.apiLatencyMs);
  const lastUpdate = stats?.latestTimestamp ? formatTime(stats.latestTimestamp) : '--';

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
      </div>
    </div>
  );
}
