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

  const BREAK_SOUND: Record<SoundKind, BurstOptions> = {
    stone: { freq: 950, dur: 0.16, gain: 0.5 },
    soft: { freq: 420, dur: 0.14, gain: 0.45, type: 'lowpass' },
    wood: { freq: 620, dur: 0.15, gain: 0.45 },
  };

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
