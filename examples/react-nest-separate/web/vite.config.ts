import { defineConfig, searchForWorkspaceRoot } from 'vite';

// The API runs on its own origin; the dev server forwards /api with the browser's cookie.
// GLIRASTES_SDK_DIR: only for the SDK's own browser proof, which links the unpublished SDK.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(process.env.GLIRASTES_SDK_DIR ? [process.env.GLIRASTES_SDK_DIR] : [])] },
    proxy: { '/api': { target: process.env.API_ORIGIN ?? 'http://127.0.0.1:4000' } },
  },
});
