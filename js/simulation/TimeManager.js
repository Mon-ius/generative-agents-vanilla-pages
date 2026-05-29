// TimeManager.js — tracks simulated time as whole minutes since Day 1, 00:00.
//
// Plan items use "minutes into the current day" (e.g. 540 = 09:00), while memory
// timestamps use the monotonic totalMinutes value so recency scoring behaves
// correctly across day boundaries.

import { CONFIG } from "../config.js";

export class TimeManager {
  constructor(startMinutes = CONFIG.startMinutes, minutesPerTick = CONFIG.minutesPerTick) {
    this.minutesPerTick = minutesPerTick;
    this.totalMinutes = startMinutes;
  }

  tick() {
    const prevDay = this.day;
    this.totalMinutes += this.minutesPerTick;
    return { rolledOver: this.day !== prevDay };
  }

  get day() {
    return Math.floor(this.totalMinutes / CONFIG.dayLengthMinutes) + 1;
  }

  get minutesIntoDay() {
    const m = this.totalMinutes % CONFIG.dayLengthMinutes;
    return ((m % CONFIG.dayLengthMinutes) + CONFIG.dayLengthMinutes) % CONFIG.dayLengthMinutes;
  }

  get hours() {
    return Math.floor(this.minutesIntoDay / 60);
  }

  get mins() {
    return this.minutesIntoDay % 60;
  }

  // "Day 1, 09:30"
  format() {
    return `Day ${this.day}, ${pad(this.hours)}:${pad(this.mins)}`;
  }

  // Format an arbitrary minutes-into-day value as "HH:MM".
  static clock(minutesIntoDay) {
    const into = ((minutesIntoDay % CONFIG.dayLengthMinutes) + CONFIG.dayLengthMinutes) % CONFIG.dayLengthMinutes;
    return `${pad(Math.floor(into / 60))}:${pad(Math.floor(into % 60))}`;
  }

  // Format a monotonic totalMinutes value as "Day N, HH:MM".
  static formatTotal(totalMinutes) {
    const day = Math.floor(totalMinutes / CONFIG.dayLengthMinutes) + 1;
    const into = ((totalMinutes % CONFIG.dayLengthMinutes) + CONFIG.dayLengthMinutes) % CONFIG.dayLengthMinutes;
    return `Day ${day}, ${pad(Math.floor(into / 60))}:${pad(Math.floor(into % 60))}`;
  }

  toJSON() {
    return { totalMinutes: this.totalMinutes, minutesPerTick: this.minutesPerTick };
  }

  static fromJSON(o) {
    const t = new TimeManager(0, o.minutesPerTick ?? CONFIG.minutesPerTick);
    t.totalMinutes = o.totalMinutes ?? CONFIG.startMinutes;
    return t;
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}
