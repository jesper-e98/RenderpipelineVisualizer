/**
 * Tiny synthesized UI sounds for the holo-lab (no audio files). Created lazily on the first
 * call, which always happens after the user clicked "VR"/"AR", so autoplay rules are satisfied.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.4, glideTo?: number, delay = 0): void {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  hover: () => tone(1800, 0.04, 'sine', 0.06),
  press: () => {
    tone(880, 0.07, 'triangle', 0.25);
    tone(1320, 0.09, 'sine', 0.18, undefined, 0.05);
  },
  grab: () => tone(220, 0.18, 'sawtooth', 0.08, 440),
  release: () => tone(440, 0.15, 'sine', 0.08, 220),
  explode: () => tone(160, 0.35, 'sawtooth', 0.06, 90),
  boot: () => {
    tone(110, 1.4, 'sawtooth', 0.05, 880);
    tone(220, 1.2, 'sine', 0.08, 1760, 0.2);
    tone(1320, 0.25, 'triangle', 0.15, undefined, 1.3);
  },
  step: () => tone(660, 0.12, 'sine', 0.12, 990),
  setMuted(m: boolean) {
    muted = m;
  },
  get muted() {
    return muted;
  },
};
