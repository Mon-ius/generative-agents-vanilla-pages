// seedEvents.js — recurring daily world events.
//
// time is minutes-into-day (0..1439); locationId must exist in seedLocations.js.
// Events fire once per day and reset at the day rollover.

export const SEED_EVENTS = [
  {
    "id": "event_cafe_pastries",
    "time": 480,
    "locationId": "loc_central_cafe",
    "title": "Fresh Pastries",
    "description": "The Willow Café puts out a tray of warm pastries for the morning crowd.",
    "importance": 3,
    "tags": [
      "food",
      "cafe",
      "morning"
    ]
  },
  {
    "id": "event_market_day",
    "time": 600,
    "locationId": "loc_central_square",
    "title": "Market Day Setup",
    "description": "Vendors begin raising stalls around the town square for market day.",
    "importance": 6,
    "tags": [
      "market",
      "community",
      "square"
    ]
  },
  {
    "id": "event_farmers_market",
    "time": 540,
    "locationId": "loc_river_farmmarket",
    "title": "Farmers' Market Opens",
    "description": "Growers lay out vegetables, honey, and flowers as the riverside market opens.",
    "importance": 5,
    "tags": [
      "market",
      "food",
      "morning"
    ]
  },
  {
    "id": "event_school_assembly",
    "time": 570,
    "locationId": "loc_east_school",
    "title": "Morning Assembly",
    "description": "Students gather in the hall for announcements and the day's notices.",
    "importance": 4,
    "tags": [
      "school",
      "learning",
      "children"
    ]
  },
  {
    "id": "event_clinic_dropin",
    "time": 660,
    "locationId": "loc_east_clinic",
    "title": "Wellness Drop-in",
    "description": "The clinic opens a free blood-pressure and wellness drop-in for residents.",
    "importance": 5,
    "tags": [
      "health",
      "care",
      "community"
    ]
  },
  {
    "id": "event_library_talk",
    "time": 900,
    "locationId": "loc_east_library",
    "title": "Author Talk",
    "description": "A visiting author gives a short talk in the library's reading room.",
    "importance": 5,
    "tags": [
      "books",
      "talk",
      "library"
    ]
  },
  {
    "id": "event_gallery_opening",
    "time": 1080,
    "locationId": "loc_south_gallery",
    "title": "Gallery Opening",
    "description": "The art gallery unveils a new show with cider and quiet music.",
    "importance": 6,
    "tags": [
      "arts",
      "culture",
      "evening"
    ]
  },
  {
    "id": "event_park_concert",
    "time": 1110,
    "locationId": "loc_west_amphi",
    "title": "Evening Concert",
    "description": "A small band sets up at the lakeside amphitheatre for an evening concert.",
    "importance": 6,
    "tags": [
      "music",
      "park",
      "evening"
    ]
  }
];
