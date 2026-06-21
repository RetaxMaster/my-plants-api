import { LIGHT_LEVELS, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import { effectiveConditions } from './indoor-climate.js';
import { placeLightRank } from '../places/place-conditions.js';
import type { LightType } from '@prisma/client';

export interface ViabilityInput {
  survivalMinC: number;
  survivalMaxC: number;
  minLightRank: number;
  minHumidityPct: number;
  seasonalLowC: number;
  seasonalHighC: number;
  placeLightRank: number;
  effectiveHumidityPct: number;
}

export type ViabilityLevel = 'good' | 'caution' | 'poor';

export interface ViabilityResult {
  level: ViabilityLevel;
  reasons: string[];
}

export function assessViability(i: ViabilityInput): ViabilityResult {
  const reasons: string[] = [];
  let poor = false;
  let caution = false;

  if (i.seasonalLowC < i.survivalMinC) {
    poor = true;
    reasons.push(`seasonal low ${i.seasonalLowC} °C is below the ${i.survivalMinC} °C survival minimum`);
  } else if (i.seasonalLowC < i.survivalMinC + 3) {
    caution = true;
    reasons.push(`seasonal low ${i.seasonalLowC} °C is close to the ${i.survivalMinC} °C survival minimum`);
  }

  if (i.seasonalHighC > i.survivalMaxC) {
    poor = true;
    reasons.push(`seasonal high ${i.seasonalHighC} °C is above the ${i.survivalMaxC} °C survival maximum`);
  }

  if (i.placeLightRank < i.minLightRank) {
    const gap = i.minLightRank - i.placeLightRank;
    if (gap >= 2) {
      poor = true;
      reasons.push(`light is well below the species minimum`);
    } else {
      caution = true;
      reasons.push(`light is below the species minimum`);
    }
  }

  if (i.effectiveHumidityPct < i.minHumidityPct) {
    caution = true;
    reasons.push(`humidity ${i.effectiveHumidityPct}% is below the ${i.minHumidityPct}% minimum`);
  }

  const level: ViabilityLevel = poor ? 'poor' : caution ? 'caution' : 'good';
  return { level, reasons };
}

export interface ViabilityPlace {
  indoor: boolean;
  climateControlled: boolean;
  humidityCharacter: 'DRY' | 'NORMAL' | 'HUMID';
  indoorTempMinC: number | null;
  indoorTempMaxC: number | null;
  lightType: LightType;
}

export interface ViabilityWeather {
  tempC: number;
  humidityPct: number;
  seasonalLowC: number;
  seasonalHighC: number;
}

// Maps a parsed species record + a flat place shape + (optional) weather into a ViabilityInput
// and assesses it. Flat shapes only — keeps the engines layer Prisma-free. The single source of
// truth for viability mapping; both moving.simulate and GET /plants/:id/care call it.
export function buildViability(
  record: SpeciesRecord,
  place: ViabilityPlace,
  weather: ViabilityWeather | null,
): ViabilityResult {
  const effective = effectiveConditions(
    {
      indoor: place.indoor,
      climateControlled: place.climateControlled,
      humidityCharacter: place.humidityCharacter,
      indoorTempMinC: place.indoorTempMinC,
      indoorTempMaxC: place.indoorTempMaxC,
    },
    weather ? { tempC: weather.tempC, humidityPct: weather.humidityPct } : null,
  );
  return assessViability({
    survivalMinC: record.temperature.survivalMinC,
    survivalMaxC: record.temperature.survivalMaxC,
    minLightRank: LIGHT_LEVELS.indexOf(record.light.minimum),
    minHumidityPct: record.humidity.minimumPct,
    seasonalLowC: weather?.seasonalLowC ?? record.temperature.idealMinC,
    seasonalHighC: weather?.seasonalHighC ?? record.temperature.idealMaxC,
    placeLightRank: placeLightRank(place.lightType),
    effectiveHumidityPct: effective.humidityPct,
  });
}
