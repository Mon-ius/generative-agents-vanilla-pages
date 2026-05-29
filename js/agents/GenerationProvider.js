// GenerationProvider.js — the "generation" abstraction.
//
// The app must run with NO external LLM. All believable text (plans, reflections,
// conversations, reactions) is produced by LocalGenerationProvider using
// deterministic templates driven by the simulation's seeded RNG. A real model can
// be swapped in later by implementing the same interface (see LLMGenerationProvider).
//
// Interface (every method receives a `context`: { env, rng, day, minutesIntoDay,
// currentTime, totalMinutes, location? }):
//
//   generatePlan(agent, context)              -> [{ startTime, endTime, locationId, activity, priority }]
//   generateReflection(agent, memories, ctx)  -> string
//   generateConversation(agentA, agentB, ctx) -> { lines:[{speakerId,speaker,text}], tone, topic, topicKeywords, summary }
//   generateReaction(agent, event, context)   -> string

import { choice, weightedChoice } from "../utils/random.js";

export class GenerationProvider {
  generatePlan() {
    throw new Error("GenerationProvider.generatePlan not implemented");
  }
  generateReflection() {
    throw new Error("GenerationProvider.generateReflection not implemented");
  }
  generateConversation() {
    throw new Error("GenerationProvider.generateConversation not implemented");
  }
  generateReaction() {
    throw new Error("GenerationProvider.generateReaction not implemented");
  }
}

// ---- Role-flavoured work descriptions ----------------------------------------
const ROLE_WORK = {
  "urban planner": "Review zoning maps and sketch ideas for public spaces",
  "café owner": "Brew coffee and look after the morning regulars",
  librarian: "Shelve returns and help visitors find what they need",
  nurse: "Check on patients and update charts",
  maker: "Prototype and tinker in the studio",
  teacher: "Prepare lessons and work with students",
};

// A daily routine template, in minutes-into-day. The "work" blocks resolve to the
// agent's workLocationId; others resolve by location type/tag.
const DAY_TEMPLATE = [
  { start: 0, end: 360, activity: "Sleep and rest at home", kinds: ["home"], priority: 1 },
  { start: 360, end: 480, activity: "Wake up and ease into the morning", kinds: ["home"], priority: 2 },
  { start: 480, end: 540, activity: "Grab breakfast and read the news", kinds: ["cafe"], priority: 2 },
  { start: 540, end: 720, activity: null, kinds: ["work"], priority: 4 }, // morning work
  { start: 720, end: 780, activity: "Have lunch and take a short walk", kinds: ["park", "cafe"], priority: 2 },
  { start: 780, end: 1020, activity: null, kinds: ["work"], priority: 4 }, // afternoon work
  { start: 1020, end: 1140, activity: "Run errands and check in around town", kinds: ["shop", "library", "square"], priority: 3 },
  { start: 1140, end: 1260, activity: "Spend time with neighbours", kinds: ["square", "park", "cafe"], priority: 3 },
  { start: 1260, end: 1440, activity: "Wind down and head home for the evening", kinds: ["home"], priority: 2 },
];

export class LocalGenerationProvider extends GenerationProvider {
  // --- Planning -------------------------------------------------------------
  generatePlan(agent, context) {
    const { env, rng } = context;
    return DAY_TEMPLATE.map((block) => {
      const locationId = this._resolveLocation(agent, env, block.kinds, rng);
      const activity = block.activity || this._workActivity(agent, rng);
      return {
        startTime: block.start,
        endTime: block.end,
        locationId,
        activity,
        priority: block.priority,
      };
    });
  }

  _workActivity(agent, rng) {
    const base = ROLE_WORK[agent.role] || `Focus on work as a ${agent.role}`;
    const goal = agent.goals && agent.goals.length ? choice(agent.goals, rng) : null;
    return goal ? `${base} — working toward "${goal.toLowerCase()}"` : base;
  }

  _resolveLocation(agent, env, kinds, rng) {
    if (kinds.includes("home")) return agent.homeLocationId;
    if (kinds.includes("work")) return agent.workLocationId || agent.homeLocationId;
    const candidates = env
      .allLocations()
      .filter((l) => kinds.includes(l.type) || kinds.some((k) => l.hasTag(k)));
    if (candidates.length) return choice(candidates, rng).id;
    return agent.homeLocationId;
  }

  // --- Reflection -----------------------------------------------------------
  generateReflection(agent, memories, context) {
    // Find the most-mentioned other agent and the most common keyword theme.
    const agentCounts = new Map();
    const kwCounts = new Map();
    for (const m of memories) {
      for (const id of m.relatedAgentIds || []) agentCounts.set(id, (agentCounts.get(id) || 0) + 1);
      for (const k of m.keywords || []) {
        const kk = String(k).toLowerCase();
        if (kk.length < 3) continue;
        kwCounts.set(kk, (kwCounts.get(kk) || 0) + 1);
      }
    }
    const topAgentId = topKey(agentCounts);
    const topTheme = topKey(kwCounts);
    const goal = agent.goals && agent.goals.length ? agent.goals[0] : "the day ahead";

    if (topAgentId && agent.relationships.has(topAgentId)) {
      const rel = agent.relationships.get(topAgentId);
      const otherName = context.nameOf ? context.nameOf(topAgentId) : topAgentId;
      const descriptor =
        rel.affinity >= 20 ? "a real friend" : rel.affinity <= -20 ? "someone to be wary of" : "a familiar face worth knowing better";
      return `${agent.name} keeps crossing paths with ${otherName} and is starting to see them as ${descriptor}.`;
    }
    if (topTheme) {
      return `${agent.name} has been thinking a lot about ${topTheme} lately — it feels connected to the goal of ${goal.toLowerCase()}.`;
    }
    return `${agent.name} took a moment to reflect on the day and stay focused on ${goal.toLowerCase()}.`;
  }

  // --- Conversations --------------------------------------------------------
  generateConversation(agentA, agentB, context) {
    const loc = context.location || (context.env && context.env.getLocation(agentA.currentLocationId));
    const rng = context.rng;
    const relA = agentA.relationships.get(agentB.id);

    const tone = relA.affinity >= 20 ? "warm" : relA.affinity <= -20 ? "tense" : "neutral";
    const topic = this._pickTopic(agentA, agentB, loc, rng);

    const opener = weightedChoice(
      [
        { item: `Morning, ${firstName(agentB)}.`, weight: tone === "warm" ? 3 : 1 },
        { item: `Hey ${firstName(agentB)}, good to see you.`, weight: 2 },
        { item: `Oh — hi ${firstName(agentB)}.`, weight: tone === "tense" ? 3 : 1 },
      ],
      rng
    );
    const aLine = `${opener} ${topic.aSays}`;
    const bLine = topic.bSays;
    const lines = [
      { speakerId: agentA.id, speaker: agentA.name, text: aLine },
      { speakerId: agentB.id, speaker: agentB.name, text: bLine },
    ];
    if (rng() < 0.6) {
      lines.push({
        speakerId: agentA.id,
        speaker: agentA.name,
        text: tone === "warm" ? "Thanks — let's catch up again soon." : "Good talking. I'll see you around.",
      });
    }

    const where = loc ? ` at ${loc.name}` : "";
    const summary = `${firstName(agentA)} and ${firstName(agentB)} talked about ${topic.label}${where}.`;
    return { lines, tone, topic: topic.label, topicKeywords: topic.keywords, summary };
  }

  _pickTopic(agentA, agentB, loc, rng) {
    const options = [];
    if (loc) {
      options.push({
        label: `${loc.name}`,
        keywords: [loc.type, ...(loc.tags || [])],
        aSays: `What do you make of ${loc.name} these days?`,
        bSays: `${loc.name}? ${capitalize(loc.description)}`,
      });
    }
    const goalA = agentA.goals && agentA.goals.length ? choice(agentA.goals, rng) : null;
    if (goalA) {
      options.push({
        label: "a shared project",
        keywords: ["project", "community"],
        aSays: `I've been trying to ${goalA.toLowerCase()}. Any thoughts?`,
        bSays: `That sounds worthwhile — as a ${agentB.role}, I'd be glad to help where I can.`,
      });
    }
    options.push({
      label: "town life",
      keywords: ["town", "community", "neighbours"],
      aSays: `How's the ${agentB.role} work going?`,
      bSays: `Busy, but good. Plenty happening around town lately.`,
    });
    return choice(options, rng);
  }

  // --- Reactions to world events -------------------------------------------
  generateReaction(agent, event, context) {
    const trait = agent.traits && agent.traits.length ? choice(agent.traits, context.rng) : "thoughtful";
    const reactions = [
      `${agent.name} noticed the ${event.title.toLowerCase()} and felt ${moodFromTrait(trait)} about it.`,
      `Being ${trait}, ${firstName(agent)} took a closer look at the ${event.title.toLowerCase()}.`,
      `${agent.name} made a mental note about the ${event.title.toLowerCase()}.`,
    ];
    return choice(reactions, context.rng);
  }
}

// A documented stub for plugging in a real model later. It intentionally throws
// so it is never silently used — and there are NO API calls in client code.
export class LLMGenerationProvider extends GenerationProvider {
  constructor(options = {}) {
    super();
    // e.g. { proxyUrl: "https://your-backend.example/llm" }
    this.options = options;
  }

  async _call() {
    throw new Error(
      "LLMGenerationProvider is a stub. Route requests through a backend proxy that holds the API key — never call an LLM API with a key embedded in client-side code."
    );
  }
}

// ---- helpers -----------------------------------------------------------------
function topKey(map) {
  let best = null;
  let bestN = 0;
  for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
  return best;
}
function firstName(agent) {
  return String(agent.name || "").split(" ")[0] || agent.name;
}
function capitalize(s) {
  s = String(s || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function moodFromTrait(trait) {
  const map = { curious: "intrigued", organized: "ready to help", empathetic: "warm", practical: "matter-of-fact", creative: "inspired", patient: "calm", outgoing: "excited", observant: "attentive" };
  return map[trait] || "interested";
}
