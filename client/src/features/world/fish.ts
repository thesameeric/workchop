// The fish in an aquarium: a freshwater community tank of fish from South America. The 3D model
// swims them around; clicking the tank shows what they are.

export interface FishSpecies {
  name: string;
  scientific: string;
  origin: string;
  fact: string;
  /** Its colour in the tank (and the dot next to its name). */
  color: string;
}

export const FISH: FishSpecies[] = [
  {
    name: 'Neon tetra',
    scientific: 'Paracheirodon innesi',
    origin: 'Streams of the Amazon basin',
    fact: 'Its blue stripe shimmers as it turns in the light, and goes pale at night while it rests.',
    color: '#3a86ff',
  },
  {
    name: 'Guppy',
    scientific: 'Poecilia reticulata',
    origin: 'North-eastern South America',
    fact: 'Guppies don’t lay eggs: they give birth to live young, often 20 or more at a time.',
    color: '#ff8c42',
  },
  {
    name: 'Freshwater angelfish',
    scientific: 'Pterophyllum scalare',
    origin: 'The Amazon basin',
    fact: 'Pairs lay their eggs on a leaf or a flat stone, and both parents guard them.',
    color: '#dfe3ea',
  },
  {
    name: 'Bronze corydoras',
    scientific: 'Corydoras aeneus',
    origin: 'Rivers of South America',
    fact: 'Now and then it darts up for a gulp of air: it can breathe through its gut.',
    color: '#b08d57',
  },
];
