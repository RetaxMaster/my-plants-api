export interface PlaceClimateInput {
  indoor: boolean;
  climateControlled: boolean;
  humidityCharacter: 'DRY' | 'NORMAL' | 'HUMID';
  indoorTempMinC: number | null;
  indoorTempMaxC: number | null;
}

export interface Weather {
  tempC: number;
  humidityPct: number;
}

export interface EffectiveConditions {
  tempC: number;
  humidityPct: number;
}

const COMFORT_BASELINE_C = 21;
const INDOOR_HUMIDITY_BASELINE = 50;
const INDOOR_DAMPING = 0.4; // how much an indoor place tracks outdoor swings
const HUMID_INDOOR = 65;
const DRY_INDOOR = 35;

function indoorHumidity(character: PlaceClimateInput['humidityCharacter']): number {
  if (character === 'HUMID') return HUMID_INDOOR;
  if (character === 'DRY') return DRY_INDOOR;
  return INDOOR_HUMIDITY_BASELINE;
}

export function effectiveConditions(
  place: PlaceClimateInput,
  weather: Weather | null,
): EffectiveConditions {
  if (!place.indoor) {
    // Outdoor: real weather, or neutral baselines if unavailable.
    return weather ?? { tempC: COMFORT_BASELINE_C, humidityPct: INDOOR_HUMIDITY_BASELINE };
  }

  // Indoor temperature.
  let tempC: number;
  if (place.indoorTempMinC !== null && place.indoorTempMaxC !== null) {
    tempC = (place.indoorTempMinC + place.indoorTempMaxC) / 2;
  } else if (place.climateControlled || weather === null) {
    tempC = COMFORT_BASELINE_C;
  } else {
    tempC = COMFORT_BASELINE_C + INDOOR_DAMPING * (weather.tempC - COMFORT_BASELINE_C);
  }

  return { tempC, humidityPct: indoorHumidity(place.humidityCharacter) };
}
