// Environment.js — the world: locations plus scheduled world events.
//
// The Environment does not own the agents; it answers spatial questions about
// them when given the current agent list (agents carry their own currentLocationId).
// World events are scheduled by minutes-into-day and fire once per day; the
// Simulation resets their "fired" flags at each day rollover so daily events recur.

import { Location } from "./Location.js";

export class Environment {
  constructor(locations = [], events = []) {
    this.locations = new Map();
    for (const l of locations) this.addLocation(l);
    this.events = events.map((e) => ({ ...e, fired: !!e.fired }));
  }

  addLocation(data) {
    const loc = data instanceof Location ? data : new Location(data);
    this.locations.set(loc.id, loc);
    return loc;
  }

  getLocation(id) {
    return this.locations.get(id) || null;
  }

  allLocations() {
    return Array.from(this.locations.values());
  }

  locationsByType(type) {
    return this.allLocations().filter((l) => l.type === type);
  }

  locationsByTag(tag) {
    return this.allLocations().filter((l) => l.hasTag(tag));
  }

  // Agents currently standing at a given location.
  agentsAt(locationId, agents) {
    return agents.filter((a) => a.currentLocationId === locationId);
  }

  // Other agents sharing `agent`'s current location.
  coLocated(agent, agents) {
    return agents.filter((a) => a.id !== agent.id && a.currentLocationId === agent.currentLocationId);
  }

  // World events that are due (time has arrived) and not yet fired today.
  dueEvents(minutesIntoDay) {
    return this.events.filter((e) => !e.fired && e.time <= minutesIntoDay);
  }

  markFired(eventId) {
    const e = this.events.find((x) => x.id === eventId);
    if (e) e.fired = true;
  }

  resetEvents() {
    for (const e of this.events) e.fired = false;
  }

  addEvent(e) {
    this.events.push({ ...e, fired: false });
  }

  toJSON() {
    return {
      locations: this.allLocations().map((l) => l.toJSON()),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  static fromJSON(o) {
    const env = new Environment(o.locations || [], []);
    env.events = (o.events || []).map((e) => ({ ...e, fired: !!e.fired }));
    return env;
  }
}
