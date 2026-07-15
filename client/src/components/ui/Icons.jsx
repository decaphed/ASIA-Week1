// ─────────────────────────────────────────────────────────────────────────
// Icons.jsx — industrial pump monitoring icon set.
// v4: thin wrappers around lucide-react, matching MOCK's icon language.
//     Every export name/signature below is unchanged from v3 so call sites
//     across the app (Sidebar, Topbar, AlarmsPanel, SensorCard, …) don't
//     need to change.
// ─────────────────────────────────────────────────────────────────────────

import {
  Activity, Waves, RotateCw, Gauge, Thermometer, Power, Bell,
  AlertTriangle, XCircle, CheckCircle2, Info, BarChart2, History,
  Settings, Sun, Moon, FileText, BrainCircuit, Radio,
} from 'lucide-react';

const defaults = { size: 16, strokeWidth: 1.75 };

function makeIcon(LucideIcon, displayName) {
  const Icon = function (props) {
    return <LucideIcon {...defaults} {...props} />;
  };
  Icon.displayName = displayName;
  return Icon;
}

// ── Pump / hydraulic icons ─────────────────────────────────────────────────
export const FlowIcon = makeIcon(Waves, 'FlowIcon');
export const RpmIcon = makeIcon(RotateCw, 'RpmIcon');
export const VibrationIcon = makeIcon(Activity, 'VibrationIcon');
export const GaugeIcon = makeIcon(Gauge, 'GaugeIcon');
export const ThermometerIcon = makeIcon(Thermometer, 'ThermometerIcon');
export const StatusIcon = makeIcon(Power, 'StatusIcon');
export const AlarmIcon = makeIcon(Bell, 'AlarmIcon');
export const WarnIcon = makeIcon(AlertTriangle, 'WarnIcon');
export const FaultIcon = makeIcon(XCircle, 'FaultIcon');
export const CheckIcon = makeIcon(CheckCircle2, 'CheckIcon');
export const InfoIcon = makeIcon(Info, 'InfoIcon');

// ── Sidebar nav icons ───────────────────────────────────────────────────────
export const DashboardNavIcon = makeIcon(Activity, 'DashboardNavIcon');
export const SensorsNavIcon = makeIcon(Radio, 'SensorsNavIcon');
export const HistoryNavIcon = makeIcon(History, 'HistoryNavIcon');
export const AnalyticsNavIcon = makeIcon(BarChart2, 'AnalyticsNavIcon');
export const SettingsNavIcon = makeIcon(Settings, 'SettingsNavIcon');
export const ReportsNavIcon = makeIcon(FileText, 'ReportsNavIcon');
export const PredictNavIcon = makeIcon(BrainCircuit, 'PredictNavIcon');

// ── Theme toggle icons ───────────────────────────────────────────────────────
export const SunIcon = makeIcon(Sun, 'SunIcon');
export const MoonIcon = makeIcon(Moon, 'MoonIcon');

// Unreferenced aliases — kept for backward compatibility, no current call sites
export const DropletIcon = FlowIcon;
export const BulbIcon = StatusIcon;
