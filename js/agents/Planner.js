// Planner.js — builds and maintains an agent's daily plan.
//
// The Planner asks the GenerationProvider for raw plan blocks, wraps them with
// ids and a status, and updates statuses each tick based on the time of day.
// Plan item shape:
//   { id, startTime, endTime, locationId, activity, priority, status }
// status: "scheduled" | "active" | "completed"

let _planCounter = 0;
function planId() {
  _planCounter += 1;
  return `plan_${String(_planCounter).padStart(4, "0")}`;
}

export class Planner {
  constructor(provider) {
    this.provider = provider;
  }

  buildDailyPlan(agent, context) {
    const raw = this.provider.generatePlan(agent, context);
    return raw.map((p) => ({
      id: planId(),
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
