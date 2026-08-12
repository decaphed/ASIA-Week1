import { useCallback, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import Toast from './components/Toast.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import PredictionsPage from './pages/PredictionsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import { api } from './api/client.js';
import { usePolling } from './hooks/usePolling.js';
import { useLiveBuffer } from './hooks/useLiveBuffer.js';

export default function App() {
  const [page, setPage] = useState('overview');
  // Navigating from a "review" CTA should land on that tab, not Forecast.
  const [predictionsTab, setPredictionsTab] = useState('forecast');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, accent = '#8fb8dd') => {
    setToast({ msg, accent });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  // Ticks at 1 Hz. Only Overview and Reports receive it; Sidebar, TopBar,
  // Analytics and Predictions are memoised so they don't re-render every
  // second for data they never display.
  const live = useLiveBuffer(1000);
  const liveOk = live.connected && !live.stale;

  const { data: whoamiRes } = usePolling(() => api.whoami(), 60000, []);
  const identity = whoamiRes?.data ?? null;
  const reviewer = identity?.username || 'Local Engineer';
  // Authentik doesn't expose a job title, so the sidebar shows the account's
  // first group as its stand-in — falls back to the default label in
  // Sidebar.jsx when there's no identity (dev/local access) or no group.
  const title = identity?.groups?.[0];

  const { data: eventsRes, refresh: refreshEvents } = usePolling(() => api.faultEvents(), 15000, []);
  const flagged = useMemo(
    () => (eventsRes?.data ?? []).filter((e) => e.eventType === 'FLAGGED'),
    [eventsRes]
  );
  const queue = useMemo(() => flagged.filter((e) => e.status === 'PENDING_REVIEW'), [flagged]);
  const audit = useMemo(() => flagged.filter((e) => e.status !== 'PENDING_REVIEW'), [flagged]);

  const goReview = useCallback(() => {
    setPredictionsTab('review');
    setPage('predictions');
  }, []);

  const onLogout = useCallback(() => {
    if (identity?.username) {
      // Authentik forward-auth sign-out, routed by Traefik on this host.
      window.location.href = '/outpost.goauthentik.io/sign_out';
    } else {
      showToast('No SSO session — direct/dev access is not signed in', '#9fb0bf');
    }
  }, [identity, showToast]);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#F1F4F8', color: '#1a2530', fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 14, overflow: 'hidden' }}>
      <Sidebar
        page={page}
        onNavigate={setPage}
        pendingCount={queue.length}
        connected={liveOk}
        reviewer={reviewer}
        title={title}
        onLogout={onLogout}
      />
      <main style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        <TopBar page={page} live={liveOk} pendingCount={queue.length} onOpenReview={goReview} />
        {page === 'overview' && <OverviewPage live={live} queue={queue} goReview={goReview} />}
        {page === 'analytics' && <AnalyticsPage />}
        {page === 'predictions' && (
          <PredictionsPage
            tab={predictionsTab}
            setTab={setPredictionsTab}
            queue={queue}
            audit={audit}
            reviewer={reviewer}
            showToast={showToast}
            goReview={goReview}
            refreshEvents={refreshEvents}
          />
        )}
        {page === 'reports' && (
          <ReportsPage live={live} queue={queue} audit={audit} showToast={showToast} />
        )}
      </main>
      <Toast toast={toast} />
    </div>
  );
}
