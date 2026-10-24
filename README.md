# Gridiron QB

A 3D American-football game for iPad, played through the quarterback's eyes.
Three.js + TypeScript + Vite, installable as a PWA, touch-first with keyboard
and gamepad as secondary inputs. Stylized-realistic 3D (stadium bowl, crowd,
soft shadows) with an optional chunky "retro pixels" mode.

This is **Phase 3d**: a playable single game where you run the offense against
a CPU defense that reads your route concepts, and play defense (any of the
eleven defenders) against a CPU quarterback. Blocking is matchup-driven,
blitzes can be picked up, kicks use a two-step meter and you cover your own
kicks. Touchdowns are followed by a try (kick or two), ties go to college
overtime, and each team has three timeouts per half. Phase 3c adds a fixed
joystick, audibles at the line, pattern-match zones, a QB who reads blitzes
nobody called, returnable interceptions and fumbles, NFL clock rules and a
4 × 5-minute game that fits in about 15 minutes. Phase 3d adds a sprint
button, a touchback-or-return choice on kickoffs into the end zone, reach
blocks and double teams, a rebalanced toss, tap-to-select defenders, lineman
body types and orange sideline down markers. Officials, penalty flags, a
crowd meter and intro cutscenes are in too. Cutscenes, crowd sound and the
environment (Phase 3e), career mode and trading come later (see
[ARCHITECTURE.md](ARCHITECTURE.md) for the modules, defaults, extension
points and known gaps).

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
| Move QB / ball carrier / returner | Joystick at the bottom left (fixed; anywhere on or near it) | WASD / arrow keys | Left stick |
| Look around | Drag on the field | Q / E | Right stick |
| Pick a receiver (pre-snap) | Tap **1 2 3 RB TE** | 1 2 3, 4/R, 5/T | X, Y, B, LB, RB |
| Throw to a receiver | **Hold** his button to charge, **release** to throw | Hold / release the key | Hold / release the button |
| Snap; throw to the last pick | Big button | Space / Enter | A or RT |
| Juke (ball carrier) / dash (returner) | Big button | Space | A or RT |
| Sprint (ball carrier, costs stamina, loosens the ball) | **Hold SPRINT** (next to JUKE) | Hold C | Hold R3 |
| Touchback (kickoff caught in the end zone) | **TOUCH BACK**, or run it out | X / Shift | LT |
| Change defender | **Tap him** on the field; **SWITCH** (left edge); **PLAYERS** menu | X / Shift; 1 2 3 | LT |
| Slide (scrambling QB) | **SLIDE** button | X / Shift | LT |
| Audible (pre-snap, up to 3) | **AUDIBLE**, then tap a play | X / Shift, then 1 2 3 | LT, then X Y B |
| Return a pick or fumble (defense) | Joystick; **JUKE** | WASD; Space | Left stick; A |
| Kick (punt, field goal, kickoff) | Hold **KICK**, release in the green | Hold / release Space | Hold / release A |
| Hand off on any play | Tap **RB** while the RB is next to you | 4 / R | LB |
| Skip the intro | Tap anywhere | Any key | Any button |
| Timeout / Pause | Top-left buttons | O / P or Esc | Back / Start |

- **Receivers:** every receiver has a colored marker ring and his number
  above his head; receivers outside your view show as arrows at the screen
  edge. Selecting a receiver never turns the QB's head (Madden-style).
- **Throwing:** hold the receiver's button to charge and release while the
  meter is in the green zone. The zone moves with the distance to the
  receiver. Under-charged balls float short (and give defenders time),
  over-charged balls sail long, and holding past full charge hurts. The ball
  leads a moving receiver. Pressure and throwing on the move cost accuracy.
  With no receiver selected, the ball goes where you are looking.
- **Deep balls are a risk:** the defense reads vertical stems. Safeties
  rotate over the top of the most dangerous route, underneath defenders
  carry seams, corners run in phase, and a defender in phase has a better
  shot at a breakup or interception.
- **Pocket:** pressure comes up the middle, around the edges and from behind.
  A red glow at the screen edge warns you about a free rusher closing in; the
  meter on the left shows overall pressure. Blockers lose their man more
  often the longer you hold the ball.
- **Screens:** the screen linemen release after a short delay; throw in the
  window after they release. Too early and the back isn't turned around yet,
  too late and the defense has read it.
- **Runs:** handoffs happen automatically on run plays. After that you steer
  the runner, and he follows the designed path if you let go. Hold the throw
  button before the handoff to keep the ball yourself.
- **Scrambles:** your view follows your running path. A scrambling QB goes
  down easily, so let blockers open a lane; SLIDE ends the run safely. Once
  past the line of scrimmage you can no longer throw.
- **Tackles** depend on angle and speed: head-on hits stop runners cold,
  arm tackles from behind can be dragged forward or shrugged off. Big hits
  can knock the ball loose: a fumble is live until someone falls on it.
- **Audibles:** before the snap, AUDIBLE offers 2-3 plays from the same
  formation. Each one costs play-clock time (3 s, then 5 s, then 7 s). The
  defense re-reads after a moment (faster on Hard); snap before it does and a
  run checked against a blitz look gets a real edge.
- **Hot reads:** a red pulsing receiver button means a blitz came free and
  that receiver is open now.
- **Turnovers are returned:** after a pick or a fumble recovery the play goes
  on. On defense you take over the man with the ball; on offense you steer
  the nearest player to chase him down.
- **Penalties:** an official throws a yellow flag at the spot of the foul; a
  call-out names the penalty and yardage; the penalty is applied (or
  declined) once the play is dead.
- **Special teams:** punts, field goals and kickoffs use a hold-and-release
  meter with a timing zone; punts also lock an angle needle on release.
  A kickoff caught in the end zone is your call: TOUCH BACK takes a knee
  (or stand still until the decision time runs out), running it out is a
  return. Uncaught kicks into the end zone and punts there are touchbacks.
  On returns you steer the returner and tap DASH for a short burst.
- **Crowd:** the meter under the scoreboard rises after big plays, takeaways
  and scores and drops after penalties, turnovers and failed fourth downs.
  The stands and the crowd noise follow it.

### Settings

CPU difficulty (Easy / Normal / Hard), quarter length, camera (QB eyes or
behind the QB), route hints before the snap, retro pixels, look sensitivity,
**Quick sim special teams** (Phase 1 instant punts/field goals/kickoffs),
**Crowd effect** (a loud home crowd adds a little pass rush and more visitor
false starts), **Penalties**, **Intro cutscenes**, **Sound** and **Soft
shadows**. Settings are stored in `localStorage`. Difficulty changes CPU
reaction time, coverage accuracy and how fast and well the defense reads
your route concepts, pass-rush and pocket pressure, tackling strength, ball
skills, how long linebackers bite on play-action, how well the CPU reads
your play-calling tendencies, the throw sweet spot and the special-teams
timing zones.

## Project layout

```
src/
  core/      seedable RNG, 2D vector math
  data/      teams, plays, formations, difficulty + Phase 2 tunables
             (coverage, pocket, tackling, screens, penalties, specialTeams,
             crowd, balance) + types
  play/      play simulation: routes, throw math, catch resolution, CPU
             defense, coverage reads, throwing windows, tackles, screens,
             penalties, officials, kicking, kick returns
  game/      game state, rules, penalty enforcement, special teams, crowd
             meter, clock, CPU drives, settings
  input/     input manager (touch/keyboard/gamepad), virtual joystick
  render/    Three.js scene: field, stadium bowl and crowd, players,
             officials, flags, cameras, intro cutscenes
  ui/        DOM overlays: HUD, touch controls, play-calling, menus, intro
  audio/     synthesized crowd noise, whistle, kick
  app.ts     top-level state machine wiring it all together
tests/       Vitest unit tests (throw timing, clock, rules, play sim, catches,
             coverage balance, pocket, tackles, screens, special teams,
             penalties, crowd meter, difficulty)
scripts/     data/icon generators and balance-probe tools
```

`node scripts/gen-teams.mjs` regenerates the placeholder rosters, and
`python3 scripts/gen-icons.py` regenerates the PWA icons (needs Pillow).
`BALANCE=balance npx vitest run` prints average yards and outcomes per play
against every coverage, which is useful when tuning the simulation.
`BALANCE=outcomes npx vitest run --silent=false` prints completion,
interception and sack rates per concept and target, and
`BALANCE=openrates npx vitest run --silent=false` the open-receiver rates the
vertical-concept balance tests check.
`BALANCE=trace TRACE=slants,cover3,1.0,WR1,1 npx vitest run --silent=false`
prints a timeline for a single play (play, defense, throw time, target, seed).

## Defaults chosen (and where to change them)

- **Units are yards.** The simulation runs in the offense's frame: x is
  lateral and y is yards from the offense's own goal line.
- **Fixed 11 personnel** (QB, RB, TE, 3 WR, 5 OL) on offense and a **nickel
  4-2-5** on defense, so each eligible receiver maps to one button.
- **NCAA/GFL hash marks** (40 ft apart). The ball is spotted between the
  hashes after each play.
- **NFL clock rules (Phase 3c).** 40-second play clock. The game clock stops
  on incompletions, scores, turnovers, possession changes and timeouts; out
  of bounds and penalties stop it only late in a half; first downs never do;
  two-minute warning in Q2 and Q4 (all scaled to the quarter length). On a
  running clock the offense snaps with 5 s on the play clock, so the game
  clock runs off between plays no matter how fast you snap (not in the
  hurry-up after the warning). A play that starts before 0:00 is always
  finished. Tunables and the real-time target: `src/data/pace.json`.
- **Kickoffs, punts and field goals are played** (Quick sim brings back the
  Phase 1 instant results). Touchdowns count 6, then the try (Phase 3b).
  Kickoffs from the 35, touchbacks at the 25 (punts: 20).
- **The CPU's possessions are simulated** drive by drive (see Known gaps).
- **Default quarter length is 5 minutes.**
- **The user team is always "home"** and receives the opening kick; the CPU
  kicks off to start the game, the user kicks off to start the second half.
- **Phase 2 balance defaults** (vertical-concept thresholds, penalty rules,
  crowd edge limits, kick rules) are listed in ARCHITECTURE.md under
  "Phase 2 defaults".
- Team/player names and colors are **fictional placeholders**, loosely
  inspired by German football (GFL) markets.

## Known gaps (Phase 2; Phase 3a/3b/3c gaps are in ARCHITECTURE.md)

- **Defense is playable since Phase 3a/3b** (setting "CPU drives: PLAY
  DEFENSE"); "QUICK SIM" still simulates CPU drives from team grades.
- **Special teams are simplified.** No kicker/punter ratings (the meter alone
  decides), no onside kicks, fair catches, fake punts/field goals, blocked
  kicks, muffed-punt recoveries by the kicking team or penalties on kicks.
  CPU tries are resolved instantly (Phase 3b). The field-goal unit is
  shown as kicker and holder only.
- **Penalty enforcement is simplified:** previous spot for everything except
  pass interference; no add-on yardage for personal fouls at the end of a
  run, no 10-second runoff, no declined-penalty choice for the user (the
  offended team automatically takes the better result).
- **Simplified game rules:** NFL clock since Phase 3c, but no 10-second
  runoff. Overtime (college rules) since Phase 3b.
- **Pre-snap:** audibles since Phase 3c; still no user hot routes, motion or
  snap count, and offensive personnel never changes (always 11 personnel).
- **Balance is tuned by script**, not by extensive play-testing. The vertical
  concepts meet the open-rate thresholds at Normal, but Hard is very tight on
  deep balls and some medium concepts (smash corner) carry a high
  interception rate when the ball floats. Screens gain modest yardage.
- **AI is heuristic.** Blocking is an engagement/shed model, not physics; the
  defense reads stems rather than disguising coverages; pursuit and return
  coverage can look robotic.
- **Animations are procedural** (no motion capture): tackles, falls and the
  slide are blended poses; there are no catch animations or celebrations.
  Cutscenes use the in-game figures.
- **Audio is synthesized** (noise, whistle, thump): no commentary, chants or
  music.
- **Fatigue, injuries and per-player stats don't exist yet,** though ratings
  and depth charts are ready for them.
- **Tested only on emulated devices.** Verified in headless Chromium with
  iPad-sized viewports (software rendering), not yet on a physical iPad.
  The stadium has ~14k instanced spectators and real-time shadows; on older
  iPads turn off "Soft shadows" or use "Retro pixels".
- **Offline caching needs HTTPS.** The service worker only registers over
  HTTPS (GitHub Pages), not on a LAN HTTP dev server.
