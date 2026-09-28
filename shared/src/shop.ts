/**
 * BedWars island shop (DESIGN.md §3.3): the shared catalog behind the client's
 * shop panel and the server's purchase validation. Prices are an iron/gold/
 * emerald mix from the island and mid generators. The bow is intentionally
 * absent from v1 (stretch goal — add an entry here when it ships).
 */

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
];

/** Melee damage by held sword tier; everything else hits like a fist. */
export const SWORD_DAMAGE: Record<SwordTier, number> = { wooden: 4, stone: 6, iron: 8 };
export const FIST_DAMAGE = 2;

/** Damage for a claimed held item — `ownedSword` lets the server validate the claim. */
export function heldDamage(held: string, ownedSword: SwordTier | null): number {
  const tier = held === 'wooden_sword' ? 'wooden' : held === 'stone_sword' ? 'stone' : held === 'iron_sword' ? 'iron' : null;
  return tier !== null && ownedSword === tier ? SWORD_DAMAGE[tier] : FIST_DAMAGE;
}
