// Reflector.js — periodic, importance-triggered reflection.
//
// Mirrors the paper's idea: when the accumulated importance of recent memories
// crosses a threshold (and enough time has passed), the agent synthesizes a
// higher-level insight from its recent memory window. The insight is produced
// by the GenerationProvider (deterministic locally) and stored back as a
// "reflection" memory by the Simulation.

import { CONFIG } from "../config.js";

export class Reflector {
  constructor(provider) {
    this.provider = provider;
  }

  shouldReflect(agent, currentTime) {
    const accumulated = agent.reflection.accumulatedImportance;
    const sinceLast = currentTime - agent.reflection.lastReflectionTime;
    return (
      accumulated >= CONFIG.reflection.importanceThreshold &&
      sinceLast >= CONFIG.reflection.minIntervalMinutes
    );
  }

  // Produces an insight string and resets the agent's reflection counters.
  reflect(agent, context) {
    const recent = agent.memoryStream.recent(CONFIG.reflection.recentMemoryWindow);
    const insight = this.provider.generateReflection(agent, recent, context);
    agent.reflection.accumulatedImportance = 0;
    agent.reflection.lastReflectionTime = context.currentTime;
    return insight;
  }
}
