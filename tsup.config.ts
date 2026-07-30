import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: true,
  minify: false,
  sourcemap: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
