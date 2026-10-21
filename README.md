# Gridiron QB

A 3D American-football game for iPad, played through the quarterback's eyes.
Three.js + TypeScript + Vite, installable as a PWA, touch-first with keyboard
and gamepad as secondary inputs. Low-poly 3D with a retro palette and an
optional chunky "retro pixels" mode.

This is **Phase 1**: a playable single game where you run the offense against
a CPU defense. Career mode, trading, special teams and playing defense come in
later phases (see [ARCHITECTURE.md](ARCHITECTURE.md) for the extension points).

## Run it

Requires Node 20+ (CI uses Node 22).

```bash
npm install
npm run dev        # dev server, also reachable from your LAN
npm test           # unit tests (Vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build, also on your LAN
```

### Play on an iPad over your local network

1. Make sure the computer and the iPad are on the same Wi-Fi.
2. Run `npm run dev` (or `npm run build && npm run preview`). Vite prints a
   `Network:` URL such as `http://192.168.1.23:5173/`.
3. Open that URL in Safari on the iPad and hold the iPad in landscape.
4. Optional: Share → **Add to Home Screen** for a fullscreen, app-like launch.

If the iPad can't connect, allow incoming connections for Node in your
computer's firewall. Offline caching (the service worker) only switches on
over HTTPS, so use the GitHub Pages build for a fully offline-capable install.
Over plain LAN HTTP the game works the same, just without offline caching.

### Deploy to GitHub Pages

The repository includes `.github/workflows/deploy.yml`, which tests, builds
and publishes `dist/` on every push to `main`.

1. On GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main` (or run the workflow by hand from the **Actions** tab).
3. The game is published at `https://<user>.github.io/<repo>/`.

The build uses relative asset paths (`base: './'` in `vite.config.ts`), so it
works under any sub-path without extra configuration. Pages is served over
HTTPS, so the installed PWA also works offline.

## How to play

| Action | Touch (iPad) | Keyboard | Gamepad |
| --- | --- | --- | --- |
| Move QB / ball carrier | Left thumb anywhere on the left half (invisible joystick) | WASD / arrow keys | Left stick |
| Look around | Drag on the right half | Q / E | Right stick |
| Target and look at a receiver | Buttons **1 2 3 RB TE** | 1 2 3, 4/R, 5/T | X, Y, B, LB, RB |
| Snap, then hold to charge and release to throw | Big button | Space / Enter | A or RT |
| Juke (when carrying the ball) | Big button | Space | A or RT |
| Hand off on any play | **RB** while the RB is next to you | 4 / R | LB |
| Timeout / Pause | Top-left buttons | O / P or Esc | Back / Start |

- **Throwing:** hold the throw button to charge and release while the meter
  is in the green zone. The zone moves with the distance to the selected
  receiver. Under-charged balls float short (and give defenders time),
  over-charged balls sail long, and holding past full charge hurts. The ball
  leads a moving receiver. Pressure and throwing on the move cost accuracy.
  With no receiver selected, the ball goes where you are looking, so you can
  throw it away.
- **Pocket:** the meter on the left shows pressure. Rushers shed blocks more
  often the longer you hold the ball, and blitzers can come in unblocked.
- **Runs:** handoffs happen automatically on run plays. After that you steer
  the runner, and he follows the designed path if you let go. Hold the throw
  button before the handoff to keep the ball yourself.
- **Scrambles:** once the QB crosses the line of scrimmage he can no longer
  throw, and the defense switches to pursuit.

### Settings

CPU difficulty (Easy / Normal / Hard), quarter length, camera (QB eyes or
behind the QB), route hints before the snap, retro pixels and look
sensitivity. Settings are stored in `localStorage`. Difficulty changes CPU
reaction time, coverage accuracy, pass-rush strength, tackling, ball skills,
how long linebackers bite on play-action, how well the CPU reads your
play-calling tendencies, and the width of the throw sweet spot.

## Project layout

```
src/
  core/      seedable RNG, 2D vector math
  data/      teams.json, plays.json, formations.json, difficulty.json + types
  play/      play simulation: routes, throw math, catch resolution, CPU defense
  game/      game state, rules (downs/scoring), clock, CPU drives, settings
  input/     input manager (touch/keyboard/gamepad), virtual joystick
  render/    Three.js scene: field, stadium, players, ball, cameras
  ui/        DOM overlays: HUD, touch controls, play-calling, menus
  app.ts     top-level state machine wiring it all together
tests/       Vitest unit tests (throw timing, clock, rules, play sim, catches)
scripts/     data/icon generators and balance-probe tools
```

`node scripts/gen-teams.mjs` regenerates the placeholder rosters, and
`python3 scripts/gen-icons.py` regenerates the PWA icons (needs Pillow).
`BALANCE=balance npx vitest run` prints average yards and outcomes per play
against every coverage, which is useful when tuning the simulation.

## Defaults chosen (and where to change them)

- **Units are yards.** The simulation runs in the offense's frame: x is
  lateral and y is yards from the offense's own goal line.
- **Fixed 11 personnel** (QB, RB, TE, 3 WR, 5 OL) on offense and a **nickel
  4-2-5** on defense, so each eligible receiver maps to one button.
- **NCAA/GFL hash marks** (40 ft apart). The ball is spotted between the
  hashes after each play.
- **Simplified clock rules.** Real time with a 40-second play clock. The game
  clock stops on incompletions, out of bounds, scores, turnovers, timeouts
  and penalties, and keeps running after in-bounds tackles. A play that
  starts before 0:00 is always finished.
- **No kickoffs or PATs.** Touchdowns count 7, and the receiving team starts
  at its own 25. Punts and field goals are resolved from a formula on the
  play-call screen.
- **The CPU's possessions are simulated** drive by drive (see Known gaps).
- **Default quarter length is 5 minutes.**
- **The user team is always "home"** and receives the opening kick.
- Team/player names and colors are **fictional placeholders**, loosely
  inspired by German football (GFL) markets.

## Known gaps (Phase 1)

- **Defense is not playable yet.** The CPU's offensive drives are simulated
  from team grades and shown as a play-by-play summary.
- **No special teams.** There are no kickoffs, returns or onside kicks; PATs
  are automatic; punts and field goals are instant formula results; there is
  no fake punt or fake field goal.
- **Interceptions end the play at the catch point.** There are no returns and
  no fumbles.
- **Simplified rules.** No penalties other than delay of game, no two-minute
  warning, no overtime (ties stand), and no NCAA clock stop after first downs.
  Spot and clock rules are approximations.
- **No pre-snap adjustments.** No audibles, hot routes, motion or snap count,
  and offensive personnel never changes (always 11 personnel).
- **Blocking and AI are heuristic.** Blocking is an engagement/shed model, not
  physics. Defenders don't disguise coverages, and pursuit can occasionally
  look robotic. Balance is tuned by script (`scripts/balance.test.ts`), not by
  extensive play-testing.
- **Limited presentation.** No audio, crowd noise or commentary. Animation is
  procedural (no tackling or catching animations). There is no replay.
- **Fatigue and injuries don't exist yet,** though the player ratings and
  depth charts in `teams.json` are ready for them.
- **Tested only on emulated devices.** Verified in headless Chromium with
  iPad-sized touch emulation, not yet on a physical iPad. Watch performance
  on older iPads, where the "retro pixels" setting lowers the render
  resolution.
- **Offline caching needs HTTPS.** The service worker only registers over
  HTTPS (GitHub Pages), not on a LAN HTTP dev server.
