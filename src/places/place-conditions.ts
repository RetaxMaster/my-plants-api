import { LIGHT_LEVELS, type LightLevel } from '@retaxmaster/my-plants-species-schema';
import type { LightType } from '@prisma/client';

const LIGHT_TYPE_TO_LEVEL: Record<LightType, LightLevel> = {
  LOW: 'low',
  MEDIUM: 'medium',
  BRIGHT_INDIRECT: 'bright-indirect',
  DIRECT: 'direct',
};

export const lightRank = (level: LightLevel): number => LIGHT_LEVELS.indexOf(level);
export const placeLightRank = (lightType: LightType): number =>
  lightRank(LIGHT_TYPE_TO_LEVEL[lightType]);
