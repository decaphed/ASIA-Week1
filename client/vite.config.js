import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ─────────────────────────────────────────────────────────────────────────
// Vite configuration.
//
// • plugin-react  → enables JSX + fast refresh (hot reload).
// • server.port   → dev server runs on 5173 (matches the backend's CORS
//                   CLIENT_ORIGIN).
// • server.proxy  → OPTIONAL convenience: forwards /api/* to the backend so
//   the browser makes same-origin requests during development (no CORS at
//   all). It only kicks in if VITE_API_URL is left as the relative "/api".
//   Our .env.example uses the full http://localhost:3000/api instead, which
//   also works because the backend enables CORS — either approach is fine.
// ─────────────────────────────────────────────────────────────────────────
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
