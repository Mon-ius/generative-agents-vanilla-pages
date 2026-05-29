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
    // Additive optimization: a location -> agents reverse index. Not persisted.
    this._byLoc = null; // Map<locationId, Agent[]>
    this._indexedAgents = null; // identity reference to the agents array last indexed
    this._indexedLength = -1; // length of that array, for a cheap freshness check
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

  // Build a location -> agents reverse index for O(1) lookups. Call this once
  // per tick after agents have moved; agentsAt/coLocated will use it while it
  // stays fresh for the same agents array, falling back to a linear scan otherwise.
  indexAgents(agents) {
    const byLoc = new Map();
    for (const a of agents) {
      const id = a.currentLocationId;
      let bucket = byLoc.get(id);
      if (!bucket) {
        bucket = [];
        byLoc.set(id, bucket);
      }
      bucket.push(a);
    }
    this._byLoc = byLoc;
    this._indexedAgents = agents;
    this._indexedLength = agents.length;
  }

  // The index is usable only for the exact agents array it was built from
  // (cheap identity + length check; never changes results vs. the linear scan).
  _indexFresh(agents) {
    return (
      this._byLoc !== null &&
      this._indexedAgents === agents &&
      this._indexedLength === agents.length
    );
  }

  // Agents currently standing at a given location.
  agentsAt(locationId, agents) {
    if (this._indexFresh(agents)) {
      return this._byLoc.get(locationId) || [];
    }
    return agents.filter((a) => a.currentLocationId === locationId);
  }

  // Other agents sharing `agent`'s current location.
  coLocated(agent, agents) {
    if (this._indexFresh(agents)) {
      const bucket = this._byLoc.get(agent.currentLocationId);
      if (!bucket) return [];
      return bucket.filter((a) => a.id !== agent.id);
    }
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
