import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/gateway/index.js',
    'lib/types/cron/index.js',
    'lib/types/config/index.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
