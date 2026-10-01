/**
 * Protocol differential check (REFACTORING.md Phase 1c) — the safety net for
 * the Phase 2c table-driven rewrite of the wire-protocol parsers in
 * shared/src/protocol.ts (~690 lines of extract→null-check boilerplate → ~200).
 *
 * It feeds a fixed corpus of wire frames (valid / malformed / absent-field
 * variants) through TWO builds of the parsers and fails on ANY behavioral
 * difference:
 *
 *   - "old": shared/src extracted from a git ref via `git archive`
 *     (default: HEAD at invocation; override with --baseline <ref>)
 *   - "new": the working tree's shared/src
 *
 * Comparison is a canonical serializer that distinguishes `{a: undefined}`
 * from `{}` (and -0/NaN from 0/0-as-string), so a rewrite cannot silently
 * change undefined-vs-absent key semantics. Selected cases additionally PIN
 * the documented tolerance quirks themselves (they must survive the rewrite
 * verbatim, not merely stay old==new):
 *
 *   - absent party payload `bomb` → null (and explicit `bomb: null` → null)
 *   - absent `mobs` `dayT` → dayT key omitted (and explicit null → rejected)
 *   - `death.killerId` string/absent/fractional → silently coerced to null
 *   - absent `startGame.mode` → 'bedwars'; `party.boxes/items/effects`
 *     absent → []/{}/[]; `bot` flag only survives as exactly `true`;
 *     `inventory.sword` absent → rejected; `matchEnd` stats emit BOTH
 *     rounds/falls keys (the absent one as explicit undefined) when either
 *     is present; `party.items` accepts an array as {}; digit-key
 *     normalization ("01" → 1); `roundResult.survivorId` accepts explicit
 *     null (the draw path party.ts sends — fixed 2026-09-29; absent/string
 *     still reject); v9 murder quirks (§3.6): absent `murder` payload →
 *     key omitted (explicit null rejects, like party), `guests` required,
 *     counter maps (coins/charges/jammedUntil/detector) absent → {},
 *     count values are ints; `zapGuest`/`investigateGravestone` ids/coords
 *     are ints; v10 bow quirks (§3.3): `bowShot.charge` accepts any finite
 *     number (the 0.2–1.0 clamp is server policy), inventory `bow`/`arrows`
 *     keys are OMITTED on v9-shaped payloads (present-garbage rejects), …
 *     (see corpus comments)
 *
 * MUST STAY GREEN through the Phase 2c rewrite: any FAIL means the rewrite
 * changed observable parse behavior (or the protocol consciously changed —
 * then update parsers AND corpus together, human-reviewed).
 *
 * Baseline caveat: once the rewrite is COMMITTED, HEAD no longer holds the
 * old parsers — pin the pre-rewrite ref explicitly: --baseline <pre-rewrite-sha>.
 * The baseline ref must be a protocol-v8-era tree (dayT exists).
 *
 * Frames are fed already-JSON-decoded (the parse*Message contract); raw
 * non-JSON values (NaN, Infinity, undefined) are included on purpose to pin
 * the rejection paths JSON cannot reach. Pure Node + esbuild (already in
 * node_modules via tsx): no server, no browser, no ports — never touches
 :6881 or client/dist.
 *
 * Usage:  npx tsx tools/check-protocol.ts [--baseline <git-ref>]
 * Exit:   0 = old and new parsers behaviorally identical, 1 = difference or
 *         tool failure.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

// --- CLI ---------------------------------------------------------------------

function parseArgs(): { baseline: string } {
  const argv = process.argv.slice(2);
  let baseline = 'HEAD';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error('[check-protocol] --baseline requires a git ref argument');
        process.exit(1);
      }
      baseline = value;
      i += 1;
    } else {
      console.error(`[check-protocol] unknown argument: ${argv[i]} (usage: npx tsx tools/check-protocol.ts [--baseline <git-ref>])`);
      process.exit(1);
    }
  }
  return { baseline };
}

// --- canonical serializer (undefined-vs-absent aware deep equal) --------------

/**
 * Total canonical form of a parsed result. Object keys with an `undefined`
 * value are emitted as `key:undefined` while absent keys are omitted —
 * `JSON.stringify` cannot make this distinction, and the parsers DO
 * (e.g. `mobs` omits `dayT` when absent, `matchEnd` stats emit
 * `falls: undefined`). Also distinguishes -0 and NaN.
 */
function canon(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '(-0)';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return String(value);
}

// --- corpus ------------------------------------------------------------------

type Frame = Record<string, unknown>;
/** Quirk/shape assertion run against BOTH parses; null = satisfied. */
type Expect = (out: unknown) => string | null;

interface Case {
  name: string;
  /** Already-JSON-decoded frame fed verbatim to the parse entry point. */
  frame: unknown;
  /** Both parsers must return null for this frame. */
  expectNull?: boolean;
  /** Explicit assertion (pinned quirk or shape) run on both parse results. */
  expect?: Expect;
}

interface Group {
  title: string;
  entry: 'client' | 'server';
  cases: Case[];
}

// Valid baseline frames, mutated per case.
const snap = (over: Frame = {}): Frame => ({ id: 1, name: 'A', x: 0, y: 1.5, z: -2, yaw: 3.14, pitch: 0, ...over });
const mob = (over: Frame = {}): Frame => ({ id: 1, kind: 'fox', x: 1.5, y: 64, z: -3, yaw: 0.1, hp: 6, ...over });
const matchPlayer = (over: Frame = {}): Frame => ({
  id: 1,
  name: 'A',
  team: 0,
  hp: 20,
  alive: true,
  respawnIn: 0,
  kills: 0,
  currency: { iron: 0, gold: 0, emerald: 0 },
  inventory: { wool: 0, planks: 0, apples: 0, sword: null },
  ...over,
});
const party = (over: Frame = {}): Frame => ({
  round: 2,
  colorId: 21,
  colorName: 'Teal',
  roundTimerMs: 8000,
  roundEndsAt: 1234567890,
  scores: [],
  bomb: null,
  boxes: [],
  items: {},
  effects: [],
  ...over,
});
const murderGuest = (over: Frame = {}): Frame => ({ id: 11, name: 'Red Guest', color: 'red', alive: true, ...over });
const murder = (over: Frame = {}): Frame => ({
  guests: [murderGuest()],
  coinItems: [{ id: 1, x: 20.5, y: 31, z: 20.5, tier: 'gold' }],
  coins: { 1: 4 },
  charges: { 1: 1 },
  jammedUntil: {},
  detector: { 1: false },
  ...over,
});
const ge = (over: Frame = {}): Frame => ({ type: 'gameEvent', ...over });

// Small assertion helpers for the quirk closures.
const asObj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const hasKey = (v: unknown, key: string): boolean => key in asObj(v);
const at = (v: unknown, i: number): unknown => (Array.isArray(v) ? v[i] : undefined);
const isNull = (problem: string): Expect => (out) => (out === null ? null : problem);
const notNull = (problem: string): Expect => (out) => (out !== null ? null : problem);

const CORPUS: Group[] = [
  // === client → server ========================================================
  {
    title: 'client / hello',
    entry: 'client',
    cases: [
      { name: 'canonical', frame: { type: 'hello', name: 'Alice' } },
      {
        name: 'unknown input fields are dropped (reconstructed object)',
        frame: { type: 'hello', name: 'a', junk: 1, nested: { x: 1 } },
        expect: (out) => {
          const o = asObj(out);
          return Object.keys(o).length === 2 && o.type === 'hello' && o.name === 'a'
            ? null
            : `expected exactly {type,name}, got ${canon(out)}`;
        },
      },
      { name: 'name as number rejected', frame: { type: 'hello', name: 123 }, expectNull: true },
      { name: 'name absent rejected', frame: { type: 'hello' }, expectNull: true },
      { name: 'name null rejected', frame: { type: 'hello', name: null }, expectNull: true },
    ],
  },
  {
    title: 'client / move',
    entry: 'client',
    cases: [
      { name: 'canonical (floats, negatives)', frame: { type: 'move', x: -1.5, y: 64.25, z: 200, yaw: Math.PI, pitch: -0.1 } },
      { name: 'huge finite number accepted', frame: { type: 'move', x: 1e308, y: 0, z: 0, yaw: 0, pitch: 0 }, expect: (out) => (asObj(out).x === 1e308 ? null : `x should pass through, got ${canon(asObj(out).x)}`) },
      { name: 'Infinity rejected (not finite)', frame: { type: 'move', x: Infinity, y: 0, z: 0, yaw: 0, pitch: 0 }, expectNull: true },
      { name: 'NaN rejected (direct feed; JSON cannot produce it)', frame: { type: 'move', x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }, expectNull: true },
      { name: 'string coordinate rejected (no coercion)', frame: { type: 'move', x: '1', y: 0, z: 0, yaw: 0, pitch: 0 }, expectNull: true },
      { name: 'missing pitch rejected', frame: { type: 'move', x: 0, y: 0, z: 0, yaw: 0 }, expectNull: true },
      { name: '-0 preserved', frame: { type: 'move', x: -0, y: 0, z: 0, yaw: 0, pitch: 0 }, expect: (out) => (Object.is(asObj(out).x, -0) ? null : 'x should stay -0') },
    ],
  },
  {
    title: 'client / blockEdit',
    entry: 'client',
    cases: [
      { name: 'canonical (negative coords)', frame: { type: 'blockEdit', x: -3, y: 0, z: 12, id: 5 } },
      { name: 'fractional coordinate rejected (int required)', frame: { type: 'blockEdit', x: 1.5, y: 0, z: 0, id: 5 }, expectNull: true },
      { name: 'string id rejected', frame: { type: 'blockEdit', x: 0, y: 0, z: 0, id: '5' }, expectNull: true },
      { name: 'huge integer 2^53 accepted (no range check at parse level)', frame: { type: 'blockEdit', x: 0, y: 0, z: 0, id: 9007199254740992 }, expect: (out) => (asObj(out).id === 9007199254740992 ? null : 'id should pass through') },
      { name: 'missing id rejected', frame: { type: 'blockEdit', x: 0, y: 0, z: 0 }, expectNull: true },
    ],
  },
  {
    title: 'client / chat',
    entry: 'client',
    cases: [
      { name: 'canonical', frame: { type: 'chat', text: 'hello world' } },
      { name: 'text as number rejected', frame: { type: 'chat', text: 42 }, expectNull: true },
      { name: 'text absent rejected', frame: { type: 'chat' }, expectNull: true },
    ],
  },
  {
    title: 'client / startGame (mode default quirk)',
    entry: 'client',
    cases: [
      { name: 'mode bedwars', frame: { type: 'startGame', mode: 'bedwars' } },
      { name: 'mode party', frame: { type: 'startGame', mode: 'party' } },
      { name: "mode 'murder' accepted (v9, §3.6)", frame: { type: 'startGame', mode: 'murder' } },
      { name: 'QUIRK: absent mode defaults to bedwars (v2-client tolerance)', frame: { type: 'startGame' }, expect: (out) => (asObj(out).mode === 'bedwars' ? null : `expected mode 'bedwars', got ${canon(asObj(out).mode)}`) },
      { name: 'explicit mode null rejected (default only for absent)', frame: { type: 'startGame', mode: null }, expectNull: true },
      { name: "mode 'sandbox' rejected (startGame cannot start sandbox)", frame: { type: 'startGame', mode: 'sandbox' }, expectNull: true },
      { name: "mode 'Party' rejected (no case folding)", frame: { type: 'startGame', mode: 'Party' }, expectNull: true },
    ],
  },
  {
    title: 'client / no-payload frames (ready, leaveGame, useHeld, addBot, removeBot)',
    entry: 'client',
    cases: [
      { name: 'ready parses to exactly {type}', frame: { type: 'ready' }, expect: (out) => (Object.keys(asObj(out)).length === 1 && asObj(out).type === 'ready' ? null : `expected bare {type:'ready'}, got ${canon(out)}`) },
      { name: 'ready ignores arbitrary junk fields', frame: { type: 'ready', x: 1, text: null, mode: 'party' }, expect: (out) => (Object.keys(asObj(out)).length === 1 ? null : `junk must be dropped, got ${canon(out)}`) },
      { name: 'leaveGame ignores junk', frame: { type: 'leaveGame', junk: [1, 2] }, expect: notNull('leaveGame should parse') },
      { name: 'useHeld ignores junk', frame: { type: 'useHeld', slot: 99 }, expect: notNull('useHeld should parse') },
      { name: 'addBot ignores junk', frame: { type: 'addBot', kind: 'zombie' }, expect: notNull('addBot should parse') },
      { name: 'removeBot canonical', frame: { type: 'removeBot' } },
    ],
  },
  {
    title: 'client / attack',
    entry: 'client',
    cases: [
      { name: 'canonical fist', frame: { type: 'attack', id: 2, held: 'fist' } },
      { name: 'held golden_apple (shop item)', frame: { type: 'attack', id: 2, held: 'golden_apple' } },
      { name: 'held wooden_sword', frame: { type: 'attack', id: 2, held: 'wooden_sword' } },
      { name: "v10: held 'bow' accepted (a bow-selected punch reports the claim; server pays fist damage)", frame: { type: 'attack', id: 2, held: 'bow' } },
      { name: "held 'diamond_sword' rejected (not a shop item id)", frame: { type: 'attack', id: 2, held: 'diamond_sword' }, expectNull: true },
      { name: "held 'Fist' rejected (exact-match union)", frame: { type: 'attack', id: 2, held: 'Fist' }, expectNull: true },
      { name: 'fractional id rejected', frame: { type: 'attack', id: 1.5, held: 'fist' }, expectNull: true },
    ],
  },
  {
    title: 'client / attackMob',
    entry: 'client',
    cases: [
      { name: 'canonical', frame: { type: 'attackMob', id: 3 } },
      { name: 'fractional id rejected', frame: { type: 'attackMob', id: 3.5 }, expectNull: true },
      { name: 'id absent rejected', frame: { type: 'attackMob' }, expectNull: true },
    ],
  },
  {
    title: 'client / useItem (slot permissiveness quirk)',
    entry: 'client',
    cases: [
      { name: 'slot 0', frame: { type: 'useItem', slot: 0 } },
      { name: 'slot 2', frame: { type: 'useItem', slot: 2 } },
      { name: 'QUIRK: slot 99 accepted (0–2 range is server policy, not parse)', frame: { type: 'useItem', slot: 99 }, expect: (out) => (asObj(out).slot === 99 ? null : 'slot should pass through') },
      { name: 'QUIRK: negative slot accepted at parse level', frame: { type: 'useItem', slot: -1 }, expect: (out) => (asObj(out).slot === -1 ? null : 'slot should pass through') },
      { name: 'fractional slot rejected', frame: { type: 'useItem', slot: 0.5 }, expectNull: true },
    ],
  },
  {
    title: 'client / zapCell',
    entry: 'client',
    cases: [
      { name: 'canonical (negative z)', frame: { type: 'zapCell', x: 10, z: -4 } },
      { name: 'fractional x rejected', frame: { type: 'zapCell', x: 1.5, z: 4 }, expectNull: true },
      { name: 'missing z rejected', frame: { type: 'zapCell', x: 10 }, expectNull: true },
    ],
  },
  {
    title: 'client / zapGuest, investigateGravestone (v9 murder, §3.6)',
    entry: 'client',
    cases: [
      { name: 'zapGuest canonical', frame: { type: 'zapGuest', id: 11 } },
      { name: 'zapGuest fractional id rejected', frame: { type: 'zapGuest', id: 11.5 }, expectNull: true },
      { name: "zapGuest string id rejected (no coercion)", frame: { type: 'zapGuest', id: '11' }, expectNull: true },
      { name: 'investigateGravestone canonical (negative z)', frame: { type: 'investigateGravestone', x: 10, z: -4 } },
      { name: 'investigateGravestone fractional x rejected', frame: { type: 'investigateGravestone', x: 1.5, z: 4 }, expectNull: true },
      { name: 'investigateGravestone missing z rejected', frame: { type: 'investigateGravestone', x: 10 }, expectNull: true },
    ],
  },
  {
    title: 'client / bowShot (v10 BedWars bow, §3.3)',
    entry: 'client',
    cases: [
      { name: 'v10: canonical full charge', frame: { type: 'bowShot', charge: 1 } },
      { name: 'v10: canonical minimum charge (0.2 floor)', frame: { type: 'bowShot', charge: 0.2 } },
      { name: 'v10: fractional mid-charge', frame: { type: 'bowShot', charge: 0.63 } },
      { name: 'v10: QUIRK: out-of-range values accepted at parse (0.2–1.0 clamp is SERVER policy)', frame: { type: 'bowShot', charge: 5 }, expect: (out) => (asObj(out).charge === 5 ? null : 'charge should pass through') },
      { name: 'v10: QUIRK: negative charge accepted at parse (server clamps)', frame: { type: 'bowShot', charge: -1 }, expect: (out) => (asObj(out).charge === -1 ? null : 'charge should pass through') },
      { name: 'v10: charge absent rejected', frame: { type: 'bowShot' }, expectNull: true },
      { name: 'v10: charge as string rejected', frame: { type: 'bowShot', charge: '1' }, expectNull: true },
      { name: 'v10: charge NaN rejected (direct feed)', frame: { type: 'bowShot', charge: NaN }, expectNull: true },
      { name: 'v10: charge Infinity rejected (not finite)', frame: { type: 'bowShot', charge: Infinity }, expectNull: true },
      { name: 'v10: junk fields dropped (reconstructed object)', frame: { type: 'bowShot', charge: 0.5, aim: { x: 1 } }, expect: (out) => (Object.keys(asObj(out)).sort().join(',') === 'charge,type' ? null : `expected exactly {type,charge}, got ${canon(out)}`) },
    ],
  },
  {
    title: 'client / buy',
    entry: 'client',
    cases: [
      { name: 'wool canonical', frame: { type: 'buy', item: 'wool' } },
      { name: 'iron_sword', frame: { type: 'buy', item: 'iron_sword' } },
      { name: "v10: shop item 'bow' accepted", frame: { type: 'buy', item: 'bow' } },
      { name: "v10: shop item 'arrows' accepted", frame: { type: 'buy', item: 'arrows' } },
      { name: "party item 'leap' rejected (shop ids only)", frame: { type: 'buy', item: 'leap' }, expectNull: true },
      { name: 'numeric item rejected', frame: { type: 'buy', item: 5 }, expectNull: true },
    ],
  },
  {
    title: 'client / frame shape (non-objects, unknown types, cross-entry)',
    entry: 'client',
    cases: [
      { name: 'unknown type rejected', frame: { type: 'warp' }, expectNull: true },
      { name: 'object without type rejected', frame: {}, expectNull: true },
      { name: 'array frame rejected', frame: [1, 2, 3], expectNull: true },
      { name: 'null frame rejected', frame: null, expectNull: true },
      { name: 'number frame rejected', frame: 42, expectNull: true },
      { name: 'string frame rejected', frame: 'hello', expectNull: true },
      { name: 'boolean frame rejected', frame: true, expectNull: true },
      { name: "server-only type 'players' rejected by client parser", frame: { type: 'players', players: [] }, expectNull: true },
      { name: "server-only type 'gameEvent' rejected by client parser", frame: ge({ kind: 'error', message: 'x' }), expectNull: true },
    ],
  },

  // === server → client ========================================================
  {
    title: 'server / welcome',
    entry: 'server',
    cases: [
      { name: 'canonical (edit quad + bot snapshot)', frame: { type: 'welcome', playerId: 1, name: 'Alice', seed: 1337, edits: [[0, 64, 0, 5]], players: [snap({ id: 2, name: 'Bot', bot: true })] } },
      { name: 'empty edits/players arrays accepted', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [], players: [] } },
      { name: 'edit tuple length 3 rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [[1, 2, 3]], players: [] }, expectNull: true },
      { name: 'edit tuple length 5 rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [[1, 2, 3, 4, 5]], players: [] }, expectNull: true },
      { name: 'fractional edit coord rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [[1.5, 0, 0, 1]], players: [] }, expectNull: true },
      { name: 'string edit id rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [[1, 2, 3, '4']], players: [] }, expectNull: true },
      { name: 'snapshot missing pitch rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1, edits: [], players: [{ id: 2, name: 'B', x: 0, y: 0, z: 0, yaw: 0 }] }, expectNull: true },
      { name: 'fractional seed rejected', frame: { type: 'welcome', playerId: 1, name: 'A', seed: 1337.5, edits: [], players: [] }, expectNull: true },
      { name: 'string playerId rejected', frame: { type: 'welcome', playerId: '1', name: 'A', seed: 1, edits: [], players: [] }, expectNull: true },
    ],
  },
  {
    title: 'server / players (bot-flag quirk)',
    entry: 'server',
    cases: [
      { name: 'canonical', frame: { type: 'players', players: [snap()] } },
      { name: 'QUIRK: bot:true survives as bot:true', frame: { type: 'players', players: [snap({ bot: true })] }, expect: (out) => (asObj(at(asObj(out).players, 0)).bot === true ? null : `expected bot:true, got ${canon(asObj(at(asObj(out).players, 0)).bot)}`) },
      { name: 'QUIRK: bot:false OMITS the key (not false)', frame: { type: 'players', players: [snap({ bot: false })] }, expect: (out) => (!hasKey(at(asObj(out).players, 0), 'bot') ? null : `bot:false must drop the key, got ${canon(at(asObj(out).players, 0))}`) },
      { name: 'QUIRK: bot:"yes" tolerated (key omitted)', frame: { type: 'players', players: [snap({ bot: 'yes' })] }, expect: (out) => (!hasKey(at(asObj(out).players, 0), 'bot') ? null : 'bot:"yes" must drop the key') },
      { name: 'bot absent → key omitted', frame: { type: 'players', players: [snap()] }, expect: (out) => (!hasKey(at(asObj(out).players, 0), 'bot') ? null : 'no bot key expected') },
      {
        name: 'unknown snapshot fields dropped',
        frame: { type: 'players', players: [{ ...snap(), skin: 'creeper' }] },
        expect: (out) => {
          const p = asObj(at(asObj(out).players, 0));
          const keys = Object.keys(p).sort().join(',');
          return keys === 'id,name,pitch,x,y,yaw,z' ? null : `expected exact snapshot keys, got ${keys}`;
        },
      },
      { name: 'players as string rejected', frame: { type: 'players', players: 'A,B' }, expectNull: true },
      { name: 'null roster entry rejected', frame: { type: 'players', players: [null] }, expectNull: true },
    ],
  },
  {
    title: 'server / blockEdits',
    entry: 'server',
    cases: [
      { name: 'empty array', frame: { type: 'blockEdits', edits: [] } },
      { name: 'canonical quad', frame: { type: 'blockEdits', edits: [[0, 0, 0, 0]] } },
      { name: 'string coord rejected', frame: { type: 'blockEdits', edits: [['0', 0, 0, 0]] }, expectNull: true },
    ],
  },
  {
    title: 'server / chat',
    entry: 'server',
    cases: [
      { name: 'canonical', frame: { type: 'chat', from: 'A', text: 'hi' } },
      { name: 'from absent rejected', frame: { type: 'chat', text: 'hi' }, expectNull: true },
      { name: 'from as number rejected', frame: { type: 'chat', from: 42, text: 'hi' }, expectNull: true },
    ],
  },
  {
    title: 'server / left',
    entry: 'server',
    cases: [
      { name: 'canonical', frame: { type: 'left', id: 5 } },
      { name: 'fractional id rejected', frame: { type: 'left', id: 5.5 }, expectNull: true },
    ],
  },
  {
    title: 'server / mobs (dayT quirk)',
    entry: 'server',
    cases: [
      { name: 'canonical (v7 payload: no dayT)', frame: { type: 'mobs', mobs: [mob()] } },
      { name: 'v8 zombie kind accepted', frame: { type: 'mobs', mobs: [mob({ kind: 'zombie', hp: 10 })] } },
      { name: "v9 guest kind accepted (murder guests ride the stream, §3.6)", frame: { type: 'mobs', mobs: [mob({ kind: 'guest', hp: 2 })] } },
      { name: 'QUIRK: dayT absent → dayT key OMITTED (not undefined)', frame: { type: 'mobs', mobs: [mob()] }, expect: (out) => (!hasKey(out, 'dayT') ? null : `dayT must be omitted, got ${canon(asObj(out).dayT)}`) },
      { name: 'QUIRK: dayT present → key present', frame: { type: 'mobs', mobs: [mob()], dayT: 0.5 }, expect: (out) => (asObj(out).dayT === 0.5 ? null : `expected dayT 0.5, got ${canon(asObj(out).dayT)}`) },
      { name: 'QUIRK: explicit dayT null REJECTED (absent tolerated, null not)', frame: { type: 'mobs', mobs: [mob()], dayT: null }, expectNull: true },
      { name: 'dayT as string rejected', frame: { type: 'mobs', mobs: [mob()], dayT: 'high' }, expectNull: true },
      { name: 'dayT NaN rejected (direct feed)', frame: { type: 'mobs', mobs: [mob()], dayT: NaN }, expectNull: true },
      { name: "unknown kind 'dragon' rejected", frame: { type: 'mobs', mobs: [mob({ kind: 'dragon' })] }, expectNull: true },
      { name: 'fractional hp accepted (asNumber, not asInt)', frame: { type: 'mobs', mobs: [mob({ hp: 5.5 })] }, expect: (out) => (asObj(at(asObj(out).mobs, 0)).hp === 5.5 ? null : 'hp should pass through') },
      { name: 'mob missing yaw rejected', frame: { type: 'mobs', mobs: [{ id: 1, kind: 'fox', x: 0, y: 0, z: 0, hp: 6 }] }, expectNull: true },
      { name: 'mobs as object rejected (array required)', frame: { type: 'mobs', mobs: { id: 1 } }, expectNull: true },
    ],
  },
  {
    title: 'server / mobDied',
    entry: 'server',
    cases: [
      { name: 'canonical (float position ok)', frame: { type: 'mobDied', id: 1, kind: 'boar', at: [1.5, 64.5, -2.5] } },
      { name: 'zombie kind accepted', frame: { type: 'mobDied', id: 1, kind: 'zombie', at: [0, 64, 0] } },
      { name: 'at length 2 rejected', frame: { type: 'mobDied', id: 1, kind: 'fox', at: [1, 2] }, expectNull: true },
      { name: 'at length 4 rejected', frame: { type: 'mobDied', id: 1, kind: 'fox', at: [1, 2, 3, 4] }, expectNull: true },
      { name: 'at as string rejected', frame: { type: 'mobDied', id: 1, kind: 'fox', at: 'origin' }, expectNull: true },
    ],
  },
  {
    title: 'server / modeChanged',
    entry: 'server',
    cases: [
      { name: 'canonical sandbox (yourTeam -1 = spectator)', frame: { type: 'modeChanged', mode: 'sandbox', seed: 1337, edits: [[1, 2, 3, 4]], spawns: [{ x: 128.5, y: 70, z: 128.5, yaw: 0 }], beds: [{ x: 10, y: 65, z: 10 }], yourTeam: -1 } },
      { name: 'party mode accepted', frame: { type: 'modeChanged', mode: 'party', seed: 1, edits: [], spawns: [{ x: 0, y: 40, z: 0, yaw: 1.5 }], beds: [], yourTeam: 0 } },
      { name: "mode 'creative' rejected", frame: { type: 'modeChanged', mode: 'creative', seed: 1, edits: [], spawns: [], beds: [], yourTeam: 0 }, expectNull: true },
      { name: 'spawn missing yaw rejected', frame: { type: 'modeChanged', mode: 'sandbox', seed: 1, edits: [], spawns: [{ x: 0, y: 0, z: 0 }], beds: [], yourTeam: 0 }, expectNull: true },
      { name: 'fractional bed coord rejected (beds are ints)', frame: { type: 'modeChanged', mode: 'bedwars', seed: 1, edits: [], spawns: [], beds: [{ x: 1.5, y: 2, z: 3 }], yourTeam: 0 }, expectNull: true },
      { name: 'yourTeam absent rejected', frame: { type: 'modeChanged', mode: 'sandbox', seed: 1, edits: [], spawns: [], beds: [] }, expectNull: true },
    ],
  },
  {
    title: 'server / gameState (bedwars shape)',
    entry: 'server',
    cases: [
      { name: 'QUIRK: party absent → party key OMITTED', frame: { type: 'gameState', phase: 'playing', timeLeft: 30, bedsAlive: [true, false], players: [matchPlayer()] }, expect: (out) => (!hasKey(out, 'party') ? null : `party must be omitted, got ${canon(asObj(out).party)}`) },
      { name: 'party phase name accepted (intermission)', frame: { type: 'gameState', phase: 'intermission', timeLeft: 5.5, bedsAlive: [], players: [matchPlayer()] } },
      { name: "phase 'lobby' rejected", frame: { type: 'gameState', phase: 'lobby', timeLeft: 0, bedsAlive: [], players: [] }, expectNull: true },
      { name: 'QUIRK: explicit party null REJECTED (asymmetric with bomb)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [], party: null }, expectNull: true },
      { name: "party as string rejected", frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [], party: 'x' }, expectNull: true },
      { name: 'QUIRK: inventory.sword ABSENT rejected (sword required; null = bare hands)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0 } }] }, expectNull: true },
      { name: "sword 'diamond' rejected (unknown tier)", frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0, sword: 'diamond' } }] }, expectNull: true },
      { name: "sword 'wooden' accepted", frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 1, planks: 0, apples: 0, sword: 'wooden' } }] }, expect: (out) => (asObj(asObj(at(asObj(out).players, 0)).inventory).sword === 'wooden' ? null : 'sword should pass through') },
      { name: 'alive absent rejected (booleans not coerced)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), alive: undefined }] }, expectNull: true },
      { name: 'fractional hp accepted', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [matchPlayer({ hp: 19.5 })] } },
      { name: 'bedsAlive [1,0] rejected (numbers are not booleans)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [1, 0], players: [] }, expectNull: true },
    ],
  },
  {
    title: 'server / gameState (v10 inventory bow/arrows quirks, §3.3)',
    entry: 'server',
    cases: [
      {
        name: 'v10: bow + arrows round-trip',
        frame: { type: 'gameState', phase: 'playing', timeLeft: 30, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 1, planks: 2, apples: 3, sword: 'wooden', bow: true, arrows: 12 } }] },
        expect: (out) => {
          const inv = asObj(asObj(at(asObj(out).players, 0)).inventory);
          return inv.bow === true && inv.arrows === 12
            ? null
            : `expected bow:true arrows:12, got ${canon(inv)}`;
        },
      },
      {
        name: 'v10: QUIRK: v9-shaped inventory (no bow/arrows) → both keys OMITTED (bit-identical legacy parse)',
        frame: { type: 'gameState', phase: 'playing', timeLeft: 30, bedsAlive: [], players: [matchPlayer()] },
        expect: (out) => {
          const inv = asObj(at(asObj(out).players, 0)).inventory;
          return !hasKey(inv, 'bow') && !hasKey(inv, 'arrows')
            ? null
            : `bow/arrows must be omitted on legacy payloads, got ${canon(inv)}`;
        },
      },
      { name: 'v10: bow-only payload → arrows defaults 0 (key present)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0, sword: null, bow: true } }] }, expect: (out) => { const inv = asObj(asObj(at(asObj(out).players, 0)).inventory); return inv.bow === true && inv.arrows === 0 ? null : `expected bow:true arrows:0, got ${canon(inv)}`; } },
      { name: "v10: bow:'yes' rejected (booleans not coerced)", frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0, sword: null, bow: 'yes', arrows: 0 } }] }, expectNull: true },
      { name: 'v10: arrows as string rejected', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0, sword: null, bow: false, arrows: '3' } }] }, expectNull: true },
      { name: 'v10: fractional arrows accepted (asNumber, the wool/planks/apples style)', frame: { type: 'gameState', phase: 'playing', timeLeft: 0, bedsAlive: [], players: [{ ...matchPlayer(), inventory: { wool: 0, planks: 0, apples: 0, sword: null, bow: false, arrows: 5.5 } }] }, expect: (out) => { const inv = asObj(asObj(at(asObj(out).players, 0)).inventory); return inv.arrows === 5.5 ? null : 'arrows should pass through'; } },
    ],
  },
  {
    title: 'server / gameState (party payload quirks)',
    entry: 'server',
    cases: [
      {
        name: 'canonical v7 payload (bomb, boxes, items, effects)',
        frame: {
          type: 'gameState',
          phase: 'announce',
          timeLeft: 5.5,
          bedsAlive: [],
          players: [matchPlayer()],
          party: party({ bomb: { cell: [3, 4], colorId: 21, detonatesAt: 9999 }, boxes: [{ cell: [5, 6] }], items: { 1: ['leap'] }, effects: [{ playerId: 1, effect: 'speed', until: 9999 }] }),
        },
        expect: (out) => {
          const p = asObj(out).party;
          const bomb = asObj(asObj(p).bomb);
          return bomb.cell !== undefined && JSON.stringify(bomb.cell) === '[3,4]' && bomb.colorId === 21
            ? null
            : `bomb should round-trip, got ${canon(asObj(p).bomb)}`;
        },
      },
      {
        name: "QUIRK: v4-era payload (no bomb/boxes/items/effects) → bomb null, boxes [], items {}, effects []",
        frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ bomb: undefined, boxes: undefined, items: undefined, effects: undefined }) },
        expect: (out) => {
          const p = asObj(out).party;
          if (out === null || typeof p !== 'object' || p === null) return 'frame should parse';
          if (p.bomb !== null) return `expected bomb null, got ${canon(p.bomb)}`;
          if (canon(p.boxes) !== '[]') return `expected boxes [], got ${canon(p.boxes)}`;
          if (canon(p.items) !== '{}') return `expected items {}, got ${canon(p.items)}`;
          if (canon(p.effects) !== '[]') return `expected effects [], got ${canon(p.effects)}`;
          return null;
        },
      },
      { name: 'QUIRK: explicit bomb null ACCEPTED (v5 tolerance)', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ bomb: null }) }, expect: (out) => (asObj(asObj(out).party).bomb === null ? null : `expected bomb null, got ${canon(asObj(asObj(out).party).bomb)}`) },
      { name: 'malformed bomb (missing colorId) rejects the WHOLE frame', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ bomb: { cell: [1, 2] } }) }, expectNull: true },
      { name: 'bomb as string rejects the frame (null tolerated, garbage not)', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ bomb: 'soon' }) }, expectNull: true },
      { name: 'box with short cell rejects the frame', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ boxes: [{ cell: [1] }] }) }, expectNull: true },
      {
        name: 'QUIRK: items digit-key normalization ("01" → 1)',
        frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ items: { '01': ['leap', 'speed'] } }) },
        expect: (out) => {
          const items = asObj(asObj(out).party).items;
          const keys = Object.keys(asObj(items));
          return keys.length === 1 && keys[0] === '1' && JSON.stringify(asObj(items)[1]) === '["leap","speed"]'
            ? null
            : `expected normalized key 1, got ${canon(items)}`;
        },
      },
      { name: "items '-1' key rejected (must be all digits)", frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ items: { '-1': [] } }) }, expectNull: true },
      { name: 'QUIRK: items as ARRAY accepted as {} (isRecord accepts arrays)', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ items: [] }) }, expect: (out) => (canon(asObj(asObj(out).party).items) === '{}' ? null : `expected items {}, got ${canon(asObj(asObj(out).party).items)}`) },
      { name: "effect 'haste' rejected (speed/jump only)", frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ effects: [{ playerId: 1, effect: 'haste', until: 1 }] }) }, expectNull: true },
      { name: "score alive:'yes' rejected (booleans not coerced)", frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ scores: [{ playerId: 1, name: 'A', score: 3, alive: 'yes' }] }) }, expectNull: true },
      { name: 'fractional round rejected', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: party({ round: 1.5 }) }, expectNull: true },
      { name: 'colorName absent rejected', frame: { type: 'gameState', phase: 'announce', timeLeft: 8, bedsAlive: [], players: [], party: { round: 1, colorId: 21, roundTimerMs: 8, roundEndsAt: 9, scores: [] } }, expectNull: true },
    ],
  },
  {
    title: 'server / gameState (murder payload quirks, v9 §3.6)',
    entry: 'server',
    cases: [
      {
        name: 'canonical v9 payload (guest roster + counters + detector)',
        frame: { type: 'gameState', phase: 'mingle', timeLeft: 240, bedsAlive: [], players: [], murder: murder() },
        expect: (out) => {
          const m = asObj(asObj(out).murder);
          const g = asObj(at(m.guests, 0));
          return g.name === 'Red Guest' && g.color === 'red' && g.alive === true && asObj(m.coins)[1] === 4
            ? null
            : `payload should round-trip, got ${canon(asObj(out).murder)}`;
        },
      },
      { name: "phase 'hunt' accepted (escalation phases widen asPhase)", frame: { type: 'gameState', phase: 'hunt', timeLeft: 30, bedsAlive: [], players: [], murder: murder() } },
      { name: "phase 'bold' accepted", frame: { type: 'gameState', phase: 'bold', timeLeft: 90, bedsAlive: [], players: [], murder: murder() } },
      { name: "phase 'eavesdrop' rejected (not a murder phase)", frame: { type: 'gameState', phase: 'eavesdrop', timeLeft: 0, bedsAlive: [], players: [], murder: murder() }, expectNull: true },
      {
        name: 'QUIRK: murder absent → murder key OMITTED (v9 clients parse v8 snapshots unchanged)',
        frame: { type: 'gameState', phase: 'playing', timeLeft: 30, bedsAlive: [true, true], players: [] },
        expect: (out) => (!hasKey(out, 'murder') ? null : `murder must be omitted, got ${canon(asObj(out).murder)}`),
      },
      { name: 'QUIRK: explicit murder null REJECTED (same asymmetry as party)', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: null }, expectNull: true },
      { name: 'murder as string rejects the frame', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: 'soon' }, expectNull: true },
      {
        name: 'QUIRK: guests-only payload → all counter maps default {} (partial-payload tolerance, party spirit)',
        frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: { guests: [murderGuest()] } },
        expect: (out) => {
          const m = asObj(asObj(out).murder);
          return canon(m.coins) === '{}' && canon(m.charges) === '{}' && canon(m.jammedUntil) === '{}' && canon(m.detector) === '{}' && canon(m.coinItems) === '[]'
            ? null
            : `expected all counter maps {} and coinItems [], got ${canon(m)}`;
        },
      },
      { name: 'coinItems canonical (super tier)', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ coinItems: [{ id: 3, x: 10.5, y: 31, z: 10.5, tier: 'super' }] }) } },
      { name: 'coinItems bad tier rejected', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ coinItems: [{ id: 3, x: 1, y: 2, z: 3, tier: 'bronze' }] }) }, expectNull: true },
      { name: 'coinItems fractional id rejected', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ coinItems: [{ id: 1.5, x: 1, y: 2, z: 3, tier: 'gold' }] }) }, expectNull: true },
      { name: 'guests absent rejected (the roster is required, no default)', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: { coins: {} } }, expectNull: true },
      { name: "guest bad color rejected ('crimson')", frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ guests: [murderGuest({ color: 'crimson' })] }) }, expectNull: true },
      { name: 'guest alive:"yes" rejected (booleans not coerced)', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ guests: [murderGuest({ alive: 'yes' })] }) }, expectNull: true },
      { name: 'guest fractional id rejected', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ guests: [murderGuest({ id: 11.5 })] }) }, expectNull: true },
      { name: "coins '-1' key rejected (digit keys only, party-items rule)", frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ coins: { '-1': 3 } }) }, expectNull: true },
      { name: 'coins fractional value rejected (counts are ints)', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ coins: { 1: 2.5 } }) }, expectNull: true },
      { name: 'detector non-boolean rejected', frame: { type: 'gameState', phase: 'mingle', timeLeft: 0, bedsAlive: [], players: [], murder: murder({ detector: { 1: 1 } }) }, expectNull: true },
    ],
  },

  // --- gameEvent kinds (all 22) ------------------------------------------------
  {
    title: 'server / gameEvent bedBroken',
    entry: 'server',
    cases: [
      { name: 'canonical', frame: ge({ kind: 'bedBroken', team: 0, by: 'Alice' }) },
      { name: 'by absent rejected', frame: ge({ kind: 'bedBroken', team: 0 }), expectNull: true },
      { name: 'fractional team rejected', frame: ge({ kind: 'bedBroken', team: 0.5, by: 'x' }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent death (killerId coercion quirk)',
    entry: 'server',
    cases: [
      { name: 'canonical combat kill', frame: ge({ kind: 'death', playerId: 1, cause: 'combat', killerId: 2, respawnIn: 5 }), expect: (out) => (asObj(out).killerId === 2 ? null : `expected killerId 2, got ${canon(asObj(out).killerId)}`) },
      { name: 'void death with explicit killerId null', frame: ge({ kind: 'death', playerId: 1, cause: 'void', killerId: null, respawnIn: 0 }), expect: (out) => (asObj(out).killerId === null ? null : 'expected killerId null') },
      {
        name: 'QUIRK: killerId "2" (STRING) accepted but coerced to null',
        frame: ge({ kind: 'death', playerId: 1, cause: 'combat', killerId: '2', respawnIn: 5 }),
        expect: (out) => {
          if (out === null) return 'frame should be ACCEPTED (coercion quirk)';
          return asObj(out).killerId === null ? null : `expected coerced null, got ${canon(asObj(out).killerId)}`;
        },
      },
      {
        name: 'QUIRK: killerId ABSENT accepted as null (guard is dead code)',
        frame: ge({ kind: 'death', playerId: 1, cause: 'void', respawnIn: 0 }),
        expect: (out) => (out !== null && asObj(out).killerId === null ? null : 'expected accepted frame with killerId null'),
      },
      {
        name: 'QUIRK: fractional killerId 2.5 accepted as null (same coercion)',
        frame: ge({ kind: 'death', playerId: 1, cause: 'combat', killerId: 2.5, respawnIn: 5 }),
        expect: (out) => (out !== null && asObj(out).killerId === null ? null : 'expected accepted frame with killerId null'),
      },
      { name: "cause 'fall' rejected", frame: ge({ kind: 'death', playerId: 1, cause: 'fall', killerId: null, respawnIn: 0 }), expectNull: true },
      { name: 'cause absent rejected', frame: ge({ kind: 'death', playerId: 1, killerId: null, respawnIn: 0 }), expectNull: true },
      { name: 'respawnIn absent rejected', frame: ge({ kind: 'death', playerId: 1, cause: 'void', killerId: null }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent respawn, purchase, heal',
    entry: 'server',
    cases: [
      { name: 'respawn canonical', frame: ge({ kind: 'respawn', playerId: 1 }) },
      { name: 'respawn playerId absent rejected', frame: ge({ kind: 'respawn' }), expectNull: true },
      { name: 'purchase canonical', frame: ge({ kind: 'purchase', playerId: 1, item: 'stone_sword' }) },
      { name: "purchase party item 'leap' rejected", frame: ge({ kind: 'purchase', playerId: 1, item: 'leap' }), expectNull: true },
      { name: 'heal canonical', frame: ge({ kind: 'heal', playerId: 1, amount: 4 }) },
      { name: 'heal amount as string rejected', frame: ge({ kind: 'heal', playerId: 1, amount: '4' }), expectNull: true },
      { name: 'heal amount 0 accepted (falsy must not reject)', frame: ge({ kind: 'heal', playerId: 1, amount: 0 }), expect: (out) => (asObj(out).amount === 0 ? null : 'amount 0 should pass through') },
    ],
  },
  {
    title: 'server / gameEvent knockback',
    entry: 'server',
    cases: [
      { name: 'canonical (floats)', frame: ge({ kind: 'knockback', playerId: 1, dir: { x: 0.1, y: 0.5, z: -0.2 }, power: 8.5 }) },
      { name: 'dir missing y rejected', frame: ge({ kind: 'knockback', playerId: 1, dir: { x: 0, z: 0 }, power: 1 }), expectNull: true },
      { name: 'dir as string rejected', frame: ge({ kind: 'knockback', playerId: 1, dir: 'up', power: 1 }), expectNull: true },
      { name: 'dir as ARRAY rejected (isRecord would pass it, field check fails)', frame: ge({ kind: 'knockback', playerId: 1, dir: [1, 2, 3], power: 1 }), expectNull: true },
      { name: 'power absent rejected', frame: ge({ kind: 'knockback', playerId: 1, dir: { x: 0, y: 0, z: 0 } }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent roundStart, drop',
    entry: 'server',
    cases: [
      { name: 'roundStart canonical', frame: ge({ kind: 'roundStart', round: 3 }) },
      { name: 'roundStart fractional round rejected', frame: ge({ kind: 'roundStart', round: 3.5 }), expectNull: true },
      { name: 'drop parses bare (no fields)', frame: ge({ kind: 'drop' }), expect: (out) => (Object.keys(asObj(out)).sort().join(',') === 'kind,type' ? null : `expected bare gameEvent, got ${canon(out)}`) },
      { name: 'drop drops junk fields silently', frame: ge({ kind: 'drop', round: 99 }), expect: notNull('drop should parse despite junk') },
    ],
  },
  {
    title: 'server / gameEvent roundResult (survivorId draw semantics)',
    entry: 'server',
    cases: [
      { name: 'canonical', frame: ge({ kind: 'roundResult', round: 1, fallers: [1, 2], survivorId: 2, draw: false }) },
      // The declared type is `survivorId: number | null` ("null on a draw") and
      // server/src/party.ts sends survivor?.id ?? null — the parser used to
      // REJECT null, silently dropping every draw's result; fixed 2026-09-29
      // (explicit null accepted, everything else still strict).
      { name: 'FIXED: explicit survivorId null parses (the draw path party.ts actually sends)', frame: ge({ kind: 'roundResult', round: 1, fallers: [1, 2], survivorId: null, draw: true }) },
      { name: 'survivorId ABSENT still rejected (no killerId-style coercion)', frame: ge({ kind: 'roundResult', round: 1, fallers: [], draw: true }), expectNull: true },
      { name: 'survivorId string rejected', frame: ge({ kind: 'roundResult', round: 1, fallers: [1], survivorId: '2', draw: false }), expectNull: true },
      { name: 'fractional faller id rejected', frame: ge({ kind: 'roundResult', round: 1, fallers: [1.5], survivorId: null, draw: false }), expectNull: true },
      { name: 'draw absent rejected', frame: ge({ kind: 'roundResult', round: 1, fallers: [], survivorId: null }), expectNull: true },
      { name: 'fallers as string rejected', frame: ge({ kind: 'roundResult', round: 1, fallers: 'none', survivorId: null, draw: false }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent bombSpawned, bombDetonated',
    entry: 'server',
    cases: [
      { name: 'bombSpawned canonical', frame: ge({ kind: 'bombSpawned', cell: [3, 4], colorId: 21 }) },
      { name: 'bombSpawned fractional cell rejected', frame: ge({ kind: 'bombSpawned', cell: [3.5, 4], colorId: 21 }), expectNull: true },
      { name: 'bombSpawned 3-length cell rejected', frame: ge({ kind: 'bombSpawned', cell: [3, 4, 5], colorId: 21 }), expectNull: true },
      { name: 'bombDetonated canonical', frame: ge({ kind: 'bombDetonated', cell: [3, 4], colorId: 21 }) },
      { name: 'bombDetonated string colorId rejected', frame: ge({ kind: 'bombDetonated', cell: [3, 4], colorId: '21' }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent boxSpawned, boxPickedUp, itemUsed',
    entry: 'server',
    cases: [
      { name: 'boxSpawned canonical', frame: ge({ kind: 'boxSpawned', cell: [5, 6] }) },
      { name: 'boxSpawned cell absent rejected', frame: ge({ kind: 'boxSpawned' }), expectNull: true },
      { name: 'boxPickedUp canonical', frame: ge({ kind: 'boxPickedUp', playerId: 1, item: 'leap' }) },
      { name: "boxPickedUp shop item 'wool' rejected (party ids only)", frame: ge({ kind: 'boxPickedUp', playerId: 1, item: 'wool' }), expectNull: true },
      { name: 'itemUsed canonical', frame: ge({ kind: 'itemUsed', playerId: 1, item: 'swapper' }) },
      { name: "itemUsed unknown item 'milk' rejected", frame: ge({ kind: 'itemUsed', playerId: 1, item: 'milk' }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent leap, teleported, swapped, cellZapped, shoved',
    entry: 'server',
    cases: [
      { name: 'leap canonical', frame: ge({ kind: 'leap', playerId: 1, dir: { x: 1, y: 5, z: 0 } }) },
      { name: 'leap dir as array rejected', frame: ge({ kind: 'leap', playerId: 1, dir: [1, 5, 0] }), expectNull: true },
      { name: 'teleported canonical (floats ok)', frame: ge({ kind: 'teleported', playerId: 1, x: 1.5, y: 65, z: -3 }) },
      { name: 'teleported x absent rejected', frame: ge({ kind: 'teleported', playerId: 1, y: 65, z: -3 }), expectNull: true },
      { name: 'swapped canonical', frame: ge({ kind: 'swapped', aId: 1, bId: 2, a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 1, z: 1 } }) },
      { name: 'swapped missing b rejected', frame: ge({ kind: 'swapped', aId: 1, bId: 2, a: { x: 0, y: 0, z: 0 } }), expectNull: true },
      { name: 'cellZapped canonical', frame: ge({ kind: 'cellZapped', by: 1, cell: [7, 8] }) },
      { name: 'shoved canonical (v8)', frame: ge({ kind: 'shoved', playerId: 1, mobId: 9, dir: { x: 0, y: 1, z: 0 }, power: 6 }) },
      { name: 'shoved mobId absent rejected', frame: ge({ kind: 'shoved', playerId: 1, dir: { x: 0, y: 1, z: 0 }, power: 6 }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent guestKilled, murdererRevealed, zapped, coinPickedUp, gravestoneRead (v9 §3.6)',
    entry: 'server',
    cases: [
      { name: 'guestKilled canonical (float world coords)', frame: ge({ kind: 'guestKilled', x: 4.5, y: 32, z: -7.25, victimId: 11 }) },
      { name: 'guestKilled fractional victimId rejected', frame: ge({ kind: 'guestKilled', x: 0, y: 0, z: 0, victimId: 11.5 }), expectNull: true },
      { name: 'guestKilled missing victimId rejected', frame: ge({ kind: 'guestKilled', x: 0, y: 0, z: 0 }), expectNull: true },
      { name: 'murdererRevealed canonical', frame: ge({ kind: 'murdererRevealed', id: 14 }) },
      { name: 'murdererRevealed string id rejected', frame: ge({ kind: 'murdererRevealed', id: '14' }), expectNull: true },
      { name: 'zapped correct canonical', frame: ge({ kind: 'zapped', by: 1, targetId: 14, correct: true }) },
      { name: "zapped correct:'yes' rejected (booleans not coerced)", frame: ge({ kind: 'zapped', by: 1, targetId: 14, correct: 'yes' }), expectNull: true },
      { name: 'coinPickedUp super coin (value 6)', frame: ge({ kind: 'coinPickedUp', playerId: 2, value: 6 }) },
      { name: 'coinPickedUp fractional value rejected', frame: ge({ kind: 'coinPickedUp', playerId: 2, value: 0.5 }), expectNull: true },
      { name: 'gravestoneRead canonical', frame: ge({ kind: 'gravestoneRead', x: 4, z: -7, victimName: 'Blue Guest', ageSeconds: 20 }) },
      { name: 'gravestoneRead missing age rejected', frame: ge({ kind: 'gravestoneRead', x: 4, z: -7, victimName: 'B' }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent arrowLaunched, hit (v10 BedWars bow, §3.3)',
    entry: 'server',
    cases: [
      { name: 'v10: arrowLaunched canonical (floats + negative dir)', frame: ge({ kind: 'arrowLaunched', by: 1, from: { x: 67.5, y: 32.62, z: 64.5 }, dir: { x: -0.7, y: 0.1, z: -0.7 }, power: 36 }) },
      { name: 'v10: arrowLaunched dir missing y rejected', frame: ge({ kind: 'arrowLaunched', by: 1, from: { x: 0, y: 0, z: 0 }, dir: { x: 1, z: 0 }, power: 20 }), expectNull: true },
      { name: 'v10: arrowLaunched from as string rejected', frame: ge({ kind: 'arrowLaunched', by: 1, from: 'eye', dir: { x: 0, y: 0, z: 0 }, power: 20 }), expectNull: true },
      { name: 'v10: arrowLaunched power absent rejected', frame: ge({ kind: 'arrowLaunched', by: 1, from: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 } }), expectNull: true },
      { name: 'v10: arrowLaunched by fractional rejected', frame: ge({ kind: 'arrowLaunched', by: 1.5, from: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 }, power: 20 }), expectNull: true },
      { name: 'v10: hit melee canonical', frame: ge({ kind: 'hit', targetId: 2, byId: 1, damage: 6, cause: 'melee' }) },
      { name: 'v10: hit arrow canonical', frame: ge({ kind: 'hit', targetId: 1, byId: 2, damage: 24, cause: 'arrow' }) },
      { name: 'v10: hit fractional damage accepted (asNumber)', frame: ge({ kind: 'hit', targetId: 2, byId: 1, damage: 11.5, cause: 'arrow' }), expect: (out) => (asObj(out).damage === 11.5 ? null : 'damage should pass through') },
      { name: "v10: hit cause 'void' rejected (melee/arrow only)", frame: ge({ kind: 'hit', targetId: 2, byId: 1, damage: 6, cause: 'void' }), expectNull: true },
      { name: 'v10: hit cause absent rejected', frame: ge({ kind: 'hit', targetId: 2, byId: 1, damage: 6 }), expectNull: true },
      { name: 'v10: hit fractional targetId rejected', frame: ge({ kind: 'hit', targetId: 2.5, byId: 1, damage: 6, cause: 'melee' }), expectNull: true },
      { name: 'v10: hit damage absent rejected', frame: ge({ kind: 'hit', targetId: 2, byId: 1, cause: 'melee' }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent matchEnd (stats undefined-vs-absent quirk)',
    entry: 'server',
    cases: [
      {
        name: 'QUIRK: bare stats entry omits BOTH rounds and falls keys',
        frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: [{ id: 1, name: 'A', kills: 3, deaths: 1 }] }),
        expect: (out) => {
          const s0 = at(asObj(out).stats, 0);
          return !hasKey(s0, 'rounds') && !hasKey(s0, 'falls')
            ? null
            : `expected both keys omitted, got ${canon(s0)}`;
        },
      },
      {
        name: "QUIRK: rounds-only stats STILL emits falls key (explicit undefined)",
        frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: [{ id: 1, name: 'A', kills: 0, deaths: 2, rounds: 2 }] }),
        expect: (out) => {
          const s0 = at(asObj(out).stats, 0);
          return hasKey(s0, 'rounds') && hasKey(s0, 'falls') && asObj(s0).rounds === 2 && asObj(s0).falls === undefined
            ? null
            : `expected {rounds:2, falls:undefined}, got ${canon(s0)}`;
        },
      },
      {
        name: 'QUIRK: falls-only stats emits rounds key as undefined',
        frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: [{ id: 1, name: 'A', kills: 0, deaths: 2, falls: 3 }] }),
        expect: (out) => {
          const s0 = at(asObj(out).stats, 0);
          return hasKey(s0, 'rounds') && asObj(s0).rounds === undefined && asObj(s0).falls === 3
            ? null
            : `expected {rounds:undefined, falls:3}, got ${canon(s0)}`;
        },
      },
      { name: 'string rounds rejected', frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: [{ id: 1, name: 'A', kills: 0, deaths: 0, rounds: '2' }] }), expectNull: true },
      { name: 'stats entry missing deaths rejected', frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: [{ id: 1, name: 'A', kills: 0 }] }), expectNull: true },
      { name: 'stats as object rejected (array required)', frame: ge({ kind: 'matchEnd', winnerId: 1, winnerName: 'A', stats: { id: 1 } }), expectNull: true },
    ],
  },
  {
    title: 'server / gameEvent error, countdown, unknown kinds',
    entry: 'server',
    cases: [
      { name: 'error canonical', frame: ge({ kind: 'error', message: 'Not enough emeralds.' }) },
      { name: 'error message absent rejected', frame: ge({ kind: 'error' }), expectNull: true },
      { name: 'countdown negative accepted (≤0 means FIGHT)', frame: ge({ kind: 'countdown', seconds: -1 }), expect: (out) => (asObj(out).seconds === -1 ? null : 'seconds -1 should pass through') },
      { name: 'countdown fractional accepted', frame: ge({ kind: 'countdown', seconds: 3.5 }) },
      { name: 'countdown string rejected', frame: ge({ kind: 'countdown', seconds: '3' }), expectNull: true },
      { name: "unknown kind 'dragon' rejected (v5 doc: unknown kinds are dropped)", frame: ge({ kind: 'dragon' }), expectNull: true },
      { name: 'missing kind rejected', frame: { type: 'gameEvent' }, expectNull: true },
    ],
  },
  {
    title: 'server / frame shape (non-objects, cross-entry)',
    entry: 'server',
    cases: [
      { name: 'null frame rejected', frame: null, expectNull: true },
      { name: 'number frame rejected', frame: 0, expectNull: true },
      { name: 'string frame rejected', frame: '', expectNull: true },
      { name: 'array frame rejected', frame: [{ type: 'players' }], expectNull: true },
      { name: "client-only type 'hello' rejected by server parser", frame: { type: 'hello', name: 'A' }, expectNull: true },
      { name: "client-only type 'move' rejected by server parser", frame: { type: 'move', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, expectNull: true },
    ],
  },
];

// --- corpus stats ------------------------------------------------------------

function corpusSize(): number {
  return CORPUS.reduce((n, group) => n + group.cases.length, 0);
}

/**
 * Coverage is measured against the CURRENT parsers: only frames that actually
 * PARSE (non-null) count toward the type/kind lists, so rejected-shape cases
 * (unknown types, cross-entry probes) don't inflate the numbers.
 */
function corpusCoverage(p: Parsers): { clientTypes: string[]; serverTypes: string[]; eventKinds: string[] } {
  const clientTypes = new Set<string>();
  const serverTypes = new Set<string>();
  const eventKinds = new Set<string>();
  for (const group of CORPUS) {
    const parse = group.entry === 'client' ? p.parseClientMessage : p.parseServerMessage;
    for (const c of group.cases) {
      if (c.frame === null || typeof c.frame !== 'object' || Array.isArray(c.frame)) continue;
      if (parse(c.frame) === null) continue;
      const type = (c.frame as Frame).type;
      if (typeof type !== 'string') continue;
      (group.entry === 'client' ? clientTypes : serverTypes).add(type);
      if (type === 'gameEvent' && typeof (c.frame as Frame).kind === 'string') {
        eventKinds.add((c.frame as Frame).kind as string);
      }
    }
  }
  return {
    clientTypes: [...clientTypes].sort(),
    serverTypes: [...serverTypes].sort(),
    eventKinds: [...eventKinds].sort(),
  };
}

// --- baseline extraction + build ---------------------------------------------

interface Parsers {
  parseClientMessage: (data: unknown) => unknown;
  parseServerMessage: (data: unknown) => unknown;
}

function resolveCommit(ref: string, repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(`baseline ref '${ref}' does not resolve to a commit`);
  }
}

function extractBaselineSharedSrc(commit: string, repoRoot: string, into: string): string {
  const tarPath = path.join(into, 'baseline.tar');
  const tar = execFileSync('git', ['archive', '--format=tar', commit, '--', 'shared/src'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(tarPath, tar);
  execFileSync('tar', ['-xf', tarPath, '-C', into]);
  const entry = path.join(into, 'shared', 'src', 'protocol.ts');
  if (!fs.existsSync(entry)) {
    throw new Error(`baseline ${commit} has no shared/src/protocol.ts (is the ref old enough?)`);
  }
  return entry;
}

async function bundle(entryPoint: string, outfile: string): Promise<void> {
  await esbuildBuild({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
}

async function loadParsers(entryPoint: string, outfile: string): Promise<Parsers> {
  await bundle(entryPoint, outfile);
  const mod = (await import(pathToFileURL(outfile).href)) as Partial<Parsers>;
  if (typeof mod.parseClientMessage !== 'function' || typeof mod.parseServerMessage !== 'function') {
    throw new Error(`bundled module ${outfile} does not export both parse entry points`);
  }
  return { parseClientMessage: mod.parseClientMessage, parseServerMessage: mod.parseServerMessage };
}

// --- runner ------------------------------------------------------------------

let failures = 0;
function fail(name: string, problem: string, input: unknown, parsed: unknown, extra?: string[]): void {
  failures += 1;
  console.log(`  FAIL  ${name} — ${problem}`);
  console.log(`        input: ${canon(input)}`);
  console.log(`        parse: ${canon(parsed)}`);
  for (const line of extra ?? []) console.log(`        ${line}`);
}

function runCorpus(oldP: Parsers, newP: Parsers): void {
  for (const group of CORPUS) {
    const entryName = group.entry === 'client' ? 'parseClientMessage' : 'parseServerMessage';
    const oldParse = group.entry === 'client' ? oldP.parseClientMessage : oldP.parseServerMessage;
    const newParse = group.entry === 'client' ? newP.parseClientMessage : newP.parseServerMessage;
    console.log(`\n${group.title}  [${entryName}]`);
    for (const c of group.cases) {
      const oldRes = oldParse(c.frame);
      const newRes = newParse(c.frame);
      if (canon(oldRes) !== canon(newRes)) {
        fail(c.name, 'OLD vs NEW differ', c.frame, oldRes, [`new:   ${canon(newRes)}`]);
        continue;
      }
      if (c.expectNull && oldRes !== null) {
        fail(c.name, `expected null from both parsers, got ${canon(oldRes)}`, c.frame, oldRes);
        continue;
      }
      if (c.expect) {
        // Pin the quirk against BOTH builds: the baseline must still exhibit
        // it (guards against pinning a too-old baseline) and the rewrite must
        // preserve it.
        const onOld = c.expect(oldRes);
        const onNew = c.expect(newRes);
        if (onOld !== null && onNew !== null) {
          fail(c.name, `pinned assertion broken on BOTH parses: ${onNew}`, c.frame, oldRes);
          continue;
        }
        if (onOld !== null) {
          fail(c.name, `pinned assertion broken on OLD parse (baseline): ${onOld}`, c.frame, oldRes);
          continue;
        }
        if (onNew !== null) {
          fail(c.name, `pinned assertion broken on NEW parse (working tree): ${onNew}`, c.frame, newRes);
          continue;
        }
      }
      const pinned = c.expect !== undefined || c.expectNull === true;
      console.log(`  PASS  ${c.name} — old == new${pinned ? ' + pinned assertion' : ''}`);
    }
  }
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const { baseline } = parseArgs();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-protocol-'));
  try {
    const commit = resolveCommit(baseline, repoRoot);
    console.log(`[check-protocol] old (baseline): ${baseline} @ ${commit} — shared/src via git archive`);
    console.log(`[check-protocol] new (current):  working tree shared/src`);
    console.log(`[check-protocol] corpus: ${corpusSize()} frames (coverage summary printed at the end)`);

    const baselineEntry = extractBaselineSharedSrc(commit, repoRoot, tmp);
    const oldP = await loadParsers(baselineEntry, path.join(tmp, 'protocol-old.mjs'));
    const newP = await loadParsers(path.join(repoRoot, 'shared', 'src', 'protocol.ts'), path.join(tmp, 'protocol-new.mjs'));

    runCorpus(oldP, newP);

    const stats = corpusCoverage(newP);
    console.log(`\n[check-protocol] C→S types covered (${stats.clientTypes.length}): ${stats.clientTypes.join(', ')}`);
    console.log(`[check-protocol] S→C types covered (${stats.serverTypes.length}): ${stats.serverTypes.join(', ')}`);
    console.log(`[check-protocol] gameEvent kinds covered (${stats.eventKinds.length}): ${stats.eventKinds.join(', ')}`);
    console.log(
      failures === 0
        ? '\n[check-protocol] ALL CHECKS PASSED — old and new parsers are behaviorally identical'
        : `\n[check-protocol] ${failures} CASE(S) FAILED — parser behavior differs or a pinned quirk broke`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`[check-protocol] TOOL ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
