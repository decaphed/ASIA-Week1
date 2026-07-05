// ─────────────────────────────────────────────────────────────────────────
// Topbar.jsx — system header with pump ID, connection status, clock.
// v3: shows pump unit ID, asset tag, and active-alarm count in header.
// ─────────────────────────────────────────────────────────────────────────

import Clock from './Clock.jsx';
import StatusIndicator from './StatusIndicator.jsx';
import { secondsSince } from '../../utils/formatters.js';
import { NODE_RED_FRESH_SECONDS, PUMP_ID, PUMP_AREA } from '../../utils/constants.js';

export default function Topbar({ health, healthError }) {
  const backendStatus = healthError ? 'offline' : health ? 'online' : 'unknown';

  const dbStatus = healthError
    ? 'offline'
    : health?.database === 'connected'
      ? 'online'
      : health ? 'offline' : 'unknown';

  let nodeRedStatus = 'unknown';
  if (health) {
    nodeRedStatus = !health.lastReadingAt
      ? 'offline'
      : secondsSince(health.lastReadingAt) <= NODE_RED_FRESH_SECONDS
        ? 'online'
        : 'offline';
  }

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
        <StatusIndicator label="Data Feed" status={nodeRedStatus} />
        <StatusIndicator label="Server"    status={backendStatus} />
        <StatusIndicator label="Database"  status={dbStatus} />
      </div>

      <Clock />
    </header>
  );
}
