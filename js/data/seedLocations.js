// seedLocations.js — the town of "Willow Creek".
//
// Locations sit on an 8×6 integer grid (x: 0..7, y: 0..5). There are well over
// the required 8 locations: shared public places plus a home for each agent.
// To add a location, append an object here with a unique id and grid coords that
// are not already taken (see README "How to add a new location").

export const SEED_LOCATIONS = [
  // ----- Public / shared places -----
  { id: "loc_townhall", name: "Town Hall", type: "civic", x: 3, y: 0,
    description: "the civic heart of town, where plans for Willow Creek take shape.",
    tags: ["civic", "work", "planning"] },
  { id: "loc_studio", name: "Maker Studio", type: "studio", x: 1, y: 1,
    description: "a bright workshop full of half-finished projects and tools.",
    tags: ["work", "creative", "making"] },
  { id: "loc_clinic", name: "Health Clinic", type: "health", x: 6, y: 1,
    description: "a calm clinic where residents come for check-ups.",
    tags: ["work", "health", "care"] },
  { id: "loc_park", name: "Cedar Park", type: "park", x: 5, y: 1,
    description: "a leafy park with benches and a small pond.",
    tags: ["social", "outdoors", "calm"] },
  { id: "loc_cafe", name: "Willow Café", type: "cafe", x: 2, y: 2,
    description: "a warm café where residents gather before work.",
    tags: ["social", "food", "morning"] },
  { id: "loc_square", name: "Town Square", type: "square", x: 3, y: 2,
    description: "the open square where the town meets and markets are held.",
    tags: ["social", "community", "market"] },
  { id: "loc_shop", name: "Corner Store", type: "shop", x: 4, y: 2,
    description: "a friendly general store stocked with daily needs.",
    tags: ["errand", "shop", "supplies"] },
  { id: "loc_library", name: "Town Library", type: "library", x: 1, y: 3,
    description: "a quiet library with tall shelves and reading nooks.",
    tags: ["quiet", "books", "study"] },
  { id: "loc_school", name: "Community School", type: "school", x: 6, y: 3,
    description: "the local school, lively with students and lessons.",
    tags: ["work", "learning", "children"] },

  // ----- Homes -----
  { id: "loc_diego_home", name: "Diego's Loft", type: "home", x: 0, y: 0,
    description: "a cosy loft cluttered with sketches and paint.",
    tags: ["home", "private"] },
  { id: "loc_maya_home", name: "Maya's Apartment", type: "home", x: 0, y: 4,
    description: "a tidy apartment with maps pinned to the walls.",
    tags: ["home", "private"] },
  { id: "loc_sam_home", name: "Sam's Cottage", type: "home", x: 2, y: 4,
    description: "a snug cottage that always smells faintly of coffee.",
    tags: ["home", "private"] },
  { id: "loc_arjun_home", name: "Arjun's House", type: "home", x: 1, y: 5,
    description: "a book-lined house with a comfortable porch.",
    tags: ["home", "private"] },
  { id: "loc_lena_home", name: "Lena's Flat", type: "home", x: 6, y: 4,
    description: "a bright flat with plants on every windowsill.",
    tags: ["home", "private"] },
  { id: "loc_nadia_home", name: "Nadia's House", type: "home", x: 7, y: 4,
    description: "a warm house with a chalkboard by the door.",
    tags: ["home", "private"] },
];
