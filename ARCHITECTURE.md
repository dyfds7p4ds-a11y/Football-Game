# Architecture

The game is split so that football logic never touches the DOM or Three.js.
The same simulation code runs in the browser, in unit tests and in headless
balance scripts. Phase 2 kept the Phase 1 module structure and added modules
next to the ones they extend.

```
            ┌────────────┐   InputFrame    ┌──────────────────────────────────┐
 touch ───▶ │   input/   │ ──────────────▶ │              app.ts              │
 keys  ───▶ │ InputMgr   │                 │ phases: title → intro → kick /   │
 pad   ───▶ └────────────┘                 │ return → playcall → presnap →    │
                                           │ live → postplay → (break/cpu)    │
                                           └──┬────────────┬───────────────┬──┘
                       SimInput / ReturnInput │            │               │ GameState
                                (fixed 60 Hz) ▼            │               ▼
                   ┌─────────────────────────────────┐     │   ┌────────────────────────┐
 data/*.json ────▶ │ play/ PlaySim (scrimmage)       │     │   │ game/ rules, penalties,│
                   │       ReturnSim (kick returns)  │     │   │ specialTeams, crowd,   │
                   │ coverage, windows, tackle,      │     │   │ clock, flow, cpuDrive  │
                   │ screen, penalties, officials,   │     │   └────────────────────────┘
                   │ kicking, routes, throw, catch   │     │
                   └───────────────┬─────────────────┘     │
                         read-only │                       │ read-only
                                   ▼                       ▼
                   ┌─────────────────────────────┐  ┌──────────────────────────┐
                   │ render/ SceneView, FieldView│  │ ui/ HUD, touch, playcall,│
                   │ Stadium, PlayerMesh,        │  │ menus, intro overlay     │
                   │ Cutscene (Three.js)         │  │ audio/ CrowdAudio        │
                   └─────────────────────────────┘  └──────────────────────────┘
```

## Modules

| Module | Responsibility | Notes |
| --- | --- | --- |
| `core/rng.ts` | Seedable mulberry32 PRNG | Every random decision in game logic goes through an `Rng`, so a game, drive or play can be replayed from its seed. |
| `core/vec.ts` | 2D vector helpers | The sim works in the offense frame: x is lateral, y is yards from the offense's goal line. |
| `data/` | Teams, rosters, ratings, depth charts, plays (route trees, screen designs), formations, difficulty presets, and every Phase 2 tunable | All JSON, typed in `data/types.ts` or next to the module that reads it. |
| `play/routes.ts` | Route tree to waypoints | Named routes (`slant`, `post`, `wheel`, ...) plus depth and direction. "Outside" is worked out relative to the ball. |
| `play/throw.ts` | Throw timing math (pure) | Charge sets ball speed; distance from the sweet spot sets accuracy and a short/long bias; also handles lead targeting and the ballistic arc. Unchanged in Phase 2: the sweet spot is the Phase 1 one. |
| `play/catch.ts` | Catch, drop, breakup and interception resolution (pure) | Phase 2 adds the in-phase defender bonus and screen-timing factors. |
| `play/defenseCalls.ts` | Coverage shells, pressure packages and the CPU play-caller | Cover 0/1/2/3, 2-Man and Fire Zone. |
| `play/coverage.ts` | **Phase 2.** Route-concept reads (`CoverageReader`) | After a read delay (difficulty `coverageRead`), vertical stems are identified; safeties give over-the-top help on the most dangerous vertical (with hysteresis, a poor read sometimes takes the wrong man); underneath zones carry verticals; the deep shell rolls toward the vertical-heavy side; man defenders get in phase on vertical stems. Tunables: `data/coverage.json`. |
| `play/windows.ts` | **Phase 2.** Throwing-window and in-phase metrics (pure) | "Open" = a perfect throw released now beats every defender (after his reaction, with momentum) to the catch point. Used by the balance tests, by the safeties to rank routes, and by the catch code. |
| `play/tackle.ts` | **Phase 2.** Tackle resolution (pure) | Outcome from approach angle (head-on / side / behind), closing speed, ratings and difficulty `tackling`; picks the contact animation (shoulder, wrap, stumble, hip turn, slide). Shared by scrimmage plays and returns. Tunables: `data/tackling.json`. |
| `play/screen.ts` | **Phase 2.** Screen timing window (pure) | Early throws are mostly incomplete, late throws invite interceptions. The per-play design (target, release time, linemen, stalk blockers, window) lives on the play in `plays.json`; tunables in `data/screens.json`. |
| `play/penalties.ts` | **Phase 2.** Foul definitions, flags and call-out text (pure) | `data/penalties.json`: false start, offside, holding (both sides), pass interference, roughing the passer, face mask. |
| `play/officials.ts` | **Phase 2.** Five officials (R, U, H, L, B) | Line up behind the LOS / on the sidelines / deep, move with the play, keep clear of players, throw flags (the nearest official). |
| `play/kicking.ts` | **Phase 2.** Kick meters and flights (pure) | Hold-to-fill power meter with a timing zone (difficulty `kickWindow`); punts add a sweeping angle needle locked on release; ballistic flights; field goals judged against the uprights. Tunables: `data/specialTeams.json`. |
| `play/sim.ts` | `PlaySim`: one play from snap to whistle | Fixed 60 Hz step: offense AI, defense AI (now with route reads, screen reads, rush lanes), blocking engagements, ball flight, tackles (short contact phase before the whistle), penalties (separate RNG stream), officials. Exposes `pocketCue`, `scrambling`, `flags`, `officials`. |
| `play/returnSim.ts` | **Phase 2.** `ReturnSim`: kickoff or punt from the kick to the whistle | Runs in the receiving team's frame. User or CPU returner (movement + dash), blockers vs. coverage lanes, touchbacks, downed punts, return TDs. Same read-only surface as `PlaySim` for the renderer. |
| `game/state.ts` | `GameState`, plain serializable data | Phase 2 adds `pendingKickoff` and `crowd`. |
| `game/rules.ts` | Downs, scoring, turnovers, Phase 1 instant punts/field goals, delay of game | Pure: `(GameState, play) → GameState`. Scores, safeties and the second half now set `pendingKickoff`. |
| `game/penalties.ts` | **Phase 2.** Penalty enforcement | Accept/decline (offended team takes the better outcome), previous-spot and spot fouls, half the distance, offsetting fouls, dead-ball fouls. |
| `game/specialTeams.ts` | **Phase 2.** Field position after played kicks and returns | `applyReturn`, `applyFieldGoal`, `kickoffOutOfBounds`; frame conversion for returns. |
| `game/crowd.ts` | **Phase 2.** Crowd pulse 0..100 | Events from plays (home perspective) move the meter; `crowdEdge` gives a bounded home edge (pass rush, penalty chances) when the setting is on. Tunables: `data/crowd.json`. |
| `game/clock.ts`, `game/flow.ts` | Game clock, play clock, quarters, half time, game over | Unchanged. |
| `game/cpuDrive.ts` | Simulated CPU possessions | Phase 2: crowd edge (sacks, false starts), crowd meter updates, and `interactivePunts` stops the drive at a punt so the user can return it. |
| `input/` | `InputManager` merges touch, keyboard and gamepad | Phase 2: `slotHeld` (hold a receiver button = charge the throw), `secondaryPressed` (slide / dash), `anyPressed` (skip cutscenes). |
| `render/view.ts` | `SceneView`: renderer, lights, cameras | Draws a `PlaySim` or a `ReturnSim`, the kick setup and field goal flights, officials, flags, receiver marker rings; projects receivers to the screen for edge arrows. Sun with soft shadows follows the play. |
| `render/fieldMesh.ts` | Field texture, sidelines, goalposts, markers | Natural turf (mowing stripes, grain, wear), worn paint. |
| `render/stadium.ts` | **Phase 2.** Stadium bowl | Two tiers, roof, light rigs, podium wall with the players' tunnel, ~14k instanced spectators animated in the vertex shader from one `uEnergy` uniform. |
| `render/playerMesh.ts` | Player and official figure | Rounded rig with contact poses (shoulder hit, wrap, stumble, hip turn, slide). |
| `render/cutscene.ts` | **Phase 2.** Intro director | Tunnel, team intro, coin toss / kickoff setup; only moves meshes and the camera, never game state. |
| `render/coords.ts` | Sim frame ↔ world | Phase 2 adds a frame flip so sims in the CPU's frame (a CPU return) draw in the user's world. |
| `ui/` | DOM overlays | HUD gains the crowd meter, pocket cue, receiver edge arrows, penalty call-out and kick meter; `intro.ts` is the cutscene overlay. |
| `audio/crowdAudio.ts` | **Phase 2.** Synthesized crowd bed, roars, whistle, kick thump | Web Audio, no files; unlocked by the first tap (iOS). |
| `app.ts` | Glue: phase machine, fixed-step accumulator, input → sim mapping, gaze | Owns the only mutable `GameState` reference. |

### Determinism

- `PlaySim` and `ReturnSim` take a seed. Given the same inputs they produce
  the same events and result (tested in `tests/sim.test.ts`).
- Penalties roll on their own forked RNG stream, so turning them on or off
  never changes the football itself (until a foul actually happens).
- Rendering interpolates `prevPos`/`pos`, so frame rate never affects the
  simulation. After the whistle the sim clock keeps running for presentation
  only (flags landing, players getting up).

### Tests

`npm test` covers Phase 1 (throw timing, clock, rules, play sim, catches) plus:
- `tests/coverage.test.ts`: **balance tests**: the open-receiver rate on
  every vertical concept (`four_verts`, `pa_shot`, `deep_post`) stays below
  the thresholds in `data/balance.json` at Normal (all CPU coverages × seeds);
  Easy leaves more open than Hard; reader, window and in-phase unit tests.
- `tests/pocket.test.ts`: edge/back pressure, lost blocks grow with hold time,
  pocket cue, difficulty, slide, scramble tackle factor.
- `tests/tackle.test.ts`: approach angles, speed, arm tackles, contact kinds,
  whistle within the contact time.
- `tests/screen.test.ts`: **screen timing window**, release, defensive read.
- `tests/specialTeams.test.ts`: **kick timing windows** (meter, zones per
  difficulty, field goals, kickoffs, punts, CPU kickers), returns, rules.
- `tests/penalties.test.ts`: enforcement, flags, officials.
- `tests/crowd.test.ts`: **crowd meter** rises/drops/bounds, bounded edge,
  CPU drives.
- `tests/difficulty.test.ts`: difficulty covers reads, pocket, tackling and
  kick windows.

`BALANCE=outcomes npx vitest run --silent=false` (scripts/outcomes.test.ts)
prints completion / interception / sack rates per concept and target.

## Phase 2 defaults (decisions that were not specified)

- **"Tighter windows" on deep throws** means tighter *coverage* windows
  (safety help, in-phase corners, carries), not a smaller sweet spot: the
  spec keeps the Phase 1 sweet spot. In-phase defenders get +15 % breakup and
  +15 % interception chance at the catch point (`data/coverage.json`).
- **"Open"** for the balance tests: a perfect throw released at 2.4 s would
  beat every defender to the catch point by 0.2 s, and no defender is in
  phase (within 1.8 yd, same direction). Thresholds: any receiver ≤ 45 %,
  the 1-route (WR1) ≤ 40 % (`data/balance.json`). Measured at Normal:
  Four Verticals WR1 ≈ 37 %, any receiver ≈ 40 % (Phase 1: WR1 open on 100 %
  of snaps). Easy ≈ 42 % / 54 %, Hard ≈ 0 % by this strict metric (Hard still
  completes contested deep balls). `BALANCE=openrates npx vitest run
  --silent=false` prints the table.
- **Receiver selection:** holding a receiver button charges the throw to him
  and releasing throws; the big THROW button still throws to the last
  receiver picked. RB tapped next to the QB is still a handoff. The camera
  never auto-turns to the target.
- **Officials:** referee and umpire both in the offensive backfield (modern
  NFL umpire spot), wing officials on the sidelines at the LOS, back judge
  deep. The nearest official throws the flag.
- **Penalty enforcement** is simplified: previous spot for everything except
  DPI (spot foul, minimum 1 yard past the LOS); defensive personal fouls do
  not add on to the end of the run; no 10-second runoff; no penalties on
  special teams.
- **Kicks:** no kicker/punter ratings in the rosters yet, so the meter alone
  decides the kick. Kickoffs from the 35; a kick that lands in the end zone
  is a touchback (25), a punt into the end zone is a touchback (20); kickoff
  out of bounds gives the ball at the 40. No onside kicks, fair catches or
  fake punts. PATs stay automatic (TD = 7).
- **CPU kicks** pick a release around the zone center with a spread from
  `specialTeams.json → cpu.timingSigma` (tighter on Hard).
- **Crowd edge** (setting, default on): at most +8 % home pass rush and
  ±30 % / −15 % penalty chances for visitors / home, only above meter 60.
  The user is always the home team, so the home pressure edge shows up in
  simulated CPU drives (more sacks), and the penalty edge in both.
- **Intro** runs before the opening kickoff on every new game (setting can
  turn it off); the game state is created first, so skipping is free.
- **Graphics:** shadows on by default with a 2048 shadow map covering ±38 yd
  around the play; the "Soft shadows" setting turns them off on older iPads.

## Extension points

### Phase 3: cornerback defense view

- **User-controlled defender.** `PlaySim.controlledId` decides who reads
  `SimInput.move`. Generalize `controlUser()` to point at a defensive actor
  (e.g. `getDef('CB1')`); `defenseAI()` already skips actors that have a
  `desired` velocity. `coverage.ts` keeps working for the other ten.
- **Camera.** Add a `'cornerback'` `CameraMode` in `render/view.ts`; the
  first-person path (eye position + gaze) works for any actor. Edge arrows
  (`App.updateEdgeMarkers`) can point at the receiver he covers instead.
- **CPU offense.** Replace `game/cpuDrive.ts` with interactive plays: build a
  `PlaySim` with the CPU as `offenseTeam` and a QB brain in a new
  `play/qbAI.ts` that produces `SimInput`. `windows.ts → throwingWindow()` is
  exactly the read a CPU QB needs (who is open now?), and `screen.ts` gives it
  the screen timing. `chooseDefense` becomes the user's play-call screen.
- **Interception / tackle timing.** `resolveCatch()` already takes
  `inPhase`, `catchFactor` and `intBonus`; a user timing press can feed the
  same inputs. `resolveTackle()` takes a `factor` for a user tackle-timing
  window, and the contact animations work for any defender.
- **Penalties on defense.** `PlaySim` already rolls defensive holding / DPI
  for CPU defenders; for a user defender, call `addFoul()` from his contact
  checks (e.g. holding when he grabs a receiver past 5 yards).
- **Turnover returns.** Interceptions still end the play; `ReturnSim`'s
  returner/blocker/coverage logic is the template for INT and fumble returns.

### Phase 3: career mode

- **Persistent data.** `GameState` (now with `crowd` and `pendingKickoff`) and
  `TeamData` are plain data: `JSON.stringify` them into a save slot.
- **League/season layer.** Add `src/career/`: league (teams, schedule),
  season state, standings, contracts and transfer windows. Home/away per
  game sets `GameState.userSide`; the crowd meter and edge already work for
  either side.
- **Progression.** Mutate `ratings` between games from per-player stat
  lines. `PlaySim` events carry actor ids (`catch`, `handoff`, `tackle`,
  `flag`), and `ReturnResult` names the returner.
- **Kickers.** Add K/P to the depth chart and scale `kickFlight` speed and
  lateral error by their ratings; the meter stays the same.

### Phase 3: trading

- **Trading logic.** Player value from ratings, age and position; AI teams
  accept when the value they gain exceeds what they lose, weighted by
  positional need (empty depth-chart slots). `teamGrades()` in
  `data/index.ts` aggregates unit strength.
- **Roster changes are free for the sim.** The sim reads players only
  through `playerFor(team, slot)`, so trades and depth-chart edits take
  effect without any sim changes (returns use the same lookup).
