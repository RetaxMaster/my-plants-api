export interface DbParts {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
}

// Assemble the Prisma/MySQL connection string from separate parts. Never hand-author it.
export function buildDatabaseUrl(p: DbParts): string {
  const user = encodeURIComponent(p.DB_USER);
  const pass = encodeURIComponent(p.DB_PASSWORD);
  return `mysql://${user}:${pass}@${p.DB_HOST}:${p.DB_PORT}/${p.DB_NAME}`;
}
