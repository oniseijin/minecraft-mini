/**
 * M1 worldgen sanity check: determinism, bounds and content assertions.
 *
 * Run with: npx tsx tools/check-worldgen.ts
 */

import {
  BEDROCK,
  BLOCKS,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_VOLUME,
  GRASS,
  LEAVES,
  LOG,
  SAND,
  SEA_LEVEL,
  SNOW,
  WATER,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  generateWorld,
} from '@mc/shared';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failures += 1;
}

const SEED = 1337;
console.log(`[check-worldgen] generating world twice with seed ${SEED}…`);
const t0 = performance.now();
const a = generateWorld(SEED);
const b = generateWorld(SEED);
const genMs = (performance.now() - t0) / 2;
console.log(`[check-worldgen] ${CHUNKS_X * CHUNKS_Z} chunks generated in ${genMs.toFixed(0)} ms (avg of 2 runs)\n`);

console.log('Determinism & bounds:');
check(
  'chunk grid complete',
  a.chunks.size === CHUNKS_X * CHUNKS_Z,
  `${a.chunks.size} chunks (expected ${CHUNKS_X * CHUNKS_Z})`,
);

let mismatchedBytes = 0;
let outOfRangeIds = 0;
let malformedChunks = 0;
for (const [key, ca] of a.chunks) {
  const cb = b.chunks.get(key);
  if (!cb || ca.length !== CHUNK_VOLUME) {
    malformedChunks += 1;
    continue;
  }
  for (let i = 0; i < ca.length; i++) {
    if (ca[i] !== cb[i]) mismatchedBytes += 1;
    if (ca[i] >= BLOCKS.length) outOfRangeIds += 1;
  }
}
check('deterministic (identical chunk bytes)', mismatchedBytes === 0, `${mismatchedBytes} differing bytes`);
check('chunk arrays sized 16×64×16', malformedChunks === 0, `${malformedChunks} malformed chunks`);
check('block ids within registry', outOfRangeIds === 0, `${outOfRangeIds} out-of-range ids`);

// Column scan: bedrock completeness + terrain height bound.
let bedrockColumns = 0;
let maxBlockY = 0;
for (let z = 0; z < WORLD_SIZE_Z; z++) {
  for (let x = 0; x < WORLD_SIZE_X; x++) {
    if (a.getBlock(x, 0, z) === BEDROCK) bedrockColumns += 1;
    for (let y = WORLD_SIZE_Y - 1; y >= 0; y--) {
      if (a.getBlock(x, y, z) !== 0) {
        if (y > maxBlockY) maxBlockY = y;
        break;
      }
    }
  }
}

const tally = new Map<number, number>();
for (const chunk of a.chunks.values()) {
  for (const cell of chunk) tally.set(cell, (tally.get(cell) ?? 0) + 1);
}
const count = (id: number): number => tally.get(id) ?? 0;

console.log('\nContent:');
check(
  'bedrock layer complete at y=0',
  bedrockColumns === WORLD_SIZE_X * WORLD_SIZE_Z,
  `${bedrockColumns}/${WORLD_SIZE_X * WORLD_SIZE_Z} columns`,
);
check(
  'all blocks inside world height',
  maxBlockY < WORLD_SIZE_Y,
  `highest block y=${maxBlockY} (world height ${WORLD_SIZE_Y})`,
);
check('grass present', count(GRASS) > 1000, `${count(GRASS)} grass blocks`);
check('water present', count(WATER) > 5000, `${count(WATER)} water blocks (sea level ${SEA_LEVEL})`);
check('trees present', count(LEAVES) > 20, `${count(LEAVES)} leaf / ${count(LOG)} log blocks`);

const centerHighest = a.highestBlock(128, 128);
const spawnY = Math.max(centerHighest, SEA_LEVEL) + 3;

console.log('\nSummary:');
const parts = [...tally.entries()]
  .sort((p, q) => p[0] - q[0])
  .map(([id, n]) => `${BLOCKS[id]?.name ?? id}=${n}`)
  .join(', ');
console.log(`  blocks: ${parts}`);
console.log(`  sand=${count(SAND)} snow=${count(SNOW)} (sanity, not asserted)`);
console.log(`  terrain top at center (128,128): y=${centerHighest}`);
console.log(`  spawn point: (${128.5}, ${spawnY}, ${128.5})`);

console.log(
  failures === 0
    ? '\n[check-worldgen] ALL CHECKS PASSED'
    : `\n[check-worldgen] ${failures} CHECK(S) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
