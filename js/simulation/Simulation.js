// Simulation.js — the orchestrator.
//
// One step() advances the clock and runs a deterministic cognitive cycle for
// every agent, in a fixed order, drawing from a single seeded RNG so the whole
// run is reproducible:
//
//   tick clock
//   (day rollover -> reset daily events, re-plan everyone)
//   1. fire due world events; present agents observe + react
//   2. plan: update each agent's plan status, move if the active block is elsewhere
//   3. observe: each agent records its location and any co-located agents
//   4. converse: co-located pairs may talk (gated), updating memories + relationships
//   5. reflect: agents whose accumulated importance crossed the threshold synthesize an insight
//   emit "tick"
//
// The Simulation never touches the DOM — the UI subscribes to its EventBus.

import { CONFIG } from "../config.js";
import { seededRandom } from "../utils/random.js";
import { tokenize } from "../utils/scoring.js";
import { storage } from "../utils/storage.js";
import * as pathfinding from "../utils/pathfinding.js";
import { EventBus } from "./EventBus.js";
import { TimeManager } from "./TimeManager.js";
import { Environment } from "./Environment.js";
import { Agent } from "../agents/Agent.js";
import { Planner } from "../agents/Planner.js";
import { Reflector } from "../agents/Reflector.js";
import { ConversationEngine } from "../agents/ConversationEngine.js";
import { LocalGenerationProvider } from "../agents/GenerationProvider.js";

export class Simulation {
  constructor({ seed, agents, locations, events, provider } = {}) {
    this.seed = seed || CONFIG.defaultSeed;
    this.bus = new EventBus();
    this.provider = provider || new LocalGenerationProvider();
    this.planner = new Planner(this.provider);
    this.reflector = new Reflector(this.provider);
    this.conversation = new ConversationEngine(this.provider);
    // Keep a pristine copy of the seed data so reset() can rebuild from scratch.
    this._seedData = {
      agents: clone(agents || []),
      locations: clone(locations || []),
      events: clone(events || []),
    };
    this.init();
  }

  init() {
    this.rng = seededRandom(this.seed);
    this.time = new TimeManager();
    this.environment = new Environment(clone(this._seedData.locations), clone(this._seedData.events));
    this.agents = this._seedData.agents.map((a) => new Agent(clone(a)));
    this.timeline = [];
    this.tickCount = 0;
    this._timelineCounter = 0;
    this._grid = null; // lazily (re)built collision grid for movement/pathing
    this._doorSpots = null; // lazily (re)built door-spot map (where agents stand)
    this.selectedAgentId = this.agents.length ? this.agents[0].id : null;
    for (const agent of this.agents) this._planAgentDay(agent);
    this.bus.emit("init", { sim: this });
  }

  // ---- context shared with cognition modules / provider --------------------
  _context() {
    return {
      env: this.environment,
      rng: this.rng,
      day: this.time.day,
      minutesIntoDay: this.time.minutesIntoDay,
      currentTime: this.time.totalMinutes, // monotonic; used for recency & cooldowns
      totalMinutes: this.time.totalMinutes,
      nameOf: (id) => {
        const a = this.getAgent(id);
        return a ? a.name : id;
      },
    };
  }

  _planAgentDay(agent) {
    agent.currentPlan = this.planner.buildDailyPlan(agent, this._context());
    agent.planDay = this.time.day;
  }

  // ---- movement / pathing (rendering only) ---------------------------------
  // Lazily build (and cache) the collision grid from the current environment.
  // Cleared on init()/reset()/loadState so a new world rebuilds it. The grid is
  // derived purely from location x/y + CELL, so it stays DOM-free.
  _getGrid() {
    if (!this._grid) {
      this._grid = pathfinding.buildGridFromEnvironment(this.environment, {
        movement: CONFIG.movement,
        cell: CONFIG.world ? CONFIG.world.cellPixels : undefined,
      });
    }
    return this._grid;
  }

  // Lazily build (and cache) the door-spot map: locationId -> {x, y, dx, dy}, the
  // world spot just OUTSIDE each building on the open network where agents stand
  // (solid buildings have no walkable interior). Shared with the renderer via the
  // same pathfinding.computeDoorSpots, so the picture and cognition agree.
  _getDoorSpots() {
    if (!this._doorSpots) {
      this._doorSpots = pathfinding.computeDoorSpots(this.environment, {
        movement: CONFIG.movement,
        cell: CONFIG.world ? CONFIG.world.cellPixels : undefined,
      });
    }
    return this._doorSpots;
  }

  // World-space "door spot" for a location — the spot just outside the building
  // (or the centre of an open plot) that A* can reach without crossing a wall.
  // Simulation stays DOM-free: computeDoorSpots needs only loc x/y/type/complex.
  _doorWorld(loc) {
    if (!loc || typeof loc.x !== "number" || typeof loc.y !== "number") return null;
    const s = this._getDoorSpots().get(loc.id);
    if (s) return { x: s.x, y: s.y };
    const CELL = (CONFIG.world && CONFIG.world.cellPixels) || 176;
    return { x: loc.x * CELL + CELL / 2, y: loc.y * CELL + CELL / 2 };
  }

  // ---- the main loop -------------------------------------------------------
  step() {
    const roll = this.time.tick();
    this.tickCount += 1;
    const ctx = this._context();

    if (roll.rolledOver) {
      this.environment.resetEvents();
      for (const agent of this.agents) this._planAgentDay(agent);
      this._log({ type: "event", title: "A new day begins", description: `Day ${this.time.day} dawns over Willow Creek.`, locationId: null, agentIds: [] });
    }

    // 1. world events
    for (const ev of this.environment.dueEvents(ctx.minutesIntoDay)) {
      this.environment.markFired(ev.id);
      this._log({ type: "event", title: ev.title, description: ev.description, locationId: ev.locationId, agentIds: [], importance: ev.importance });
      for (const a of this.environment.agentsAt(ev.locationId, this.agents)) {
        a.addMemory({ timestamp: ctx.currentTime, type: "event", description: `${ev.title}: ${ev.description}`, importance: ev.importance ?? CONFIG.importance.event, locationId: ev.locationId, keywords: ev.tags || [] });
        const reaction = this.provider.generateReaction(a, ev, ctx);
        if (reaction) a.addMemory({ timestamp: ctx.currentTime, type: "observation", description: reaction, importance: 2, locationId: ev.locationId, keywords: ev.tags || [] });
      }
    }

    // 2. plan -> move -> activity
    const pathfindingOn = !!(CONFIG.movement && CONFIG.movement.pathfindingEnabled);
    for (const agent of this.agents) {
      const active = this.planner.updateStatuses(agent.currentPlan, ctx.minutesIntoDay);
      if (active) {
        if (agent.currentLocationId !== active.locationId) {
          const target = active.locationId;
          const fromLoc = this.environment.getLocation(agent.currentLocationId);
          const toLoc = this.environment.getLocation(target);

          // Plan a walking route for the renderer (best-effort, deterministic).
          // This sets agent.path/destLocationId/arrived but does NOT move the
          // agent — currentLocationId is updated separately below so co-location
          // timing stays bit-identical to a run with pathfinding off.
          if (pathfindingOn) {
            const fromWorld = this._doorWorld(fromLoc);
            const toWorld = this._doorWorld(toLoc);
            if (toWorld) {
              agent.setDestination(target, fromWorld || toWorld, toWorld, this._getGrid());
            }
          }

          // Cognition/co-location: move immediately (deterministic, unchanged).
          agent.moveTo(target);
          const where = toLoc ? toLoc.name : target;
          this._log({ type: "movement", title: `${agent.name} moved`, description: `${agent.name} walked to ${where}.`, locationId: target, agentIds: [agent.id] });
          agent.addMemory({ timestamp: ctx.currentTime, type: "action", description: `Walked to ${where}.`, importance: CONFIG.importance.movement, locationId: target, keywords: toLoc ? [toLoc.type, ...(toLoc.tags || [])] : [] });
        }
        agent.currentActivity = active.activity;
      } else {
        agent.currentActivity = "Resting";
      }
    }

    // Rebuild the environment's location->agents reverse index after movement so
    // agentsAt/coLocated reflect this tick's positions. Defensive: indexAgents is
    // part of the Environment contract but guard in case of an older build.
    if (typeof this.environment.indexAgents === "function") {
      this.environment.indexAgents(this.agents);
    }

    // 3. observe
    for (const agent of this.agents) {
      const loc = this.environment.getLocation(agent.currentLocationId);
      if (loc && this.rng() < 0.5) {
        agent.addMemory({ timestamp: ctx.currentTime, type: "observation", description: `At ${loc.name}: ${capitalize(loc.description)}`, importance: CONFIG.importance.observation, locationId: loc.id, keywords: [loc.type, ...(loc.tags || [])] });
      }
      for (const other of this.environment.coLocated(agent, this.agents)) {
        agent.addMemory({ timestamp: ctx.currentTime, type: "observation", description: `Saw ${other.name} (${String(other.currentActivity).toLowerCase()})${loc ? ` at ${loc.name}` : ""}.`, importance: CONFIG.importance.observation, locationId: agent.currentLocationId, relatedAgentIds: [other.id], keywords: [firstName(other)] });
      }
    }

    // 4. conversations — at most one group per location per tick.
    // For each location with >= 2 co-located agents (sorted by id), form ONE
    // group of up to CONFIG.conversation.maxGroupSize. If the group gate passes,
    // run a single group conversation and apply its effects to every participant
    // and every ordered pair. A group of size 2 behaves exactly like before.
    const maxGroup = (CONFIG.conversation && CONFIG.conversation.maxGroupSize) || 2;
    const maxPerLoc = (CONFIG.conversation && CONFIG.conversation.maxPerLocationPerTick) || 1;
    const byLoc = new Map();
    for (const a of this.agents) {
      if (!byLoc.has(a.currentLocationId)) byLoc.set(a.currentLocationId, []);
      byLoc.get(a.currentLocationId).push(a);
    }
    // Iterate locations in a deterministic order (by location id).
    const locIds = Array.from(byLoc.keys()).sort((x, y) => (String(x) < String(y) ? -1 : 1));
    for (const locId of locIds) {
      const present = byLoc.get(locId);
      if (present.length < 2) continue;
      const loc = this.environment.getLocation(locId);
      const sorted = present.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
      // One group per location per tick (maxPerLocationPerTick groups, default 1).
      let convos = 0;
      let offset = 0;
      while (convos < maxPerLoc && offset < sorted.length - 1) {
        const group = sorted.slice(offset, offset + Math.max(2, maxGroup));
        if (group.length < 2) break;
        if (this.conversation.checkGroupConverse(group, ctx.currentTime, this.rng)) {
          const convo = this.conversation.converseGroup(group, { ...ctx, location: loc });
          this._applyGroupConversation(group, convo, loc, ctx);
          convos++;
        }
        offset += group.length;
      }
    }

    // 5. reflections
    for (const agent of this.agents) {
      if (this.reflector.shouldReflect(agent, ctx.currentTime)) {
        const insight = this.reflector.reflect(agent, ctx);
        if (insight) {
          agent.addMemory({ timestamp: ctx.currentTime, type: "reflection", description: insight, importance: CONFIG.importance.reflection, locationId: agent.currentLocationId, keywords: tokenize(insight).slice(0, 5) });
          this._log({ type: "reflection", title: `${agent.name} reflected`, description: insight, locationId: agent.currentLocationId, agentIds: [agent.id] });
        }
      }
    }

    this.bus.emit("tick", { sim: this, tick: this.tickCount });
    return this;
  }

  // Apply one (group) conversation to all participants. Generalizes the former
  // pairwise _applyConversation to N participants: each participant records a
  // conversation memory (relatedAgentIds = the OTHER participants), every ordered
  // pair gets the same tone-derived relationship deltas as before, and ONE
  // timeline entry carries every participant id + the location id. A group of
  // size 2 produces exactly the same effects as the historical pair path.
  _applyGroupConversation(group, convo, loc, ctx) {
    if (!convo) return;
    const transcript = convo.lines.map((l) => `${l.speaker}: ${l.text}`).join("  ");
    const names = group.map((a) => firstName(a));
    const fallbackSummary =
      group.length === 2
        ? `${names[0]} and ${names[1]} talked${loc ? ` at ${loc.name}` : ""}.`
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} talked${loc ? ` at ${loc.name}` : ""}.`;
    const summary = convo.summary || fallbackSummary;
    const kw = convo.topicKeywords || [];
    const locId = loc ? loc.id : null;

    const tone = convo.tone || "neutral";
    const affinity = tone === "warm" ? 3 : tone === "tense" ? -3 : 1;
    const trust = tone === "warm" ? 2 : tone === "tense" ? -1 : 1;
    const note = loc ? `Talked at ${loc.name}` : "Talked";

    // Per-participant conversation memory referencing the other participants.
    for (const a of group) {
      const others = group.filter((o) => o.id !== a.id);
      a.addMemory({
        timestamp: ctx.currentTime,
        type: "conversation",
        description: summary,
        importance: CONFIG.importance.conversation,
        locationId: locId || a.currentLocationId,
        relatedAgentIds: others.map((o) => o.id),
        keywords: [...others.map((o) => firstName(o)), ...kw],
      });
    }

    // Relationship deltas for every ordered pair (matches the old pair path).
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id) continue;
        a.relationships.update(b.id, { affinity, trust, familiarity: 4, note });
      }
    }

    // ONE timeline entry for the whole group, carrying every participant id.
    const title = group.length === 2 ? `${names[0]} ↔ ${names[1]}` : `${names.join(", ")} chatted`;
    const participantIds = (convo.participantIds && convo.participantIds.length ? convo.participantIds : group.map((a) => a.id)).slice();
    this._log({
      type: "conversation",
      title,
      description: transcript,
      locationId: locId,
      agentIds: participantIds,
      participantIds,
    });
  }

  // ---- timeline ------------------------------------------------------------
  _log(entry) {
    this._timelineCounter += 1;
    const e = {
      id: `tl_${String(this._timelineCounter).padStart(5, "0")}`,
      tick: this.tickCount,
      totalMinutes: this.time.totalMinutes,
      timeLabel: this.time.format(),
      type: entry.type,
      title: entry.title,
      description: entry.description,
      locationId: entry.locationId ?? null,
      agentIds: entry.agentIds || [],
      importance: entry.importance ?? null,
    };
    // 'conversation' entries carry the full participant list (Timeline contract).
    if (entry.participantIds) e.participantIds = entry.participantIds;
    this.timeline.push(e);
    const cap = (CONFIG.ui && CONFIG.ui.timelineMax) || 500;
    while (this.timeline.length > cap) this.timeline.shift();
    this.bus.emit("timeline", e);
    return e;
  }

  // ---- selection & lookups -------------------------------------------------
  selectAgent(id) {
    if (this.getAgent(id)) {
      this.selectedAgentId = id;
      this.bus.emit("select", { id });
    }
  }
  getSelectedAgent() {
    return this.getAgent(this.selectedAgentId);
  }
  getAgent(id) {
    return this.agents.find((a) => a.id === id) || null;
  }

  // ---- lifecycle -----------------------------------------------------------
  reset(seed) {
    if (seed != null && seed !== "") this.seed = seed;
    this.init();
    this.bus.emit("reset", { sim: this });
    return this;
  }

  // ---- (de)serialization & persistence -------------------------------------
  getState() {
    return {
      version: 1,
      seed: this.seed,
      rngState: this.rng.getState(),
      time: this.time.toJSON(),
      tickCount: this.tickCount,
      timelineCounter: this._timelineCounter,
      selectedAgentId: this.selectedAgentId,
      environment: this.environment.toJSON(),
      agents: this.agents.map((a) => a.toJSON()),
      timeline: this.timeline,
    };
  }

  loadState(state) {
    if (!state || state.version !== 1) return false;
    this.seed = state.seed;
    this.rng = seededRandom(this.seed);
    if (typeof state.rngState === "number") this.rng.setState(state.rngState);
    this.time = TimeManager.fromJSON(state.time);
    this.environment = Environment.fromJSON(state.environment);
    this._grid = null; // rebuild lazily for the loaded world
    this._doorSpots = null; // rebuild lazily for the loaded world
    this.agents = (state.agents || []).map((a) => Agent.fromJSON(a));
    this.timeline = state.timeline || [];
    this.tickCount = state.tickCount || 0;
    this._timelineCounter = state.timelineCounter || this.timeline.length;
    this.selectedAgentId = state.selectedAgentId || (this.agents[0] && this.agents[0].id) || null;
    this.bus.emit("load", { sim: this });
    return true;
  }

  save(key = CONFIG.storageKey) {
    return storage.save(key, this.getState());
  }
  load(key = CONFIG.storageKey) {
    const s = storage.load(key);
    return s ? this.loadState(s) : false;
  }
  hasSaved(key = CONFIG.storageKey) {
    return storage.load(key) != null;
  }
  clearSaved(key = CONFIG.storageKey) {
    return storage.remove(key);
  }

  // ---- debug ---------------------------------------------------------------
  getDebugInfo() {
    return {
      seed: this.seed,
      rngState: this.rng.getState(),
      tick: this.tickCount,
      time: this.time.format(),
      agents: this.agents.length,
      locations: this.environment.allLocations().length,
      memories: this.agents.reduce((s, a) => s + a.memoryCount, 0),
      timeline: this.timeline.length,
      selected: this.selectedAgentId,
    };
  }
}

// ---- helpers -----------------------------------------------------------------
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function firstName(agent) {
  return String(agent.name || "").split(" ")[0] || agent.name;
}
function capitalize(s) {
  s = String(s || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
