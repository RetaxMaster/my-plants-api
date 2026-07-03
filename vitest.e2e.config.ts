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
    // Keep the full-app boot hermetic: satisfy the required engine vars with dummies and keep the
    // realtime engine inert (no port binding, no claude spawn) during e2e. Vitest sets these before
    // load-env-file runs, and dotenv does not override already-set vars.
    env: {
      KNOWLEDGE_CHAT_ENGINE_ENABLED: 'false',
      KNOWLEDGE_CHAT_ENGINE_SECRET: 'x'.repeat(16),
      KNOWLEDGE_ENGINE_CWD: '/tmp/knowledge-engine-e2e',
    },
  },
});
