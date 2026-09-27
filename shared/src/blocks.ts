/**
 * Block registry — numeric ids shared by client and server.
 * `tiles` hold Kenney tile file basenames (client/assets/kenney/tiles/<name>.png);
 * the client resolves them to atlas UVs at runtime.
 */

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const WATER = 5;
export const LOG = 6;
export const LEAVES = 7;
export const PLANKS = 8;
export const COBBLE = 9;
export const GLASS = 10;
export const SNOW = 11;
export const BEDROCK = 12;
/** BedWars: team beds — unbreakable in the sandbox registry; the server's
 * bedwars edit path allows (and only allows) the ENEMY team to break them. */
export const BED_RED = 13;
export const BED_BLUE = 14;
/** BedWars: cheap white bridge block sold in the island shop. */
export const WOOL_WHITE = 15;
/** BedWars: unbreakable mid-island emerald generator marker block. */
export const EMERALD_GEN = 16;
/** Block Party (M5): the 8 dance-floor wool colors. Every id shares the
 * neutral `cotton_tan` tile; the visible color comes from the per-block
 * `tint` baked into vertex colors by the mesher (AO × tint). Reserved:
 * they must never enter the persistent sandbox overlay. */
export const WOOL_RED = 20;
export const WOOL_ORANGE = 21;
export const WOOL_YELLOW = 22;
export const WOOL_GREEN = 23;
export const WOOL_TEAL = 24;
export const WOOL_BLUE = 25;
export const WOOL_PURPLE = 26;
export const WOOL_PARTY_WHITE = 27;

export interface BlockTiles {
  top: string;
  side: string;
  bottom: string;
}

export interface BlockDef {
  id: number;
  name: string;
  tiles: BlockTiles;
  /** Fully occludes the neighbouring face (drives face culling and AO). */
  opaque: boolean;
  liquid?: boolean;
  unbreakable?: boolean;
  /** RGB multipliers (0–1) baked into vertex color by the mesher (AO × tint). */
  tint?: [number, number, number];
  /** Mode-reserved block (beds, generators, party floor): never placeable in
   * the sandbox and never client-editable during a match. */
  reserved?: boolean;
}

/** One Block Party dance-floor color: block id + human name (UI, also spoken
 * over chat for colorblind players) + the mesher/UI tint. */
export interface PartyColor {
  id: number;
  name: string;
  tint: [number, number, number];
}

/** The 8 floor colors, index = id − WOOL_RED (protocol: colorId is a block id). */
export const PARTY_COLORS: readonly PartyColor[] = [
  { id: WOOL_RED, name: 'Red', tint: [0.86, 0.18, 0.18] },
  { id: WOOL_ORANGE, name: 'Orange', tint: [0.95, 0.52, 0.12] },
  { id: WOOL_YELLOW, name: 'Yellow', tint: [0.95, 0.86, 0.16] },
  { id: WOOL_GREEN, name: 'Green', tint: [0.22, 0.72, 0.24] },
  { id: WOOL_TEAL, name: 'Teal', tint: [0.1, 0.68, 0.62] },
  { id: WOOL_BLUE, name: 'Blue', tint: [0.22, 0.42, 0.92] },
  { id: WOOL_PURPLE, name: 'Purple', tint: [0.58, 0.32, 0.88] },
  { id: WOOL_PARTY_WHITE, name: 'White', tint: [1.0, 1.0, 1.0] },
];

export const BLOCKS: BlockDef[] = [
  { id: AIR, name: 'air', tiles: { top: '', side: '', bottom: '' }, opaque: false },
  {
    id: GRASS,
    name: 'grass',
    tiles: { top: 'grass_top', side: 'dirt_grass', bottom: 'dirt' },
    opaque: true,
  },
  { id: DIRT, name: 'dirt', tiles: { top: 'dirt', side: 'dirt', bottom: 'dirt' }, opaque: true },
  { id: STONE, name: 'stone', tiles: { top: 'stone', side: 'stone', bottom: 'stone' }, opaque: true },
  { id: SAND, name: 'sand', tiles: { top: 'sand', side: 'sand', bottom: 'sand' }, opaque: true },
  {
    id: WATER,
    name: 'water',
    tiles: { top: 'water', side: 'water', bottom: 'water' },
    opaque: false,
    liquid: true,
  },
  {
    id: LOG,
    name: 'log',
    tiles: { top: 'trunk_top', side: 'trunk_side', bottom: 'trunk_bottom' },
    opaque: true,
  },
  {
    id: LEAVES,
    name: 'leaves',
    // Cutout: alpha-tested foliage (see through the gaps).
    tiles: {
      top: 'leaves_transparent',
      side: 'leaves_transparent',
      bottom: 'leaves_transparent',
    },
    opaque: false,
  },
  { id: PLANKS, name: 'planks', tiles: { top: 'wood', side: 'wood', bottom: 'wood' }, opaque: true },
  {
    id: COBBLE,
    name: 'cobblestone',
    tiles: { top: 'rock', side: 'rock', bottom: 'rock' },
    opaque: true,
  },
  { id: GLASS, name: 'glass', tiles: { top: 'glass', side: 'glass', bottom: 'glass' }, opaque: false },
  { id: SNOW, name: 'snow', tiles: { top: 'snow', side: 'snow', bottom: 'snow' }, opaque: true },
  {
    id: BEDROCK,
    name: 'bedrock',
    tiles: { top: 'stone_dirt', side: 'stone_dirt', bottom: 'stone_dirt' },
    opaque: true,
    unbreakable: true,
  },
  {
    id: BED_RED,
    name: 'red bed',
    tiles: { top: 'brick_red', side: 'brick_red', bottom: 'wood' },
    opaque: true,
    unbreakable: true,
    reserved: true,
  },
  {
    id: BED_BLUE,
    name: 'blue bed',
    tiles: { top: 'cotton_blue', side: 'cotton_blue', bottom: 'wood' },
    opaque: true,
    unbreakable: true,
    reserved: true,
  },
  { id: WOOL_WHITE, name: 'wool', tiles: { top: 'snow', side: 'snow', bottom: 'snow' }, opaque: true },
  {
    id: EMERALD_GEN,
    name: 'emerald generator',
    tiles: { top: 'redstone_emerald', side: 'redstone_emerald', bottom: 'stone' },
    opaque: true,
    unbreakable: true,
    reserved: true,
  },
  // NOTE: the party wools (ids 20–27) are registered right below — appended
  // index-aligned, never with a spread (see the invariant comment).
];

/**
 * Registry invariant: `BLOCKS[id]` is the def for block id `id`, so the list
 * above must stay index-aligned. Ids 17–19 are unused — fill them with inert
 * reserved placeholders so a malformed edit can never hit `undefined`.
 */
for (let gapId = EMERALD_GEN + 1; gapId < WOOL_RED; gapId++) {
  BLOCKS[gapId] = {
    id: gapId,
    name: 'reserved',
    tiles: { top: 'stone_dirt', side: 'stone_dirt', bottom: 'stone_dirt' },
    opaque: true,
    unbreakable: true,
    reserved: true,
  };
}
for (const color of PARTY_COLORS) {
  BLOCKS[color.id] = {
    id: color.id,
    name: `${color.name.toLowerCase()} wool`,
    tiles: { top: 'cotton_tan', side: 'cotton_tan', bottom: 'cotton_tan' },
    opaque: true,
    unbreakable: true,
    reserved: true,
    tint: color.tint,
  };
}

/** Blocks offered in the 9-slot hotbar (slot 1–9, left to right). */
export const HOTBAR_BLOCKS: number[] = [
  GRASS,
  DIRT,
  STONE,
  PLANKS,
  COBBLE,
  SAND,
  LOG,
  LEAVES,
  GLASS,
];
