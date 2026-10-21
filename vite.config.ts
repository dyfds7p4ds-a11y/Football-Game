import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset URL relative, so the same build works on
// GitHub Pages (served from /<repo>/), on a LAN dev box and from file hosting.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
  test: { include: [process.env.BALANCE ? 'scripts/' + process.env.BALANCE + '.test.ts' : 'tests/**/*.test.ts'], environment: 'node' },
});
