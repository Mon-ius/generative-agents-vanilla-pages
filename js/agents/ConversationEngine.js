// ConversationEngine.js — decides when co-located agents talk, and runs it.
//
// Gating rules (pairs and groups):
//   - all agents are in the same location (checked by the Simulation),
//   - at least one pair has not spoken within the conversation cooldown window,
//   - a seeded RNG gate passes (nudged up by familiarity).
// The actual dialogue is produced by the GenerationProvider. The Simulation
// applies the results (memories for participants, relationship updates, a
// timeline entry).
//
// A conversation can involve 2..CONFIG.conversation.maxGroupSize agents. A group
// of size 2 behaves exactly like the historical pair path (same provider call,
// same RNG draw count) so determinism is preserved for existing seeds.

import { CONFIG } from "../config.js";

export class ConversationEngine {
  constructor(provider) {
    this.provider = provider;
  }

  // --- Pair gating (unchanged) ---------------------------------------------
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

  // --- Group gating ---------------------------------------------------------
  // True when the group has >= 2 members, at least one pair is off-cooldown, and
  // a familiarity-scaled RNG gate passes. The familiarity used is the maximum
  // over all off-cooldown ordered pairs (a single warm acquaintance is enough to
  // make the group likely to chat). A single rng() draw keeps the stream usage
  // identical to the pair path when the group is size 2.
  checkGroupConverse(agents, currentTime, rng) {
    if (!agents || agents.length < 2) return false;

    let anyOffCooldown = false;
    let maxFamiliarity = 0;
    for (let i = 0; i < agents.length; i++) {
      for (let j = 0; j < agents.length; j++) {
        if (i === j) continue;
        const a = agents[i];
        const b = agents[j];
        const last = a.conversationLog[b.id];
        if (last != null && currentTime - last < CONFIG.conversation.cooldownMinutes) continue;
        anyOffCooldown = true;
        const fam = a.relationships.get(b.id).familiarity || 0;
        if (fam > maxFamiliarity) maxFamiliarity = fam;
      }
    }
    if (!anyOffCooldown) return false;

    const chance = CONFIG.conversation.baseChance + Math.min(0.3, maxFamiliarity / 300);
    return rng() < chance;
  }

  // Run a group conversation among 2..maxGroupSize agents. For size 2 this
  // delegates to the historical pair path so the output (and RNG usage) match
  // exactly. Returns the provider's group transcript, augmented with
  // participantIds, and stamps the conversationLog for every ordered pair.
  converseGroup(agents, context) {
    let convo;
    if (agents.length === 2) {
      // Same provider call as the pair path; converse() also stamps the log.
      convo = this.converse(agents[0], agents[1], context);
    } else {
      convo = this.provider.generateGroupConversation(agents, context);
      // Stamp the cooldown clock for every ordered pair of participants.
      for (let i = 0; i < agents.length; i++) {
        for (let j = 0; j < agents.length; j++) {
          if (i === j) continue;
          agents[i].conversationLog[agents[j].id] = context.currentTime;
        }
      }
    }
    if (convo && !convo.participantIds) {
      convo = { ...convo, participantIds: agents.map((a) => a.id) };
    }
    return convo;
  }
}
