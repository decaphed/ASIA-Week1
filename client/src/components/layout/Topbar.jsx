// ─────────────────────────────────────────────────────────────────────────
// Topbar.jsx — system header with pump ID, connection status, clock.
// v4: adds the V2 spec's notification bell (active alarm/warn count) and
//     operator avatar; status pills renamed to match the spec (Server /
//     Node-RED / SQLite) and now share computeServiceStatus with the
//     System Health panel instead of duplicating the derivation.
// ─────────────────────────────────────────────────────────────────────────

import Clock from './Clock.jsx';
import StatusIndicator from './StatusIndicator.jsx';
import { computeServiceStatus } from '../../utils/health.js';
import { PUMP_ID, PUMP_AREA } from '../../utils/constants.js';
import { AlarmIcon, SunIcon, MoonIcon } from '../ui/Icons.jsx';

export default function Topbar({ health, healthError, alarmCount = 0, theme = 'dark', onToggleTheme }) {
  const { backend, database, nodeRed } = computeServiceStatus(health, healthError);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__unit-id">{PUMP_ID}</span>
        <div className="topbar__title">
          <h1>Industrial Pump Monitor</h1>
          <p>{PUMP_AREA}</p>
        </div>
      </div>

      <div className="topbar__status">
        {/* Plain names for the exec audience; the vendor/tech names live in
            the hover tooltips for engineers. */}
        <StatusIndicator label="System"       status={backend}  title="Express backend" />
        <StatusIndicator label="Sensor Feed"  status={nodeRed}  title="Node-RED ingestion flow" />
        <StatusIndicator label="Data Storage" status={database} title="SQLite database" />
      </div>

      <button
        type="button"
        className="topbar__theme"
        onClick={onToggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <SunIcon width={17} height={17} /> : <MoonIcon width={17} height={17} />}
      </button>

      <button type="button" className="topbar__bell" aria-label={`Notifications: ${alarmCount} active`}>
        <AlarmIcon width={17} height={17} />
        <span className="topbar__bell-badge">{alarmCount}</span>
      </button>

      <Clock />

      <div className="topbar__avatar" aria-hidden="true">OP</div>
    </header>
  );
}
