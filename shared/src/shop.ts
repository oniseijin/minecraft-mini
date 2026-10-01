/**
 * BedWars island shop (DESIGN.md §3.3): the shared catalog behind the client's
 * shop panel and the server's purchase validation. Prices are an iron/gold/
 * emerald mix from the island and mid generators. V10 (M6.1) adds the bow +
 * its arrows — the charge constants below are consumed on BOTH sides (the
 * server clamps + simulates, the client ramps the hold-to-charge bar), so
 * they live here and nowhere else.
 */

import { GRAVITY } from './simulation';

export type CurrencyKind = 'iron' | 'gold' | 'emerald';

export const SWORD_TIERS = ['wooden', 'stone', 'iron'] as const;

export type SwordTier = (typeof SWORD_TIERS)[number];

export const SHOP_ITEM_IDS = [
  'wool',
  'planks',
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'golden_apple',
  'bow',
  'arrows',
] as const;

export type ShopItemId = (typeof SHOP_ITEM_IDS)[number];

export interface ShopItem {
  id: ShopItemId;
  name: string;
  description: string;
  currency: CurrencyKind;
  price: number;
  /**
   * Client-resolvable icon: `tile:<kenney tile basename>` (block tiles via the
   * atlas) or `item:<kenney items basename>` (client/assets/kenney/items/).
   */
  icon: string;
}

export const SHOP_ITEMS: readonly ShopItem[] = [
  {
    id: 'wool',
    name: 'Wool ×16',
    description: 'White bridge blocks',
    currency: 'iron',
    price: 4,
    icon: 'tile:snow',
  },
  {
    id: 'planks',
    name: 'Planks ×16',
    description: 'Sturdy bridge blocks',
    currency: 'iron',
    price: 4,
    icon: 'tile:wood',
  },
  {
    id: 'wooden_sword',
    name: 'Wooden Sword',
    description: '4 damage per hit',
    currency: 'iron',
    price: 10,
    icon: 'item:sword_bronze',
  },
  {
    id: 'stone_sword',
    name: 'Stone Sword',
    description: '6 damage per hit',
    currency: 'gold',
    price: 7,
    icon: 'item:sword_silver',
  },
  {
    id: 'iron_sword',
    name: 'Iron Sword',
    description: '8 damage per hit',
    currency: 'emerald',
    price: 4,
    icon: 'item:sword_iron',
  },
  {
    id: 'golden_apple',
    name: 'Golden Apple',
    description: 'Eat to heal 8 HP',
    currency: 'gold',
    price: 3,
    icon: 'item:apple',
  },
  {
    id: 'bow',
    name: 'Bow',
    description: 'Hold right-click to charge, release to fire',
    currency: 'gold',
    price: 12,
    icon: 'item:bow',
  },
  {
    id: 'arrows',
    name: 'Arrows ×6',
    description: 'Charged shots hit harder (no pickup)',
    currency: 'iron',
    price: 8,
    icon: 'item:arrow',
  },
];

/** Melee damage by held sword tier; everything else hits like a fist. */
export const SWORD_DAMAGE: Record<SwordTier, number> = { wooden: 4, stone: 6, iron: 8 };
export const FIST_DAMAGE = 2;

// --- bow (§3.3, protocol v10) ---------------------------------------------------

/**
 * The `bowShot` wire charge clamps: holding 0.2–1 s ramps the charge from
 * ARROW_MIN_CHARGE to 1.0 (a shorter tap still fires at the floor). The
 * server clamps any incoming value into this range; the client ramps its
 * charge bar across the same second.
 */
export const ARROW_MIN_CHARGE = 0.2;
export const ARROW_MAX_CHARGE = 1.0;
/** Full-charge hold time, seconds — the charge bar's full width. */
export const ARROW_CHARGE_SECONDS = 1.0;

/**
 * Arrow damage and launch speed are linear in the charge (§3.3: "0.2–1 s →
 * 8–24 dmg", speed ~18–36 m/s). The full 8–24 span assumes charge 0–1; the
 * enforced 0.2 floor keeps quick taps meaningful (≈11–24 after rounding).
 * Server-resolved (authoritative) — the client only renders the arc.
 */
export const ARROW_DAMAGE_BASE = 8;
export const ARROW_DAMAGE_SPAN = 16;
export const ARROW_SPEED_MIN = 18;
export const ARROW_SPEED_MAX = 36;

/** Arrow damage at a charge (int — hp is integer-ish for the hearts UI). */
export function arrowDamage(charge: number): number {
  return Math.round(ARROW_DAMAGE_BASE + ARROW_DAMAGE_SPAN * charge);
}

/** Launch speed (m/s) at a charge — rides `arrowLaunched.power`. */
export function arrowSpeed(charge: number): number {
  return ARROW_SPEED_MIN + (ARROW_SPEED_MAX - ARROW_SPEED_MIN) * charge;
}

/**
 * The ballistic arrow arc, shared verbatim by the server's per-tick hit
 * raycasts and the client's render: p(t) = from + dir·power·t − ½·GRAVITY·t².
 * Deterministic given (from, dir, power) + the shared GRAVITY (simulation.ts).
 */
export function arrowPosition(
  from: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  power: number,
  t: number,
): { x: number; y: number; z: number } {
  return {
    x: from.x + dir.x * power * t,
    y: from.y + dir.y * power * t - 0.5 * GRAVITY * t * t,
    z: from.z + dir.z * power * t,
  };
}

/** Damage for a claimed held item — `ownedSword` lets the server validate the claim. */
export function heldDamage(held: string, ownedSword: SwordTier | null): number {
  const tier = held === 'wooden_sword' ? 'wooden' : held === 'stone_sword' ? 'stone' : held === 'iron_sword' ? 'iron' : null;
  return tier !== null && ownedSword === tier ? SWORD_DAMAGE[tier] : FIST_DAMAGE;
}
