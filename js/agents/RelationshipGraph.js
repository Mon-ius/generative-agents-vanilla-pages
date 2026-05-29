// RelationshipGraph.js — per-agent relationships toward other agents.
//
// Each relationship tracks three numeric dimensions and free-text notes:
//   affinity     -100..100  (liking / warmth)
//   trust        -100..100  (reliability / confidence)
//   familiarity     0..100  (how well they know each other)
// Conversations nudge these values; the UI displays them as labelled bars.

export function defaultRelationship(targetAgentId) {
  return { targetAgentId, affinity: 0, trust: 0, familiarity: 0, notes: [] };
}

function clampScore(v, min = -100, max = 100) {
  return Math.max(min, Math.min(max, v));
}

export class RelationshipGraph {
  constructor(map = {}) {
    this.relationships = { ...map };
  }

  get(targetAgentId) {
    if (!this.relationships[targetAgentId]) {
      this.relationships[targetAgentId] = defaultRelationship(targetAgentId);
    }
    return this.relationships[targetAgentId];
  }

  has(targetAgentId) {
    return Boolean(this.relationships[targetAgentId]);
  }

  all() {
    return Object.values(this.relationships);
  }

  update(targetAgentId, { affinity = 0, trust = 0, familiarity = 0, note = null } = {}) {
    const rel = this.get(targetAgentId);
    rel.affinity = clampScore(rel.affinity + affinity);
    rel.trust = clampScore(rel.trust + trust);
    rel.familiarity = clampScore(rel.familiarity + familiarity, 0, 100);
    if (note && !rel.notes.includes(note)) {
      rel.notes.push(note);
      if (rel.notes.length > 6) rel.notes.shift();
    }
    return rel;
  }

  toJSON() {
    return { relationships: this.relationships };
  }

  static fromJSON(o) {
    return new RelationshipGraph((o && o.relationships) || {});
  }
}
