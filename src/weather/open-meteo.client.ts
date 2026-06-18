import { Injectable } from '@nestjs/common';

export interface CurrentWeather {
  tempC: number;
  humidityPct: number;
  seasonalLowC: number;
  seasonalHighC: number;
}

@Injectable()
export class OpenMeteoClient {
  // Current conditions + the day's min/max. NOTE (v1 proxy): seasonalLowC/seasonalHighC are
  // the *today* forecast min/max — a coarse stand-in for true seasonal extremes used by the
  // viability semaphore. A later version can widen this to a multi-day forecast or climate
  // normals; the contract (low/high pair) stays the same.
  async fetch(latitude: number, longitude: number): Promise<CurrentWeather> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m');
    url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'auto');

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = (await res.json()) as {
      current: { temperature_2m: number; relative_humidity_2m: number };
      daily: { temperature_2m_min: number[]; temperature_2m_max: number[] };
    };
    return {
      tempC: data.current.temperature_2m,
      humidityPct: data.current.relative_humidity_2m,
      seasonalLowC: data.daily.temperature_2m_min[0],
      seasonalHighC: data.daily.temperature_2m_max[0],
    };
  }
}
