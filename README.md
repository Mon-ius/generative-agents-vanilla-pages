# Generative Agents — Vanilla Edition

A dependency-free browser simulation of **generative agents**, inspired by
*"Generative Agents: Interactive Simulacra of Human Behavior"* (Park et al., 2023).
Six residents of the small town of **Willow Creek** observe their world, store
memories, retrieve them, make daily plans, reflect, hold conversations, and form
relationships — all in **vanilla HTML, CSS, and JavaScript** with **no frameworks,
no build step, no backend, and no LLM API keys**.

> This project was rebuilt from the Stanford "Generative Agents" research codebase
> (a Python/Django + Phaser stack) into a pure static web app. The original Python
> simulation cannot run in a browser, so the cognitive **architecture** (agents,
> memory streams, retrieval, reflection, planning, conversations, relationships,
> world events, time progression) was re-implemented from first principles in
> client-side JavaScript.

## Live demo

- **Live site (GitHub Pages):** <https://mon-ius.github.io/generative-agents-vanilla-pages/>
- **Repository:** <https://github.com/Mon-ius/generative-agents-vanilla-pages>

## Quick start (run locally)

The app is a static site. The simplest way to run it:

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000/
```

Because the app uses ES modules, most browsers block `import` from `file://`
URLs, so opening `index.html` directly may not work in every browser — use the
static server above (any static server works). When served over `http://`,
everything (including `localStorage` persistence) works with no backend.

## What you can do

- **Start / Pause / Step** the simulation, choose a **Speed**, and **Reset** with a chosen **seed**.
- **Save / Load / Clear** the full simulation state in `localStorage`.
- Click any **agent marker** on the map (or a legend chip) to inspect that agent.
- Watch the **memory stream**, **plan**, **relationships**, and **event timeline** update live.
- Toggle a **debug panel** (seed, tick, counts, RNG state).

## File structure

```
/
  index.html              # app shell (semantic, accessible, relative asset paths)
  README.md
  .nojekyll               # tells GitHub Pages to serve files as-is
  /css/
    styles.css            # design tokens, reset, base typography, primitives
    layout.css            # page shell + responsive 3/2/1-column layout
    components.css        # map, markers, panels, memory/timeline/relationship widgets
  /js/
    main.js               # bootstrap: wires sim<->UI, playback loop, window.runSmokeTest
    config.js             # all tunable constants (time, weights, thresholds, speeds, keys)
    /simulation/
      Simulation.js       # the orchestrator / tick loop
      TimeManager.js      # simulated clock (minutes since Day 1)
      Environment.js      # locations + scheduled world events
      Location.js         # a place on the grid
      EventBus.js         # pub/sub between sim and UI
    /agents/
      Agent.js            # identity + per-agent state + convenience behaviour
      MemoryStream.js     # append-only memory stream + retrieval delegation
      Planner.js          # builds/updates daily plans
      Reflector.js        # importance-triggered reflection
      ConversationEngine.js  # decides + runs conversations
      RelationshipGraph.js   # affinity / trust / familiarity per pair
      GenerationProvider.js  # LocalGenerationProvider (deterministic) + LLM stub
    /ui/
      Renderer.js         # map + legend + coordination; subscribes to the EventBus
      AgentPanel.js       # agent details, plan, relationships
      MemoryPanel.js      # memory stream
      TimelinePanel.js    # event feed
      Controls.js         # wires the control bar
    /data/
      seedAgents.js       # 6 residents
      seedLocations.js    # 15 locations (9 public + 6 homes)
      seedEvents.js       # recurring world events
    /utils/
      random.js           # seeded RNG (mulberry32) + choice/weightedChoice/clamp
      scoring.js          # deterministic memory-retrieval scoring
      storage.js          # safe localStorage wrapper (degrades gracefully)
      dom.js              # tiny DOM helpers (the only UI-coupled util)
  /test/
    smoke.node.mjs        # headless Node harness for the DOM-free core (dev only)
  package.json            # dev-only { "type": "module" } marker for Node tests (NOT deployed)
```

## Architecture

The guiding principle is **separation of concerns**: the **simulation core**
(`config/`, `utils/`, `simulation/`, `agents/`, `data/`) never touches the DOM,
and the **UI** (`ui/`, `main.js`) never contains simulation logic. They communicate
through an `EventBus`. Because the core is DOM-free, it runs headless under Node
(`test/smoke.node.mjs`) for fast, real verification.

```
            ┌──────────────┐   emits "tick"/"select"/...   ┌──────────────┐
seed data → │  Simulation  │ ─────────────────────────────►│   Renderer   │ → DOM
            │  (core)      │                               │   + panels   │
            └──────────────┘  ◄── selectAgent()/step() ──── └──────────────┘
                                      from Controls / main.js loop
```

## Simulation model

- Time is tracked as **whole minutes since Day 1, 00:00** and displayed as `Day 1, 09:30`.
- One **tick** advances the clock by `minutesPerTick` (default **10** simulated minutes).
- Each tick, in a fixed, deterministic order:
  1. **World events** that are due fire; agents present observe and react.
  2. **Plans**: each agent's plan status is updated; if the active block is in another location, the agent **moves** there.
  3. **Observation**: each agent records its location and any co-located agents as memories.
  4. **Conversations**: co-located pairs may talk (gated by cooldown + RNG + familiarity).
  5. **Reflection**: agents whose accumulated memory importance crossed a threshold synthesize an insight.
- At each **day rollover**, daily events reset and every agent re-plans the day.
- The UI re-renders after each tick (the Renderer subscribes to the `EventBus`).

## How agents work

An `Agent` holds identity/personality data (name, age, role, personality, traits,
goals, home/work locations) and per-agent state (current location, current activity,
current plan, a `MemoryStream`, a `RelationshipGraph`, conversation cooldowns, and
reflection counters). Cognition is delegated to focused modules (`Planner`,
`Reflector`, `ConversationEngine`, `GenerationProvider`) so the `Agent` stays a
clean state object. Agents never reference the UI.

## How memory retrieval works

Every memory has `{ id, agentId, timestamp, type, description, importance,
locationId, relatedAgentIds, keywords }`. Retrieval (`utils/scoring.js`) scores
each memory with a simple, **deterministic** combination:

```
score = recencyWeight*recency + importanceWeight*importance + relevanceWeight*relevance
```

- **recency** — exponential decay by memory age (`0.5 ^ (age / halfLife)`).
- **importance** — the memory's own importance, normalised to `[0,1]`.
- **relevance** — keyword overlap between the memory and the query, in `[0,1]`.

`memoryStream.retrieve({ text } | { keywords }, currentTime, n)` returns the
top-`n` scored memories, newest-first as a tie-breaker. Weights live in
`config.js` (`CONFIG.retrieval`).

## How planning works

`Planner.buildDailyPlan()` asks the `GenerationProvider` for a day's worth of
blocks and wraps each as `{ id, startTime, endTime, locationId, activity, priority,
status }` (times are **minutes-into-day**, e.g. `540` = 09:00). The local provider
builds a believable routine (sleep → morning → breakfast at the café → work →
lunch → work → errands → socialising → home), resolving each block to a concrete
location (home/work by id; others by location type/tag) and flavouring work
activities by the agent's role and goals. Each tick `Planner.updateStatuses()`
marks blocks `completed` / `active` / `scheduled` and returns the active one.

## How reflection works

`Reflector` fires when an agent's **accumulated memory importance** crosses
`CONFIG.reflection.importanceThreshold` and at least `minIntervalMinutes` have
passed. It synthesizes a higher-level insight from the agent's recent memory
window (e.g. *"Maya keeps crossing paths with Sam and is starting to see them as a
familiar face worth knowing better."*), stores it as a `reflection` memory, and
resets the counter. It runs entirely with deterministic local logic — **no LLM**.

## How conversations work

When two agents share a location, `ConversationEngine` may start a conversation if
they haven't spoken within the cooldown window and a seeded RNG gate passes
(nudged up by familiarity). The `GenerationProvider` produces a short,
template-based dialogue whose **tone** depends on the existing relationship. The
result creates a `conversation` memory for **both** agents, adds a timeline entry,
increases **familiarity**, and adjusts **affinity/trust** by tone.

## How relationships work

Each agent keeps a `RelationshipGraph` of `{ targetAgentId, affinity, trust,
familiarity, notes }`. `affinity` and `trust` range `-100..100`; `familiarity`
ranges `0..100`. Conversations update these values; the agent panel shows them as
labelled bars (with numeric values, so meaning is never conveyed by colour alone).

## How persistence works

Persistence uses `localStorage` only (works on GitHub Pages, no backend):

- **Simulation state** (`Save` / `Load` / `Clear`) stores the **full** state under
  `CONFIG.storageKey`: `seed`, exact **RNG state** (so a loaded run continues
  *identically*), time, tick count, all agents (identity, memories, relationships,
  plans, reflection counters), the environment (locations + event flags), and the
  event timeline.
- **UI settings** are stored separately under `CONFIG.settingsKey`: `speedIndex`,
  `debugVisible`, and the last-used `seed`.

## Deterministic randomness

`utils/random.js` provides `seededRandom(seed)` (mulberry32 seeded via an xfnv1a
string hash) plus `choice`, `weightedChoice`, `clamp`, `shuffle`. The **same seed
reproduces the same world and run**. The RNG exposes `getState()/setState()` so
save/load restores the exact stream position. Change the seed in the **Seed** box
and press **Reset** to explore a different town day.

## How to add a new agent

Append an object to `js/data/seedAgents.js`:

```js
{
  id: "agent_rosa",                 // unique
  name: "Rosa Linden",
  age: 31,
  role: "gardener",
  personality: "Patient and observant; reads the town by its plants.",
  traits: ["patient", "observant", "creative"],
  homeLocationId: "loc_rosa_home",  // must exist in seedLocations.js
  workLocationId: "loc_park",       // optional; defaults to home
  currentLocationId: "loc_rosa_home",
  goals: ["Green the town square"],
  color: "#3f7d3f",                 // map marker colour
  emoji: "🌿",
}
```

Optionally add a role description in `ROLE_WORK` (in `GenerationProvider.js`) for
nicer work-activity text. Reset to rebuild the world.

## How to add a new location

Append an object to `js/data/seedLocations.js` with a **unique id** and grid
coordinates (`x`, `y`) not already used:

```js
{ id: "loc_market", name: "Farmers Market", type: "shop", x: 5, y: 2,
  description: "stalls of produce on market mornings.", tags: ["errand", "food"] }
```

Location `type`/`tags` influence planning (e.g. `cafe`, `park`, `shop`, `library`,
`square` are used by routine blocks). Reset to rebuild.

## How to plug in a real LLM later

The app is intentionally model-agnostic via the `GenerationProvider` interface
(`generatePlan`, `generateReflection`, `generateConversation`, `generateReaction`).
`LocalGenerationProvider` is the deterministic, no-API default. To use a real
model, implement `LLMGenerationProvider` (a documented stub is included) and pass
it to the `Simulation` constructor in `main.js`.

> **Security:** never call an LLM API with a key embedded in client-side code —
> the key would be public. Route requests through a **backend proxy** that holds
> the key server-side. The stub deliberately throws to prevent accidental
> key-in-frontend usage.

## Smoke test

A browser self-check is available — open the page and run in the console:

```js
window.runSmokeTest()
```

It verifies (with clear console output and a returned summary): the app booted,
locations exist, agents exist, the simulation can step, time advances, memories can
be created, the selected agent can be changed, save/load functions exist and
`save()` returns a boolean, and reset works. It mutates the live simulation (it
steps, selects, saves, and resets) and re-renders afterwards.

The DOM-free **core** also has a headless Node harness (developer-only, not
deployed):

```bash
node test/smoke.node.mjs    # or: npm run smoke
```

## Manual test checklist

1. Page loads with a map, six agent markers, and a selected agent's details.
2. **Start** runs the clock; markers move between locations over time.
3. **Pause** stops it; **Step** advances exactly one tick.
4. The **Speed** selector changes playback rate.
5. Clicking a marker / legend chip selects that agent and updates all panels.
6. The **memory stream** grows; types (observation/conversation/reflection/event) are labelled.
7. The **plan** shows scheduled/active/completed states; the active block is marked.
8. **Relationships** appear and grow after conversations.
9. The **timeline** shows movements, conversations, reflections, and world events.
10. **Save**, then **Reset**, then **Load** restores the saved state; **Clear** removes it.
11. Change the **Seed**, **Reset** — a different but reproducible run.
12. **Show debug** reveals seed/tick/counts; reload preserves speed/debug settings.
13. Resize to tablet/mobile widths — layout reflows to 2 / 1 columns.

## Known limitations

- Conversations, reflections, and plans are **template-based** and deterministic —
  believable and inspectable, but not as open-ended as a real LLM.
- "Movement" is instantaneous to the target location (no per-tile travel/pathfinding).
- The world is a labelled grid, not a tile-art game map.
- Reflection/relationship dynamics are intentionally simple and tuned for legibility.
- All state is per-browser (`localStorage`); there is no multi-device sync.

## Future improvement ideas

- Per-tile movement and simple pathfinding on the grid.
- Richer reflection that branches plans (e.g. an agent decides to visit a friend).
- Importance scoring of memories via a small learned/heuristic model.
- A pluggable `LLMGenerationProvider` wired to a backend proxy.
- Export/import simulation state as a downloadable JSON file.
- A relationship graph visualisation and per-agent memory search UI.

## Tech & deployment

- **Vanilla HTML/CSS/JS, ES modules.** No frameworks, bundlers, transpilers,
  runtime npm dependencies, server, or database. Dependency-free static site.
- Asset paths are **relative**, so the app works from a GitHub Pages **project
  subpath** (`https://OWNER.github.io/REPO/`).

### How to deploy / redeploy with `gh`

This repo's deployment uses GitHub Pages **branch publishing** from `main /`
(no build workflow). To (re)deploy a clean static copy to a new public repo:

```bash
# 1. choose names (env overrides are honoured)
BASE_NAME="${TARGET_REPO_NAME:-generative-agents-vanilla-pages}"
OWNER="${GH_OWNER:-$(gh api user --jq .login)}"
VISIBILITY="${TARGET_REPO_VISIBILITY:-public}"

# 2. copy ONLY the static app into a fresh directory (fresh git history)
DEPLOY_DIR="../${BASE_NAME}-deploy"
mkdir -p "$DEPLOY_DIR"
rsync -a index.html README.md css js "$DEPLOY_DIR"/
touch "$DEPLOY_DIR/.nojekyll"

# 3. fresh repo + push
cd "$DEPLOY_DIR"
git init && git branch -M main
git add . && git commit -m "Vanilla generative agents simulation"
gh repo create "$OWNER/$BASE_NAME" --"$VISIBILITY" --source=. --remote=origin --push

# 4. enable Pages from main / (root)
gh api --method POST "repos/$OWNER/$BASE_NAME/pages" \
  -f 'source[branch]=main' -f 'source[path]=/' \
  || gh api --method PUT "repos/$OWNER/$BASE_NAME/pages" \
       -f 'source[branch]=main' -f 'source[path]=/'

# 5. read the Pages URL
gh api "repos/$OWNER/$BASE_NAME/pages" --jq '.html_url'
```

> The deployed repo contains **only** the static app (`index.html`, `README.md`,
> `.nojekyll`, `css/`, `js/`). Dev-only files (`package.json`, `test/`) and the
> original Python/Django sources are **not** published.

## License

The original "Generative Agents" research code is licensed by its authors (see the
upstream repository). This vanilla rebuild is provided for educational use.
