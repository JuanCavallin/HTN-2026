import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev, so there is no CORS to configure and SSE passes
      // straight through. Do NOT set ws:true here — it breaks the SSE route.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
