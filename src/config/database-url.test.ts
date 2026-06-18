import { describe, expect, it } from 'vitest';
import { buildDatabaseUrl } from './database-url.js';

describe('buildDatabaseUrl', () => {
  it('assembles a MySQL URL from separate parts and URL-encodes the password', () => {
    const url = buildDatabaseUrl({
      DB_HOST: 'localhost',
      DB_PORT: 3306,
      DB_USER: 'my_plants',
      DB_PASSWORD: 'p@ss/word',
      DB_NAME: 'my_plants',
    });
    expect(url).toBe('mysql://my_plants:p%40ss%2Fword@localhost:3306/my_plants');
  });
});
