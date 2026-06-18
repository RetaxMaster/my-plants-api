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
