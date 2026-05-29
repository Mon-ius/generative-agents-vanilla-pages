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
    for (const agent of this.agents) {
      const active = this.planner.updateStatuses(agent.currentPlan, ctx.minutesIntoDay);
      if (active) {
        if (agent.currentLocationId !== active.locationId) {
          agent.moveTo(active.locationId);
          const loc = this.environment.getLocation(active.locationId);
          const where = loc ? loc.name : active.locationId;
          this._log({ type: "movement", title: `${agent.name} moved`, description: `${agent.name} walked to ${where}.`, locationId: active.locationId, agentIds: [agent.id] });
          agent.addMemory({ timestamp: ctx.currentTime, type: "action", description: `Walked to ${where}.`, importance: CONFIG.importance.movement, locationId: active.locationId, keywords: loc ? [loc.type, ...(loc.tags || [])] : [] });
        }
        agent.currentActivity = active.activity;
      } else {
        agent.currentActivity = "Resting";
      }
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

    // 4. conversations (grouped by location, capped per location)
    const byLoc = new Map();
    for (const a of this.agents) {
      if (!byLoc.has(a.currentLocationId)) byLoc.set(a.currentLocationId, []);
      byLoc.get(a.currentLocationId).push(a);
    }
    for (const [locId, group] of byLoc) {
      if (group.length < 2) continue;
      const loc = this.environment.getLocation(locId);
      const sorted = group.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
      let convos = 0;
      for (let i = 0; i < sorted.length && convos < CONFIG.conversation.maxPerLocationPerTick; i++) {
        for (let j = i + 1; j < sorted.length && convos < CONFIG.conversation.maxPerLocationPerTick; j++) {
          const A = sorted[i];
          const B = sorted[j];
          if (this.conversation.canConverse(A, B, ctx.currentTime, this.rng)) {
            const convo = this.conversation.converse(A, B, { ...ctx, location: loc });
            this._applyConversation(A, B, convo, loc, ctx);
            convos++;
          }
        }
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

  _applyConversation(A, B, convo, loc, ctx) {
    const transcript = convo.lines.map((l) => `${l.speaker}: ${l.text}`).join("  ");
    const summary = convo.summary || `${firstName(A)} and ${firstName(B)} talked${loc ? ` at ${loc.name}` : ""}.`;
    const kw = convo.topicKeywords || [];

    A.addMemory({ timestamp: ctx.currentTime, type: "conversation", description: summary, importance: CONFIG.importance.conversation, locationId: loc ? loc.id : A.currentLocationId, relatedAgentIds: [B.id], keywords: [firstName(B), ...kw] });
    B.addMemory({ timestamp: ctx.currentTime, type: "conversation", description: summary, importance: CONFIG.importance.conversation, locationId: loc ? loc.id : B.currentLocationId, relatedAgentIds: [A.id], keywords: [firstName(A), ...kw] });

    const tone = convo.tone || "neutral";
    const affinity = tone === "warm" ? 3 : tone === "tense" ? -3 : 1;
    const trust = tone === "warm" ? 2 : tone === "tense" ? -1 : 1;
    const note = loc ? `Talked at ${loc.name}` : "Talked";
    A.relationships.update(B.id, { affinity, trust, familiarity: 4, note });
    B.relationships.update(A.id, { affinity, trust, familiarity: 4, note });

    this._log({ type: "conversation", title: `${firstName(A)} ↔ ${firstName(B)}`, description: transcript, locationId: loc ? loc.id : null, agentIds: [A.id, B.id] });
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
    this.timeline.push(e);
    if (this.timeline.length > 500) this.timeline.shift();
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
