import type { Difficulty } from '../data/types';
import type { CameraMode } from '../render/view';

export interface Settings {
  difficulty: Difficulty;
  /** Minutes per quarter. */
  quarterMinutes: number;
  cameraMode: CameraMode;
  retroPixels: boolean;
  showRoutes: boolean;
  lookSensitivity: number;
  userTeam: string;
  cpuTeam: string;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  quarterMinutes: 5,
  cameraMode: 'firstPerson',
  retroPixels: false,
  showRoutes: true,
  lookSensitivity: 1,
  userTeam: 'rheinstadt',
  cpuTeam: 'elbtal',
};

const KEY = 'gridiron-qb.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable (private mode) */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
