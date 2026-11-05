import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Everything must be an external file with a URL so the manifest can list it.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    minify: 'esbuild',
  },
});
