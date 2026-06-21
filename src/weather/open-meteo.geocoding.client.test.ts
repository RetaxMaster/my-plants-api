import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenMeteoGeocodingClient } from './open-meteo.geocoding.client.js';

const client = new OpenMeteoGeocodingClient();

afterEach(() => vi.restoreAllMocks());

function mockFetch(impl: () => Promise<Partial<Response>>) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
}

describe('OpenMeteoGeocodingClient.search', () => {
  it('maps Open-Meteo results to CitySearchResult[]', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            name: 'Guadalajara',
            latitude: 20.6668,
            longitude: -103.3918,
            timezone: 'America/Mexico_City',
            country: 'Mexico',
            admin1: 'Jalisco',
          },
        ],
      }),
    }));
    const out = await client.search('guadalajara');
    expect(out).toEqual([
      {
        name: 'Guadalajara',
        country: 'Mexico',
        admin1: 'Jalisco',
        latitude: 20.6668,
        longitude: -103.3918,
        timezone: 'America/Mexico_City',
      },
    ]);
  });

  it('returns [] when the API omits results (no match)', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(await client.search('zzzznotacity')).toEqual([]);
  });

  it('returns [] (never throws) on a non-ok HTTP status', async () => {
    mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await client.search('x')).toEqual([]);
  });

  it('returns [] (never throws) on a network error', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    expect(await client.search('x')).toEqual([]);
  });

  it('returns [] for a blank query without calling fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    expect(await client.search('   ')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defaults missing country/admin1 to empty strings', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        results: [{ name: 'Somewhere', latitude: 1, longitude: 2, timezone: 'UTC' }],
      }),
    }));
    const out = await client.search('somewhere');
    expect(out[0]).toEqual({
      name: 'Somewhere',
      country: '',
      admin1: '',
      latitude: 1,
      longitude: 2,
      timezone: 'UTC',
    });
  });
});
