import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS relies on emitted decorator metadata for DI / class-validator. Vitest's default
  // esbuild transform drops it, so the in-process Nest app 500s. unplugin-swc transforms the
  // TS with SWC honoring the tsconfig's experimentalDecorators + emitDecoratorMetadata.
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    globals: true,
    hookTimeout: 30000,
  },
});
