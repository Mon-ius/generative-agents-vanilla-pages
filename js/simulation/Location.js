// Location.js — a place in the town world.
//
// Locations live on an integer grid (x, y). The Manhattan distance helper is
// used for simple "how far" reasoning; the app does not simulate travel time
// beyond moving an agent to its target location when a plan requires it.

export class Location {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.type = data.type;
    this.x = data.x;
    this.y = data.y;
    this.description = data.description || "";
    this.tags = data.tags || [];
  }

  distanceTo(other) {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }

  hasTag(tag) {
    return this.tags.includes(tag);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      x: this.x,
      y: this.y,
      description: this.description,
      tags: this.tags,
    };
  }
}
