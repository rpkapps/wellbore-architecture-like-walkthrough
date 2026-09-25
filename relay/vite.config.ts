import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/** Bundles the relay into one file for Node: `node relay/dist/relay.mjs relay.config.json`. */
export default defineConfig({
  // the app's public data has no place in the relay
  publicDir: false,
  build: {
    ssr: 'relay/server.ts',
    outDir: 'relay/dist',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'bufferutil', 'utf-8-validate'],
      output: { entryFileNames: 'relay.mjs', format: 'es', inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
});
