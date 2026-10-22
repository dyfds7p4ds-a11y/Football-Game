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
  /** Phase 1 instant results for punts, field goals and kickoffs (no meters, no returns). */
  quickSim: boolean;
  /** Home crowd gives a small, bounded edge (pressure, penalty chance). */
  crowdEffect: boolean;
  /** Flags: holding, offside, pass interference, ... */
  penalties: boolean;
  /** Tunnel / team intro / coin toss cutscenes before the opening kickoff. */
  intro: boolean;
  /** Crowd noise and whistles. */
  sound: boolean;
  /** Real-time soft shadows (turn off on older iPads). */
  shadows: boolean;
  /** CPU possessions are simulated (Phase 2) instead of played on defense. */
  simCpuDrives: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  quarterMinutes: 5,
  cameraMode: 'behindQB',
  retroPixels: false,
  showRoutes: true,
  lookSensitivity: 1,
  userTeam: 'rheinstadt',
  cpuTeam: 'elbtal',
  quickSim: false,
  crowdEffect: true,
  penalties: true,
  intro: true,
  sound: true,
  shadows: true,
  simCpuDrives: false,
};

const KEY = 'gridiron-qb.settings.v1';
const SETTINGS_VERSION = 2;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Phase 3a: the broadcast camera became the default; older saves get it once.
      if (!saved.v || saved.v < SETTINGS_VERSION) saved.cameraMode = DEFAULT_SETTINGS.cameraMode;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {
    /* storage unavailable (private mode) */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, v: SETTINGS_VERSION }));
  } catch {
    /* ignore */
  }
}
