// Agent.js — a generative agent.
//
// The Agent holds identity/personality data and per-agent state (plan, current
// activity/location, memory stream, relationships). Heavy cognition lives in the
// dedicated modules (Planner, Reflector, ConversationEngine, GenerationProvider)
// so this stays a clean state object with convenience behaviour. Crucially, the
// Agent has no knowledge of the UI.

import { MemoryStream } from "./MemoryStream.js";
import { RelationshipGraph } from "./RelationshipGraph.js";
import { pathWorldPoints } from "../utils/pathfinding.js";

export class Agent {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.age = data.age;
    this.role = data.role;
    this.personality = data.personality || "";
    this.traits = data.traits || [];
    this.homeLocationId = data.homeLocationId;
    this.workLocationId = data.workLocationId || null;
    this.currentLocationId = data.currentLocationId || data.homeLocationId;
    this.goals = data.goals || [];
    this.dailyRoutine = data.dailyRoutine || [];
    this.currentPlan = data.currentPlan || [];
    this.currentActivity = data.currentActivity || "Settling in";
    this.color = data.color || "#4b6bdc";
    this.emoji = data.emoji || "🙂";

    this.memoryStream =
      data.memoryStream instanceof MemoryStream
        ? data.memoryStream
        : new MemoryStream(this.id, data.memories || []);

    this.relationships =
      data.relationships instanceof RelationshipGraph
        ? data.relationships
        : new RelationshipGraph(data.relationships || {});

    this.conversationLog = data.conversationLog || {}; // otherAgentId -> last conversation totalMinutes
    this.reflection = data.reflection || { accumulatedImportance: 0, lastReflectionTime: 0 };
    this.planDay = data.planDay ?? -1; // which day the current plan was built for

    // --- Movement / pathing (for rendering only; cognition uses currentLocationId) ---
    // path: world-space waypoints [{x,y}] | null. pathIndex: index of next waypoint.
    // destLocationId: where the path leads. arrived: true once the walk is done
    // (or when there is nothing to walk to).
    this.path = data.path || null;
    this.pathIndex = data.pathIndex ?? 0;
    this.destLocationId = data.destLocationId ?? null;
    this.arrived = data.arrived ?? true;

    // --- Optional appearance / behaviour passthrough (default gracefully) -----
    // Consumed by the renderer/character factory and (optionally) cognition.
    // These never feed the sim RNG; they are stable per-agent inputs only.
    this.spriteVariant = data.spriteVariant ?? null;
    this.palette = data.palette ?? null;
    this.archetype = data.archetype ?? null;
    this.activityPrefs = data.activityPrefs ?? {};
    this.relationshipPrefs = data.relationshipPrefs ?? {};
  }

  addMemory(memory) {
    const m = this.memoryStream.add(memory);
    // Reflection is triggered by accumulated importance of fresh, lived memories
    // (not by reflections themselves, which would create a feedback loop).
    if (["observation", "action", "conversation", "event"].includes(m.type)) {
      this.reflection.accumulatedImportance += m.importance;
    }
    return m;
  }

  retrieveMemories(query, currentTime, n) {
    return this.memoryStream.retrieve(query, currentTime, n);
  }

  moveTo(locationId) {
    this.currentLocationId = locationId;
  }

  // Plan a walking route for the renderer. Deterministic: pathWorldPoints runs
  // grid A* with fixed tie-breaks, so identical inputs yield identical paths.
  // grid may be null (e.g. pathfinding disabled) — then we fall back to a single
  // straight hop to the destination. This sets state only; it does NOT change
  // currentLocationId (the Simulation does that separately so co-location timing
  // stays bit-identical regardless of rendering).
  setDestination(locationId, fromWorld, toWorld, grid) {
    const route = grid ? pathWorldPoints(grid, fromWorld, toWorld) : null;
    this.path = route && route.length ? route : (toWorld ? [toWorld] : null);
    this.pathIndex = 0;
    this.destLocationId = locationId;
    this.arrived = false;
  }

  get currentGoal() {
    return this.goals && this.goals.length ? this.goals[0] : "—";
  }

  get memoryCount() {
    return this.memoryStream.count();
  }

  get initials() {
    return String(this.name || "")
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      age: this.age,
      role: this.role,
      personality: this.personality,
      traits: this.traits,
      homeLocationId: this.homeLocationId,
      workLocationId: this.workLocationId,
      currentLocationId: this.currentLocationId,
      goals: this.goals,
      dailyRoutine: this.dailyRoutine,
      currentPlan: this.currentPlan,
      currentActivity: this.currentActivity,
      color: this.color,
      emoji: this.emoji,
      memoryStream: this.memoryStream.toJSON(),
      relationships: this.relationships.toJSON().relationships,
      conversationLog: this.conversationLog,
      reflection: this.reflection,
      planDay: this.planDay,
      path: this.path,
      pathIndex: this.pathIndex,
      destLocationId: this.destLocationId,
      arrived: this.arrived,
      spriteVariant: this.spriteVariant,
      palette: this.palette,
      archetype: this.archetype,
      activityPrefs: this.activityPrefs,
      relationshipPrefs: this.relationshipPrefs,
    };
  }

  static fromJSON(o) {
    return new Agent({
      ...o,
      memoryStream: MemoryStream.fromJSON(o.memoryStream || { agentId: o.id, memories: [] }),
      relationships: RelationshipGraph.fromJSON({ relationships: o.relationships || {} }),
    });
  }
}
