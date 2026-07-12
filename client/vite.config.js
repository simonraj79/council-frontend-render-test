import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite builds the SPA to client/dist, which the Express server serves as static root.
// A dev proxy forwards /api to the local Express server so `vite dev` works end-to-end.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
