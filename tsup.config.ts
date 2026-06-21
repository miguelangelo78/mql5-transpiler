import { defineConfig } from 'tsup';

/**
 * Build the publishable package: bundle the public API barrel (src/index.ts)
 * into a single ESM file + type declarations under dist/. Internal modules are
 * inlined; the only runtime dependency (@tickerall/sdk) and Node builtins stay
 * external. Emitted EA modules are loaded at RUNTIME via a data: URL
 * (src/loadExpert.ts), so nothing about the emit path is bundled here.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  external: ['@tickerall/sdk'],
});
