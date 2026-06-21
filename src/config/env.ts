import { z } from 'zod';

const dbSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
});

export const envSchema = dbSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  DEFAULT_CITY_TZ: z.string().min(1).default('America/Mexico_City'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('30d'),
});

export type DbEnv = z.infer<typeof dbSchema>;
export type Env = z.infer<typeof envSchema>;

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbSchema.parse(source);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
