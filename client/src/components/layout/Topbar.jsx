// ─────────────────────────────────────────────────────────────────────────
// Topbar.jsx — system header with pump ID, connection status, clock.
// v4: adds the V2 spec's notification bell (active alarm/warn count) and
//     operator avatar. The System/Sensor Feed/Data Storage status pills
//     were removed from here — that status is still shown in the Sidebar's
//     system-status section, so this bar no longer duplicates it.
// ─────────────────────────────────────────────────────────────────────────

import Clock from './Clock.jsx';
import { PUMP_ID, PUMP_AREA } from '../../utils/constants.js';
import { AlarmIcon, SunIcon, MoonIcon } from '../ui/Icons.jsx';

export default function Topbar({ alarms = 0, warns = 0, theme = 'dark', onToggleTheme }) {
  // Honest severity on the bell: show the critical count in danger styling
  // when there are alarms, otherwise the caution count, otherwise a quiet 0.
  const badgeSeverity = alarms > 0 ? 'alarm' : warns > 0 ? 'warn' : 'none';
  const badgeCount = alarms > 0 ? alarms : warns;
  const bellLabel = alarms > 0 || warns > 0
    ? `Notifications: ${alarms} alarm${alarms === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`
    : 'Notifications: none active';

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__unit-id">{PUMP_ID}</span>
        <div className="topbar__title">
          <h1>Industrial Pump Monitor</h1>
          <p>{PUMP_AREA}</p>
        </div>
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

      <button type="button" className="topbar__bell" aria-label={bellLabel}>
        <AlarmIcon width={17} height={17} />
        <span className={`topbar__bell-badge topbar__bell-badge--${badgeSeverity}`}>{badgeCount}</span>
      </button>

      <Clock />

      <div className="topbar__avatar" aria-hidden="true">OP</div>
    </header>
  );
}
