# Architecture

The game is split so that football logic never touches the DOM or Three.js.
The same simulation code runs in the browser, in unit tests and in headless
balance scripts. Phase 2 kept the Phase 1 module structure and added modules
next to the ones they extend; Phase 3a does the same (playable cornerback
defense, CPU quarterback, stadium audio, one-flag penalties), and so does
Phase 3b (offensive line and blocking, blitzes, corner targets and picks,
every defender playable, playable kick coverage with a two-layer kick meter,
overtime, tries after touchdowns, timeouts) and Phase 3c (fixed joystick, kick
penalties, pattern-match zones, surprise rushers and hot reads, audibles, NFL
clock and game pace, returnable turnovers, down-and-distance CPU calls).

```
            ┌────────────┐   InputFrame    ┌──────────────────────────────────┐
 touch ───▶ │   input/   │ ──────────────▶ │              app.ts              │
 keys  ───▶ │ InputMgr   │                 │ user ball: playcall → presnap →  │
 pad   ───▶ └────────────┘                 │ live → postplay → (break)        │
                                           │ CPU ball: defense call → presnap │
                                           │ → live (any defender + CpuQB)    │
                                           │ kicks: kick (power, aim) → return│
                                           │ / coverage; try; overtime        │
                                           └──┬────────────┬───────────────┬──┘
                       SimInput / ReturnInput │            │               │ GameState
                                (fixed 60 Hz) ▼            │               ▼
                   ┌─────────────────────────────────┐     │   ┌────────────────────────┐
 data/*.json ────▶ │ play/ PlaySim (scrimmage)       │     │   │ game/ rules, penalties,│
                   │       ReturnSim (kicks, cover)  │     │   │ specialTeams, crowd,   │
                   │ coverage, windows, tackle,      │     │   │ clock, flow, cpuDrive  │
                   │ screen, penalties, officials,   │     │   │ 3b: overtime,          │
                   │ kicking, routes, throw, catch,  │     │   │ conversion, timeouts   │
                   │ interception, qbAI (CPU QB)     │     │   │ 3c: pace (game length) │
                   │ 3b: blocking, blitz,            │     │   └────────────────────────┘
                   │ defenseSelect                   │     │
                   │ 3c: audible, turnover returns   │     │
                   └───────────────┬─────────────────┘     │
                         read-only │                       │ read-only
                                   ▼                       ▼
                   ┌─────────────────────────────┐  ┌──────────────────────────┐
                   │ render/ SceneView, FieldView│  │ ui/ HUD, touch, playcall,│
                   │ Stadium, PlayerMesh,        │  │ menus, intro, audible    │
                   │ Cutscene (Three.js)         │  │ audio/ crowdMix (pure),  │
                   │                             │  │ CrowdAudio (Web Audio)   │
                   └─────────────────────────────┘  └──────────────────────────┘
```

## Modules

| Module | Responsibility | Notes |
| --- | --- | --- |
| `core/rng.ts` | Seedable mulberry32 PRNG | Every random decision in game logic goes through an `Rng`, so a game, drive or play can be replayed from its seed. |
| `core/vec.ts` | 2D vector helpers | The sim works in the offense frame: x is lateral, y is yards from the offense's goal line. |
| `data/` | Teams, rosters, ratings, depth charts, plays (route trees, screen designs), formations, difficulty presets, and every Phase 2 tunable | All JSON, typed in `data/types.ts` or next to the module that reads it. |
| `play/routes.ts` | Route tree to waypoints | Named routes (`slant`, `post`, `wheel`, ...) plus depth and direction. "Outside" is worked out relative to the ball. **Phase 3a:** waypoints stay `sidelineMargin` inside the sideline; `boundRouteVelocity()` turns a receiver who keeps running past his last waypoint upfield near the sideline and never past the margin or the end line (`data/routes.json`). |
| `play/throw.ts` | Throw timing math (pure) | Charge sets ball speed; distance from the sweet spot sets accuracy and a short/long bias; also handles lead targeting and the ballistic arc. Unchanged in Phase 2: the sweet spot is the Phase 1 one. |
| `play/catch.ts` | Catch, drop, breakup and interception resolution (pure) | Phase 2 adds the in-phase defender bonus and screen-timing factors. Phase 3a: a candidate can carry a `timing` bonus (breakup, interception, reach) from the user's jump. **Phase 3b:** the pick share of a defender's hands-on plays (`intBase`, `noReceiverInt`; in-flight undercuts `undercutInt`) comes from `coverage.json`. |
| `play/interception.ts` | **Phase 3a.** Interception timing window (pure) | `jumpTiming(pressT, arriveT)` grades the user defender's JUMP by how close its peak is to the ball's arrival (perfect / good / mistimed / none); `timingEffect()` maps the grade to catch bonuses; `jumpHeight()` for the renderer. **Phase 3b:** `readGrade(margin)` grades the read (did the user's defender beat the receiver to the catch point?) and `combinedEffect()` adds it to the jump's effect. Tunables: `data/defenseControl.json` (also `rip`, the JUMP-while-blocked move). |
| `play/blocking.ts` | **Phase 3b.** Offensive line (pure) | `assignProtection()` gives every pass blocker a responsibility: pass set (inside-out, a lineman slides at most `olReach` yd), double team (spare lineman), chip and release (a back on a `check` route chips the edge, then runs his route), and slide protection toward a recognized blitz. `planRunBlocks()` turns a run design's `scheme` (inside, zone, power, toss, draw) into run blocks with drive directions; gap schemes double the point of attack and climb to a linebacker. `blockQuality()` grades a matchup from ratings (-1..1) and `holdTime()` turns the grade into how long the block holds (no fixed roll; rep variance only around the matchup). `pickLane()` scores the design's gaps by how the blocks are going. Tunables: `data/blocking.json`. |
| `play/blitz.ts` | **Phase 3b.** Blitzes (pure) | Each blitz call gives its blitzers a path (edge, A gap, B gap, delayed) and a delay (`data/blitz.json`). `recognizeChance()` (path, line awareness): an unseen blitzer comes free. `arrivalTime()` for the path vs. the throw. `classifyBlitz()` turns what happened into sack / hurry / blocked / late. **Phase 3c:** `surpriseReaction()` (line and QB reaction to a rush nobody planned for: field of view, awareness; `blitz.json` `surprise`). |
| `play/audible.ts` | **Phase 3c.** Audibles (pure) | `audibleOptions()` (2-3 plays per called play, same formation; `data/audibles.json`), `audibleCost(k)` (play-clock cost of the k-th audible), `isBlitz()`, `counterCall()` (the CPU defense's answer: right counter with difficulty `audibleRead`, else its old call) and `AudibleSession` (one pre-snap: count, play-clock deduction, the defense's re-read after difficulty `audibleReact`, `edge` = run audible caught a blitz look). |
| `play/defenseSelect.ts` | **Phase 3b.** Which defender the user plays (pure) | Units DL / LB / DB; `switchTarget()`: SWITCH takes the defender nearest the ball during the play, the next slot before the snap. |
| `play/qbAI.ts` | **Phase 3a.** CPU offense | `CpuQB.input(sim)` turns the sim state into a `SimInput` each step: drop, progression reads with `windows.throwingWindow()`, the same hold-and-release throw as the user (the sweet spot tracks the receiver), throw-aways under pressure, screen timing, and a ball carrier who bends away from tacklers. `chooseCpuPlay()` calls plays by down and distance; `fourthDownCall()` picks go / field goal / punt. Difficulty `cpuOffense` scales read noise and release error. **Phase 3b:** reads outside receivers first (`slotBias`) and the back only as a late check-down (`checkdownAfter`), so the corners see realistic target volume. **Phase 3c:** once `sim.qbAlert` the QB throws the hot read or throws it away (`hot`); `callMix()` by down and distance (`callsLate`: no designed runs on 3rd / 4th and 8+). Tunables: `data/cpuOffense.json`. |
| `play/defenseCalls.ts` | Coverage shells, pressure packages and the CPU play-caller | Cover 0/1/2/3, 2-Man and Fire Zone. |
| `play/coverage.ts` | **Phase 2.** Route-concept reads (`CoverageReader`). **Phase 3c:** `ZoneMatcher` (pattern-match zone: ownership, release, handoff; `coverage.json` `zone`) | After a read delay (difficulty `coverageRead`), vertical stems are identified; safeties give over-the-top help on the most dangerous vertical (with hysteresis, a poor read sometimes takes the wrong man); underneath zones carry verticals; the deep shell rolls toward the vertical-heavy side; man defenders get in phase on vertical stems. Tunables: `data/coverage.json`. |
| `play/windows.ts` | **Phase 2.** Throwing-window and in-phase metrics (pure) | "Open" = a perfect throw released now beats every defender (after his reaction, with momentum) to the catch point. Used by the balance tests, by the safeties to rank routes, and by the catch code. |
| `play/tackle.ts` | **Phase 2.** Tackle resolution (pure) | Outcome from approach angle (head-on / side / behind), closing speed, ratings and difficulty `tackling`; picks the contact animation (shoulder, wrap, stumble, hip turn, slide). Shared by scrimmage plays and returns. Tunables: `data/tackling.json`. |
| `play/screen.ts` | **Phase 2.** Screen timing window (pure) | Early throws are mostly incomplete, late throws invite interceptions. The per-play design (target, release time, linemen, stalk blockers, window) lives on the play in `plays.json`; tunables in `data/screens.json`. |
| `play/penalties.ts` | **Phase 2.** Foul definitions, flags and call-out text (pure) | `data/penalties.json`: false start, offside, holding (both sides), pass interference, roughing the passer, face mask. **Phase 3a:** every foul has a `severity`; `callFoul(current, candidate)` keeps the more severe one, so a play has at most one flag. Chances are scaled by difficulty `penaltyRate`. |
| `play/officials.ts` | **Phase 2.** Five officials (R, U, H, L, B) | Line up behind the LOS / on the sidelines / deep, move with the play, keep clear of players, throw flags (the nearest official). |
| `play/kicking.ts` | **Phase 2.** Kick meters and flights (pure) | Hold-to-fill power meter with a timing zone (difficulty `kickWindow`); ballistic flights; field goals judged against the uprights. **Phase 3b:** second layer `releaseKickAimed()`: after the power is locked, `aimNeedle()` sweeps and a tap locks it: sideways direction for kickoffs and field goals, launch angle for punts (`aimZone`, `aimToAngle`). `releaseKick()` (Phase 2, with the old punt angle sweep) stays for the CPU. **Phase 3c:** `timingPenalty()`, one curve for both layers: a bad power costs launch speed, a bad needle costs speed, flattens kickoffs / field goals and pushes them wide. Tunables: `data/specialTeams.json`. |
| `play/sim.ts` | `PlaySim`: one play from snap to whistle | Fixed 60 Hz step: offense AI, defense AI (now with route reads, screen reads, rush lanes), blocking engagements, ball flight, tackles (short contact phase before the whistle), penalties (separate RNG stream), officials. Exposes `pocketCue`, `scrambling`, `flags`, `officials`. **Phase 3a:** the `userDefense` option, plus `userDefId` / `selectDefender()` / `userDefender`. `SimInput.defense` (stick + JUMP) moves the selected defender; every other defender stays on the CPU AI. The jump lunges toward the ball, the carrier or his man, is graded against the ball's arrival (`lastTiming`, `timing` event) and extends diving-tackle range. `keepInBounds()` holds every player without the ball inside the sideline. `addFoul()` applies the one-flag rule. A CPU QB's throw uses window scale 1 (the throw-window difficulty belongs to the user QB). **Phase 3b:** blocking uses `blocking.ts` (`blockStates()`, `blockRole()`; block variance on its own RNG stream), blitzers follow `blitz.ts` paths (`blitzReport()`, `hurry` / `pickup` events), run plays read lanes, `switchDefender()` and the rip move, `lastTiming.read`. **Phase 3c:** `zones` (`ZoneMatcher`) and `handoffs`; `surprise` / `surpriseReport()` / `qbAlert` / `hot` (rushers nobody planned for, spotted by behaviour); `audibleEdge`; turnover returns (`turnover`, `loose`, `returning`; `startReturn`, live fumbles with `fumbleRng` on its own seed, `controlPursuer`, `finishReturn`), result fields `fumble` / `returnYards`. |
| `play/returnSim.ts` | **Phase 2.** `ReturnSim`: kickoff or punt from the kick to the whistle | Runs in the receiving team's frame. User or CPU returner (movement + dash), blockers vs. coverage lanes, touchbacks, downed punts, return TDs. Same read-only surface as `PlaySim` for the renderer. **Phase 3b:** `userCovers`: on his own kicks the user plays a cover man (`coverId`, `ReturnInput.cover`: stick, DIVE = tackle attempt with longer range, RIP when blocked, SWITCH = `switchCover()`); the CPU plays the other ten. |
| `game/state.ts` | `GameState`, plain serializable data | Phase 2 adds `pendingKickoff` and `crowd`. **Phase 3b:** `pendingConversion`, `conversionTry`, `overtime`. |
| `game/rules.ts` | Downs, scoring, turnovers, Phase 1 instant punts/field goals, delay of game | Pure: `(GameState, play) → GameState`. Scores, safeties and the second half now set `pendingKickoff`. **Phase 3b:** `scoreTouchdown()` (6 points, then the try), `finishTry()`, two-point plays (`conversionTry`); `startPossession()` routes every possession change through overtime when it is on. |
| `game/conversion.ts` | **Phase 3b.** Tries (pure) | `conversionOptions()`, `chooseConversion()` (CPU chart), `startTwoPointTry()`, `quickConversion()`. Tunables: `data/rules.json`. |
| `game/overtime.ts` | **Phase 3b.** Overtime (pure) | College rules, see "Overtime rule" below: `startOvertime()`, `possessionStart()`, `endOvertimePossession()`, `mustGoForTwo()`, `isShootout()`. |
| `game/timeouts.ts` | **Phase 3b.** Timeouts (pure) | `callTimeout()`, `cpuWantsTimeout()` (CPU offense late in a half). 3 per half, 1 per overtime period. |
| `game/penalties.ts` | **Phase 2.** Penalty enforcement | Accept/decline (offended team takes the better outcome), previous-spot and spot fouls, half the distance, dead-ball fouls. **Phase 3a:** any list of fouls is reduced to the single most severe one (no offsetting fouls). |
| `game/specialTeams.ts` | **Phase 2.** Field position after played kicks and returns | `applyReturn`, `applyFieldGoal`, `kickoffOutOfBounds` (**Phase 3c:** at the kicking team's 40); frame conversion for returns. |
| `game/pace.ts` | **Phase 3c.** Game length (pure) | `estimateRealSeconds()` turns a game's counts (snaps, kicks, scores, breaks) into real time with `pace.json` `real`. Used by `tests/gameLength.test.ts` and the `BALANCE=gamelength` probe. |
| `game/crowd.ts` | **Phase 2.** Crowd pulse 0..100 | Events from plays (home perspective) move the meter; `crowdEdge` gives a bounded home edge (pass rush, penalty chances) when the setting is on. Tunables: `data/crowd.json`. |
| `game/clock.ts`, `game/flow.ts` | Game clock, play clock, quarters, half time, game over. **Phase 3c:** NFL stop rules (`stopsClock(reason, clock)`), two-minute warning (`warned`), snap timing (`paceRunoff()`, `pacedSnap()`), tunables `PACE` from `data/pace.json` | **Phase 3b:** `checkQuarter()` sends a tie after four quarters to overtime (`brk: 'overtime'`), never ends a quarter before a pending try, and treats overtime as untimed. |
| `game/cpuDrive.ts` | Simulated CPU possessions. **Phase 3c:** pace runoff between snaps, `callMix()` play mix, `onPlay` hook for the game-length probe | Phase 2: crowd edge (sacks, false starts), crowd meter updates, and `interactivePunts` stops the drive at a punt so the user can return it. **Phase 3b:** plays the try after a touchdown, no punts in overtime, CPU timeouts late in a half. |
| `input/` | `InputManager` merges touch, keyboard and gamepad. **Phase 3c:** `joystick.ts` is a fixed stick (layout from `data/touch.json`: `joystickLayout`, `actionsRect`) | Phase 2: `slotHeld` (hold a receiver button = charge the throw), `secondaryPressed` (slide / dash), `anyPressed` (skip cutscenes). |
| `render/view.ts` | `SceneView`: renderer, lights, cameras | Draws a `PlaySim` or a `ReturnSim`, the kick setup and field goal flights, officials, flags, receiver marker rings; projects receivers to the screen for edge arrows. Sun with soft shadows follows the play. **Phase 3a:** the broadcast camera (default) sits higher and further back on a fixed field axis with a narrower FOV and never rotates during scrambles; officials right under it are hidden. The defense camera sits behind the user's cornerback (`updateDefenseCamera`). **Phase 3b:** per-unit presets (`camera.json` `defenseUnits`), the selected defender carries his label, and a coverage camera behind the user's cover man on kicks. CPU-offense sims are drawn frame-flipped, with CB labels, a ring under the controlled CB and jump height. Tunables: `data/camera.json`. |
| `render/fieldMesh.ts` | Field texture, sidelines, goalposts, markers | Natural turf (mowing stripes, grain, wear), worn paint. |
| `render/stadium.ts` | **Phase 2.** Stadium bowl | Two tiers, roof, light rigs, podium wall with the players' tunnel, ~14k instanced spectators animated in the vertex shader from one `uEnergy` uniform. **Phase 3a:** the tunnel is built into the west stand: an open-mouthed passage with a portal and a lit door, and nothing closes the field end. Curved corner stands (tiers, spectators, concourse, facade, roof) close the bowl. |
| `render/playerMesh.ts` | Player and official figure | Rounded rig with contact poses (shoulder hit, wrap, stumble, hip turn, slide). |
| `render/cutscene.ts` | **Phase 2.** Intro director | Tunnel, team intro, coin toss / kickoff setup; only moves meshes and the camera, never game state. |
| `render/coords.ts` | Sim frame ↔ world | Phase 2 adds a frame flip so sims in the CPU's frame (a CPU return) draw in the user's world. |
| `ui/` | DOM overlays. **Phase 3c:** `audible.ts` (the AUDIBLE picker), HOT receiver button, turnover banners, two-minute warning | HUD gains the crowd meter, pocket cue, receiver edge arrows, penalty call-out and kick meter; `intro.ts` is the cutscene overlay. **Phase 3a:** `PlaycallScreen.showDefense()` (coverage cards plus the coordinator's call), the Sound ON / MUTE and CPU drives settings. **Phase 3b:** the defender strip (all eleven, DL · LB · DB) and SWITCH (secondary button) in `TouchControls`; the HUD's large aim bar and step indicator for the kick meter, both teams' timeouts as dots in the score bug, OT label and the untimed clock; punt / field goal disabled on tries, punts disabled in overtime. |
| `audio/crowdMix.ts` | **Phase 3a.** What the crowd sounds like (pure) | `layerGains(meter)` gives murmur, chatter and chant levels. `reactionTo(play)` / `reactionToFlag()` work from the home crowd's view: cheers on big plays and stops, boos on flags against the home team, a short roar on home touchdowns and takeaways, silence on home turnovers and opponent scores. Tunables: `data/audio.json`. |
| `audio/crowdAudio.ts` | **Phase 2, rewritten in 3a.** Synthesized stadium sound | Web Audio, no files. A crowd bus carries murmur, formant chatter and a stomp-stomp-clap chant, with volume following the meter. Cheer, roar and boo voices sit on top; silence ducks the bus and cuts the voices. Whistle and kick thump bypass the bus. Unlocked by the first tap (iOS); mute = the Sound setting. |
| `app.ts` | Glue: phase machine, fixed-step accumulator, input → sim mapping, gaze | Owns the only mutable `GameState` reference. **Phase 3b:** `startConversion()` (user choice modal / CPU chart; the kick uses the field goal meter, the two-point play is a normal snap or a defensive snap), the kick's `stage` (power, then aim), cover-man input on returns, SWITCH and the defender strip on defense, the overtime break, CPU timeouts before CPU snaps. **Phase 3a:** CPU possessions run `enterDefense()` (fourth-down call, defensive play call) → `callDefense()` (CPU play, `PlaySim` with `userDefense`, `CpuQB`) → `presnapDefense()` (auto snap) → `liveDefense()`; `whistle()` is shared with offense. No penalty chains: the first play-clock expiry after a flagged play only resets the clock. |

### Determinism

- `PlaySim` and `ReturnSim` take a seed. Given the same inputs they produce
  the same events and result (tested in `tests/sim.test.ts`).
- Penalties roll on their own forked RNG stream, so turning them on or off
  never changes the football itself (until a foul actually happens).
- **Phase 3c:** fumbles roll on their own RNG, seeded from the play seed (not
  forked, so the block and penalty streams are unchanged); a play only
  differs from Phase 3b once a ball actually comes out. Audibles use their own
  RNG per snap (`AudibleSession`).
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

Phase 3a adds:
- `tests/interception.test.ts`: **interception timing window**. Grades,
  nested windows, perfect > good > none > mistimed for picks, a pick is
  never automatic, reach.
- `tests/penalties.test.ts`: **one flag max**. `callFoul`, enforcement of
  several fouls, and no play ever has more than one flag even at 400× foul
  rates. Also declined / accepted down and distance, and rare flags at
  Normal.
- `tests/defenseControl.test.ts`: the user CB follows only the stick,
  switching, determinism, timed jumps beat no jump.
- `tests/qbAI.test.ts`: the CPU QB plays every play to a whistle with sane
  completion / INT / sack rates, Hard beats Easy, play calls follow down and
  distance, fourth-down calls.
- `tests/sim.test.ts`: routes stay in bounds.
- `tests/audio.test.ts`: crowd layers and reactions.

Phase 3b adds:
- `tests/blocking.test.ts`: **block outcome logic**. Matchup grades, hold time
  follows quality (strong blocks outlast weak ones), doubles hold longer,
  protection (pass sets, doubles, back pickups, chip and release), run plans
  (doubles, climbs, zone drive) and lanes; in the sim a weak line gives up
  pressure early and loses run yards, a strong one holds.
- `tests/blitz.test.ts`: **blitz success**. Paths and arrival times, designs,
  recognition, sack / hurry / blocked / late, slide protection, and in the sim
  the Fire Zone nickel blitz is mostly blocked, never gets home on a quick
  throw, and outcomes vary with throw timing.
- `tests/interception.test.ts`: **interception timing window** plus the read
  (read + perfect jump beats either alone and stays below 50 % on the spot);
  `tests/defenseControl.test.ts`: in the sim, reading the throw plus a timed
  jump picks more than trailing the receiver; every defender is playable,
  SWITCH, rip move.
- `tests/targets.test.ts`: **balance**: CB target share, outside-CB share and
  interceptions per game at Normal stay inside `balance.json` → `targets`.
- `tests/specialTeams.test.ts`: two-layer kick meter (needle, punt angle,
  field goals: power timing as before, aim decides wide or through), kick
  coverage (user cover man, dives shorten returns, SWITCH).
- `tests/overtime.test.ts`: **overtime sequence** (start, possessions,
  periods, alternation, mandatory two from 2OT, shootout from 3OT, defensive
  score, walk-off touchdown, played field goals).
- `tests/conversion.test.ts`: **conversion choice** (options, CPU chart,
  two-point play, quick tries, a try at 0:00, simulated drives) and timeouts.

Phase 3c adds:
- `tests/joystick.test.ts`: fixed base, size, no overlap with the action
  cluster on iPad / phone viewports.
- `tests/specialTeams.test.ts`: **kickoff out of bounds** (kicking team's 40),
  **meter penalty** (one curve; a bad needle gives a short flat kick, a bad
  power costs extra yards).
- `tests/coverage.test.ts`: **Cover 3 balance** (LB1 zone open rate under
  `balance.json` `zoneCoverage.maxOpenRate`, no straying), matcher handoffs,
  gap throws are contested.
- `tests/blitz.test.ts`: **blitz pressure**: the user's LB1 blitzing in Cover 3
  against an average line: sack rate and QB detection time inside
  `balance.json` `surpriseBlitz`; weak line > strong line; the ball comes out
  sooner; no false alarms.
- `tests/audible.test.ts`: **audible reaction** (the defense changes its call
  exactly at its reaction time; Hard reacts better), **clock costs**, the run
  edge.
- `tests/clock.test.ts`: **clock stops** (NFL rules, late windows, two-minute
  warning, snap timing); `tests/gameLength.test.ts`: a 4 × 5 game within
  `pace.json` `targetRealMinutes`.
- `tests/turnoverReturn.test.ts`: **return control** (pick returns steered by
  the user, CPU pick chased by the user, live fumbles, rules).
- `tests/qbAI.test.ts`: **CPU 3rd / 4th play selection** (never a designed run
  on 3rd / 4th and 8+, in played and simulated drives).

Stat probes: `JUMP_STATS=1`, `QB_STATS=1` or `BALANCE_STATS=1 npx vitest run
tests/<file> --silent=false`. `BALANCE=gamelength npx vitest run
--silent=false` prints plays per game, game-clock seconds per play, clock
stops per game and the real-time estimate for every quarter length.

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
  out of bounds gives the ball at the 40 (Phase 3c: the kicking team's 40). No onside kicks, fair catches or
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

## Phase 3a defaults (decisions that were not specified)

- **One flag per play.** The first foul throws the flag. A later, more severe
  foul replaces the call under the same flag, and a lesser one is not called.
  Severity: PI 4, roughing / face mask 3, holding 2, false start / offside 1;
  ties keep the first. There are no offsetting fouls any more.
- **No penalty chains.** After a flagged play, the first play-clock expiry
  only resets the clock (no delay of game). A second expiry is a real delay
  of game. While the user picks a defense the CPU never gets a delay of game.
- **Penalty rate per difficulty** (`penaltyRate` in `difficulty.json`): Easy
  0.2, Normal 0.25, Hard 0.3, on top of the per-opportunity chances.
  Offensive holding went from 0.06 to 0.03 per opportunity. The test keeps
  flags under 12 % of snaps at Normal without the crowd edge (Phase 2 was
  about 28 %).
- **Audio** is fully synthesized: no bundled samples, nothing to download.
  Reactions are the *home* crowd's. A takeaway by the home defense gets a
  roar; a home turnover or an opponent score goes silent. The old "Sound"
  setting is the mute toggle (ON / MUTE).
- **Camera:** the broadcast view ("BROADCAST", was "BEHIND QB") is the new
  default; old saves are switched once (`settings.v`). QB eyes stays
  available and drops to the broadcast view during a scramble, so the field
  axis never turns.
- **Routes:** receivers stay 1.5 yd off the sideline, and a route that ends
  heading outward turns upfield over its last 3 yd. No player without the
  ball ever gets closer than 0.4 yd to the sideline, so toe-tap catches are
  not possible.
- **CPU drives are played** by default (setting "CPU drives: PLAY DEFENSE /
  QUICK SIM"). The defensive play call offers every `DEFENSE_CALLS` entry
  plus "Coordinator's Call" (the Phase 2 CPU caller). The offense snaps by
  itself 4 s after the call (Phase 3c: 2 s); READY snaps at once.
- **Controlled defenders:** CB1, CB2 and the nickel (NB). The user's
  teammates cover at Normal on every difficulty; difficulty shows in the CPU
  QB (`cpuOffense`) and the flag rate. Stick "up" moves the CB toward the
  line of scrimmage, because the camera looks at the offense.
- **Jump:** peaks 0.28 s after the press. Windows: ±0.07 s perfect, ±0.16 s
  good, ±0.35 s mistimed. Effects on the user defender only:
  - Perfect: +30 % breakup, +0.5 yd reach, normal pick chance.
  - Good: +15 % breakup, −10 % picks.
  - No jump: −20 % picks (he can still bat the ball away).
  - Mistimed: −20 % breakup, −30 % picks.

  Standing on the landing point, a perfect jump picks about 36 % of throws,
  no jump about 16 %, a late jump about 1 %. CPU defenders are unchanged.
  Against a runner, JUMP is a diving tackle (2.2 yd range, ×1.1).
- **CPU QB** at Normal against eleven CPU defenders: about 49 % completions,
  6 % interceptions, 10 % sacks and 4.5 yd per play. On fourth down it kicks
  a field goal from the opponent's 38. It goes for it on 4th and 1 from
  midfield, or when trailing late, and punts otherwise (the user returns
  the punt).

## Phase 3b defaults (decisions that were not specified)

- **Blocking.** A matchup grade is (blocker rating mix − rusher rating mix) /
  18, clamped to ±1: pass blocks weigh blocking 2 : strength 1 against pass
  rush 2 : strength 1 : speed 0.5; run blocks weigh strength more. An even pass
  block holds 4.8 s, ×e^(0.8·grade), with ±30 % rep variance (lognormal), on
  its own RNG stream so blocking never shifts catches or tackles. A double team
  uses its hold time 2.4× slower. After 1.6 s the QB holding the ball wears
  every block down faster (+30 % per second). Even run blocks hold 1.9 s,
  ×e^(1.5·grade). There is no fixed early-loss roll any more (Phase 2 lost 10 %
  of reps at random). Measured: a line of 95s gives up its first shed about
  1.5 s later than a line of 50s, and rushing yards per carry go from about 2.5
  (line of 50s) to 6.3 (line of 95s) against the same defense.
- **Run designs** carry a `scheme`: HB Dive = inside, Outside Zone = zone,
  Toss = toss, Pistol Counter = power, HB Draw = draw. Gap schemes double the
  man nearest the aim; the second man climbs to a linebacker after 0.5 s. The
  carrier compares the design gap (+1.2 yd bias) with one gap either side
  (zone: two) while he is behind the line.
- **Protection.** Linemen take rushers inside-out and only within 3.6 yd
  laterally. A blitzer outside that range goes to a back on his side, else the
  line slides toward him (the spare lineman starts the slide), else a back
  crosses the formation. A back on a `check` route with nobody to block chips
  the edge rusher for about 0.5 s (max 1.3 s), then runs his route. He stays in
  while the blitzer he picked up is still coming.
- **Blitz recognition** at the snap: edge 75 %, A gap 60 %, B gap 65 %,
  delayed 40 %, scaled by the line's awareness. An unseen blitzer comes free;
  then only the throw timing decides (quick throws beat him). A free rusher
  within 2.2 yd at the release hurries the throw (pressure ≥ 0.85, which
  costs accuracy). Measured on the Fire Zone nickel blitz when the QB holds the
  ball: blocked about 75 %, sack about 25 %; a throw at 0.9 s never gets sacked.
- **Corner targets.** A target "goes to" the defender nearest the receiver at
  the release. The CPU QB adds `slotBias` (WR1 +0.08 s, WR2 +0.06 s, RB −0.1 s)
  to its window reads and reads the back only after 1.9 s unless pressured.
  Normal, all-CPU defense: CB1 + CB2 + NB about 54 % of targets, CB1 + CB2
  about 28 %, 1.3 interceptions per 32 attempts. Ranges in `balance.json`:
  35–65 %, 20–45 %, 0.4–1.8 per game.
- **CPU picks** are rarer: the pick share of a defender's hands-on plays is 0.1
  (Phase 2: 0.3), +0.04 in phase (was +0.15), +0.08 when no receiver is near
  (was +0.2); in-flight undercuts 0.15 (was 0.3). CPU QB at Normal: about 47 %
  completions, 4 % interceptions, 16 % sacks (Phase 3a: 49 %, 6 %, 10 %).
- **The read.** Margin = receiver's distance to the catch point minus the
  user defender's at the arrival. ≥ 0 undercut (+12 % picks, +10 % breakups),
  ≥ −0.8 even (+5 %), ≥ −1.8 trail (0), else beaten (−8 %). A perfect jump now
  adds +8 % picks, no jump −30 %. Sim, user corner shadowing the receiver:
  perfect jump and read about 31 % picks, perfect jump while trailing about
  15 %, no jump about 4 %.
- **Any defender.** SWITCH = secondary button (X / Shift / pad LT·L3): the
  defender nearest the ball during the play, the next slot before the snap.
  The strip (top right) selects any slot directly; 1 / 2 / 3 still jump to
  CB1 / CB2 / NB. JUMP while a blocker has you is a rip move: it uses up 0.9 s
  × (pass rush / 75) of that block's hold time, once per 1.2 s. Linemen and
  linebackers get a higher camera (`camera.json` `defenseUnits`).
- **Kick meter, layer 2.** Hold KICK for power (Phase 2 zones), release, then a
  needle sweeps left-right (0.9 s per side, starting at the left) and a tap
  locks it; it locks itself after six sweeps. Kickoffs / field goals: needle =
  sideways direction (±9° at the ends; green ±0.16 × kickWindow); punts:
  needle = launch angle 25°–70°, green ±7° × kickWindow around 50°. Kick
  quality = 60 % power timing + 40 % aim; 30 % of the old random sideways
  spray remains. **Field goals** keep the power-zone timing (distance-dependent
  zone, short kicks fall short); the second layer replaces only their random
  sideways error, so all three kicks use the same two-tap control. The CPU
  still uses the Phase 2 single release.
- **Kick coverage.** The user starts on LB2 (the middle of the coverage line).
  DIVE: lunge (+2.6 yd/s), tackle range 2.3 yd (normal 1.0), tackle chance
  ×1.1 for 0.4 s; a miss puts him on the turf for 0.7 s. RIP against a return
  block cuts 0.6 s off it. A blocked cover man moves at 1.2 yd/s. The stick is
  mirrored like on defense (the camera looks back at the returner).
- **Tries.** A touchdown is worth 6 everywhere (offense, pick six, kick
  returns); then the try. Kick = a 20-yard field goal with the two-layer meter
  (snap from the 3, college distance); two = one play from the 3, good only as
  a touchdown, untimed, no flags. The CPU kicks before the fourth quarter;
  from the fourth on it goes for two when, after the touchdown, it trails by
  2, 5, 9, 10, 12, 16 or leads by 1, 4, 5, 12, 15, 19. In overtime period 1 it
  kicks, except to win when trailing by one on the second possession. Quick
  tries: kick 96 %, two 45 %. A CPU two-point try is defended live when CPU
  drives are played; otherwise it is resolved instantly. Defensive returns of
  failed tries (2 points for the defense) are not modelled.
- **Timeouts.** 3 per team per half (reset at half time, not carried over), 1
  per team per overtime period. They stop the game clock and reset the play
  clock, and can be called from the play-call screen (offense and defense) or
  T/O / O / pad Back before the snap. The score bug shows each team's left as
  dots. The CPU offense calls one after an in-bounds play in the last 2:00 of
  the 2nd quarter, or of the 4th when it trails or is tied.

## Phase 3c defaults (decisions that were not specified)

- **Joystick.** Fixed at the bottom left: base radius 92 px, knob 38 px,
  36 px from the left and bottom safe-area edges. A touch anywhere in the hit
  circle (base + 44 px) grabs the stick and points it from the base center at
  once; nothing follows the thumb. The left half outside the circle does
  nothing. The action cluster keeps its full size (the old 0.82 scale on short
  screens is gone) and its 310 px box stays at least 24 px clear of the stick
  on every tested viewport (iPad 1180×820 / 820×1180 / 1366×1024 / 1024×768,
  phone 844×390). The secondary button (SLIDE / DASH / SWITCH / AUDIBLE) moved
  to the cluster's free top-left corner; it used to overlap receiver 1.
- **Kickoff out of bounds**: the receiving team takes over at the *kicking*
  team's 40 (receiving frame 60), as specified (the NFL uses the receiving
  team's 40). A kickoff that rolls out untouched also counts.
- **Kick meter penalty.** One curve for both layers: 0 inside the green zone,
  rising to 1 at 4 half-widths out (exponent 1.3). Power layer: up to −30 %
  launch speed on top of the lower power. Aim layer: up to −15 % speed, 14°
  flatter (kickoffs / field goals) and up to 30° further sideways, so a needle
  at the end of its sweep gives a short, flat kick that can go out of bounds.
  Punts already flatten or balloon with the angle needle and also lose speed.
  A 2.5-half-width field goal miss now usually falls short instead of going
  wide.
- **Pattern-match zones.** Every underneath zone defender owns at most one
  receiver, and only while that receiver is in his area (landmark ± zone
  width, from 1 yd behind the LOS to 7 yd past the zone depth). He releases
  him 1.5 yd past the edge, and the next zone whose area the receiver enters
  picks him up (a handoff, recorded in `sim.handoffs`). He works 65 % of the
  way from his landmark to his man but never leaves 90 % of his zone width.
  Zone defenders face the QB and break on a throw after 70 % of their
  reaction (man defenders still add `manBallReadDelay`). Measured at Normal:
  receivers inside the Cover 3 LB1's zone are open on about 5 % of samples
  (threshold 15 %); he strays about 1.9 yd from his landmark; mesh produces
  about 3 handoffs per snap; throws to the primary in Cover 3 holes at 1.7 s
  complete about 55 %, and 26 % are broken up or picked.
- **The user's own call.** The zone the user's defender was given stays his:
  CPU teammates do not fill it when he leaves (the matcher skips him), so a
  blitzing LB opens his hook zone, and the QB sees that because every window
  read uses actual positions.
- **Surprise rushers** (blitzes nobody planned for: the user's defender, a
  green dog, a designed blitzer the line did not identify): a non-lineman
  within 4 yd of the LOS, within 12 yd of the QB and closing at 4.5 yd/s or
  more. A man defender within 4 yd of his receiver, or whose receiver lies
  within 35° of the line to the QB, is covering, not rushing (no false alarms
  on backs). Linebackers stepping up on a play fake are ignored during the
  bite. The line treats him as a rusher (any free blocker may pick him up)
  0.5 s × 75 / line awareness later; the QB notices him 0.35 s × 75 / QB
  awareness later, plus 0.25 s if he comes from outside a 100° field of view.
  Pressure counts him from the start by how he is actually blocked (free,
  engaged, picked up). Measured, user LB1 blitzing straight at the QB in
  Cover 3 against an average line, CPU QB, Normal: about 24 % sacks (range in
  `balance.json` 12-40 %), detection 0.35 s on average (range 0.2-0.6 s), the
  ball comes out about 1.0 s after he triggers.
- **Hot reads.** Once alerted the CPU QB reads at once: he throws to the most
  open receiver (`sim.hot`) if the window beats 0 s (with read noise), else
  throws it away above pressure 0.55. The user QB sees `sim.hot` as a pulsing
  red receiver button. Side effect: the CPU QB at Normal now takes fewer sacks
  (Phase 3b 16 % of dropbacks, now 12 %) and gains more (4.4 → 5.4 yd per
  play, 47 → 49 % completions), mostly against Cover 0 / Cover 1 blitzes.
- **Audibles.** Up to 3 per snap, 2-3 options per play from the same formation
  (trips has no run, so its run-like check is the bubble screen; the pistol
  has a single play, so it checks to shotgun plays with the same personnel).
  Play-clock cost 3 s, then 5 s, then 7 s; the game clock is not touched. The
  CPU defense re-reads after 1.5 / 1.0 / 0.6 s (Easy / Normal / Hard) and
  checks to the right counter (vs. run: Cover 1 Blitz / Cover 1 / Cover 0; vs.
  pass: Cover 2 / 2-Man / Cover 3) with chance 0.4 / 0.65 / 0.9, else keeps its
  call. Snapping before the re-read against a blitz look after a run audible
  earns the edge: blitzers read the run 0.45 s later and only get an arm on
  the runner (tackle × 0.35) until then, run blocks grade +0.25. Measured, four
  runs vs. Cover 1 Blitz / Cover 0 / Fire Zone: about +2.4 yd per play (HB
  Counter −0.1 → 4.8, HB Draw −1.0 → 2.3). No audibles on two-point tries.
- **NFL clock.** First downs never stop the clock. Out of bounds and accepted
  penalties stop it only in the last 2:00 of Q2 and the last 5:00 of Q4,
  otherwise it restarts when the ball is ready. Two-minute warning in Q2 and Q4.
  Both windows are NFL seconds for a 15-minute quarter and scale with the
  quarter length (5-minute quarters: warning at 0:40, Q4 window 1:40).
- **Snap timing.** On a running clock the offense snaps with 5 s on the play
  clock: at the snap the game clock runs off what is left down to 5 s, for
  user and CPU snaps alike, whatever the real time spent. No runoff in the
  hurry-up after the two-minute warning, never past the warning, and never
  to 0:00 before a snap. Simulated CPU drives use the same runoff (play clock
  40 ± 4 s); in the hurry-up they spend 12 s between snaps.
- **Game length.** Target in `pace.json`: a 4 × 5-minute game in at most 15
  real minutes. Real seconds per step (estimates): picking a play 6, until the
  snap 3 (CPU snaps: the defensive call 3 plus the auto-snap 2), live play 6,
  post-play 1.3 (the app's pause, was 1.7), kick with return 12, score 4,
  break 5. The CPU offense's auto-snap went from 4 s to 2 s. Measured with
  `BALANCE=gamelength` (20 games each):

  | Quarter | Plays / game | Clock s / play | Clock stops / game | Real minutes |
  | --- | --- | --- | --- | --- |
  | 3 min | 40 | 16 | 24 | 11.6 |
  | 5 min | 52 | 21 | 27 | 14.8 |
  | 15 min | 129 | 24 | 64 | 36.6 |

  Before Phase 3c a user snap on a running clock only ran off the seconds the
  user actually waited (about 9 s), and out of bounds always stopped the
  clock: the same model gives about 114 plays and 33 real minutes for 4 × 5
  (21 minutes for 4 × 3).
- **Turnover returns.** After an interception or a fumble the defense recovers,
  the play goes on until a tackle, the sideline, the end zone or 14 s. User
  on defense: control goes to the man with the ball (JUMP = juke, SWITCH off
  while he has it). User on offense: he steers the offensive player nearest
  the ball or returner (idle stick = pursuit angle). Tackles use the shared
  tackle model (offensive tacklers at factor 1). Return-team players screen
  the nearest pursuer; a pursuer within 0.9 yd of one runs at 45 % speed. A
  returner at the sideline or end line is placed 0.6 yd inside. Result:
  outcome `interception` at the end of the return (rules: the defense's ball
  there, pick six / scoop and score at the goal line, touchback in its own end
  zone), `fumble` and `returnYards` on the result.
- **Fumbles.** On a successful tackle: 1.8 % × 1.6 for a shoulder hit × 1.5 on
  a sack, × (1 + strength difference / 100), at most 6 %. Measured: about 1.8 % of
  run plays fumble (11 of 600 at Normal). The ball pops out at 2-4.5 yd/s and rolls; the
  nearest man within 0.9 yd falls on it (30 % per step), after 3.5 s the
  nearest player gets it. Out of bounds: the offense keeps it at the spot
  (never ahead of the fumble); out of its own end zone it is a safety, out of
  the other end zone a touchback. An offensive recovery plays on. CPU
  simulated drives still have no fumbles (Phase 1 model).
- **CPU play calls.** 1st / 2nd down mixes as before. 3rd / 4th down: short
  (≤ 2) 55 % runs, normal (3-7) 15 %, long (8+) 0 %: designed runs are never
  called on 3rd / 4th and long; a scramble on a pass play is still possible.
  Simulated CPU drives use the same run share. Without room for a deep shot
  (inside the 20), the deep call becomes a short / medium pass.

## Overtime rule (NCAA, 2021 book), as implemented

1. A game tied after four quarters goes to overtime. There are no kickoffs,
   no punts and no game clock (the play clock still runs); each team has one
   timeout per period.
2. Coin toss: the winner is the game seed's parity (even = home). The winner
   always defers, so the other team has the first possession of period 1.
3. **Periods 1 and 2:** each team gets one possession, first and 10 from the
   opponent's 25. A possession ends on a touchdown, a field goal attempt (made
   or missed), a turnover or a turnover on downs. A safety or a defensive
   touchdown (pick six) ends the game for the defense.
4. After a touchdown in period 1 the team may kick (1) or go for two (2).
   **From period 2 the try must be a two-point play.** If the team with the
   second possession scores a touchdown that already wins (lead greater than
   2), the game ends without the try.
5. After both possessions: if the scores differ, the game is over. If tied,
   the next period starts and the team that went second in the previous
   period goes first.
6. **From period 3** there are no possessions from the 25: each team runs one
   two-point play from the 3 per period (alternating, the order flips every
   period). A period with one success and one failure ends the game.

## Extension points

### Phase 3d: visuals, audio, animation

The Phase 3b list below still applies; Phase 3c adds hooks for:

- **Turnovers on screen.** `fumble` / `recovery` / `interception` events name
  the actor; `sim.loose` (where and when the ball came out) and
  `sim.turnover` (kind, spot, returner) are enough for a fumble scramble
  animation, a change-of-possession camera cut or a pick-six celebration.
- **Pre-snap.** `AudibleSession` (count, pending re-read, `edge`) can drive a QB
  hand-signal animation, a "defense shifting" visual when the re-read lands and
  a crowd reaction to a caught blitz.
- **Pressure.** `sim.surprise` (rush start, line / QB notice times, blind
  side) and `sim.hot` can drive a QB head turn, a "HOT!" call-out and a blitz
  arrow; `sim.handoffs` can draw zone handoffs on a replay.
- **Clock.** `ClockState.warned` and `pacedSnap()` let a broadcast-style
  two-minute warning bumper or a "clock running" HUD sit on the existing state.

Phase 3b hooks:

- **Block and blitz visuals.** `PlaySim.blockStates()` exposes every block
  (blocker, defender, role, grade, progress 0..1); `blitzReport()` and the
  `pickup` / `hurry` / `rip` / `chip` events say what happened to blitzers.
  Contact poses for blocks (`PlayerMesh` already has shoulder / wrap /
  stumble) can be driven from them without touching the sim.
- **Pick moments.** `lastTiming` now carries `grade`, `offset`, `read` and
  `margin`: enough for slow-motion or camera beats on an undercut pick. A
  cutscene director for scores, tries and overtime would hang off the
  `scored` result and the `overtime` break in `app.handleBreak`.
- **Crowd audio.** `audio/crowdMix.reactionTo()` takes a `PlayForCrowd`; tries
  and timeouts already feed it. Overtime periods, two-point tries and late
  timeouts are natural places to raise the meter or add chants (data in
  `audio.json`).
- **HUD art.** The kick meter's second layer (`#aimbar`), the defender strip
  (`#defstrip`) and the timeout dots are plain DOM with CSS classes; they can
  be restyled or replaced by canvas art without changing `Hud`'s API.

### Defense: what is still open

- **User-defender fouls.** DPI already applies to the user defender. Holding
  would call `addFoul('holdingDefense')` from `controlDefender()` when he stays
  in contact past 5 yards.
- **Defensive two-point returns.** `PlaySim.startReturn()` works on any play;
  a two-point try only needs `finishReturn()` to score 2 for the defense
  instead of a possession.
- **Pre-snap defense.** Shading or pressing would move the selected actor
  during `presnapDefense()`. The user's defensive audible can reuse
  `AudibleSession` with the roles swapped (the CPU offense re-reads via
  `counterCall()`-style data). Blitz designs are data (`blitz.json`); a user
  blitz that is not in the call already works as a surprise rusher.
- **Offensive hot routes.** `sim.hot` names the open receiver once a blitz is
  noticed; a user hot route would set that receiver's route to a quick
  `slant` / `flat` in `PlaySim.routes` before the snap.

### Career mode (later phase)

- **Persistent data.** `GameState` (with `crowd`, `pendingKickoff`,
  `pendingConversion`, `overtime`) and `TeamData` are plain data:
  `JSON.stringify` them into a save slot. `Settings` already carries a
  version (`v`) for migrations.
- **League/season layer.** Add `src/career/` for the league (teams, schedule),
  season state, standings and contracts. Home/away per game sets
  `GameState.userSide`. Overtime always produces a winner, so standings need
  no ties.
- **Progression.** Mutate `ratings` between games from per-player stat lines.
  **Phase 3c:** `fumble` / `recovery` events, `returnYards`, `surpriseReport()`
  (who blitzed unplanned, sack / hurry / blocked) and `handoffs` give forced
  fumbles, recoveries, return yards and coverage stats.
  `PlaySim` events carry actor ids (`catch`, `handoff`, `tackle`, `flag`,
  `interception`, `jump`, `timing`, `shed`, `pickup`, `hurry`), `blitzReport()`
  and `blockStates()` give per-player blocking and pass-rush wins (pressures
  allowed, sacks, pancakes), `ReturnResult` names the returner.
- **Ratings now matter more.** Blocking, strength, pass rush, speed and
  awareness feed `blockQuality()` and blitz recognition directly, so roster
  and progression changes show up in sacks and rushing yards without any sim
  change.
- **CPU identity per team.** `CPU_OFFENSE.calls`, `slotBias`, `fourthDown`,
  the conversion chart (`rules.json`) and blitz designs (`blitz.json`) are
  plain data; per-team overrides passed to `chooseCpuPlay`, `CpuQB`,
  `chooseConversion` and `PlaySim` give coaches a style.
- **Kickers.** Add K/P to the depth chart and scale `kickFlight` speed and the
  aim needle's speed or green zone by their ratings; the meter stays the same.
  `timingPenalty()` takes a zone, so a kicker rating can widen the zone and
  the penalty follows.
- **Season pace.** `pace.json` (quarter length, snap timing, real-time target)
  is plain data; a season setting can pick a preset per game type.
- **QB intelligence.** Awareness already sets how fast the line and the QB
  notice a surprise rush (`surpriseReaction`), so QB progression shows up in
  sacks and hot throws without sim changes.

### Transfers and trading (later phase)

- **Trading logic.** Player value comes from ratings, age and position. AI
  teams accept when the value they gain exceeds what they lose, weighted by
  positional need (empty depth-chart slots). `teamGrades()` in
  `data/index.ts` aggregates unit strength; `blockQuality()` can rate a line
  against a typical front for line-specific value.
- **Transfer windows** belong to the season state in `src/career/` (dates on
  the schedule); the game itself only needs the resulting `TeamData`.
- **Ball security for value.** Strength sets fumble odds (`turnovers.json`); a
  carrying / ball-security rating would slot into `fumbles()` and into player
  value.
- **Roster changes are free for the sim.** The sim reads players only through
  `playerFor(team, slot)`, so trades and depth-chart edits take effect without
  any sim changes. Returns, coverage units, the CPU QB and every defender the
  user controls use the same lookup.

## Known gaps (Phase 3c)

- **Passes into blitz looks gain too much.** Against Cover 0 / Cover 1
  Blitz the CPU QB averages 17-25 yd per play in probes, mostly yards after
  the catch (about 16 yd per catch against man coverage, 6 against Cover 3):
  man defenders trail by more than tackle range at the catch and nobody is
  deep. Hot reads (Phase 3c) made this more visible (Cover 0: 10 → 25 yd per
  play for the pass concepts probed). So a run audible against a blitz look
  gains clearly more than the same run without the edge (+2.4 yd), but not
  more than a pass into that blitz. Fixing it means tackling / pursuit after
  the catch in man coverage, which changes many balance numbers; left for a
  focused balance pass.
- **Game length is an estimate.** The 15-minute target is checked with a
  model (quick-sim drives for both teams plus fixed real-time costs per step
  in `pace.json`), not by playing. A slow play caller or many returns will
  take longer; 4 × 5 is at about 14.8 minutes, close to the limit.
- **Fumbles only in played snaps.** Simulated CPU drives (QUICK SIM) still
  have no fumbles and no returns. Fumbles out of bounds use a simplified spot
  rule; there is no recovery in the end zone other than touchback or safety,
  and no fumble on a kick return.
- **Returns are simple.** Return blockers only screen (they slow a pursuer at
  0.9 yd, no engagement or block grades), the CPU returner runs a single
  avoid line, laterals do not exist, and a return ends after 14 s.
- **Surprise rush detection is behavioural**: a man defender running at the
  QB from more than 4 yd off his receiver counts as a rusher. Screens never
  raise an alert (their rush is on purpose).
- **Audibles:** the user's offense only; there is no defensive audible for
  the user, no audibles on two-point tries, and the CPU offense never
  audibles. Options are a fixed list per play.
- **NFL clock:** no 10-second runoff, no clock start on the kickoff touch
  (the return runs on live time), and accepted-penalty stops ignore which
  team fouled.
- **CPU play mix** reacts to down and distance only, not to the score, the
  clock or the opponent's tendencies.
- **Joystick:** fixed position only (no left-handed mirror), and the touch zone
  outside the circle does nothing.
- Not done here by design (Phase 3d): visuals, animations and sound for the
  new features (fumble scrambles, audible signals, two-minute warning bumper).

## Known gaps (Phase 3b, still open unless fixed above)

- **Sacks run high for the CPU QB** (about 16 % of dropbacks at Normal in
  3b, 12 % with the Phase 3c hot reads; NFL ≈ 7 %). Most come from a single lost block against strong rushers late
  in a dropback, or from the man-coverage calls where nobody is open; the
  CPU QB does not throw it away early enough.
- **Outside Zone with a weak line** loses yards on most snaps against a strong
  front, while HB Dive gains a lot against Cover 3. The run game is now
  rating-driven but not yet balanced per play.
- **Blocks have no special animation**: engaged players stand chest to chest;
  rips, chips and pickups show only in outcomes (3c).
- **The read** is graded from position at the catch, not from when the user
  started breaking on the ball; a defender who is already ahead of the route
  gets it "for free".
- **Blitz recognition is a roll** at the snap (path and line awareness); there
  are no protection calls or user hot routes (Phase 3c: the QB reacts to
  blitzes the line missed, and the open receiver is shown as HOT).
- **Two-point tries** cannot be returned by the defense, and tries have no
  penalties. CPU extra points resolve instantly (no kick animation), like CPU
  field goals.
- **Overtime coin toss** is the game seed's parity and the winner always
  defers; the user cannot choose.
- **Timeouts:** the CPU only uses them on offense late in a half; it never
  ices a kicker or saves time on defense. Timeouts cannot be called during a
  play or on kicks.
- **Kick coverage:** cover men cannot be blocked into the returner, there are
  no onside kicks or fair catches, and the user cannot down a punt by hand
  (the CPU coverage still does).
- **CPU kickers** use the Phase 2 single release (no aim layer) but are scored
  on the same flight model.
- Still open from 3a (turnover returns are done in 3c): crowd
  sound is synthesized (iOS needs one tap first); no toe-tap catches at the
  sideline; the CPU QB never scrambles on purpose; the defense camera leans
  when switching to a defender on the other side of the ball.
- Only CB1 / CB2 / NB have keyboard shortcuts; the other defenders need the
  strip (touch / mouse) or SWITCH.
- Tested headless (Chromium, iPad-sized 1180×820 landscape and 820×1180
  portrait touch viewports), not yet on a physical iPad.
