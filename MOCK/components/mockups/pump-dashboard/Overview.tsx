import React from "react";
import { AppShell } from "./_shared/AppShell";
import "./_group.css";
import { 
  CheckCircle2, 
  TrendingUp, 
  AlertTriangle, 
  Check, 
  Activity, 
  Clock,
  Layers,
  BoxSelect,
  RefreshCw,
  ChevronRight
} from "lucide-react";

// Mock data
const sensors = [
  { id: "flow", name: "Flow Rate", unit: "m³/h", current: 78.3, min: 75.1, max: 79.4, status: "normal", trend: "steady", w: 95, a: 105,
    sparkline: "M0,15 L5,14 L10,16 L15,13 L20,15 L25,14 L30,12 L35,14 L40,15 L45,16 L50,15 L55,14 L60,15 L65,13 L70,14 L75,15 L80,14 L85,13 L90,14 L95,15 L100,14" },
  { id: "speed", name: "Shaft Speed", unit: "RPM", current: 2847, min: 2840, max: 2855, status: "normal", trend: "steady", w: 2950, a: 3100,
    sparkline: "M0,15 L5,15 L10,16 L15,14 L20,15 L25,15 L30,15 L35,16 L40,15 L45,14 L50,15 L55,16 L60,15 L65,15 L70,14 L75,15 L80,15 L85,16 L90,15 L95,15 L100,14" },
  { id: "vibration", name: "Vibration", unit: "mm/s", current: 3.2, min: 2.8, max: 3.5, status: "normal", trend: "steady", w: 4.5, a: 7.0,
    sparkline: "M0,20 L5,18 L10,22 L15,19 L20,21 L25,18 L30,23 L35,17 L40,20 L45,21 L50,19 L55,22 L60,18 L65,21 L70,19 L75,20 L80,18 L85,22 L90,19 L95,20 L100,18" },
  { id: "suction", name: "Suction Pressure", unit: "bar", current: 1.14, min: 1.10, max: 1.21, status: "normal", trend: "steady", w: 0.8, a: 0.5,
    sparkline: "M0,10 L5,11 L10,10 L15,12 L20,11 L25,10 L30,11 L35,12 L40,11 L45,10 L50,11 L55,10 L60,12 L65,11 L70,10 L75,11 L80,12 L85,11 L90,10 L95,11 L100,10" },
  { id: "discharge", name: "Discharge Pressure", unit: "bar", current: 7.23, min: 7.15, max: 7.35, status: "normal", trend: "steady", w: 8.5, a: 9.5,
    sparkline: "M0,15 L5,14 L10,15 L15,16 L20,14 L25,15 L30,14 L35,16 L40,15 L45,14 L50,15 L55,16 L60,14 L65,15 L70,14 L75,16 L80,15 L85,14 L90,15 L95,16 L100,15" },
  { id: "temp", name: "Motor Temperature", unit: "°C", current: 74.1, min: 71.0, max: 74.1, status: "warning-trend", trend: "rising", w: 82, a: 90,
    sparkline: "M0,25 L5,24 L10,24 L15,23 L20,22 L25,22 L30,21 L35,20 L40,20 L45,19 L50,18 L55,17 L60,17 L65,16 L70,15 L75,14 L80,13 L85,12 L90,11 L95,10 L100,9" },
];

export default function Overview() {
  return (
    <AppShell activePage="Overview">
      <div className="flex-1 flex flex-col min-h-0 bg-background">
        {/* Status Banner */}
        <div className="bg-healthy-subtle border-b border-healthy/20 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-4 h-4 text-healthy" />
            <span className="font-medium text-foreground">System operating within normal parameters — all sensors nominal.</span>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="text-warning font-medium">Outlook:</span>
            <span>Next-hour forecast: stable. Motor temperature trending +1.2°C/h — monitor if sustained.</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          
          {/* Summary Cards Row */}
          <div className="grid grid-cols-4 gap-4 shrink-0">
            <div className="bg-card border border-border rounded-lg p-3 flex flex-col justify-between hover:border-primary/50 transition-colors cursor-pointer group">
              <div className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Pumps Running</div>
              <div className="flex items-end justify-between mt-2">
                <div className="text-2xl font-mono text-foreground">1<span className="text-muted-foreground text-sm">/1</span></div>
                <div className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">View status <ChevronRight className="w-3 h-3"/></div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 flex flex-col justify-between hover:border-primary/50 transition-colors cursor-pointer group">
              <div className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Active Trends</div>
              <div className="flex items-end justify-between mt-2">
                <div className="text-2xl font-mono text-warning flex items-center gap-2">1 <TrendingUp className="w-5 h-5"/></div>
                <div className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">View analytics <ChevronRight className="w-3 h-3"/></div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 flex flex-col justify-between hover:border-primary/50 transition-colors cursor-pointer group">
              <div className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Predictions</div>
              <div className="flex items-end justify-between mt-2">
                <div className="text-2xl font-mono text-healthy flex items-center gap-2">Low Risk</div>
                <div className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">View predictions <ChevronRight className="w-3 h-3"/></div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 flex flex-col justify-between hover:border-primary/50 transition-colors cursor-pointer group">
              <div className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Data Quality</div>
              <div className="flex items-end justify-between mt-2">
                <div className="text-2xl font-mono text-foreground">99.2%</div>
                <div className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">View reports <ChevronRight className="w-3 h-3"/></div>
              </div>
            </div>
          </div>

          {/* Health Strip */}
          <div className="bg-card border border-border rounded-lg flex items-center divide-x divide-border shrink-0 text-xs">
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Machine Health Score</span>
              <div className="flex items-center gap-2">
                <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                  <div className="bg-healthy h-full w-[87%]" />
                </div>
                <span className="font-mono text-foreground font-semibold">87/100</span>
              </div>
            </div>
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Operating Status</span>
              <div className="flex items-center gap-2 text-healthy font-mono font-bold tracking-wider">
                <span className="w-2 h-2 rounded-full bg-healthy animate-pulse" />
                RUNNING
              </div>
            </div>
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Availability (30d)</span>
              <span className="font-mono text-foreground font-semibold">99.1%</span>
            </div>
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Active Alarms</span>
              <span className="font-mono text-muted-foreground">0 alarms, 0 warnings</span>
            </div>
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Run Hours</span>
              <span className="font-mono text-foreground">2,847 <span className="text-muted-foreground">tot</span> / 312 <span className="text-muted-foreground">cur</span></span>
            </div>
            <div className="px-4 py-3 flex-1 flex flex-col gap-1">
              <span className="text-muted-foreground uppercase">Last Update</span>
              <div className="flex items-center gap-2 font-mono text-foreground">
                <RefreshCw className="w-3 h-3 text-primary animate-spin-slow" />
                3s ago
              </div>
            </div>
          </div>

          {/* Main Section */}
          <div className="grid grid-cols-10 gap-4 shrink-0 h-[400px]">
            {/* Left: Schematic */}
            <div className="col-span-6 bg-card border border-border rounded-lg flex flex-col relative overflow-hidden">
              <div className="absolute top-3 left-3 right-3 flex justify-between items-center z-10">
                <div className="flex items-center gap-2 bg-background/80 backdrop-blur border border-border rounded-md p-1">
                  <button className="px-3 py-1 text-xs font-medium bg-secondary text-foreground rounded shadow-sm">P&ID Schematic</button>
                  <button className="px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded">3D Model</button>
                </div>
              </div>
              
              <div className="flex-1 w-full h-full relative flex items-center justify-center p-8 bg-[#0a0e13]">
                {/* SVG Schematic Background */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 800 400" preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1"/>
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill="url(#grid)" />
                  
                  {/* Piping Lines */}
                  {/* Suction Line */}
                  <path d="M 100 250 L 350 250" fill="none" stroke="#2d3748" strokeWidth="8" />
                  <path d="M 100 250 L 350 250" fill="none" stroke="#00d4c8" strokeWidth="2" strokeDasharray="6 6" className="animate-flow" />
                  
                  {/* Discharge Line */}
                  <path d="M 400 200 L 400 120 L 750 120" fill="none" stroke="#2d3748" strokeWidth="8" strokeLinejoin="round" />
                  <path d="M 400 200 L 400 120 L 750 120" fill="none" stroke="#00d4c8" strokeWidth="2" strokeDasharray="6 6" className="animate-flow" strokeLinejoin="round" />
                </svg>

                {/* Equipment Layer */}
                <div className="absolute inset-0 w-full h-full">
                  {/* Sump Tank */}
                  <div className="absolute left-[40px] top-[180px] group cursor-help">
                    <div className="w-[80px] h-[140px] border-2 border-healthy bg-secondary rounded-t-sm rounded-b-md flex items-end justify-center pb-2 relative overflow-hidden">
                       <div className="absolute bottom-0 left-0 right-0 h-[60%] bg-healthy/20" />
                       <span className="text-xs font-mono text-muted-foreground z-10">TK-101</span>
                    </div>
                  </div>

                  {/* Centrifugal Pump */}
                  <div className="absolute left-[330px] top-[200px] group cursor-help">
                    <div className="w-[100px] h-[100px] rounded-full border-2 border-healthy bg-secondary flex items-center justify-center relative">
                      <div className="w-[60px] h-[60px] rounded-full border border-border flex items-center justify-center animate-[spin_2s_linear_infinite]">
                        <div className="w-1 h-full bg-border/50" />
                        <div className="h-1 w-full bg-border/50 absolute" />
                      </div>
                      <span className="absolute -bottom-6 text-xs font-mono text-muted-foreground bg-background px-1">P-201A</span>
                    </div>
                  </div>

                  {/* Motor */}
                  <div className="absolute left-[450px] top-[220px] group cursor-help">
                    <div className="w-[120px] h-[60px] border-2 border-warning bg-secondary rounded-sm flex items-center justify-center relative">
                       {/* Connection shaft to pump */}
                       <div className="absolute -left-[20px] top-[20px] w-[20px] h-[16px] bg-border border-y border-border" />
                       {/* Cooling fins */}
                       <div className="absolute top-0 left-2 right-2 h-full flex flex-col justify-evenly py-1 opacity-20">
                         {[1,2,3,4,5].map(i => <div key={i} className="h-px bg-foreground" />)}
                       </div>
                       <span className="text-xs font-mono text-muted-foreground z-10 bg-background px-1">M-201A</span>
                    </div>
                  </div>

                  {/* Check Valve */}
                  <div className="absolute left-[550px] top-[105px] group cursor-help">
                    <div className="w-[40px] h-[30px] relative flex items-center justify-center">
                      <div className="w-0 h-0 border-y-[15px] border-y-transparent border-l-[20px] border-l-healthy" />
                      <div className="w-0 h-0 border-y-[15px] border-y-transparent border-r-[20px] border-r-healthy" />
                      <div className="absolute w-[4px] h-[40px] bg-healthy left-[18px]" />
                    </div>
                    <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-mono text-muted-foreground bg-background px-1 whitespace-nowrap">CV-301</span>
                  </div>

                  {/* Sensor Overlays */}
                  <div className="absolute left-[180px] top-[260px] bg-background border border-border rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-muted-foreground uppercase leading-tight">Suction</div>
                    <div className="text-xs font-mono font-bold">1.14 <span className="text-[10px] font-sans font-normal text-muted-foreground">bar</span></div>
                  </div>

                  <div className="absolute left-[240px] top-[215px] bg-background border border-border rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-muted-foreground uppercase leading-tight">Flow</div>
                    <div className="text-xs font-mono font-bold">78.3 <span className="text-[10px] font-sans font-normal text-muted-foreground">m³/h</span></div>
                  </div>

                  <div className="absolute left-[380px] top-[150px] bg-background border border-border rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-muted-foreground uppercase leading-tight">Discharge</div>
                    <div className="text-xs font-mono font-bold">7.23 <span className="text-[10px] font-sans font-normal text-muted-foreground">bar</span></div>
                  </div>

                  <div className="absolute left-[350px] top-[310px] bg-background border border-border rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-muted-foreground uppercase leading-tight">Vibration</div>
                    <div className="text-xs font-mono font-bold">3.2 <span className="text-[10px] font-sans font-normal text-muted-foreground">mm/s</span></div>
                  </div>

                  <div className="absolute left-[480px] top-[290px] bg-warning-subtle border border-warning/50 rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-warning uppercase leading-tight font-medium flex items-center gap-1">Temp ↗</div>
                    <div className="text-xs font-mono font-bold text-warning">74.1 <span className="text-[10px] font-sans font-normal opacity-80">°C</span></div>
                  </div>

                  <div className="absolute left-[540px] top-[180px] bg-background border border-border rounded px-2 py-1 shadow-md">
                    <div className="text-[10px] text-muted-foreground uppercase leading-tight">Speed</div>
                    <div className="text-xs font-mono font-bold">2847 <span className="text-[10px] font-sans font-normal text-muted-foreground">RPM</span></div>
                  </div>

                </div>
              </div>
            </div>

            {/* Right: Panels */}
            <div className="col-span-4 flex flex-col gap-4">
              {/* Alarms Feed */}
              <div className="flex-1 bg-card border border-border rounded-lg flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b border-border flex items-center justify-between bg-secondary/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Alarms & Events</h3>
                  <span className="bg-muted text-muted-foreground px-2 py-0.5 rounded text-[10px] font-mono">0 ACTIVE</span>
                </div>
                <div className="flex-1 overflow-auto p-4 flex flex-col">
                  <div className="flex items-center gap-2 text-healthy bg-healthy-subtle border border-healthy/20 px-3 py-2 rounded mb-4 shrink-0">
                    <Check className="w-4 h-4" />
                    <span className="text-xs font-medium">No active alarms</span>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex gap-3 items-start">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                      <div>
                        <div className="text-xs text-foreground">Motor Temp warning cleared</div>
                        <div className="text-[10px] text-muted-foreground font-mono">2025-07-13 14:23</div>
                      </div>
                    </div>
                    <div className="flex gap-3 items-start">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                      <div>
                        <div className="text-xs text-foreground">System started</div>
                        <div className="text-[10px] text-muted-foreground font-mono">2025-07-12 09:07</div>
                      </div>
                    </div>
                    <div className="flex gap-3 items-start">
                      <div className="w-1.5 h-1.5 rounded-full bg-warning mt-1.5 shrink-0" />
                      <div>
                        <div className="text-xs text-foreground">Discharge pressure spike (auto-resolved)</div>
                        <div className="text-[10px] text-muted-foreground font-mono">2025-07-11 22:51</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* System Health */}
              <div className="flex-1 bg-card border border-border rounded-lg flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-secondary/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">System Health</h3>
                </div>
                <div className="flex-1 overflow-auto p-4 grid grid-cols-2 gap-x-4 gap-y-3 content-start">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Monitoring Service</span>
                    <span className="text-healthy flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-healthy"></span>Online</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Sensor Feed</span>
                    <span className="text-healthy flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-healthy animate-pulse"></span>Live / 3s</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Data Storage</span>
                    <span className="text-foreground">Connected</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">API Latency</span>
                    <span className="text-foreground font-mono">12ms</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Network Signal</span>
                    <span className="text-foreground">Excellent</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Data Quality Score</span>
                    <span className="text-foreground font-mono">99.2%</span>
                  </div>
                  <div className="flex justify-between items-center text-xs col-span-2 mt-2 pt-2 border-t border-border">
                    <span className="text-muted-foreground">Condition Trend</span>
                    <span className="text-warning flex items-center gap-1">Stable ↗ <span className="text-muted-foreground">(motor temp)</span></span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Live Sensor Cards Grid */}
          <div className="grid grid-cols-3 gap-4 shrink-0 pb-4">
            {sensors.map((sensor) => (
              <div key={sensor.id} className={`bg-card border rounded-lg p-4 flex flex-col gap-3 relative overflow-hidden ${sensor.status === 'warning-trend' ? 'border-warning/50' : 'border-border'}`}>
                {/* Header */}
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground">{sensor.name}</h4>
                    <div className="flex items-baseline gap-1 mt-1">
                      <span className={`text-3xl font-mono font-bold ${sensor.status === 'warning-trend' ? 'text-warning' : 'text-foreground'}`}>
                        {sensor.current}
                      </span>
                      <span className="text-xs text-muted-foreground">{sensor.unit}</span>
                    </div>
                  </div>
                  {sensor.status === 'normal' ? (
                    <span className="bg-healthy-subtle text-healthy text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-healthy/20">Normal</span>
                  ) : (
                    <span className="bg-warning-subtle text-warning text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-warning/20">Monitor</span>
                  )}
                </div>

                {/* Chart Area */}
                <div className="h-12 w-full relative mt-2">
                  <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 30">
                    <path 
                      d={sensor.sparkline} 
                      fill="none" 
                      stroke={sensor.status === 'warning-trend' ? 'hsl(var(--color-warning))' : 'hsl(var(--color-healthy))'} 
                      strokeWidth="2" 
                      vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>

                {/* Footer Stats */}
                <div className="grid grid-cols-2 gap-2 text-xs border-t border-border pt-3 mt-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase text-muted-foreground">Today's Range</span>
                    <span className="font-mono text-foreground">{sensor.min} - {sensor.max}</span>
                  </div>
                  <div className="flex flex-col gap-1 text-right">
                    <span className="text-[10px] uppercase text-muted-foreground">Thresholds</span>
                    <span className="font-mono text-muted-foreground">W:&gt;{sensor.w} / A:&gt;{sensor.a}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </AppShell>
  );
}
