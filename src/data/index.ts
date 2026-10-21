import teamsJson from './teams.json';
import playsJson from './plays.json';
import formationsJson from './formations.json';
import difficultyJson from './difficulty.json';
import type { Difficulty, DifficultyConfig, Formation, FormationId, OffSlot, DefSlot, PlayData, PlayerData, TeamData } from './types';

export const TEAMS: TeamData[] = (teamsJson as { teams: TeamData[] }).teams;
export const PLAYS: PlayData[] = (playsJson as { plays: PlayData[] }).plays;
export const FORMATIONS = formationsJson as unknown as Record<FormationId, Formation>;
export const DIFFICULTY = difficultyJson as Record<Difficulty, DifficultyConfig>;

export function getTeam(id: string): TeamData {
  const t = TEAMS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown team ${id}`);
  return t;
}

export function getPlay(id: string): PlayData {
  const p = PLAYS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown play ${id}`);
  return p;
}

export function playerFor(team: TeamData, slot: OffSlot | DefSlot): PlayerData {
  const id =
    (team.depthChart.offense as Record<string, string>)[slot] ??
    (team.depthChart.defense as Record<string, string>)[slot];
  const p = team.roster.find((r) => r.id === id);
  if (!p) throw new Error(`no player for ${team.id}/${slot}`);
  return p;
}

/** Simple 0..100 unit grades used by the simulated CPU drives. */
export function teamGrades(team: TeamData) {
  const avg = (slots: string[], key: keyof PlayerData['ratings']) =>
    slots.reduce((s, sl) => s + playerFor(team, sl as OffSlot).ratings[key], 0) / slots.length;
  return {
    passing: (avg(['QB'], 'throwAccuracy') + avg(['WR1', 'WR2', 'WR3', 'TE'], 'catching')) / 2,
    rushing: (avg(['RB'], 'speed') + avg(['LT', 'LG', 'C', 'RG', 'RT'], 'blocking')) / 2,
    passDefense: avg(['CB1', 'CB2', 'NB', 'FS', 'SS'], 'coverage'),
    runDefense: avg(['DE1', 'DT1', 'DT2', 'DE2', 'LB1', 'LB2'], 'tackling'),
  };
}
