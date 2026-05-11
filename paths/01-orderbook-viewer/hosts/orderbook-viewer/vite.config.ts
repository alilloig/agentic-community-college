import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal host for the Orderbook Viewer lesson workspace. The lesson App.tsx
// fetches "/api/faucet/manifest" — the proxy below forwards that to the
// running deepbook-sandbox API at localhost:9009, matching the dashboard's
// integration shape.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:9009',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
