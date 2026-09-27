/**
 * Runtime texture atlas: the Kenney tiles used by the M1 block registry are
 * stitched into one 512×512 canvas (4×4 grid of native 128px tiles) and
 * uploaded as a THREE.CanvasTexture (NearestFilter, no mipmaps, sRGB).
 */

import * as THREE from 'three';

import grassTopUrl from '../assets/kenney/tiles/grass_top.png';
import dirtGrassUrl from '../assets/kenney/tiles/dirt_grass.png';
import dirtUrl from '../assets/kenney/tiles/dirt.png';
import stoneUrl from '../assets/kenney/tiles/stone.png';
import sandUrl from '../assets/kenney/tiles/sand.png';
import waterUrl from '../assets/kenney/tiles/water.png';
import trunkSideUrl from '../assets/kenney/tiles/trunk_side.png';
import trunkTopUrl from '../assets/kenney/tiles/trunk_top.png';
import trunkBottomUrl from '../assets/kenney/tiles/trunk_bottom.png';
import leavesTransparentUrl from '../assets/kenney/tiles/leaves_transparent.png';
import woodUrl from '../assets/kenney/tiles/wood.png';
import rockUrl from '../assets/kenney/tiles/rock.png';
import glassUrl from '../assets/kenney/tiles/glass.png';
import snowUrl from '../assets/kenney/tiles/snow.png';
import stoneDirtUrl from '../assets/kenney/tiles/stone_dirt.png';

const TILE_FILES = {
  grass_top: grassTopUrl,
  dirt_grass: dirtGrassUrl,
  dirt: dirtUrl,
  stone: stoneUrl,
  sand: sandUrl,
  water: waterUrl,
  trunk_side: trunkSideUrl,
  trunk_top: trunkTopUrl,
  trunk_bottom: trunkBottomUrl,
  leaves_transparent: leavesTransparentUrl,
  wood: woodUrl,
  rock: rockUrl,
  glass: glassUrl,
  snow: snowUrl,
  stone_dirt: stoneDirtUrl,
} as const;

export type TileName = keyof typeof TILE_FILES;

const TILE_SIZE = 128;
const GRID = 4; // 15 tiles fit in a 4×4 grid
const ATLAS_SIZE = TILE_SIZE * GRID;
/** Half an atlas texel — guards against bleeding at tile seams. */
const UV_INSET = 0.5 / ATLAS_SIZE;

export interface UVRect {
  /** Lower-left corner of the tile in atlas UV space. */
  u0: number;
  v0: number;
  /** Upper-right corner of the tile in atlas UV space. */
  u1: number;
  v1: number;
}

export interface Atlas {
  texture: THREE.CanvasTexture;
  /** Atlas UV rect for a tile name (throws on unknown names). */
  uv(tile: string): UVRect;
}

const images = new Map<string, HTMLImageElement>();
const dataUrlCache = new Map<string, string>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[atlas] failed to load ${url}`));
    img.src = url;
  });
}

/** Loads all tile images and stitches them into the atlas texture. */
export async function loadAtlas(): Promise<Atlas> {
  const names = Object.keys(TILE_FILES) as TileName[];
  await Promise.all(
    names.map(async (name) => {
      images.set(name, await loadImage(TILE_FILES[name]));
    }),
  );

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[atlas] no 2d canvas context');
  ctx.imageSmoothingEnabled = false;
  names.forEach((name, i) => {
    ctx.drawImage(images.get(name)!, (i % GRID) * TILE_SIZE, Math.floor(i / GRID) * TILE_SIZE);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const index = new Map<string, number>(names.map((name, i) => [name, i] as const));
  return {
    texture,
    uv(tile: string): UVRect {
      const i = index.get(tile);
      if (i === undefined) throw new Error(`[atlas] unknown tile "${tile}"`);
      const col = i % GRID;
      const row = Math.floor(i / GRID);
      // flipY canvas texture: row 0 (top of the canvas) sits at v ≈ 1.
      return {
        u0: col / GRID + UV_INSET,
        u1: (col + 1) / GRID - UV_INSET,
        v0: 1 - (row + 1) / GRID + UV_INSET,
        v1: 1 - row / GRID - UV_INSET,
      };
    },
  };
}

/** Renders a loaded tile as a standalone PNG data URL (hotbar icons). */
export function tileDataUrl(tile: string): string {
  const cached = dataUrlCache.get(tile);
  if (cached) return cached;
  const img = images.get(tile);
  if (!img) throw new Error(`[atlas] tile "${tile}" not loaded — call loadAtlas() first`);
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[atlas] no 2d canvas context');
  ctx.drawImage(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  dataUrlCache.set(tile, url);
  return url;
}
