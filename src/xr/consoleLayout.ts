/**
 * Layout of the holo-console: one gently curved desk in front of the user, below the hologram,
 * within arm's reach. Pure numbers (no three.js objects) so it can be tested.
 *
 * Console frame: origin where the user stands (floor), −z straight ahead, y up. The console's
 * surface is part of a vertical cylinder of radius `radius` whose front-most line is `distance`
 * ahead of the user and `below` under the eyes, tilted back by `tilt` so it faces the eyes.
 * Coordinates on the surface: `s` = metres along the arc (right positive), `v` = metres up the
 * tilted surface.
 *
 *   ┌──────────────┐ ┌────────────────────┐ ┌──────────────┐   ← facets (flat, v ≈ 0.15)
 *   │ API · läge   │ │ info               │ │ lager · vy   │
 *   │ modell       │ │                    │ │              │
 *   └──────────────┘ └────────────────────┘ └──────────────┘
 *   ‹ [0][1][2] … [19] ›                                         ← stage strip (v = 0, curved)
 */

export const CONSOLE = {
  /** Curvature radius of the console surface. */
  radius: 0.75,
  /** Horizontal distance from the user to the strip. */
  distance: 0.38,
  /** Height of the strip below the eyes (clamped to a sensible table height). */
  below: 0.55,
  minHeight: 0.7,
  maxHeight: 1.3,
  /** Tilt back from vertical (radians). */
  tilt: (48 * Math.PI) / 180,
  /** Start following when the head has turned this far from the console (radians)… */
  followAngle: (35 * Math.PI) / 180,
  /** …and stop once it is this close again. */
  settleAngle: (4 * Math.PI) / 180,
  /** Follow the user when they have walked this far (m). */
  followMove: 0.4,
  /** Gap between the stage strip and the facets above it. */
  stripGap: 0.013,
};

export type ConsoleKind = 'button' | 'tile' | 'slider' | 'info' | 'plate' | 'handle';
export type Facet = 'left' | 'center' | 'right' | 'top' | 'strip';

export interface ConsoleItem {
  id: string;
  kind: ConsoleKind;
  facet: Facet;
  /** Position within the facet (metres, facet centre = 0). For the strip, `x` is the arc position `s`. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Interactive area (≥ 4 × 4 cm). */
  hitW: number;
  hitH: number;
  /** Strip tiles: stage index. */
  index?: number;
}

export const FACET = {
  sideW: 0.27,
  centerW: 0.36,
  h: 0.23,
  gap: 0.012,
};

const STRIP = { pitch: 0.042, tileW: 0.038, tileH: 0.044, hitH: 0.048, arrowW: 0.05, gap: 0.006 };
const ROW = { h: 0.042, gap: 0.006, pad: 0.008, label: 0.016 };

/** Where each facet's centre is on the console surface. */
export function facetCentre(f: Exclude<Facet, 'strip'>): { s: number; v: number } {
  const v = STRIP.hitH / 2 + CONSOLE.stripGap + FACET.h / 2;
  const side = FACET.centerW / 2 + FACET.gap + FACET.sideW / 2;
  if (f === 'left') return { s: -side, v };
  if (f === 'right') return { s: side, v };
  if (f === 'top') return { s: 0, v: v + FACET.h / 2 + 0.028 };
  return { s: 0, v };
}

function hit(w: number, h: number): [number, number] {
  return [Math.max(w, 0.04), Math.max(h, 0.04)];
}

function item(id: string, kind: ConsoleKind, facet: Facet, x: number, y: number, w: number, h: number, hw?: number, hh?: number): ConsoleItem {
  const [a, b] = hit(w, h);
  return { id, kind, facet, x, y, w, h, hitW: hw ?? a, hitH: hh ?? b };
}

/** Rows from the top of a facet: the label row, then button rows of `ROW.h`. Returns row centres. */
function rows(heights: number[]): number[] {
  let y = FACET.h / 2 - ROW.pad - ROW.label - ROW.gap;
  return heights.map((h) => {
    const c = y - h / 2;
    y -= h + ROW.gap;
    return c;
  });
}

/** Evenly spread `n` buttons over the facet's inner width. */
function cols(n: number, inner = FACET.sideW - ROW.pad * 2): { w: number; xs: number[] } {
  const w = (inner - ROW.gap * (n - 1)) / n;
  return { w, xs: Array.from({ length: n }, (_, i) => -inner / 2 + w / 2 + i * (w + ROW.gap)) };
}

/** The label row's centre (top of each side facet). */
export const LABEL_Y = FACET.h / 2 - ROW.pad - ROW.label / 2;

export const MODEL_IDS = ['teapot', 'cube', 'sphere', 'torusknot', 'ico', 'triangle'] as const;
export const LAYER_IDS = ['solid', 'wire', 'points', 'normals'] as const;
export const API_IDS = ['opengl', 'vulkan', 'd3d12'] as const;

/** Every item of the console. `stages` = number of pipeline stages in the strip. */
export function consoleLayout(stages = 20): ConsoleItem[] {
  const out: ConsoleItem[] = [];
  // Facet plates (passive backgrounds; the centre one is the info screen).
  out.push(item('plate:left', 'plate', 'left', 0, 0, FACET.sideW, FACET.h));
  out.push(item('info', 'info', 'center', 0, 0, FACET.centerW, FACET.h));
  out.push(item('plate:right', 'plate', 'right', 0, 0, FACET.sideW, FACET.h));

  // Left: API, mode, model.
  const [rApi, rMode, rM1, rM2] = rows([ROW.h, ROW.h, ROW.h, ROW.h]);
  const c3 = cols(3);
  API_IDS.forEach((a, i) => out.push(item(`api:${a}`, 'button', 'left', c3.xs[i], rApi, c3.w, ROW.h)));
  const c2 = cols(2);
  out.push(item('mode:data', 'button', 'left', c2.xs[0], rMode, c2.w, ROW.h));
  out.push(item('mode:concept', 'button', 'left', c2.xs[1], rMode, c2.w, ROW.h));
  MODEL_IDS.forEach((m, i) => out.push(item(`model:${m}`, 'button', 'left', c3.xs[i % 3], i < 3 ? rM1 : rM2, c3.w, ROW.h)));

  // Right: layers, pull-apart slider, view / sound / pin / exit.
  const sliderH = 0.046;
  const [rLay, rSl, rV1, rV2] = rows([ROW.h, sliderH, ROW.h, ROW.h]);
  const c4 = cols(4);
  LAYER_IDS.forEach((l, i) => out.push(item(`layer:${l}`, 'button', 'right', c4.xs[i], rLay, c4.w, ROW.h)));
  const inner = FACET.sideW - ROW.pad * 2;
  out.push(item('slider:explode', 'slider', 'right', 0, rSl, inner, sliderH));
  out.push(item('reset', 'button', 'right', c2.xs[0], rV1, c2.w, ROW.h));
  out.push(item('sound', 'button', 'right', c2.xs[1], rV1, c2.w, ROW.h));
  out.push(item('pin', 'button', 'right', c2.xs[0], rV2, c2.w, ROW.h));
  out.push(item('exit', 'button', 'right', c2.xs[1], rV2, c2.w, ROW.h));

  // Top: the grab handle for moving the whole console.
  out.push(item('handle', 'handle', 'top', 0, 0, 0.17, 0.028, 0.2, 0.044));

  // Stage strip: ‹ [0] … [n−1] › in one row along the curve.
  const half = (stages * STRIP.pitch) / 2;
  for (let i = 0; i < stages; i++) {
    const s = -half + STRIP.pitch / 2 + i * STRIP.pitch;
    out.push({ ...item(`stage:${i}`, 'tile', 'strip', s, 0, STRIP.tileW, STRIP.tileH, STRIP.pitch, STRIP.hitH), index: i });
  }
  const arrowS = half + STRIP.gap + STRIP.arrowW / 2;
  out.push(item('prev', 'button', 'strip', -arrowS, 0, STRIP.arrowW, STRIP.tileH, STRIP.arrowW, STRIP.hitH));
  out.push(item('next', 'button', 'strip', arrowS, 0, STRIP.arrowW, STRIP.tileH, STRIP.arrowW, STRIP.hitH));
  return out;
}

/** Height of the console strip for a user whose eyes are at `eyeY`. */
export function consoleHeight(eyeY: number): number {
  return Math.min(CONSOLE.maxHeight, Math.max(CONSOLE.minHeight, eyeY - CONSOLE.below));
}

export type V3 = [number, number, number];

export interface SurfacePose {
  position: V3;
  /** Euler angles (order 'YXZ'): yaw around y, then tilt around x. */
  yaw: number;
  tilt: number;
  right: V3;
  up: V3;
  normal: V3;
}

/** Pose of the console surface at arc position `s`, height `v` (console frame, strip at height `y0`). */
export function surfacePose(s: number, v: number, y0: number, c = CONSOLE): SurfacePose {
  const th = s / c.radius;
  const a = c.tilt;
  const r = c.radius + v * Math.sin(a);
  const position: V3 = [r * Math.sin(th), y0 + v * Math.cos(a), -c.distance + c.radius - r * Math.cos(th)];
  const right: V3 = [Math.cos(th), 0, Math.sin(th)];
  const up: V3 = [Math.sin(a) * Math.sin(th), Math.cos(a), -Math.sin(a) * Math.cos(th)];
  const normal: V3 = [-Math.sin(th) * Math.cos(a), Math.sin(a), Math.cos(th) * Math.cos(a)];
  return { position, yaw: -th, tilt: -a, right, up, normal };
}

/** Pose of an item in the console frame (strip items sit on the curve, the rest on flat facets). */
export function itemPose(it: ConsoleItem, y0: number): SurfacePose {
  if (it.facet === 'strip') return surfacePose(it.x, it.y, y0);
  const f = facetCentre(it.facet);
  const base = surfacePose(f.s, f.v, y0);
  const p = base.position.map((p, k) => p + base.right[k] * it.x + base.up[k] * it.y) as V3;
  return { ...base, position: p };
}

/* ------------------------------------------------------------------ */
/* Lazy follow                                                         */
/* ------------------------------------------------------------------ */

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Lazy follow: once the head has turned more than `followAngle` away from the console, it starts
 * swinging round to face the user again, and stops when within `settleAngle`.
 */
export function followStep(consoleYaw: number, headYaw: number, following: boolean, c = CONSOLE): { following: boolean; target: number } {
  const diff = Math.abs(wrap(headYaw - consoleYaw));
  if (!following && diff > c.followAngle) following = true;
  else if (following && diff < c.settleAngle) following = false;
  return { following, target: following ? headYaw : consoleYaw };
}

/* ------------------------------------------------------------------ */
/* Hand menu                                                           */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  id: 'hm:prev' | 'hm:next' | 'hm:api' | 'hm:summon';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The palm-up hand menu: a 2 × 2 grid of 4.6 cm buttons. Local frame: x right, y up, facing +z. */
export function handMenuLayout(): MenuItem[] {
  const s = 0.046;
  const p = 0.052;
  return [
    { id: 'hm:prev', x: -p / 2, y: p / 2, w: s, h: s },
    { id: 'hm:next', x: p / 2, y: p / 2, w: s, h: s },
    { id: 'hm:api', x: -p / 2, y: -p / 2, w: s, h: s },
    { id: 'hm:summon', x: p / 2, y: -p / 2, w: s, h: s },
  ];
}
