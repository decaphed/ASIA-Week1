import React, { useState } from "react";
import { 
  Activity, 
  BarChart2, 
  BrainCircuit, 
  FileText, 
  Settings, 
  LogOut,
  Signal,
  Server,
  Database,
  Sun,
  Moon,
} from "lucide-react";
import "./../_group.css";

export type PageType = "Overview" | "Analytics" | "Predict" | "Reports";

interface AppShellProps {
  activePage: PageType;
  children: React.ReactNode;
}

export function AppShell({ activePage, children }: AppShellProps) {
  const [lightMode, setLightMode] = useState(false);

  const navItems = [
    { name: "Overview", icon: Activity },
    { name: "Analytics", icon: BarChart2 },
    { name: "Predict", icon: BrainCircuit },
    { name: "Reports", icon: FileText },
  ];

  return (
    <div className={`pump-dashboard${lightMode ? " light-mode" : ""} flex h-screen w-full overflow-hidden text-sm`}>
      {/* Sidebar */}
      <div className="w-[220px] flex-shrink-0 border-r border-border bg-[hsl(var(--sidebar))] flex flex-col justify-between">
        <div>
          {/* Logo */}
          <div className="h-14 flex items-center px-4" style={{ borderBottom: "1px solid hsl(var(--sidebar-border))" }}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded flex items-center justify-center" style={{ backgroundColor: "hsl(var(--sidebar-primary))" }}>
                <Activity className="w-4 h-4" style={{ color: "hsl(var(--sidebar-primary-foreground))" }} />
              </div>
              <span className="font-bold tracking-widest text-xs uppercase" style={{ color: "hsl(var(--sidebar-foreground))" }}>Pumpwatch</span>
            </div>
          </div>

          {/* Nav */}
          <nav className="p-2 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.name}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left"
                style={activePage === item.name
                  ? { backgroundColor: "hsl(var(--sidebar-accent))", color: "hsl(var(--sidebar-primary))", fontWeight: 500 }
                  : { color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Bottom Section */}
        <div className="p-2 space-y-1 mt-auto" style={{ borderTop: "1px solid hsl(var(--sidebar-border))" }}>
          {/* Theme toggle */}
          <button
            onClick={() => setLightMode(m => !m)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left"
            style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.7 }}
          >
            {lightMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span className="text-xs">{lightMode ? "Light Mode" : "Dark Mode"}</span>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "hsl(var(--sidebar-accent))", color: "hsl(var(--sidebar-primary))" }}>
              {lightMode ? "ON" : "ON"}
            </span>
          </button>

          <div className="px-3 py-1 text-xs mb-1" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.45 }}>
            System Status
          </div>
          <div className="px-3 flex flex-col gap-2 mb-3">
            <div className="flex items-center justify-between text-xs" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}>
              <span className="flex items-center gap-2"><Signal className="w-3 h-3"/> API</span>
              <span className="w-2 h-2 rounded-full bg-healthy animate-pulse"></span>
            </div>
            <div className="flex items-center justify-between text-xs" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}>
              <span className="flex items-center gap-2"><Server className="w-3 h-3"/> Network</span>
              <span className="w-2 h-2 rounded-full bg-healthy"></span>
            </div>
            <div className="flex items-center justify-between text-xs" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}>
              <span className="flex items-center gap-2"><Database className="w-3 h-3"/> Data Feed</span>
              <span className="w-2 h-2 rounded-full bg-healthy"></span>
            </div>
          </div>

          <div className="h-px mx-2" style={{ backgroundColor: "hsl(var(--sidebar-border))" }} />

          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}>
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left" style={{ color: "hsl(var(--sidebar-foreground))", opacity: 0.6 }}>
            <LogOut className="w-4 h-4" />
            <span>Log out</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto bg-background flex flex-col">
        {children}
      </div>
    </div>
  );
}
