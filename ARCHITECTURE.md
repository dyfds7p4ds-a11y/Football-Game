# Architecture

Phase 1 is split so that football logic never touches the DOM or Three.js.
The same simulation code runs in the browser, in unit tests and in headless
balance scripts.

```
            ┌────────────┐   InputFrame    ┌──────────────────────────────┐
 touch ───▶ │   input/   │ ──────────────▶ │            app.ts            │
 keys  ───▶ │ InputMgr   │                 │ phase machine: title →       │
 pad   ───▶ └────────────┘                 │ playcall → presnap → live →  │
                                           │ postplay → (break/cpuDrive)  │
                                           └──┬────────────┬───────────┬──┘
                                SimInput      │            │           │ GameState
                                (fixed 60 Hz) ▼            │           ▼
                                   ┌────────────────┐      │    ┌──────────────┐
                 data/*.json ────▶ │ play/PlaySim   │      │    │ game/ rules, │
                                   │ routes, throw, │      │    │ clock, flow, │
                                   │ catch, defense │      │    │ cpuDrive     │
                                   └───────┬────────┘      │    └──────────────┘
                                 read-only │               │ read-only
                                           ▼               ▼
                                   ┌────────────────┐  ┌──────────────┐
                                   │ render/        │  │ ui/ HUD,     │
                                   │ SceneView      │  │ playcall,    │
                                   │ (Three.js)     │  │ menus, touch │
                                   └────────────────┘  └──────────────┘
```

## Modules

| Module | Responsibility | Notes |
| --- | --- | --- |
| `core/rng.ts` | Seedable mulberry32 PRNG | Every random decision in game logic goes through an `Rng`, so a game, drive or play can be replayed from its seed. |
| `core/vec.ts` | 2D vector helpers | The sim works in the offense frame: x is lateral, y is yards from the offense's goal line. |
| `data/` | Teams, rosters, ratings, depth charts, plays (route trees), formations, difficulty presets | All JSON, typed in `data/types.ts`. |
| `play/routes.ts` | Route tree to waypoints | Named routes (`slant`, `post`, `wheel`, ...) plus depth and direction. "Outside" is worked out relative to the ball. |
| `play/throw.ts` | Throw timing math (pure) | Charge sets ball speed; distance from the sweet spot sets accuracy and a short/long bias; also handles lead targeting and the ballistic arc. |
| `play/catch.ts` | Catch, drop, breakup and interception resolution (pure) | Driven by ratings, distances, ball quality and difficulty. |
| `play/defenseCalls.ts` | Coverage shells, pressure packages and the CPU play-caller | Cover 0/1/2/3, 2-Man and Fire Zone, chosen by down & distance and by your play-calling tendencies. |
| `play/sim.ts` | `PlaySim`: one play from snap to whistle | Runs on a fixed 60 Hz step and covers offense AI, defense AI, blocking engagements, ball flight, tackles and boundaries. It outputs a `PlayResult` plus an event list. |
| `game/state.ts` | `GameState`, plain serializable data | Score, possession, down & distance, clock, timeouts, stats, tendencies. |
| `game/rules.ts` | Downs, scoring, turnovers, punts, field goals, delay of game | Pure: `(GameState, play) → GameState`. |
| `game/clock.ts` | Game clock and 40-second play clock | Pure functions; stop/run rules live in `endPlayClock`. |
| `game/flow.ts` | Quarter breaks, half time, game over | |
| `game/cpuDrive.ts` | Simulated CPU possessions | Uses the same rules and clock code as user plays. |
| `input/` | `InputManager` merges touch, keyboard and gamepad into one `InputFrame` per frame; `VirtualJoystick` is pure logic | Taps are latched, so a press shorter than a frame is never lost. |
| `render/` | `SceneView` (renderer, lights, cameras), `FieldView` (canvas-textured field, stadium, markers), `PlayerMesh` (low-poly figure) | Reads the sim's state and interpolates between fixed steps. Never writes to it. |
| `ui/` | DOM overlays: HUD, touch controls, play-call screen with route diagrams, menus | |
| `app.ts` | Glue: phase state machine, fixed-step accumulator, mapping from input to `SimInput` and gaze | Owns the only mutable `GameState` reference. |

### Determinism

- `PlaySim` takes a seed. Given the same `SimInput` sequence it produces the
  same events and result (tested in `tests/sim.test.ts`).
- The app derives each play's seed from the game RNG, which is seeded at
  kick-off. Logging the game seed plus the per-frame `SimInput` would give a
  full replay. That isn't recorded yet, but the hooks are in place.
- Rendering uses `prevPos`/`pos` interpolation, so frame rate never affects
  the simulation.

### Tests

`npm test` covers:
- `tests/throw.test.ts`: charge-to-speed mapping, sweet-spot quality,
  lead, short/long bias, determinism, trajectory height.
- `tests/clock.test.ts`: play clock, stop/run rules, quarter, half and game
  transitions, a play that ends at 0:00.
- `tests/rules.test.ts`: downs, first downs, goal-to-go, turnover on downs,
  TD/safety/INT, sacks, delay of game, FG/punt, CPU drive termination.
- `tests/sim.test.ts`: whole-play resolution for every play against every
  coverage, handoffs and pitches, sacks under sustained pressure, how timing
  affects completion, difficulty, catch resolution and CPU play-calling.

## Extension points

### Phase 2: defense from the cornerback's view, interception/tackle timing

- **User-controlled defender.** `PlaySim.controlledId` already decides who
  reads `SimInput.move`. Generalize `controlUser()` so it can point at a
  defensive actor (for example `getDef('CB1')`). The defensive AI already
  skips actors that already have a `desired` velocity, the same way the
  offensive AI does.
- **Camera.** Add a `'cornerback'` `CameraMode` in `render/view.ts`. The
  first-person path (eye position plus gaze yaw/pitch) works for any actor,
  so swap `qb` for the controlled actor.
- **CPU offense.** Replace `game/cpuDrive.ts` with interactive plays: build a
  `PlaySim` with the CPU team as `offenseTeam` and let an offensive AI drive
  the QB. The QB "brain" belongs in a new `play/qbAI.ts` that produces
  `SimInput` (drop back, read progressions using `perceived()`, throw with
  `computeThrow`). `chooseDefense` becomes the user's play-call screen, and
  `DEFENSE_CALLS` is already the data it needs.
- **Interception timing.** `resolveCatch()` in `play/catch.ts` is the single
  decision point. Add an optional `defenderTiming` input (how close the
  user's button press was to ball arrival) that scales the defender's `p` and
  `pInt`. `PlaySim.resolveArrival()` can supply it from an input like
  `SimInput.playBall` with a timestamp. Tip drills mid-flight live in
  `updateBall()`.
- **Tackle timing.** `PlaySim.checkTackles()` computes a per-contact tackle
  probability. Add a `SimInput.tackle` edge plus a timing window, and use it
  in place of the probability for the user's defender (or multiply by it).
  The juke logic for ball carriers (`jukeUntil`) shows the pattern.
- **Turnover returns.** Today the play ends on an interception. To add
  returns, set the interceptor as `carrier`, flip the pursuit targets
  (offense pursues) and add a return-boundary check. `makeResult` already
  carries `endY`.

### Phase 3: career mode, transfers and trading

- **Persistent data.** `TeamData` already carries `roster` (with `age` and
  0–100 `ratings`) and a `depthChart` mapping slots to player ids. The
  simulation reads players only through `playerFor(team, slot)`, so trades
  and depth-chart edits take effect without any sim changes.
- **League/season layer.** Add `src/career/`: league (teams, schedule),
  season state, standings, player contracts and transfer windows. Persist it
  with `JSON.stringify(GameState)` and the career object. Both are plain data.
- **Trading logic.** Player value comes from ratings, age and position. AI
  teams accept a trade when the value they gain exceeds the value they lose,
  weighted by positional need (empty depth-chart slots). `teamGrades()` in
  `data/index.ts` shows how to aggregate unit strength.
- **Progression.** Mutate `ratings` between games from season stats
  (`GameState.stats` is per side today, so add per-player stat lines in
  `PlaySim` events: `catch`, `handoff`, `tackle` already carry actor ids).
- **More plays and teams.** Plays and formations are data. New route types go
  in `play/routes.ts`, new formations in `formations.json`. A playbook per
  team is just a list of play ids.
- **Special teams** (excluded from Phase 1): add a kick sim beside `PlaySim`
  and swap `rules.punt` / `attemptFieldGoal` / the touchback placement in
  `startPossession` for a real kick play.
