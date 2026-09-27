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
}

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
  },
  {
    id: BED_BLUE,
    name: 'blue bed',
    tiles: { top: 'cotton_blue', side: 'cotton_blue', bottom: 'wood' },
    opaque: true,
    unbreakable: true,
  },
  { id: WOOL_WHITE, name: 'wool', tiles: { top: 'snow', side: 'snow', bottom: 'snow' }, opaque: true },
  {
    id: EMERALD_GEN,
    name: 'emerald generator',
    tiles: { top: 'redstone_emerald', side: 'redstone_emerald', bottom: 'stone' },
    opaque: true,
    unbreakable: true,
  },
];

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
