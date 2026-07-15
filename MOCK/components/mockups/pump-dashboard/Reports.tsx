import React, { useState } from "react";
import { AppShell } from "./_shared/AppShell";
import "./_group.css";
import { Download, ChevronDown, ChevronRight, Activity, Zap, Check } from "lucide-react";

export default function Reports() {
  const [period, setPeriod] = useState("24h");
  const [toolsOpen, setToolsOpen] = useState(false);

  const stats = [
    { sensor: "Flow Rate", min: "71.2", avg: "77.8", max: "81.4", unit: "m³/h", status: "Nominal" },
    { sensor: "Shaft Speed", min: "2840", avg: "2848", max: "2855", unit: "RPM", status: "Nominal" },
    { sensor: "Vibration", min: "2.8", avg: "3.1", max: "3.9", unit: "mm/s", status: "Nominal" },
    { sensor: "Suction Pressure", min: "1.08", avg: "1.15", max: "1.22", unit: "bar", status: "Nominal" },
    { sensor: "Discharge Pressure", min: "7.11", avg: "7.21", max: "7.38", unit: "bar", status: "Nominal" },
    { sensor: "Motor Temperature", min: "68.5", avg: "71.2", max: "74.1", unit: "°C", status: "Monitor", statusColor: "text-warning" },
  ];

  const history = [
    { t: "10:45:00", f: 78.3, s: 2847, v: 3.2, sp: 1.14, dp: 7.23, mt: 74.1 },
    { t: "10:44:57", f: 78.4, s: 2847, v: 3.1, sp: 1.14, dp: 7.22, mt: 74.1 },
    { t: "10:44:54", f: 78.2, s: 2848, v: 3.3, sp: 1.13, dp: 7.24, mt: 74.0 },
    { t: "10:44:51", f: 78.3, s: 2846, v: 3.2, sp: 1.15, dp: 7.23, mt: 74.0 },
    { t: "10:44:48", f: 78.5, s: 2847, v: 3.2, sp: 1.14, dp: 7.21, mt: 74.0 },
    { t: "10:44:45", f: 78.1, s: 2847, v: 3.4, sp: 1.14, dp: 7.25, mt: 73.9 },
    { t: "10:44:42", f: 78.3, s: 2848, v: 3.1, sp: 1.15, dp: 7.23, mt: 73.9 },
    { t: "10:44:39", f: 78.2, s: 2846, v: 3.2, sp: 1.13, dp: 7.22, mt: 73.9 },
  ];

  return (
    <AppShell activePage="Reports">
      <div className="flex-1 flex flex-col min-h-0 bg-background overflow-auto">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-border bg-card shrink-0 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Data & Reports</h2>
            <p className="text-sm text-muted-foreground mt-1">Aggregated statistics, history logs, and data exports</p>
          </div>
          <div className="flex bg-secondary p-1 rounded-md border border-border">
            {["24h", "7d"].map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-1.5 text-xs font-medium rounded transition-colors ${
                  period === p 
                    ? "bg-background text-foreground shadow-sm border border-border/50" 
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-6">
          
          {/* Top Stats Grid */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-card border border-border rounded-lg p-4 flex flex-col justify-center">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Availability ({period})</div>
              <div className="text-2xl font-mono text-foreground font-semibold">100%</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex flex-col justify-center">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Run Hours</div>
              <div className="text-2xl font-mono text-foreground font-semibold">{period === '24h' ? '24.0' : '168.0'} <span className="text-sm font-sans text-muted-foreground">hrs</span></div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex flex-col justify-center">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Sensor Exceedances</div>
              <div className="text-2xl font-mono text-healthy font-semibold">0</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex flex-col justify-center">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Data Points Collected</div>
              <div className="text-2xl font-mono text-foreground font-semibold">{period === '24h' ? '8,640' : '60,480'}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            
            {/* Min/Avg/Max Table */}
            <div className="col-span-2 bg-card border border-border rounded-lg overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-border bg-secondary/50 flex justify-between items-center">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sensor Aggregates</h3>
                <button className="flex items-center gap-2 px-3 py-1 text-xs border border-border hover:bg-secondary rounded text-foreground transition-colors">
                  <Download className="w-3 h-3" />
                  Export CSV
                </button>
              </div>
              <div className="p-0 overflow-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-background text-xs uppercase text-muted-foreground font-mono">
                    <tr>
                      <th className="px-4 py-3 font-medium border-b border-border">Sensor</th>
                      <th className="px-4 py-3 font-medium border-b border-border">Min</th>
                      <th className="px-4 py-3 font-medium border-b border-border">Avg</th>
                      <th className="px-4 py-3 font-medium border-b border-border">Max</th>
                      <th className="px-4 py-3 font-medium border-b border-border">Unit</th>
                      <th className="px-4 py-3 font-medium border-b border-border">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stats.map((row) => (
                      <tr key={row.sensor} className="hover:bg-secondary/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{row.sensor}</td>
                        <td className="px-4 py-3 font-mono text-muted-foreground">{row.min}</td>
                        <td className="px-4 py-3 font-mono text-foreground font-medium">{row.avg}</td>
                        <td className="px-4 py-3 font-mono text-muted-foreground">{row.max}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{row.unit}</td>
                        <td className={`px-4 py-3 text-xs font-medium ${row.statusColor || 'text-healthy'}`}>
                          {row.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Side Panels */}
            <div className="col-span-1 flex flex-col gap-6">
              {/* All-Time Stats */}
              <div className="bg-card border border-border rounded-lg p-5">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">All-Time Statistics</h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center border-b border-border pb-2">
                    <span className="text-muted-foreground text-sm">Total Run Hours</span>
                    <span className="font-mono text-foreground">2,847</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-border pb-2">
                    <span className="text-muted-foreground text-sm">Total Starts</span>
                    <span className="font-mono text-foreground">47</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-border pb-2">
                    <span className="text-muted-foreground text-sm">MTBF</span>
                    <span className="font-mono text-foreground">60.6 hrs</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">Total Records</span>
                    <span className="font-mono text-foreground">847,293</span>
                  </div>
                </div>
              </div>

              {/* Data Quality */}
              <div className="bg-card border border-border rounded-lg p-5 flex-1">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">Data Quality & Confidence</h3>
                <div className="space-y-3 mb-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">Quality Score</span>
                    <span className="font-mono text-healthy font-semibold">99.2%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">Flagged Sensors</span>
                    <span className="font-mono text-foreground">0</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">Outlier Count (24h)</span>
                    <span className="font-mono text-muted-foreground">3 <span className="text-[10px] font-sans">(resolved)</span></span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">Limit Violations</span>
                    <span className="font-mono text-foreground">0</span>
                  </div>
                </div>
                <div className="pt-3 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
                  <Check className="w-4 h-4 text-healthy" />
                  All 6 sensors passing validity checks
                </div>
              </div>
            </div>

          </div>

          {/* History Table */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-secondary/50">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Recent Readings</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left whitespace-nowrap">
                <thead className="bg-background text-xs uppercase text-muted-foreground font-mono">
                  <tr>
                    <th className="px-4 py-3 font-medium border-b border-border">Timestamp</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Flow (m³/h)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Speed (RPM)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Vib (mm/s)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Suc P (bar)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Dis P (bar)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Temp (°C)</th>
                    <th className="px-4 py-3 font-medium border-b border-border">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono text-sm">
                  {history.map((row, i) => (
                    <tr key={i} className="hover:bg-secondary/30 text-muted-foreground">
                      <td className="px-4 py-2.5 text-foreground">{row.t}</td>
                      <td className="px-4 py-2.5">{row.f.toFixed(1)}</td>
                      <td className="px-4 py-2.5">{row.s}</td>
                      <td className="px-4 py-2.5">{row.v.toFixed(1)}</td>
                      <td className="px-4 py-2.5">{row.sp.toFixed(2)}</td>
                      <td className="px-4 py-2.5">{row.dp.toFixed(2)}</td>
                      <td className="px-4 py-2.5">{row.mt.toFixed(1)}</td>
                      <td className="px-4 py-2.5">
                        <span className="bg-healthy-subtle text-healthy font-sans text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-healthy/20">Running</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Engineering Tools Section */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button 
              onClick={() => setToolsOpen(!toolsOpen)}
              className="w-full px-4 py-3 bg-secondary/30 hover:bg-secondary/50 flex items-center justify-between text-sm font-semibold uppercase tracking-wider text-muted-foreground transition-colors"
            >
              <span>Engineering Tools</span>
              {toolsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            
            {toolsOpen && (
              <div className="p-5 bg-card flex gap-8 border-t border-border">
                
                <div className="flex-1 space-y-4">
                  <h4 className="text-sm font-medium text-foreground border-b border-border pb-2">Manual Reading Entry</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground font-mono">Flow Rate</label>
                      <input type="text" placeholder="Value" className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground font-mono">Shaft Speed</label>
                      <input type="text" placeholder="Value" className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground font-mono">Vibration</label>
                      <input type="text" placeholder="Value" className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground font-mono">Motor Temp</label>
                      <input type="text" placeholder="Value" className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-primary" />
                    </div>
                  </div>
                  <button className="mt-2 bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-medium hover:bg-primary/90 transition-colors">
                    Submit Readings
                  </button>
                </div>

                <div className="w-px bg-border" />

                <div className="w-64 space-y-4">
                  <h4 className="text-sm font-medium text-foreground border-b border-border pb-2">System Actions</h4>
                  <div className="space-y-3">
                    <button className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-border hover:bg-secondary rounded text-sm text-foreground transition-colors">
                      <Zap className="w-4 h-4 text-primary" />
                      Force Data Resync
                    </button>
                    <button className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-border hover:bg-secondary rounded text-sm text-foreground transition-colors">
                      <Download className="w-4 h-4" />
                      Export Full Dataset
                    </button>
                  </div>
                </div>

              </div>
            )}
          </div>

        </div>
      </div>
    </AppShell>
  );
}
