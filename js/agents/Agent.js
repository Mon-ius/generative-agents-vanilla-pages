// Agent.js — a generative agent.
//
// The Agent holds identity/personality data and per-agent state (plan, current
// activity/location, memory stream, relationships). Heavy cognition lives in the
// dedicated modules (Planner, Reflector, ConversationEngine, GenerationProvider)
// so this stays a clean state object with convenience behaviour. Crucially, the
// Agent has no knowledge of the UI.

import { MemoryStream } from "./MemoryStream.js";
import { RelationshipGraph } from "./RelationshipGraph.js";

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
