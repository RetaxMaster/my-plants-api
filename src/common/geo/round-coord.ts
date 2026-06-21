// Rounds a latitude/longitude to 4 decimal places (~11 m precision). Used to match a
// geocoded selection against an already-saved City without comparing floats for exact
// equality — distinct searches of the same place yield the same rounded key.
export function roundCoord4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
