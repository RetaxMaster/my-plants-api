import { Injectable, Logger } from '@nestjs/common';
import { OpenMeteoClient, type CurrentWeather } from './open-meteo.client.js';

interface CacheEntry { value: CurrentWeather; at: number }
const TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

@Injectable()
export class WeatherService {
  private readonly log = new Logger(WeatherService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly client: OpenMeteoClient) {}

  // Generalized weather fetch keyed by an arbitrary string. Saved cities pass cityId;
  // ad-hoc Moving targets pass "<lat>,<lng>". Returns fresh weather, a still-valid cache
  // hit, a stale cache on failure, or null if we have nothing — never throws.
  // NOTE: ad-hoc coordinate keys make this in-memory cache unbounded across distinct
  // searched coordinates. Acceptable for local single-user; add eviction only if it matters.
  async forLocation(key: string, latitude: number, longitude: number): Promise<CurrentWeather | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    try {
      const value = await this.client.fetch(latitude, longitude);
      this.cache.set(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      this.log.warn(`Open-Meteo failed for ${key}; using ${hit ? 'stale cache' : 'no'} weather: ${String(err)}`);
      return hit?.value ?? null;
    }
  }

  // Thin wrapper: a saved city caches under its id.
  async forCity(cityId: string, latitude: number, longitude: number): Promise<CurrentWeather | null> {
    return this.forLocation(cityId, latitude, longitude);
  }
}
