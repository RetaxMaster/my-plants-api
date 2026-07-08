export interface PlaceClimateInput {
  indoor: boolean;
  climateControlled: boolean;
  humidityCharacter: 'DRY' | 'NORMAL' | 'HUMID' | null;
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
  tempSignal: boolean; // true when tempC is a real reading (not a comfort baseline)
  humiditySignal: boolean; // true when humidityPct is a real reading (not a baseline)
}

const COMFORT_BASELINE_C = 21;
const INDOOR_HUMIDITY_BASELINE = 50;
const HUMID_INDOOR = 65;
const DRY_INDOOR = 35;

function indoorHumidity(character: 'DRY' | 'NORMAL' | 'HUMID'): number {
  if (character === 'HUMID') return HUMID_INDOOR;
  if (character === 'DRY') return DRY_INDOOR;
  return INDOOR_HUMIDITY_BASELINE;
}

// Classify an effective humidity percentage into a band. Thresholds align to the indoor mapping
// (DRY≈35, NORMAL≈50, HUMID≈65). Single source used by the misting schedule (Phase 4).
export function humidityBand(humidityPct: number): 'DRY' | 'NORMAL' | 'HUMID' {
  if (humidityPct < 42) return 'DRY';
  if (humidityPct > 58) return 'HUMID';
  return 'NORMAL';
}

// The effective temp/humidity for a place, plus whether each is a REAL signal. Indoor places with
// no provided data fall back to the real outdoor weather (the only real reading); a comfort
// baseline (climate-controlled, or nothing available) is NOT a signal, so modulators stay neutral.
export function effectiveConditions(
  place: PlaceClimateInput,
  weather: Weather | null,
): EffectiveConditions {
  if (!place.indoor) {
    if (weather) return { tempC: weather.tempC, humidityPct: weather.humidityPct, tempSignal: true, humiditySignal: true };
    return { tempC: COMFORT_BASELINE_C, humidityPct: INDOOR_HUMIDITY_BASELINE, tempSignal: false, humiditySignal: false };
  }

  // Indoor temperature.
  let tempC: number;
  let tempSignal: boolean;
  if (place.indoorTempMinC !== null && place.indoorTempMaxC !== null) {
    tempC = (place.indoorTempMinC + place.indoorTempMaxC) / 2;
    tempSignal = true;
  } else if (place.climateControlled) {
    tempC = COMFORT_BASELINE_C;
    tempSignal = false;
  } else if (weather) {
    tempC = weather.tempC; // raw outdoor fallback
    tempSignal = true;
  } else {
    tempC = COMFORT_BASELINE_C;
    tempSignal = false;
  }

  // Indoor humidity.
  let humidityPct: number;
  let humiditySignal: boolean;
  if (place.humidityCharacter) {
    humidityPct = indoorHumidity(place.humidityCharacter);
    humiditySignal = true;
  } else if (weather) {
    humidityPct = weather.humidityPct; // raw outdoor fallback
    humiditySignal = true;
  } else {
    humidityPct = INDOOR_HUMIDITY_BASELINE;
    humiditySignal = false;
  }

  return { tempC, humidityPct, tempSignal, humiditySignal };
}

// Vapour-pressure deficit (kPa): the air's evaporative demand — the physically-correct JOINT signal of
// temperature and humidity (higher VPD = thirstier air = faster drying). Saturation vapour pressure via
// the Tetens equation; VPD = es(T) × (1 − RH). Single source used by the watering engine's vpdFactor.
export function vpd(tempC: number, humidityPct: number): number {
  const es = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3)); // kPa
  const rh = Math.min(100, Math.max(0, humidityPct)) / 100;
  return es * (1 - rh);
}
