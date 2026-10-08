// What a plant in the office is, for the card that opens when someone clicks it. Pet toxicity follows
// the ASPCA's plant list where it covers the species; the "air" notes keep NASA's 1989 Clean Air Study
// in proportion (it measured sealed chambers; in real rooms, ventilation matters far more).

export type LightNeed = 'low' | 'medium' | 'bright' | 'sun';
export type Difficulty = 'easy' | 'moderate' | 'fussy';

export interface PlantSpecies {
  /** The catalog item type. */
  type: string;
  name: string;
  scientific: string;
  origin: string;
  light: string;
  lightLevel: LightNeed;
  water: string;
  humidity: string;
  difficulty: Difficulty;
  petSafe: boolean;
  pets: string;
  air: string;
  fact: string;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', moderate: 'Some care', fussy: 'Fussy' };

export const PLANTS: PlantSpecies[] = [
  {
    type: 'plant',
    name: 'Boston fern',
    scientific: "Nephrolepis exaltata 'Bostoniensis'",
    origin: 'Tropical Americas, from Florida to Brazil',
    light: 'Bright, indirect light',
    lightLevel: 'bright',
    water: 'Keep the soil evenly moist',
    humidity: 'High: group it with other plants',
    difficulty: 'moderate',
    petSafe: true,
    pets: 'Non-toxic to cats and dogs (ASPCA).',
    air: 'Often called air-cleaning after lab-chamber tests; an open window does far more.',
    fact: "The 'Boston' form turned up by chance in 1894, in a shipment of sword ferns sent to Boston. It's grown from runners, not spores, so today's plants descend from that find.",
  },
  {
    type: 'tall-plant',
    name: 'Weeping fig',
    scientific: 'Ficus benjamina',
    origin: 'South and Southeast Asia to northern Australia',
    light: 'Bright, indirect light',
    lightLevel: 'bright',
    water: 'When the top 2–3 cm of soil is dry',
    humidity: 'Average to high',
    difficulty: 'fussy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: its sap irritates the mouth, gut and skin (ASPCA).',
    air: "Tested in NASA's 1989 Clean Air Study, in sealed chambers. Offices still need ventilation.",
    fact: "It's the official tree of Bangkok, and it drops leaves in protest when you move it.",
  },
  {
    type: 'monstera',
    name: 'Monstera',
    scientific: 'Monstera deliciosa',
    origin: 'Rainforests of southern Mexico to Panama',
    light: 'Bright, indirect light',
    lightLevel: 'bright',
    water: 'When the top 5 cm of soil is dry',
    humidity: 'Likes it humid (50%+)',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: calcium oxalate crystals (ASPCA, as split-leaf philodendron).',
    air: "Not in NASA's Clean Air Study; like any plant, it barely changes a room's air.",
    fact: "'Deliciosa' is for its fruit, which tastes of pineapple and banana when fully ripe. Unripe, it stings.",
  },
  {
    type: 'snake-plant',
    name: 'Snake plant',
    scientific: 'Dracaena trifasciata',
    origin: 'Tropical West Africa, from Nigeria to Congo',
    light: 'Low to bright, indirect light',
    lightLevel: 'low',
    water: 'Every 2–4 weeks; let the soil dry out',
    humidity: 'Fine in dry air',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: saponins upset the stomach (ASPCA).',
    air: "Tested in NASA's 1989 Clean Air Study. You'd need a jungle of them to match an open window.",
    fact: 'It opens its pores at night to take in CO₂, which saves water. Botanists recently moved it from Sansevieria into Dracaena.',
  },
  {
    type: 'fiddle-leaf',
    name: 'Fiddle-leaf fig',
    scientific: 'Ficus lyrata',
    origin: 'Lowland rainforests of western Africa',
    light: 'Bright light, some gentle sun',
    lightLevel: 'bright',
    water: 'When the top 2–3 cm of soil is dry',
    humidity: 'Average (40–60%)',
    difficulty: 'fussy',
    petSafe: false,
    pets: 'Mildly toxic to cats and dogs: irritating milky sap (ASPCA).',
    air: "Not in NASA's Clean Air Study. Its big leaves mostly collect dust: wipe them now and then.",
    fact: "'Lyrata' means lyre-shaped. It sulks at change: move it or put it in a draught and it may drop leaves.",
  },
  {
    type: 'pothos',
    name: 'Golden pothos',
    scientific: 'Epipremnum aureum',
    origin: "Mo'orea, in French Polynesia",
    light: 'Low to bright, indirect light',
    lightLevel: 'medium',
    water: 'When the top half of the soil is dry',
    humidity: 'Average',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: calcium oxalate crystals (ASPCA).',
    air: "Tested in NASA's 1989 Clean Air Study, in sealed chambers. Offices still need ventilation.",
    fact: "Nicknamed devil's ivy because it's so hard to kill. Climbing trees in the wild, its leaves can grow a metre long.",
  },
  {
    type: 'peace-lily',
    name: 'Peace lily',
    scientific: 'Spathiphyllum wallisii',
    origin: 'Rainforests of Colombia and Venezuela',
    light: 'Low to medium, indirect light',
    lightLevel: 'low',
    water: 'Keep it lightly moist; it droops when thirsty',
    humidity: 'Likes it humid',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: irritates the mouth (ASPCA). Not a true lily.',
    air: "A star of NASA's 1989 Clean Air Study, which tested sealed chambers, not offices.",
    fact: "Its white 'flower' is really a leaf, a spathe, wrapped around the tiny true flowers on the spike.",
  },
  {
    type: 'zz-plant',
    name: 'ZZ plant',
    scientific: 'Zamioculcas zamiifolia',
    origin: 'Eastern Africa, from Kenya to South Africa',
    light: 'Low to bright, indirect light',
    lightLevel: 'low',
    water: 'Every 2–3 weeks; let it dry out fully',
    humidity: 'Fine in dry air',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Mildly toxic: calcium oxalate crystals irritate the mouth if chewed.',
    air: "Not in NASA's Clean Air Study; it's here for its looks and toughness.",
    fact: 'It stores water in potato-like rhizomes, so it shrugs off a month of neglect. A single fallen leaflet can root into a new plant.',
  },
  {
    type: 'cactus',
    name: 'Golden barrel cactus',
    scientific: 'Echinocactus grusonii',
    origin: 'Central Mexico (Querétaro and Hidalgo)',
    light: 'Full sun: the brightest window',
    lightLevel: 'sun',
    water: 'Every 2–4 weeks in summer, hardly at all in winter',
    humidity: 'Dry air',
    difficulty: 'easy',
    petSafe: true,
    pets: 'Not known to be toxic, but the spines hurt curious pets.',
    air: "Not in NASA's Clean Air Study.",
    fact: "Nurseries grow it by the million, yet it's endangered in the wild: a dam flooded much of its home valley in the 1990s.",
  },
  {
    type: 'bonsai',
    name: 'Ficus bonsai',
    scientific: 'Ficus microcarpa',
    origin: 'Southern China and South Asia to northern Australia',
    light: 'Bright light, some direct sun',
    lightLevel: 'bright',
    water: 'When the surface feels dry; never let it dry out',
    humidity: 'Medium to high',
    difficulty: 'moderate',
    petSafe: false,
    pets: 'Toxic to cats and dogs: irritating sap, like other figs.',
    air: "Too small to matter for the air, and not in NASA's study.",
    fact: "'Bonsai' means 'tray planting' in Japanese. The art grew out of Chinese penjing more than a thousand years ago.",
  },
  {
    type: 'bird-of-paradise',
    name: 'Bird of paradise',
    scientific: 'Strelitzia reginae',
    origin: 'Eastern Cape and KwaZulu-Natal, South Africa',
    light: 'Bright light with a few hours of sun',
    lightLevel: 'sun',
    water: 'When the top 5 cm of soil is dry',
    humidity: 'Average to high',
    difficulty: 'moderate',
    petSafe: false,
    pets: 'Mildly toxic to cats and dogs: nausea and vomiting, mostly from seeds and fruit (ASPCA).',
    air: "Not in NASA's Clean Air Study.",
    fact: "A sunbird landing on its blue 'perch' opens the flower and gets pollen on its feet. It's the official flower of Los Angeles.",
  },
  {
    type: 'rubber-plant',
    name: 'Rubber plant',
    scientific: 'Ficus elastica',
    origin: 'Eastern Himalayas to Indonesia',
    light: 'Bright, indirect light',
    lightLevel: 'bright',
    water: 'When the top 2–3 cm of soil is dry',
    humidity: 'Average',
    difficulty: 'easy',
    petSafe: false,
    pets: 'Toxic to cats and dogs: the milky latex irritates the mouth, gut and skin.',
    air: "Not in NASA's 1989 Clean Air Study; dust its glossy leaves to keep them shining.",
    fact: 'In Meghalaya, India, people guide its roots across rivers to grow living bridges that last for centuries.',
  },
  {
    type: 'lavender',
    name: 'Lavender',
    scientific: 'Lavandula angustifolia',
    origin: 'Mountains of the western Mediterranean',
    light: 'Full sun, 6 hours or more',
    lightLevel: 'sun',
    water: 'Sparingly; let the soil dry between waterings',
    humidity: 'Dry air',
    difficulty: 'moderate',
    petSafe: false,
    pets: 'Toxic to cats and dogs: linalool can cause nausea and vomiting (ASPCA).',
    air: "Not in NASA's Clean Air Study; the scent is the point.",
    fact: "Despite the name 'English lavender', it comes from the Mediterranean. Bees can't resist it.",
  },
];

const byType = new Map(PLANTS.map((p) => [p.type, p]));

export function plantSpecies(type: string): PlantSpecies | undefined {
  return byType.get(type);
}
