import React from "react";
import { AppShell } from "./_shared/AppShell";
import "./_group.css";
import { BrainCircuit, Info, AlertCircle, Clock, TrendingUp, CheckCircle2 } from "lucide-react";

export default function Predict() {
  return (
    <AppShell activePage="Predict">
      <div className="flex-1 flex flex-col min-h-0 bg-background overflow-auto">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-border bg-card shrink-0">
          <h2 className="text-lg font-semibold text-foreground">Predictive Maintenance</h2>
          <p className="text-sm text-muted-foreground mt-1">AI-driven failure forecasting and short-term statistical outlook</p>
        </div>

        <div className="p-6 space-y-8">
          
          {/* AI Prediction Section (Placeholder) */}
          <section>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-primary" />
                AI Failure Prediction
              </h3>
              <span className="bg-secondary text-muted-foreground text-[10px] uppercase font-mono px-2 py-0.5 rounded border border-border">
                Model training in progress
              </span>
            </div>

            <div className="grid grid-cols-4 gap-4 opacity-50 grayscale select-none pointer-events-none">
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-xs text-muted-foreground uppercase mb-2">Failure Risk (7d)</div>
                <div className="text-2xl font-mono text-muted-foreground">--</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-xs text-muted-foreground uppercase mb-2">Suggested Maintenance</div>
                <div className="text-2xl font-mono text-muted-foreground">--</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-xs text-muted-foreground uppercase mb-2">Likely Failed Component</div>
                <div className="text-2xl font-mono text-muted-foreground">--</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-xs text-muted-foreground uppercase mb-2">Est. Remaining Life</div>
                <div className="text-2xl font-mono text-muted-foreground">--</div>
              </div>
            </div>

            <div className="mt-4 bg-secondary/50 border border-border rounded-lg p-4 flex gap-4 items-start">
              <Info className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The predictive neural network requires a minimum of 30 days of continuous operational data to establish a reliable baseline. Data collection began 12 days ago. Predictions will become available in approximately 18 days.
                </p>
                <div className="space-y-1.5 w-1/2">
                  <div className="flex justify-between text-xs text-muted-foreground font-mono">
                    <span>Data collection progress</span>
                    <span>40%</span>
                  </div>
                  <div className="h-1.5 w-full bg-background rounded-full overflow-hidden border border-border">
                    <div className="h-full bg-primary/50 w-[40%]" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Short-Term Outlook Section (Live) */}
          <section>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">Short-Term Forecast</h3>
              <span className="bg-primary/10 text-primary text-[10px] uppercase font-mono px-2 py-0.5 rounded border border-primary/20">
                Interim — statistical trend projection
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Next 60 Mins Card */}
              <div className="bg-card border border-border rounded-lg p-5 flex flex-col">
                <div className="flex items-center gap-2 text-foreground font-medium mb-4">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  Next 60 Minutes Outlook
                </div>
                
                <div className="space-y-3 flex-1">
                  <div className="flex justify-between items-center text-sm p-2 rounded bg-background border border-border">
                    <span className="text-muted-foreground">Flow Rate</span>
                    <span className="font-mono text-foreground">Stable at ~78 m³/h</span>
                  </div>
                  <div className="flex justify-between items-center text-sm p-2 rounded bg-background border border-border">
                    <span className="text-muted-foreground">Pressure (Suc/Dis)</span>
                    <span className="font-mono text-foreground">Stable</span>
                  </div>
                  <div className="flex justify-between items-center text-sm p-2 rounded bg-background border border-border">
                    <span className="text-muted-foreground">Vibration</span>
                    <span className="font-mono text-foreground">Stable</span>
                  </div>
                  <div className="flex justify-between items-center text-sm p-2 rounded bg-warning/10 border border-warning/30">
                    <span className="text-warning font-medium">Motor Temperature</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-warning">74.1°C <TrendingUp className="inline w-3 h-3"/> 75.3°C</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-healthy shrink-0 mt-0.5" />
                  <span className="text-sm text-muted-foreground">No exceedances of warning or alarm thresholds are forecast in the next 60 minutes.</span>
                </div>
              </div>

              {/* Risk Factors Card */}
              <div className="bg-card border border-border rounded-lg p-5 flex flex-col">
                <div className="flex items-center gap-2 text-foreground font-medium mb-4">
                  <AlertCircle className="w-4 h-4 text-muted-foreground" />
                  Identified Risk Factors
                </div>

                <div className="space-y-4 flex-1">
                  <div className="border-l-2 border-warning pl-3 space-y-1">
                    <div className="text-sm text-foreground font-medium">Motor temperature upward trend</div>
                    <div className="text-xs text-muted-foreground">Current rate of increase is 1.2°C/h. This is considered a low-urgency concern as it remains well below the 82.0°C warning threshold.</div>
                  </div>
                  
                  <div className="border-l-2 border-healthy pl-3 space-y-1">
                    <div className="text-sm text-foreground font-medium">Hydraulics nominal</div>
                    <div className="text-xs text-muted-foreground">No cavitation signatures detected in vibration or pressure data.</div>
                  </div>

                  <div className="border-l-2 border-healthy pl-3 space-y-1">
                    <div className="text-sm text-foreground font-medium">Mechanicals nominal</div>
                    <div className="text-xs text-muted-foreground">Bearing frequencies remain within baseline limits.</div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Next recommended action:</span> Inspect motor cooling fins and ambient ventilation during next scheduled walkaround. No immediate action required.
                </div>
              </div>
            </div>

          </section>

        </div>
      </div>
    </AppShell>
  );
}
