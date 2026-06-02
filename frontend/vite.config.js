import { defineConfig } from 'vite';

// Vite runs from this folder (root scripts call `vite build frontend` /
// `vite ... frontend`). No @vitejs/plugin-react: Vite's esbuild compiles the
// .jsx sources directly, keeping the dependency set to what the root already
// ships (vite, react, react-dom, lucide-react).
//
// Output goes to frontend/dist, which the backend serves via express.static
// (see src/app.js). In dev, /v1 is proxied to the local API.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/v1': { target: 'http://127.0.0.1:4420', changeOrigin: true },
    },
  },
});
