import { defineConfig } from 'vitest/config';

// Relative base so the build works both on GitHub Pages (/<repo>/) and locally.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
