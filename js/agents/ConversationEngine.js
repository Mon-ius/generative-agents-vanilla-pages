// ConversationEngine.js — decides when two co-located agents talk, and runs it.
//
// Gating rules:
//   - both agents are in the same location (checked by the Simulation),
//   - they have not spoken within the conversation cooldown window,
//   - a seeded RNG gate passes (nudged up by familiarity).
// The actual dialogue is produced by the GenerationProvider. The Simulation
// applies the results (memories for both, relationship updates, timeline entry).

import { CONFIG } from "../config.js";

export class ConversationEngine {
  constructor(provider) {
    this.provider = provider;
  }

  canConverse(agentA, agentB, currentTime, rng) {
    const lastA = agentA.conversationLog[agentB.id];
    if (lastA != null && currentTime - lastA < CONFIG.conversation.cooldownMinutes) return false;

    const familiarity = agentA.relationships.get(agentB.id).familiarity || 0;
    const chance = CONFIG.conversation.baseChance + Math.min(0.3, familiarity / 300);
    return rng() < chance;
  }

  converse(agentA, agentB, context) {
    const convo = this.provider.generateConversation(agentA, agentB, context);
    agentA.conversationLog[agentB.id] = context.currentTime;
    agentB.conversationLog[agentA.id] = context.currentTime;
    return convo;
  }
}
