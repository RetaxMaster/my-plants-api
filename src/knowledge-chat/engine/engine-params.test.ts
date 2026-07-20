import { describe, it, expect } from 'vitest';
import { knowledgeEngineParams, doctorEngineParams } from './engine-params.js';
import type { Env } from '../../config/env.js';

const env = {
  KNOWLEDGE_CHAT_ENGINE_ENABLED: true,
  KNOWLEDGE_ENGINE_CWD: '/tmp/ke',
  KNOWLEDGE_CHAT_ENGINE_PORT: 8010,
  KNOWLEDGE_CHAT_ENGINE_SECRET: 'x'.repeat(16),
  KNOWLEDGE_CHAT_LOG_DIR: '/tmp/ke-logs',
  KNOWLEDGE_CHAT_STATE_DIR: '/tmp/ke-state',
  KNOWLEDGE_CHAT_UPLOAD_DIR: '/tmp/ke-uploads',
  PLANT_DOCTOR_ENGINE_ENABLED: true,
  PLANT_DOCTOR_ENGINE_CWD: '/tmp/pd',
  PLANT_DOCTOR_CHAT_ENGINE_PORT: 8400,
  PLANT_DOCTOR_CHAT_ENGINE_SECRET: 'x'.repeat(16),
  PLANT_DOCTOR_LOG_DIR: '/tmp/pd-logs',
  PLANT_DOCTOR_STATE_DIR: '/tmp/pd-state',
  PLANT_DOCTOR_UPLOAD_DIR: '/tmp/pd-uploads',
} as unknown as Env;

describe('engine params carry a per-engine upload dir', () => {
  it('gives each engine its OWN upload root — never a shared one', () => {
    expect(knowledgeEngineParams(env).uploadDir).toBe('/tmp/ke-uploads');
    expect(doctorEngineParams(env).uploadDir).toBe('/tmp/pd-uploads');
    expect(knowledgeEngineParams(env).uploadDir).not.toBe(doctorEngineParams(env).uploadDir);
  });
});
