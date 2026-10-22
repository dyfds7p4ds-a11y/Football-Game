# Architecture

The game is split so that football logic never touches the DOM or Three.js.
The same simulation code runs in the browser, in unit tests and in headless
balance scripts. Phase 2 kept the Phase 1 module structure and added modules
next to the ones they extend; Phase 3a does the same (playable cornerback
defense, CPU quarterback, stadium audio, one-flag penalties).

```
            ┌────────────┐   InputFrame    ┌──────────────────────────────────┐
 touch ───▶ │   input/   │ ──────────────▶ │              app.ts              │
 keys  ───▶ │ InputMgr   │                 │ user ball: playcall → presnap →  │
 pad   ───▶ └────────────┘                 │ live → postplay → (break)        │
                                           │ CPU ball: defense call → presnap │
                                           │ → live (user CB + CpuQB) → post  │
                                           │ kicks: kick / return             │
                                           └──┬────────────┬───────────────┬──┘
                       SimInput / ReturnInput │            │               │ GameState
                                (fixed 60 Hz) ▼            │               ▼
                   ┌─────────────────────────────────┐     │   ┌────────────────────────┐
 data/*.json ────▶ │ play/ PlaySim (scrimmage)       │     │   │ game/ rules, penalties,│
                   │       ReturnSim (kick returns)  │     │   │ specialTeams, crowd,   │
                   │ coverage, windows, tackle,      │     │   │ clock, flow, cpuDrive  │
                   │ screen, penalties, officials,   │     │   └────────────────────────┘
                   │ kicking, routes, throw, catch,  │     │
                   │ interception, qbAI (CPU QB)     │     │
                   └───────────────┬─────────────────┘     │
                         read-only │                       │ read-only
                                   ▼                       ▼
                   ┌─────────────────────────────┐  ┌──────────────────────────┐
                   │ render/ SceneView, FieldView│  │ ui/ HUD, touch, playcall,│
                   │ Stadium, PlayerMesh,        │  │ menus, intro overlay     │
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
| `play/catch.ts` | Catch, drop, breakup and interception resolution (pure) | Phase 2 adds the in-phase defender bonus and screen-timing factors. Phase 3a: a candidate can carry a `timing` bonus (breakup, interception, reach) from the user's jump. |
| `play/interception.ts` | **Phase 3a.** Interception timing window (pure) | `jumpTiming(pressT, arriveT)` grades the user defender's JUMP by how close its peak is to the ball's arrival (perfect / good / mistimed / none); `timingEffect()` maps the grade to catch bonuses; `jumpHeight()` for the renderer. Tunables: `data/defenseControl.json`. |
| `play/qbAI.ts` | **Phase 3a.** CPU offense | `CpuQB.input(sim)` turns the sim state into a `SimInput` each step: drop, progression reads with `windows.throwingWindow()`, the same hold-and-release throw as the user (the sweet spot tracks the receiver), throw-aways under pressure, screen timing, and a ball carrier who bends away from tacklers. `chooseCpuPlay()` calls plays by down and distance; `fourthDownCall()` picks go / field goal / punt. Difficulty `cpuOffense` scales read noise and release error. Tunables: `data/cpuOffense.json`. |
| `play/defenseCalls.ts` | Coverage shells, pressure packages and the CPU play-caller | Cover 0/1/2/3, 2-Man and Fire Zone. |
| `play/coverage.ts` | **Phase 2.** Route-concept reads (`CoverageReader`) | After a read delay (difficulty `coverageRead`), vertical stems are identified; safeties give over-the-top help on the most dangerous vertical (with hysteresis, a poor read sometimes takes the wrong man); underneath zones carry verticals; the deep shell rolls toward the vertical-heavy side; man defenders get in phase on vertical stems. Tunables: `data/coverage.json`. |
| `play/windows.ts` | **Phase 2.** Throwing-window and in-phase metrics (pure) | "Open" = a perfect throw released now beats every defender (after his reaction, with momentum) to the catch point. Used by the balance tests, by the safeties to rank routes, and by the catch code. |
| `play/tackle.ts` | **Phase 2.** Tackle resolution (pure) | Outcome from approach angle (head-on / side / behind), closing speed, ratings and difficulty `tackling`; picks the contact animation (shoulder, wrap, stumble, hip turn, slide). Shared by scrimmage plays and returns. Tunables: `data/tackling.json`. |
| `play/screen.ts` | **Phase 2.** Screen timing window (pure) | Early throws are mostly incomplete, late throws invite interceptions. The per-play design (target, release time, linemen, stalk blockers, window) lives on the play in `plays.json`; tunables in `data/screens.json`. |
| `play/penalties.ts` | **Phase 2.** Foul definitions, flags and call-out text (pure) | `data/penalties.json`: false start, offside, holding (both sides), pass interference, roughing the passer, face mask. **Phase 3a:** every foul has a `severity`; `callFoul(current, candidate)` keeps the more severe one, so a play has at most one flag. Chances are scaled by difficulty `penaltyRate`. |
| `play/officials.ts` | **Phase 2.** Five officials (R, U, H, L, B) | Line up behind the LOS / on the sidelines / deep, move with the play, keep clear of players, throw flags (the nearest official). |
| `play/kicking.ts` | **Phase 2.** Kick meters and flights (pure) | Hold-to-fill power meter with a timing zone (difficulty `kickWindow`); punts add a sweeping angle needle locked on release; ballistic flights; field goals judged against the uprights. Tunables: `data/specialTeams.json`. |
| `play/sim.ts` | `PlaySim`: one play from snap to whistle | Fixed 60 Hz step: offense AI, defense AI (now with route reads, screen reads, rush lanes), blocking engagements, ball flight, tackles (short contact phase before the whistle), penalties (separate RNG stream), officials. Exposes `pocketCue`, `scrambling`, `flags`, `officials`. **Phase 3a:** the `userDefense` option, plus `userDefId` / `selectDefender()` / `userDefender`. `SimInput.defense` (stick + JUMP) moves the selected defender; every other defender stays on the CPU AI. The jump lunges toward the ball, the carrier or his man, is graded against the ball's arrival (`lastTiming`, `timing` event) and extends diving-tackle range. `keepInBounds()` holds every player without the ball inside the sideline. `addFoul()` applies the one-flag rule. A CPU QB's throw uses window scale 1 (the throw-window difficulty belongs to the user QB). |
| `play/returnSim.ts` | **Phase 2.** `ReturnSim`: kickoff or punt from the kick to the whistle | Runs in the receiving team's frame. User or CPU returner (movement + dash), blockers vs. coverage lanes, touchbacks, downed punts, return TDs. Same read-only surface as `PlaySim` for the renderer. |
| `game/state.ts` | `GameState`, plain serializable data | Phase 2 adds `pendingKickoff` and `crowd`. |
| `game/rules.ts` | Downs, scoring, turnovers, Phase 1 instant punts/field goals, delay of game | Pure: `(GameState, play) → GameState`. Scores, safeties and the second half now set `pendingKickoff`. |
| `game/penalties.ts` | **Phase 2.** Penalty enforcement | Accept/decline (offended team takes the better outcome), previous-spot and spot fouls, half the distance, dead-ball fouls. **Phase 3a:** any list of fouls is reduced to the single most severe one (no offsetting fouls). |
| `game/specialTeams.ts` | **Phase 2.** Field position after played kicks and returns | `applyReturn`, `applyFieldGoal`, `kickoffOutOfBounds`; frame conversion for returns. |
| `game/crowd.ts` | **Phase 2.** Crowd pulse 0..100 | Events from plays (home perspective) move the meter; `crowdEdge` gives a bounded home edge (pass rush, penalty chances) when the setting is on. Tunables: `data/crowd.json`. |
| `game/clock.ts`, `game/flow.ts` | Game clock, play clock, quarters, half time, game over | Unchanged. |
| `game/cpuDrive.ts` | Simulated CPU possessions | Phase 2: crowd edge (sacks, false starts), crowd meter updates, and `interactivePunts` stops the drive at a punt so the user can return it. |
| `input/` | `InputManager` merges touch, keyboard and gamepad | Phase 2: `slotHeld` (hold a receiver button = charge the throw), `secondaryPressed` (slide / dash), `anyPressed` (skip cutscenes). |
| `render/view.ts` | `SceneView`: renderer, lights, cameras | Draws a `PlaySim` or a `ReturnSim`, the kick setup and field goal flights, officials, flags, receiver marker rings; projects receivers to the screen for edge arrows. Sun with soft shadows follows the play. **Phase 3a:** the broadcast camera (default) sits higher and further back on a fixed field axis with a narrower FOV and never rotates during scrambles; officials right under it are hidden. The defense camera sits behind the user's cornerback (`updateDefenseCamera`). CPU-offense sims are drawn frame-flipped, with CB labels, a ring under the controlled CB and jump height. Tunables: `data/camera.json`. |
| `render/fieldMesh.ts` | Field texture, sidelines, goalposts, markers | Natural turf (mowing stripes, grain, wear), worn paint. |
| `render/stadium.ts` | **Phase 2.** Stadium bowl | Two tiers, roof, light rigs, podium wall with the players' tunnel, ~14k instanced spectators animated in the vertex shader from one `uEnergy` uniform. **Phase 3a:** the tunnel is built into the west stand: an open-mouthed passage with a portal and a lit door, and nothing closes the field end. Curved corner stands (tiers, spectators, concourse, facade, roof) close the bowl. |
| `render/playerMesh.ts` | Player and official figure | Rounded rig with contact poses (shoulder hit, wrap, stumble, hip turn, slide). |
| `render/cutscene.ts` | **Phase 2.** Intro director | Tunnel, team intro, coin toss / kickoff setup; only moves meshes and the camera, never game state. |
| `render/coords.ts` | Sim frame ↔ world | Phase 2 adds a frame flip so sims in the CPU's frame (a CPU return) draw in the user's world. |
| `ui/` | DOM overlays | HUD gains the crowd meter, pocket cue, receiver edge arrows, penalty call-out and kick meter; `intro.ts` is the cutscene overlay. **Phase 3a:** `PlaycallScreen.showDefense()` (coverage cards plus the coordinator's call), CB1 / CB2 / NB switch buttons in `TouchControls`, the Sound ON / MUTE and CPU drives settings. |
| `audio/crowdMix.ts` | **Phase 3a.** What the crowd sounds like (pure) | `layerGains(meter)` gives murmur, chatter and chant levels. `reactionTo(play)` / `reactionToFlag()` work from the home crowd's view: cheers on big plays and stops, boos on flags against the home team, a short roar on home touchdowns and takeaways, silence on home turnovers and opponent scores. Tunables: `data/audio.json`. |
| `audio/crowdAudio.ts` | **Phase 2, rewritten in 3a.** Synthesized stadium sound | Web Audio, no files. A crowd bus carries murmur, formant chatter and a stomp-stomp-clap chant, with volume following the meter. Cheer, roar and boo voices sit on top; silence ducks the bus and cuts the voices. Whistle and kick thump bypass the bus. Unlocked by the first tap (iOS); mute = the Sound setting. |
| `app.ts` | Glue: phase machine, fixed-step accumulator, input → sim mapping, gaze | Owns the only mutable `GameState` reference. **Phase 3a:** CPU possessions run `enterDefense()` (fourth-down call, defensive play call) → `callDefense()` (CPU play, `PlaySim` with `userDefense`, `CpuQB`) → `presnapDefense()` (auto snap) → `liveDefense()`; `whistle()` is shared with offense. No penalty chains: the first play-clock expiry after a flagged play only resets the clock. |

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

Stat probes: `JUMP_STATS=1` or `QB_STATS=1 npx vitest run tests/<file>
--silent=false`.

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
  itself 4 s after the call; READY snaps at once.
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

## Extension points

### Defense (playable since 3a): what is still open

- **More controllable defenders.** `selectDefender()` accepts any `DefSlot`;
  safeties and linebackers only need buttons (`TouchControls.setDefenders`)
  and a camera rig in `camera.json`.
- **User-defender fouls.** DPI already applies to the user CB (beaten and
  not in phase at the catch). Holding would call `addFoul('holdingDefense')`
  from `controlDefender()` when he stays in contact past 5 yards.
- **Turnover returns.** Interceptions still end the play at the spot;
  `ReturnSim` remains the template for INT and fumble returns.
- **Pre-snap defense.** Shading or pressing the CB would move the selected
  actor during `presnapDefense()`; audibles would swap `PlaySim.defense`
  before the first step.

### Phase 3b: career mode

- **Persistent data.** `GameState` (with `crowd`, `pendingKickoff`) and
  `TeamData` are plain data: `JSON.stringify` them into a save slot.
  `Settings` already carries a version (`v`) for migrations.
- **League/season layer.** Add `src/career/` for the league (teams,
  schedule), season state, standings and contracts. Home/away per game sets
  `GameState.userSide`. The crowd meter, crowd edge, crowd audio (written
  from the home crowd's view) and interactive CPU drives already work
  whichever side the user is on.
- **Progression.** Mutate `ratings` between games from per-player stat
  lines. `PlaySim` events carry actor ids (`catch`, `handoff`, `tackle`,
  `flag`, `interception`, `jump`, `timing`), `ReturnResult` names the
  returner, and box-score stats are kept for whichever side has the ball.
- **CPU play style per team.** `CPU_OFFENSE.calls` (run/pass mix by
  distance) and `fourthDown` are plain data. A per-team or per-coach
  override passed to `chooseCpuPlay` / `fourthDownCall` gives teams an
  identity; `chooseDefense` works the same way for the CPU defense.
- **Kickers.** Add K/P to the depth chart and scale `kickFlight` speed and
  lateral error by their ratings; the meter stays the same.

### Phase 3b: transfers and trading

- **Trading logic.** Player value comes from ratings, age and position. AI
  teams accept when the value they gain exceeds what they lose, weighted by
  positional need (empty depth-chart slots). `teamGrades()` in
  `data/index.ts` aggregates unit strength.
- **Transfer windows** belong to the season state in `src/career/` (dates on
  the schedule); the game itself only needs the resulting `TeamData`.
- **Roster changes are free for the sim.** The sim reads players only
  through `playerFor(team, slot)`, so trades and depth-chart edits take
  effect without any sim changes. Returns, the CPU QB and the user's
  controlled cornerbacks all use the same lookup.

## Known gaps (Phase 3a)

- CPU interceptions run about 6 % of attempts at Normal (NFL ≈ 2.5 %). The
  Phase 2 coverage model is tough on any QB.
- Interceptions and fumbles are not returned; the play ends at the catch.
- Only CB1, CB2 and NB can be controlled. There is no pre-snap shading and
  no audibles.
- The user CB cannot be called for holding; only DPI applies to him.
- CPU field goals resolve instantly (Phase 1, no kick animation). CPU punts
  use the Phase 2 kick and the user returns them.
- No two-point conversions, onside kicks or fair catches (unchanged).
- Crowd sound is synthesized: it reads as a stadium but is not sample
  quality. iOS needs one tap before any sound plays.
- Receivers cannot make toe-tap catches at the sideline (boundary hold).
- The CPU QB never scrambles on purpose; a CPU ball carrier only bends away
  from the nearest tackler.
- The defense camera turns a little when switching between corners on
  opposite sides (it leans toward the ball); it never spins during a play.
- Tested headless (Chromium, iPad-sized 1180×820 touch viewport), not yet on
  a physical iPad.
