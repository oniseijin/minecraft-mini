/**
 * Procedural WebAudio SFX — synthesized noise bursts and thuds, no asset
 * files. The AudioContext is created lazily on the first user gesture (the
 * click-to-play overlay), so the loading screen and headless tests never
 * touch audio. Everything routes through a quiet master gain (~0.3);
 * M toggles mute and the preference persists in localStorage.
 */

import { BEDROCK, COBBLE, GLASS, LOG, PLANKS, STONE } from '@mc/shared';

/** Material families that get distinct break/step sounds. */
export type SoundKind = 'stone' | 'soft' | 'wood';

export function blockSoundKind(blockId: number): SoundKind {
  switch (blockId) {
    case STONE:
    case COBBLE:
    case BEDROCK:
    case GLASS:
      return 'stone';
    case LOG:
    case PLANKS:
      return 'wood';
    default:
      return 'soft'; // grass, dirt, sand, snow, leaves, water, …
  }
}

export interface GameAudio {
  /** Create/resume the AudioContext — call from a user gesture once. */
  resume(): void;
  blockBreak(kind: SoundKind): void;
  blockPlace(): void;
  footstep(kind: SoundKind): void;
  /** Landing after a fall > 1.5 blocks. */
  land(): void;
  /** Entered water. */
  splash(): void;
  // --- BedWars (M4) — procedural cosmetics, all quiet ---
  /** Landed a melee hit (attacker feedback). */
  hit(): void;
  /** Took damage (short low thud). */
  hurt(): void;
  /** Own death: descending tone. */
  deathSound(): void;
  /** Bed destroyed: deep boom + crunch. */
  bedBreak(): void;
  /** Shop purchase: rising double blip. */
  purchase(): void;
  /** Generic short beep (countdown ticks, respawn). */
  beep(freq?: number): void;
  /** "FIGHT!": quick two-note rise. */
  fight(): void;
  /** Match won: little arpeggio. */
  win(): void;
  /** Match lost: falling two-note. */
  lose(): void;
  /** Golden apple gulp. */
  eat(): void;
  // --- Block Party (M5) — procedural cosmetics, all quiet ---
  /** Floor pieces vanishing: falling filtered-noise whoosh. */
  whoosh(): void;
  /** Won a round (not the match): quick two-note rise. */
  roundWin(): void;
  /** Auto color bomb fuse: accelerating tick (urgency 0..1 raises pitch). */
  bombTick(urgency: number): void;
  /** Color bomb detonation: deep boom + spray of debris noise. */
  boom(): void;
  // --- Block Party power-ups (M5.2) — procedural cosmetics, all quiet ---
  /** Mystery box pickup: bright sparkly two-blip. */
  pickup(): void;
  /** Item used: short confirmation blip (any item). */
  itemUse(): void;
  /** Spectate Color Zapper: quick descending zap. */
  zap(): void;
  // --- Mobs (M5.3) — procedural cosmetics, all quiet ---
  /** Punched a mob: soft low thud (gentler than the player hit). */
  mobHit(): void;
  /** Mob death poof: tiny airy puff. */
  mobPoof(): void;
  /** Zombie contact shove: heavier thud + a short groan layered under it. */
  zombieShove(): void;
  /** Idle zombie groan (proximity-triggered): low pitch-wobbling drone. */
  zombieGroan(): void;
  toggleMute(): boolean;
  readonly muted: boolean;
  dispose(): void;
}

const MASTER_GAIN = 0.3;
const MUTE_KEY = 'mc-muted';

interface BurstOptions {
  freq: number;
  q?: number;
  dur: number;
  gain: number;
  type?: BiquadFilterType;
}

export function createGameAudio(): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';

  /** Creates the context + a shared 0.5 s white-noise buffer. */
  function ensure(): boolean {
    if (!ctx) {
      if (typeof window.AudioContext === 'undefined') return false;
      ctx = new window.AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(ctx.destination);
      const length = Math.floor(ctx.sampleRate * 0.5);
      noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }

  /** True only when audio was already unlocked by a gesture (sfx are quiet no-ops before that). */
  function ready(): boolean {
    if (!ctx) return false;
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }

  /** Filtered noise burst with an exponential decay — the workhorse. */
  function burst({ freq, q = 1, dur, gain, type = 'bandpass' }: BurstOptions): void {
    if (!ctx || !master || !noise) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3; // slight pitch variety
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter).connect(env).connect(master);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /** Pitch-dropping sine — the body of thuds. */
  function thud(freq: number, dur: number, gain: number): void {
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.55), now + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(env).connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  /** Plain sine blip with its own envelope (beeps, coins, jingles). */
  function blip(freq: number, dur: number, gain: number, at = 0, type: OscillatorType = 'sine'): void {
    if (!ctx || !master) return;
    const now = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(env).connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  const BREAK_SOUND: Record<SoundKind, BurstOptions> = {
    stone: { freq: 950, dur: 0.16, gain: 0.5 },
    soft: { freq: 420, dur: 0.14, gain: 0.45, type: 'lowpass' },
    wood: { freq: 620, dur: 0.15, gain: 0.45 },
  };

  /** One note of a blip-sequence jingle (offset `at` in seconds). */
  interface JingleNote {
    freq: number;
    dur: number;
    gain: number;
    at?: number;
    type?: OscillatorType;
  }

  /**
   * The blip-sequence jingles as data (REFACTORING.md Phase 3) — each used to
   * be a hand-written run of blip() calls differing only in note values.
   */
  const JINGLES: Record<'purchase' | 'fight' | 'win' | 'lose' | 'roundWin' | 'pickup' | 'itemUse', JingleNote[]> = {
    purchase: [
      { freq: 660, dur: 0.07, gain: 0.2 },
      { freq: 990, dur: 0.09, gain: 0.2, at: 0.08 },
    ],
    fight: [
      { freq: 523, dur: 0.1, gain: 0.25, type: 'triangle' },
      { freq: 784, dur: 0.18, gain: 0.25, at: 0.1, type: 'triangle' },
    ],
    win: [
      { freq: 523, dur: 0.14, gain: 0.22, type: 'triangle' },
      { freq: 659, dur: 0.14, gain: 0.22, at: 0.13, type: 'triangle' },
      { freq: 784, dur: 0.14, gain: 0.22, at: 0.26, type: 'triangle' },
      { freq: 1047, dur: 0.3, gain: 0.22, at: 0.39, type: 'triangle' },
    ],
    lose: [
      { freq: 392, dur: 0.2, gain: 0.22, type: 'triangle' },
      { freq: 262, dur: 0.4, gain: 0.22, at: 0.2, type: 'triangle' },
    ],
    roundWin: [
      { freq: 659, dur: 0.09, gain: 0.2, type: 'triangle' },
      { freq: 988, dur: 0.16, gain: 0.2, at: 0.09, type: 'triangle' },
    ],
    pickup: [
      { freq: 720, dur: 0.07, gain: 0.2, type: 'triangle' },
      { freq: 1080, dur: 0.12, gain: 0.2, at: 0.07, type: 'triangle' },
    ],
    itemUse: [
      { freq: 540, dur: 0.06, gain: 0.18, type: 'square' },
      { freq: 810, dur: 0.1, gain: 0.18, at: 0.05, type: 'square' },
    ],
  };

  /** Plays one table jingle (caller gates on ready() first, as before). */
  function jingle(name: keyof typeof JINGLES): void {
    for (const note of JINGLES[name]) blip(note.freq, note.dur, note.gain, note.at ?? 0, note.type ?? 'sine');
  }

  return {
    resume() {
      ensure();
    },
    blockBreak(kind) {
      if (!ready()) return;
      burst(BREAK_SOUND[kind]);
      if (kind === 'stone') burst({ freq: 2200, dur: 0.08, gain: 0.18 }); // crunch top end
    },
    blockPlace() {
      if (!ready()) return;
      burst({ freq: 700, dur: 0.07, gain: 0.25, type: 'lowpass' });
      thud(190, 0.1, 0.2);
    },
    footstep(kind) {
      if (!ready()) return;
      const freq = kind === 'stone' ? 800 : kind === 'wood' ? 550 : 350;
      burst({ freq, dur: 0.06, gain: 0.1, type: 'lowpass' });
    },
    land() {
      if (!ready()) return;
      burst({ freq: 300, dur: 0.14, gain: 0.4, type: 'lowpass' });
      thud(140, 0.14, 0.3);
    },
    splash() {
      if (!ready()) return;
      const now = ctx!.currentTime;
      const src = ctx!.createBufferSource();
      src.buffer = noise!;
      src.loop = true;
      const filter = ctx!.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(400, now);
      filter.frequency.linearRampToValueAtTime(1600, now + 0.12);
      filter.frequency.linearRampToValueAtTime(300, now + 0.4);
      const env = ctx!.createGain();
      env.gain.setValueAtTime(0.001, now);
      env.gain.linearRampToValueAtTime(0.35, now + 0.08); // swell…
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.45); // …then settle
      src.connect(filter).connect(env).connect(master!);
      src.start(now);
      src.stop(now + 0.5);
    },
    hit() {
      if (!ready()) return;
      burst({ freq: 1300, dur: 0.07, gain: 0.3 });
      thud(260, 0.09, 0.25);
    },
    hurt() {
      if (!ready()) return;
      burst({ freq: 300, dur: 0.12, gain: 0.35, type: 'lowpass' });
      thud(180, 0.16, 0.4);
    },
    deathSound() {
      if (!ready()) return;
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(330, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.55);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.22, now);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
      osc.connect(env).connect(master);
      osc.start(now);
      osc.stop(now + 0.6);
    },
    bedBreak() {
      if (!ready()) return;
      thud(95, 0.5, 0.6);
      burst({ freq: 500, dur: 0.4, gain: 0.5 });
      burst({ freq: 1800, dur: 0.2, gain: 0.2 });
    },
    purchase() {
      if (!ready()) return;
      jingle('purchase');
    },
    beep(freq = 880) {
      if (!ready()) return;
      blip(freq, 0.09, 0.18);
    },
    fight() {
      if (!ready()) return;
      jingle('fight');
    },
    win() {
      if (!ready()) return;
      jingle('win');
    },
    lose() {
      if (!ready()) return;
      jingle('lose');
    },
    eat() {
      if (!ready()) return;
      burst({ freq: 500, dur: 0.08, gain: 0.3, type: 'lowpass' });
      burst({ freq: 400, dur: 0.08, gain: 0.3, type: 'lowpass' });
    },
    whoosh() {
      if (!ready() || !ctx || !master || !noise) return;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.8;
      filter.frequency.setValueAtTime(1800, now);
      filter.frequency.exponentialRampToValueAtTime(220, now + 0.45);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.001, now);
      env.gain.linearRampToValueAtTime(0.4, now + 0.05);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      src.connect(filter).connect(env).connect(master);
      src.start(now);
      src.stop(now + 0.5);
    },
    roundWin() {
      if (!ready()) return;
      jingle('roundWin');
    },
    bombTick(urgency) {
      if (!ready()) return;
      blip(520 + Math.max(0, Math.min(1, urgency)) * 640, 0.06, 0.16, 0, 'square');
    },
    boom() {
      if (!ready()) return;
      thud(70, 0.5, 0.6);
      burst({ freq: 380, dur: 0.35, gain: 0.5, type: 'lowpass' });
      burst({ freq: 1400, dur: 0.14, gain: 0.22 });
    },
    pickup() {
      if (!ready()) return;
      jingle('pickup');
    },
    itemUse() {
      if (!ready()) return;
      jingle('itemUse');
    },
    zap() {
      if (!ready()) return;
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1600, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.18);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.22, now);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(env).connect(master);
      osc.start(now);
      osc.stop(now + 0.2);
      burst({ freq: 2400, dur: 0.1, gain: 0.16 });
    },
    mobHit() {
      if (!ready()) return;
      burst({ freq: 500, dur: 0.07, gain: 0.18, type: 'lowpass' });
      thud(170, 0.09, 0.16);
    },
    mobPoof() {
      if (!ready()) return;
      burst({ freq: 1400, dur: 0.22, gain: 0.12, type: 'lowpass' });
    },
    zombieShove() {
      if (!ready()) return;
      thud(110, 0.22, 0.5);
      burst({ freq: 300, dur: 0.15, gain: 0.2, type: 'lowpass' });
    },
    zombieGroan() {
      if (!ready()) return;
      const t = ctx!.currentTime;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(95, t);
      osc.frequency.linearRampToValueAtTime(70, t + 0.5); // sinking pitch
      osc.frequency.linearRampToValueAtTime(85, t + 0.9);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.15);
      gain.gain.linearRampToValueAtTime(0.0001, t + 0.95);
      osc.connect(gain).connect(master!);
      osc.start(t);
      osc.stop(t + 1);
    },
    toggleMute() {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.01);
      return muted;
    },
    get muted() {
      return muted;
    },
    dispose() {
      void ctx?.close().catch(() => undefined);
      ctx = null;
      master = null;
      noise = null;
    },
  };
}
