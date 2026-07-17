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
    // Boot the full app ONE file at a time. Each e2e file boots its own AppModule, whose startup
    // recompute (onApplicationBootstrap → recomputeAll) writes shared rows (e.g. due_caches). Two
    // boots in parallel race on those writes and MariaDB rejects one (error 1020, "record has
    // changed since last read"). Production boots a single app, so serial files mirror reality.
    fileParallelism: false,
    // Keep the full-app boot hermetic: satisfy the required engine vars with dummies and keep the
    // realtime engine inert (no port binding, no claude spawn) during e2e. Vitest sets these before
    // load-env-file runs, and dotenv does not override already-set vars.
    env: {
      KNOWLEDGE_CHAT_ENGINE_ENABLED: 'false',
      KNOWLEDGE_CHAT_ENGINE_SECRET: 'x'.repeat(16),
      KNOWLEDGE_ENGINE_CWD: '/tmp/knowledge-engine-e2e',
      // The Plant Doctor engine has the same required-no-default keys; supply dummies and keep it inert
      // (no port binding, no CLI spawn) so EVERY e2e file boots — not just the doctor spec.
      PLANT_DOCTOR_ENGINE_ENABLED: 'false',
      PLANT_DOCTOR_CHAT_ENGINE_SECRET: 'x'.repeat(16),
      PLANT_DOCTOR_ENGINE_CWD: '/tmp/plant-doctor-e2e',
    },
  },
});
