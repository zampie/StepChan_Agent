import type { TouchPart } from '../../../../shared/room';
// Full transparent source canvas coordinates, independent of render scale and drag position.
export function hitRegion(x: number, y: number): TouchPart | null {
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (y >= 0.03 && y < 0.23 && x > 0.25 && x < 0.75) return 'head';
  // The neck brooch sits just below the chin, overlapping the lower face band.
  if (y >= 0.32 && y < 0.49 && x > 0.43 && x < 0.61) return 'badge';
  if (y >= 0.23 && y < 0.36 && x > 0.32 && x < 0.68) return 'cheek';
  if (y >= 0.49 && y < 0.69 && (x < 0.4 || x > 0.6)) return 'hand';
  return null;
}
