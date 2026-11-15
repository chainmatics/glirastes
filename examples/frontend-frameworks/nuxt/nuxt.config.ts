export default defineNuxtConfig({
  compatibilityDate:'2026-04-01',
  devtools:{enabled:false},
  // Development fixture only; production ingress must route to the real backend/runtime.
  nitro:{devProxy:{'/api':{target:'http://127.0.0.1:8899/api',changeOrigin:true}}},
  vite:{resolve:{dedupe:['react','react-dom']}},
});
