// Planner.js — builds and maintains an agent's daily plan.
//
// The Planner asks the GenerationProvider for raw plan blocks, wraps them with
// ids and a status, and updates statuses each tick based on the time of day.
// Plan item shape:
//   { id, startTime, endTime, locationId, activity, priority, status }
// status: "scheduled" | "active" | "completed"

// Plan-item ids are derived from the agent + day + block index so they are fully
// deterministic: two fresh runs of the same seed (and a save/load round-trip)
// produce identical ids. (A module-global counter used to leak state across
// Simulation instances, breaking same-seed reproducibility.)
function planId(agent, day, index) {
  const aid = agent && agent.id != null ? agent.id : "agent";
  return `plan_${aid}_d${day}_${String(index).padStart(2, "0")}`;
}

export class Planner {
  constructor(provider) {
    this.provider = provider;
  }

  buildDailyPlan(agent, context) {
    // Enrich the provider context with the agent's relationships and activity
    // preferences (additive; existing providers ignore unknown keys). These are
    // stable per-agent inputs, not RNG sources, so determinism is unaffected.
    const enriched = {
      ...context,
      relationships: agent.relationships,
      activityPrefs: agent.activityPrefs || {},
    };
    const raw = this.provider.generatePlan(agent, enriched);
    const day = context && context.day != null ? context.day : 1;
    return raw.map((p, i) => ({
      id: planId(agent, day, i),
      startTime: p.startTime,
      endTime: p.endTime,
      locationId: p.locationId,
      activity: p.activity,
      priority: p.priority ?? 2,
      status: "scheduled",
    }));
  }

  // Mark each item completed/active/scheduled for the given minutes-into-day.
  // Returns the currently active item, or null.
  updateStatuses(plan, minutesIntoDay) {
    let active = null;
    for (const item of plan) {
      if (minutesIntoDay >= item.endTime) item.status = "completed";
      else if (minutesIntoDay >= item.startTime && minutesIntoDay < item.endTime) {
        item.status = "active";
        active = item;
      } else {
        item.status = "scheduled";
      }
    }
    return active;
  }
}
