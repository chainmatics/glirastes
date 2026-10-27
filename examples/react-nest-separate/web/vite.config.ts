import { defineConfig } from 'vite';

// The API runs on its own origin; the dev server forwards /api with the browser's cookie.
export default defineConfig({
  server: { proxy: { '/api': { target: process.env.API_ORIGIN ?? 'http://127.0.0.1:4000' } } },
});
