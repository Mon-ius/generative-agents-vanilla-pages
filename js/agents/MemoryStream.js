// MemoryStream.js — an agent's chronological memory stream.
//
// Memories are append-only records. Retrieval is delegated to the deterministic
// scoring utility (recency + importance + relevance). Each memory looks like:
//
//   {
//     id, agentId, timestamp,           // timestamp = total simulated minutes
//     type,                             // observation | action | conversation | reflection | plan | event
//     description, importance,          // importance ~1..10
//     locationId, relatedAgentIds[], keywords[]
//   }

import { retrieveMemories } from "../utils/scoring.js";

export class MemoryStream {
  constructor(agentId, memories = []) {
    this.agentId = agentId;
    this.memories = memories.slice();
    this._counter = memories.length;
  }

  _nextId() {
    this._counter += 1;
    return `mem_${this.agentId}_${String(this._counter).padStart(4, "0")}`;
  }

  add(memory) {
    const m = {
      id: memory.id || this._nextId(),
      agentId: this.agentId,
      timestamp: memory.timestamp ?? 0,
      type: memory.type || "observation",
      description: memory.description || "",
      importance: memory.importance ?? 1,
      locationId: memory.locationId ?? null,
      relatedAgentIds: memory.relatedAgentIds || [],
      keywords: memory.keywords || [],
    };
    this.memories.push(m);
    return m;
  }

  all() {
    return this.memories;
  }

  // Most recent N, newest first.
  recent(n = 10) {
    return this.memories.slice(-n).reverse();
  }

  byType(type) {
    return this.memories.filter((m) => m.type === type);
  }

  count() {
    return this.memories.length;
  }

  // Deterministic relevance/recency/importance retrieval.
  // query: { text?: string, keywords?: string[] }
  retrieve(query, currentTime, n) {
    return retrieveMemories(this.memories, query, currentTime, n);
  }

  toJSON() {
    return { agentId: this.agentId, memories: this.memories, counter: this._counter };
  }

  static fromJSON(o) {
    const ms = new MemoryStream(o.agentId, o.memories || []);
    ms._counter = o.counter ?? (o.memories ? o.memories.length : 0);
    return ms;
  }
}
