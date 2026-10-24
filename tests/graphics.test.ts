import { describe, expect, it } from 'vitest';
import { GRAPHICS, naturalUniform, qualityPreset } from '../src/render/graphics';

describe('Phase 4: graphics quality', () => {
  it('LOW is the cheapest preset, HIGH the most expensive; the default exists', () => {
    const low = qualityPreset('low');
    const med = qualityPreset('medium');
    const high = qualityPreset('high');
    expect(qualityPreset(GRAPHICS.default)).toBeDefined();
    expect(low.pixelRatioCap).toBeLessThanOrEqual(med.pixelRatioCap);
    expect(med.pixelRatioCap).toBeLessThanOrEqual(high.pixelRatioCap);
    expect(low.shadows).toBe(false);
    expect(low.rimLight || low.glossyHelmets || low.fabric).toBe(false);
    expect(high.shadowMapSize).toBeGreaterThanOrEqual(med.shadowMapSize);
  });

  it('team colors read as fabric: less saturated and darker, white gets warmer, never noticeably brighter', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const c of ['#c8102e', '#1d3557', '#2d6a4f', '#f28c28', '#f4efe1', '#ffffff']) {
      const out = naturalUniform(c);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
      expect(lum(out)).toBeLessThanOrEqual(lum(c) + 3); // desaturating a deep red lifts its luma a hair
      expect(lum(out)).toBeGreaterThan(lum(c) * 0.8);
    }
    const white = naturalUniform('#ffffff');
    expect(parseInt(white.slice(5, 7), 16)).toBeLessThan(parseInt(white.slice(1, 3), 16)); // blue < red: warm
  });
});
