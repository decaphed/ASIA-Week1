import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import "./_group.css";
import { TrendingUp, ArrowRight, TrendingDown } from "lucide-react";

const charts = {
  hydraulic: [
    { id: "flow", name: "Flow Rate", unit: "m³/h", current: "78.3", trend: "steady", w: 95, a: 105,
      path: "M0,60 L10,58 L20,62 L30,59 L40,61 L50,60 L60,58 L70,59 L80,60 L90,62 L100,58", yMin: 60, yMax: 110 },
    { id: "suction", name: "Suction Pressure", unit: "bar", current: "1.14", trend: "steady", w: 0.8, a: 0.5,
      path: "M0,70 L10,72 L20,68 L30,71 L40,70 L50,69 L60,71 L70,70 L80,68 L90,71 L100,70", yMin: 0, yMax: 2 },
    { id: "discharge", name: "Discharge Pressure", unit: "bar", current: "7.23", trend: "steady", w: 8.5, a: 9.5,
      path: "M0,60 L10,58 L20,61 L30,59 L40,60 L50,58 L60,61 L70,59 L80,60 L90,58 L100,61", yMin: 5, yMax: 10 },
  ],
  mechanical: [
    { id: "speed", name: "Shaft Speed", unit: "RPM", current: "2847", trend: "steady", w: 2950, a: 3100,
      path: "M0,50 L10,48 L20,52 L30,49 L40,51 L50,50 L60,49 L70,51 L80,48 L90,52 L100,50", yMin: 2700, yMax: 3200 },
    { id: "vibration", name: "Vibration", unit: "mm/s", current: "3.2", trend: "steady", w: 4.5, a: 7.0,
      path: "M0,80 L10,75 L20,85 L30,78 L40,82 L50,77 L60,84 L70,76 L80,81 L90,79 L100,82", yMin: 0, yMax: 8 },
    { id: "temp", name: "Motor Temperature", unit: "°C", current: "74.1", trend: "rising", w: 82, a: 90,
      path: "M0,85 L10,83 L20,81 L30,78 L40,75 L50,72 L60,68 L70,65 L80,60 L90,55 L100,50", yMin: 60, yMax: 100 },
  ]
};

function MiniChart({ data, isLive }: { data: any, isLive: boolean }) {
  // Normalize Y logic just for visuals
  // viewBox="0 0 100 100", 0 is top, 100 is bottom.
  // Warning and Alarm line Y positions:
  const range = data.yMax - data.yMin;
  const wY = 100 - ((data.w - data.yMin) / range) * 100;
  const aY = 100 - ((data.a - data.yMin) / range) * 100;

  const isWarningTrend = data.trend === 'rising' && data.id === 'temp';

  return (
    <div className={`bg-card border ${isWarningTrend ? 'border-warning/50' : 'border-border'} rounded-lg p-4 flex flex-col`}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <h4 className="text-sm font-medium text-foreground">{data.name}</h4>
          <div className="text-xs text-muted-foreground mt-0.5">{data.unit}</div>
        </div>
        <div className="flex flex-col items-end">
          <div className={`text-2xl font-mono font-bold ${isWarningTrend ? 'text-warning' : 'text-foreground'}`}>
            {data.current}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            {data.trend === 'steady' ? <ArrowRight className="w-3 h-3"/> : data.trend === 'rising' ? <TrendingUp className="w-3 h-3 text-warning"/> : <TrendingDown className="w-3 h-3"/>}
            {data.trend === 'steady' ? 'Steady' : 'Rising'}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-[160px] relative w-full mt-2">
        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-0 w-8 flex flex-col justify-between text-[9px] text-muted-foreground font-mono">
          <span>{data.yMax}</span>
          <span>{data.yMin + (data.yMax - data.yMin)/2}</span>
          <span>{data.yMin}</span>
        </div>

        <div className="absolute left-10 right-0 top-0 bottom-0 border-l border-b border-border">
          <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 115 100">
            {/* Grid lines */}
            <line x1="0" y1="25" x2="115" y2="25" stroke="currentColor" strokeOpacity="0.05" strokeWidth="1" />
            <line x1="0" y1="50" x2="115" y2="50" stroke="currentColor" strokeOpacity="0.05" strokeWidth="1" />
            <line x1="0" y1="75" x2="115" y2="75" stroke="currentColor" strokeOpacity="0.05" strokeWidth="1" />

            {/* Threshold lines */}
            {wY >= 0 && wY <= 100 && (
              <line x1="0" y1={wY} x2="115" y2={wY} stroke="hsl(var(--color-warning))" strokeDasharray="4 4" strokeWidth="1" strokeOpacity="0.5" />
            )}
            {aY >= 0 && aY <= 100 && (
              <line x1="0" y1={aY} x2="115" y2={aY} stroke="hsl(var(--color-alarm))" strokeDasharray="4 4" strokeWidth="1" strokeOpacity="0.5" />
            )}

            {/* Data line */}
            <path 
              d={data.path} 
              fill="none" 
              stroke={isWarningTrend ? 'hsl(var(--color-warning))' : 'hsl(var(--color-healthy))'} 
              strokeWidth="2" 
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />

            {/* Forecast extension */}
            {isLive && (
              <>
                <line x1="100" y1="0" x2="100" y2="100" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2 2" strokeWidth="1" />
                <path 
                  d={`M100,${data.path.split(',').pop()} L115,${isWarningTrend ? '40' : data.path.split(',').pop()}`} 
                  fill="none" 
                  stroke={isWarningTrend ? 'hsl(var(--color-warning))' : 'hsl(var(--color-healthy))'} 
                  strokeWidth="2" 
                  strokeDasharray="4 4"
                  strokeOpacity="0.5"
                  vectorEffect="non-scaling-stroke"
                />
                <text x="102" y="10" fontSize="8" fill="currentColor" opacity="0.5" className="font-mono">FORECAST</text>
              </>
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

export default function Analytics() {
  const [timeRange, setTimeRange] = useState("Live");
  const ranges = ["Live", "1h", "8h", "24h", "7d"];

  return (
    <AppShell activePage="Analytics">
      <div className="flex-1 flex flex-col min-h-0">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-card shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Sensor Analytics</h2>
            <p className="text-sm text-muted-foreground mt-1">Real-time and historical trend analysis</p>
          </div>
          
          <div className="flex bg-secondary p-1 rounded-md border border-border">
            {ranges.map(range => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  timeRange === range 
                    ? "bg-background text-foreground shadow-sm border border-border/50" 
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        {/* Summary Strip */}
        <div className="bg-warning-subtle border-b border-warning/20 px-6 py-2 shrink-0">
          <div className="flex items-center gap-2 text-warning text-sm font-medium">
            <TrendingUp className="w-4 h-4" />
            <span>4 of 6 metrics steady — Motor Temperature rising fastest (+1.2°C/h)</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-8">
          
          {/* Hydraulic Group */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">Hydraulic Performance</h3>
            <div className="grid grid-cols-3 gap-4">
              {charts.hydraulic.map(chart => (
                <MiniChart key={chart.id} data={chart} isLive={timeRange === "Live"} />
              ))}
            </div>
          </section>

          {/* Mechanical Group */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">Mechanical Condition</h3>
            <div className="grid grid-cols-3 gap-4">
              {charts.mechanical.map(chart => (
                <MiniChart key={chart.id} data={chart} isLive={timeRange === "Live"} />
              ))}
            </div>
          </section>

        </div>
      </div>
    </AppShell>
  );
}
