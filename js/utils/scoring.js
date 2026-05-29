// scoring.js — deterministic memory-retrieval scoring.
//
// Inspired by the Generative Agents paper's retrieval function, each memory is
// scored by a simple, understandable combination of three factors:
//
//   score = recencyWeight*recency + importanceWeight*importance + relevanceWeight*relevance
//
// - recency:    exponential decay by memory age (recent memories score higher)
// - importance: the memory's own poignancy/importance, normalised to [0,1]
// - relevance:  keyword overlap between the memory and the query, in [0,1]
//
// No randomness here — given the same inputs the ranking is always identical.

import { CONFIG } from "../config.js";

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function recencyScore(memory, currentTime, halfLife) {
  const age = Math.max(0, currentTime - (memory.timestamp ?? currentTime));
  return Math.pow(0.5, age / Math.max(1, halfLife)); // 1 at age 0, 0.5 at one half-life
}

export function importanceScore(memory) {
  return clamp01((memory.importance ?? 0) / 10);
}

export function relevanceScore(memory, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) return 0;
  const memWords = new Set([
    ...(memory.keywords || []).map((k) => String(k).toLowerCase()),
    ...tokenize(memory.description),
  ]);
  if (memWords.size === 0) return 0;
  let hits = 0;
  for (const q of queryKeywords) {
    if (memWords.has(String(q).toLowerCase())) hits++;
  }
  return clamp01(hits / queryKeywords.length);
}

// Returns { score, recency, importance, relevance } for one memory.
export function scoreMemory(memory, query, currentTime, weights = CONFIG.retrieval) {
  const keywords = query.keywords && query.keywords.length ? query.keywords : tokenize(query.text);
  const recency = recencyScore(memory, currentTime, weights.recencyHalfLifeMinutes);
  const importance = importanceScore(memory);
  const relevance = relevanceScore(memory, keywords);
  const score =
    weights.recencyWeight * recency +
    weights.importanceWeight * importance +
    weights.relevanceWeight * relevance;
  return { score, recency, importance, relevance };
}

// memories: array of memory objects.
// query: { text?: string, keywords?: string[] }.
// Returns the top-n scored entries: [{ memory, score, recency, importance, relevance }].
export function retrieveMemories(
  memories,
  query,
  currentTime,
  n = CONFIG.retrieval.defaultCount,
  weights = CONFIG.retrieval
) {
  const keywords = query.keywords && query.keywords.length ? query.keywords : tokenize(query.text);
  const scored = memories.map((memory) => ({
    memory,
    ...scoreMemory(memory, { keywords }, currentTime, weights),
  }));
  scored.sort((a, b) => b.score - a.score || (b.memory.timestamp ?? 0) - (a.memory.timestamp ?? 0));
  return scored.slice(0, n);
}
