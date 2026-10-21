# Retro Gridiron

Ein kleines American-Football-Spiel im 8-Bit-Retro-Look, angelehnt an Tecmo Bowl.
Läuft komplett im Browser, ohne Build-Schritt und ohne Abhängigkeiten.

**Starten:** `index.html` im Browser öffnen (Doppelklick reicht).

## Features

- **3 Teams** mit unterschiedlichem Profil: Thunder Hogs (Lauf), Neon Hawks (Pass), Iron Wolves (Defense)
- **Spieler-Attribute** für jeden der 23 Spieler pro Team, im Kader-Bildschirm einsehbar:

  | Attribut | Wirkung im Spiel |
  |---|---|
  | SPD Speed | Höchstgeschwindigkeit |
  | AGI Agilität | Beschleunigung, Cuts, Reaktionszeit, Juke-Stärke |
  | STR Stärke | Blocks lösen (D-Line), Tackles brechen |
  | HND Hände | Fangquote (auch Interceptions) |
  | THR Wurfkraft | Ballgeschwindigkeit und maximale Wurfweite |
  | ACC Genauigkeit | Streuung der Pässe |
  | BLK Blocken | Blocks halten |
  | TKL Tackling | Tackle-Quote |
  | COV Coverage | Reaktion in Manndeckung, Pässe abwehren |
  | KCK Kicken | Field-Goal-Reichweite und -Quote, Punt-Weite |

- **Playbook**
  - Lauf: HB Dive, Power, Toss Sweep, Counter
  - Pass: Slant/Flat, Smash, Four Verts, Mesh
  - Defense (4-3): Cover 2, Cover 3, Cover 1 (Mann), Blitz (Cover 0)
  - Special Teams: Punt, Field Goal
- Downs, First Downs, Uhr (4 Viertel), Halbzeit, Touchdowns mit PAT, Safety, Interceptions, Sacks, Turnover on Downs
- CPU-Gegner mit situationsabhängigem Playcalling
- Pixel-Sound per WebAudio, Touch-Steuerung (Joystick + A/B) auf dem Handy

## Steuerung

| | Tastatur | Touch |
|---|---|---|
| Menü | Pfeile + Enter | Antippen (zweimal = bestätigen) |
| Snap | Space / Enter | A |
| QB bewegen / Ballträger steuern | Pfeile oder WASD | Joystick |
| Pass auf Receiver 1-5 | Tasten 1-5 | Receiver antippen |
| Juke (Ballträger) | Space | A |
| Defense: Spieler wechseln | Space | A |
| Kader im Play-Menü | R | Button „Kader" |
| Pause / Ton | P / M | |

## Code

```
index.html      Einstieg
css/style.css   Layout + Touch-Steuerung
js/data.js      Teams, Positionen, Attribute, Kader-Generator
js/plays.js     Formationen und Playbook (Routen, Laufwege, Zonen)
js/engine.js    Simulation eines Spielzugs (KI, Blocken, Tackles, Pässe)
js/render.js    Pixel-Grafik, HUD, Playbook-Diagramme
js/audio.js     8-Bit-Soundeffekte
js/main.js      Spielablauf, Menüs, Downs, Uhr, CPU-Playcalling, Eingabe
```

Neue Spielzüge lassen sich in `js/plays.js` ergänzen: Routen sind Wegpunkte relativ zur Startposition des Spielers.
