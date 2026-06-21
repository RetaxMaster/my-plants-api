import { Injectable, Logger } from '@nestjs/common';

export interface CitySearchResult {
  name: string;
  country: string;
  admin1: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

interface RawResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  country?: string;
  admin1?: string;
}

@Injectable()
export class OpenMeteoGeocodingClient {
  private readonly log = new Logger(OpenMeteoGeocodingClient.name);

  // Proxies Open-Meteo's free, key-less geocoding API. Mirrors the weather client's
  // failure posture: any network/HTTP error degrades to [] and is logged, never thrown,
  // so the endpoint stays available even when the upstream is down.
  async search(query: string): Promise<CitySearchResult[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', q);
    url.searchParams.set('count', '10');
    url.searchParams.set('language', 'es');
    url.searchParams.set('format', 'json');

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
      const data = (await res.json()) as { results?: RawResult[] };
      return (data.results ?? []).map((r) => ({
        name: r.name,
        country: r.country ?? '',
        admin1: r.admin1 ?? '',
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone,
      }));
    } catch (err) {
      this.log.warn(`Geocoding failed for "${q}"; returning []: ${String(err)}`);
      return [];
    }
  }
}
