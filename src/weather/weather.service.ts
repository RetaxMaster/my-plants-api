import { Injectable, Logger } from '@nestjs/common';
import { OpenMeteoClient, type CurrentWeather } from './open-meteo.client.js';

interface CacheEntry { value: CurrentWeather; at: number }
const TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

@Injectable()
export class WeatherService {
  private readonly log = new Logger(WeatherService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly client: OpenMeteoClient) {}

  // Returns fresh weather, a still-valid cache hit, a stale cache on failure, or null if we
  // have nothing. The scheduler treats null as "neutral" — it never throws here.
  async forCity(cityId: string, latitude: number, longitude: number): Promise<CurrentWeather | null> {
    const hit = this.cache.get(cityId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    try {
      const value = await this.client.fetch(latitude, longitude);
      this.cache.set(cityId, { value, at: Date.now() });
      return value;
    } catch (err) {
      this.log.warn(`Open-Meteo failed for ${cityId}; using ${hit ? 'stale cache' : 'no'} weather: ${String(err)}`);
      return hit?.value ?? null;
    }
  }
}
