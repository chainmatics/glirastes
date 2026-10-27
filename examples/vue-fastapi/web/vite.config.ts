import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// The chat runtime and the FastAPI app run on their own origins; the dev
// server forwards /api/chat to the runtime and every other /api path to FastAPI.
export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('glirastes-') } } })],
  server: {
    proxy: {
      '/api/chat': { target: process.env.RUNTIME_ORIGIN ?? 'http://127.0.0.1:8787' },
      '/api': { target: process.env.API_ORIGIN ?? 'http://127.0.0.1:8000' },
    },
  },
});
