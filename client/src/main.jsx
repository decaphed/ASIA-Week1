// ─────────────────────────────────────────────────────────────────────────
// main.jsx — the browser entry point.
//
// Vite loads this from index.html. It mounts the top-level <App/> component
// into the #root div. StrictMode adds extra dev-only checks and intentionally
// double-invokes effects, which is why our polling hooks must clean up their
// intervals on unmount (they do — see hooks/usePolling.js).
// ─────────────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
