import { describe, expect, it } from 'vitest';
import { roundCoord4 } from './round-coord.js';

describe('roundCoord4', () => {
  it('rounds to 4 decimal places', () => {
    expect(roundCoord4(20.66682)).toBe(20.6668);
    expect(roundCoord4(-103.39182)).toBe(-103.3918);
  });

  it('rounds half away from the boundary consistently', () => {
    expect(roundCoord4(0.00005)).toBe(0.0001);
  });

  it('leaves a value already at 4 decimals unchanged', () => {
    expect(roundCoord4(19.4326)).toBe(19.4326);
  });

  it('maps two near-identical floats to the same rounded value', () => {
    expect(roundCoord4(20.66680001)).toBe(roundCoord4(20.66684999));
  });
});
