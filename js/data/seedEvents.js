// seedEvents.js — scheduled world events.
//
// `time` is minutes-into-day, so each event recurs daily (the Simulation resets
// event "fired" flags at every day rollover). Agents present at the event's
// location observe it, react, and store it as a memory.

export const SEED_EVENTS = [
  {
    id: "event_cafe_pastries",
    time: 510, // 08:30
    locationId: "loc_cafe",
    title: "Fresh Pastries",
    description: "The café puts out a tray of fresh pastries for the morning crowd.",
    importance: 3,
    tags: ["food", "cafe", "morning"],
  },
  {
    id: "event_market_day",
    time: 600, // 10:00
    locationId: "loc_square",
    title: "Market Day Setup",
    description: "Vendors begin setting up stalls around the town square.",
    importance: 6,
    tags: ["market", "community", "square"],
  },
  {
    id: "event_library_talk",
    time: 900, // 15:00
    locationId: "loc_library",
    title: "Author Talk",
    description: "A visiting author gives a short talk in the reading room.",
    importance: 5,
    tags: ["books", "talk", "library"],
  },
  {
    id: "event_park_concert",
    time: 1110, // 18:30
    locationId: "loc_park",
    title: "Evening Concert",
    description: "A small band sets up near the pond for an evening concert.",
    importance: 6,
    tags: ["music", "park", "evening"],
  },
];
