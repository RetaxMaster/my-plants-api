import { describe, expect, it, vi } from 'vitest';
import { WeatherService } from './weather.service.js';
import type { OpenMeteoClient, CurrentWeather } from './open-meteo.client.js';

const sample: CurrentWeather = { tempC: 22, humidityPct: 50, seasonalLowC: 16, seasonalHighC: 28 };

function makeService(fetchImpl: () => Promise<CurrentWeather>) {
  const client = { fetch: vi.fn(fetchImpl) } as unknown as OpenMeteoClient;
  return { svc: new WeatherService(client), client };
}

describe('WeatherService.forLocation', () => {
  it('fetches on a cache miss and returns the value', async () => {
    const { svc, client } = makeService(async () => sample);
    const out = await svc.forLocation('19.43,-99.13', 19.43, -99.13);
    expect(out).toEqual(sample);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses the cache for the same key within TTL (no second fetch)', async () => {
    const { svc, client } = makeService(async () => sample);
    await svc.forLocation('k', 1, 2);
    await svc.forLocation('k', 1, 2);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('keys the cache per location (different keys each fetch once)', async () => {
    const { svc, client } = makeService(async () => sample);
    await svc.forLocation('a', 1, 2);
    await svc.forLocation('b', 3, 4);
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns null on failure with an empty cache', async () => {
    const { svc } = makeService(async () => {
      throw new Error('down');
    });
    expect(await svc.forLocation('k', 1, 2)).toBeNull();
  });
});

describe('WeatherService.forCity', () => {
  it('delegates to forLocation using cityId as the cache key', async () => {
    const { svc, client } = makeService(async () => sample);
    const out = await svc.forCity('city-1', 1, 2);
    expect(out).toEqual(sample);
    // Same city id is a cache hit -> still one fetch.
    await svc.forCity('city-1', 1, 2);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
});
