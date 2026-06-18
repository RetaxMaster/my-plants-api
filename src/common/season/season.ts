import type { Season } from '@retaxmaster/my-plants-species-schema';

export type Hemisphere = 'north' | 'south';

const NORTH: Season[] = ['winter', 'spring', 'summer', 'autumn'];

// Meteorological seasons by month index (0-11): DJF winter, MAM spring, JJA summer, SON autumn.
export function seasonForDate(date: Date, hemisphere: Hemisphere): Season {
  const m = date.getUTCMonth();
  const idx = m === 11 ? 0 : Math.floor(((m + 1) % 12) / 3); // 0 winter..3 autumn
  const north = NORTH[idx];
  if (hemisphere === 'north') return north;
  const flip: Record<Season, Season> = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' };
  return flip[north];
}

export function hemisphereForLatitude(latitude: number): Hemisphere {
  return latitude >= 0 ? 'north' : 'south';
}
