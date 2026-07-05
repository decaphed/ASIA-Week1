// ─────────────────────────────────────────────────────────────────────────
// Topbar.jsx — page title, the three connection indicators, and the clock.
//
// It receives the latest /api/health result (and any error) from App and
// derives three independent statuses:
//   • Backend  → did the health request succeed at all?
//   • Database → health.database === 'connected'
//   • Node-RED → is the newest stored reading fresh (< N seconds old)? If data
//     is still arriving, Node-RED must be running. This is a neat trick: we
//     infer an upstream component's health from the freshness of its output.
// ─────────────────────────────────────────────────────────────────────────

import Clock from './Clock.jsx';
import StatusIndicator from './StatusIndicator.jsx';
import { secondsSince } from '../../utils/formatters.js';
import { NODE_RED_FRESH_SECONDS } from '../../utils/constants.js';

export default function Topbar({ health, healthError }) {
  const backendStatus = healthError ? 'offline' : health ? 'online' : 'unknown';

  const dbStatus = healthError
    ? 'offline'
    : health?.database === 'connected'
      ? 'online'
      : health
        ? 'offline'
        : 'unknown';

  let nodeRedStatus = 'unknown';
  if (health) {
    if (!health.lastReadingAt) nodeRedStatus = 'offline';
    else nodeRedStatus = secondsSince(health.lastReadingAt) <= NODE_RED_FRESH_SECONDS ? 'online' : 'offline';
  }

  return (
    <header className="topbar">
      <div className="topbar__title">
        <h1>Industrial Monitoring</h1>
        <p>Live sensor telemetry &amp; historical analytics</p>
      </div>
      <div className="topbar__status">
        <StatusIndicator label="Backend" status={backendStatus} />
        <StatusIndicator label="Node-RED" status={nodeRedStatus} />
        <StatusIndicator label="Database" status={dbStatus} />
      </div>
      <Clock />
    </header>
  );
}
