import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  // module workers, so the connector worker loads its rarer readers (Parquet, Arrow) on demand
  worker: { format: 'es' },
  test: {
    environment: 'node',
  },
} as never);
