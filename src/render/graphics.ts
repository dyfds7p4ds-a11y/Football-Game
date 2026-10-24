/**
 * Phase 4 graphics settings (pure): quality presets for iPad performance and
 * the "dyed fabric" look of team colors. Tunables: data/graphics.json.
 */
import json from '../data/graphics.json';

export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface QualityPreset {
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
  softShadows: boolean;
  rimLight: boolean;
  glossyHelmets: boolean;
  fabric: boolean;
}

export const GRAPHICS = json as unknown as {
  default: GraphicsQuality;
  presets: Record<GraphicsQuality, QualityPreset>;
  lighting: {
    exposure: number; hemiSky: string; hemiGround: string; hemiIntensity: number; sunColor: string; sunIntensity: number;
    rimColor: string; rimIntensity: number; contactShadow: number;
  };
  uniform: { saturation: number; lightness: number; pantsWarmth: number };
};

export function qualityPreset(q: GraphicsQuality): QualityPreset {
  return GRAPHICS.presets[q] ?? GRAPHICS.presets[GRAPHICS.default];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** A team color as dyed fabric: a little less saturated and darker; near-white gets a touch of warmth. */
export function naturalUniform(hex: string): string {
  const U = GRAPHICS.uniform;
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  if (l > 0.85 && s < 0.4) {
    // White / cream pants and jerseys: warm off-white instead of paper white.
    const w = U.pantsWarmth;
    return rgbToHex(r * (1 - w * 0.2), g * (1 - w * 0.6), b * (1 - w * 1.6));
  }
  return rgbToHex(...hslToRgb(h, s * U.saturation, l * U.lightness));
}
