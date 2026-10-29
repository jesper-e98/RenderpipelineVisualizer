import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type Ray,
} from 'three';
import { farSelect, HOVER, hitSize, inRect, pickNearest, poke0, pokeHover, pokeStep, POKE, stickyHover, type HoverState, type PokeState } from './interaction';
import type { Pointer } from './XRInput';
import { sfx } from './sounds';

export interface ControlState {
  hover: boolean;
  pressed: boolean;
  active: boolean;
  enabled: boolean;
  value: number;
}

export type DrawFn = (g: CanvasRenderingContext2D, w: number, h: number, st: ControlState) => void;

/** Canvas resolution of controls (pixels per metre): ~2× the headset's resolution at 0.6 m. */
const PX_PER_M = 2600;
let autoId = 0;

/**
 * A flat interactive surface: a button, slider, tile, handle or a whole panel. `root` is placed by
 * the layout (local +z = front); the visual `mesh` sits inside it and is pushed in when poked.
 */
export class HoloControl {
  readonly root = new Group();
  readonly mesh: Mesh;
  readonly state: ControlState = { hover: false, pressed: false, active: false, enabled: true, value: 0 };
  id: string;
  /** Interactive area, at least 4 × 4 cm even if the visual is smaller. */
  hitW: number;
  hitH: number;
  /** How far (m) the visual travels when pushed all the way in. */
  travel = POKE.travel;
  /** 0..1 how far the button is pushed in (target; the visual eases towards it). */
  depth = 0;
  private shown = 0;
  private canvas: HTMLCanvasElement | null = null;
  private tex: CanvasTexture | null = null;
  private drawn = '';
  private flashT = 0;
  onPress?: (u: number, v: number, p: Pointer) => void;
  onHover?: (u: number | null, v: number | null) => void;
  /** Continuous drag (sliders): u, v in 0..1 over the control. */
  onDrag?: (u: number, v: number) => void;
  /** Pinch-hold (handles): called on start / every frame / end while pinched with the ray. */
  onHoldStart?: (p: Pointer, point: Vector3) => void;
  onHoldMove?: (p: Pointer) => void;
  onHoldEnd?: (p: Pointer) => void;
  isActive?: () => boolean;
  isEnabled?: () => boolean;
  getValue?: () => number;
  /** Extra input to the redraw key (e.g. a label that depends on language). */
  labelKey?: () => string;
  /** Decoration only: drawn and it stops rays (nothing behind it is grabbed), but never hovered or pressed. */
  passive = false;
  /** Pointers that may not use this control (e.g. the hand a hand menu is attached to). */
  ignore?: (p: Pointer) => boolean;

  constructor(
    readonly w: number,
    readonly h: number,
    private draw?: DrawFn,
    mesh?: Mesh,
    id?: string,
  ) {
    this.id = id ?? `c${autoId++}`;
    [this.hitW, this.hitH] = hitSize(w, h);
    if (mesh) {
      this.mesh = mesh;
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = Math.max(32, Math.round(w * PX_PER_M));
      this.canvas.height = Math.max(16, Math.round(h * PX_PER_M));
      this.tex = new CanvasTexture(this.canvas);
      this.tex.colorSpace = SRGBColorSpace;
      this.tex.anisotropy = 4;
      this.mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: this.tex, transparent: true, side: DoubleSide, depthWrite: false }));
      this.mesh.renderOrder = 30;
    }
    this.mesh.userData.holoControl = this;
    this.root.add(this.mesh);
  }

  setHit(w: number, h: number): this {
    [this.hitW, this.hitH] = hitSize(w, h);
    return this;
  }

  /** Brief "pressed" flash after a press. */
  flash(nowMs: number): void {
    this.flashT = nowMs + 170;
  }

  /** Ease the visual towards its pushed-in depth and keep the pressed flash up to date. */
  animate(nowMs: number, dt: number): void {
    const k = 1 - Math.exp(-dt / 0.035);
    this.shown += (this.depth - this.shown) * k;
    this.mesh.position.z = -this.shown * this.travel;
    const pressed = nowMs < this.flashT || this.depth > 0.6;
    if (pressed !== this.state.pressed) this.state.pressed = pressed;
  }

  /** Re-render the canvas if anything visible changed. */
  refresh(force = false): void {
    if (this.isActive) this.state.active = this.isActive();
    if (this.isEnabled) this.state.enabled = this.isEnabled();
    if (this.getValue) this.state.value = this.getValue();
    if (!this.canvas || !this.draw) return;
    const s = this.state;
    const key = `${+s.hover}${+s.pressed}${+s.active}${+s.enabled}${s.value.toFixed(3)}|${this.labelKey?.() ?? ''}`;
    if (!force && key === this.drawn) return;
    this.drawn = key;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.draw(g, this.canvas.width, this.canvas.height, this.state);
    this.tex!.needsUpdate = true;
  }
}

interface RayHit {
  c: HoloControl;
  dist: number;
  off: number;
  passive: boolean;
  id: string;
  x: number;
  y: number;
  point: Vector3;
}

interface PointerUI {
  hover: HoverState;
  pending: string | null;
  held: HoloControl | null;
  /** Current poke target and its state. */
  poke: { c: HoloControl; s: PokeState } | null;
}

/** Proximity ring shown on a surface under an approaching fingertip. */
class PokeCursor {
  readonly group = new Group();
  private ring: Mesh;
  private dot: Mesh;
  constructor(color: number) {
    const mat = () => new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, depthTest: false, side: DoubleSide });
    this.ring = new Mesh(new RingGeometry(0.0075, 0.0095, 40), mat());
    this.dot = new Mesh(new CircleGeometry(0.0035, 24), mat());
    this.ring.renderOrder = this.dot.renderOrder = 40;
    this.group.add(this.ring, this.dot);
    this.group.visible = false;
  }
  /** `prox` 1 = far (big faint ring) … 0 = touching (small bright ring + filled dot). */
  show(c: HoloControl, x: number, y: number, prox: number): void {
    c.root.updateMatrixWorld();
    this.group.position.set(x, y, 0.0015).applyMatrix4(c.root.matrixWorld);
    c.root.getWorldQuaternion(this.group.quaternion);
    this.ring.scale.setScalar(0.55 + prox * 1.3);
    (this.ring.material as MeshBasicMaterial).opacity = 0.35 + (1 - prox) * 0.65;
    (this.dot.material as MeshBasicMaterial).opacity = (1 - prox) * 0.95;
    this.group.visible = true;
  }
  hide(): void {
    this.group.visible = false;
  }
}

/**
 * Drives every HoloControl from the pointers:
 *  - poking with the fingertip (a 1 cm sphere): proximity ring, buttons travel in, fire when pushed
 *    deep enough, only from the front, re-arm after pulling back,
 *  - rays: sticky hover, pinch-and-release over the same target to select (like the Quest UI),
 *    pinch-drag for sliders and handles.
 * Returns which pointers are busy with the UI so they don't also grab the hologram.
 */
export class HoloUI {
  readonly root = new Group();
  readonly controls: HoloControl[] = [];
  private byId = new Map<string, HoloControl>();
  private ptr = new Map<number, PointerUI>();
  private cursors = new Map<number, PokeCursor>();
  private lastMs = 0;
  /** For tests/debugging: the id of the last control that fired. */
  lastPress: string | null = null;

  add(c: HoloControl, parent: Object3D = this.root): HoloControl {
    if (this.byId.has(c.id)) c.id = `${c.id}#${this.controls.length}`;
    this.controls.push(c);
    this.byId.set(c.id, c);
    parent.add(c.root);
    c.refresh(true);
    return c;
  }

  get(id: string): HoloControl | undefined {
    return this.byId.get(id);
  }

  refreshAll(force = false): void {
    for (const c of this.controls) c.refresh(force);
  }

  /** Is this pointer pinch-holding a control (slider / handle)? */
  holding(pointerId: number): boolean {
    return !!this.ptr.get(pointerId)?.held;
  }

  /** Ids of the controls currently hovered. */
  hoveredIds(): string[] {
    return this.controls.filter((c) => c.state.hover).map((c) => c.id);
  }

  visible(c: HoloControl): boolean {
    let o: Object3D | null = c.root;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  private state(id: number): PointerUI {
    let s = this.ptr.get(id);
    if (!s) {
      s = { hover: { id: null, lostAt: null }, pending: null, held: null, poke: null };
      this.ptr.set(id, s);
    }
    return s;
  }

  private cursor(p: Pointer): PokeCursor {
    let c = this.cursors.get(p.id);
    if (!c) {
      c = new PokeCursor(p.handedness === 'left' ? 0x9b7bff : 0x38e1ff);
      this.cursors.set(p.id, c);
      this.root.add(c.group);
    }
    return c;
  }

  private press(c: HoloControl, u: number, v: number, p: Pointer, nowMs: number): void {
    if (!c.state.enabled) return;
    c.flash(nowMs);
    this.lastPress = c.id;
    c.onPress?.(u, v, p);
    sfx.press();
    p.pulse(0.5, 30);
  }

  /** The control a fingertip is poking / about to poke, with its signed sphere distance `d`. */
  pokeTarget(p: Pointer, live: HoloControl[], current: HoloControl | null): { c: HoloControl; d: number; x: number; y: number; inside: boolean } | null {
    if (!p.tip) return null;
    let best: { c: HoloControl; d: number; x: number; y: number; inside: boolean } | null = null;
    const local = new Vector3();
    for (const c of live) {
      if (c.passive || (c.ignore && c.ignore(p))) continue;
      local.copy(p.tip);
      c.root.worldToLocal(local);
      const d = local.z - POKE.radius;
      if (d > POKE.hover || d < -POKE.through) continue;
      const margin = c === current ? POKE.margin : 0;
      if (!inRect(local.x, local.y, c.hitW, c.hitH, margin)) continue;
      // Prefer the surface the finger is closest to; the current target wins ties.
      const score = Math.abs(d) - (c === current ? 0.004 : 0);
      if (!best || score < Math.abs(best.d) - (best.c === current ? 0.004 : 0)) best = { c, d, x: local.x, y: local.y, inside: true };
    }
    // Keep tracking the current target slightly outside its area so drifting cancels cleanly.
    if (!best && current && this.visible(current)) {
      local.copy(p.tip);
      current.root.worldToLocal(local);
      const d = local.z - POKE.radius;
      if (d < POKE.hover && d > -POKE.through) best = { c: current, d, x: local.x, y: local.y, inside: false };
    }
    return best;
  }

  /** Is this pointer's fingertip right in front of a control (about to poke it)? */
  nearUI(p: Pointer): boolean {
    if (!p.tip) return false;
    return !!this.pokeTarget(p, this.controls.filter((c) => this.visible(c)), null);
  }

  /** Ray against one control's hit rectangle (grown by `margin`). */
  rayHit(ray: Ray, c: HoloControl, margin = 0): RayHit | null {
    c.root.updateMatrixWorld();
    const inv = c.root.matrixWorld.clone().invert();
    const o = ray.origin.clone().applyMatrix4(inv);
    const d = ray.direction.clone().transformDirection(inv);
    // transformDirection normalises; recover the scale so distances stay in world units.
    if (Math.abs(d.z) < 1e-6) return null;
    const t = -o.z / d.z;
    if (t <= 0) return null;
    const lx = o.x + d.x * t;
    const ly = o.y + d.y * t;
    if (!inRect(lx, ly, c.hitW, c.hitH, margin)) return null;
    const point = new Vector3(lx, ly, 0).applyMatrix4(c.root.matrixWorld);
    const dist = point.distanceTo(ray.origin);
    return { c, id: c.id, dist, off: Math.max(Math.abs(lx) / (c.hitW / 2), Math.abs(ly) / (c.hitH / 2)), passive: c.passive, x: lx, y: ly, point };
  }

  /** Nearest UI surface along a ray (for the desktop simulator's cursor depth). */
  pick(ray: Ray): { id: string; dist: number; passive: boolean } | null {
    this.root.updateMatrixWorld(true);
    const hits = this.controls.filter((c) => this.visible(c)).map((c) => this.rayHit(ray, c)).filter((h): h is RayHit => !!h);
    const top = pickNearest(hits);
    return top ? { id: top.id, dist: top.dist, passive: top.c.passive } : null;
  }

  /**
   * Update all controls. `exclude` = pointers that are busy elsewhere (holding the hologram, or the
   * hand that carries the hand menu): they neither hover nor press anything.
   */
  update(pointers: Pointer[], nowMs: number, exclude: Set<number> = new Set()): Set<number> {
    const dt = this.lastMs ? Math.min(0.1, (nowMs - this.lastMs) / 1000) : 1 / 72;
    this.lastMs = nowMs;
    this.root.updateMatrixWorld(true);
    const busy = new Set<number>();
    const live = this.controls.filter((c) => this.visible(c));
    const hoverNow = new Set<HoloControl>();
    const depth = new Map<HoloControl, number>();
    const seen = new Set<number>();

    for (const p of pointers) {
      seen.add(p.id);
      const st = this.state(p.id);
      const cur = this.cursor(p);
      if (exclude.has(p.id)) {
        if (st.held) st.held.onHoldEnd?.(p);
        st.held = null;
        st.pending = null;
        st.poke = null;
        st.hover = { id: null, lostAt: null };
        cur.hide();
        continue;
      }

      // 1) Pinch-holding a slider / handle.
      if (st.held) {
        const c = st.held;
        busy.add(p.id);
        hoverNow.add(c);
        cur.hide();
        if (!p.pinch && !p.fist) {
          c.onHoldEnd?.(p);
          st.held = null;
          sfx.release();
          p.pulse(0.25, 20);
        } else {
          c.onHoldMove?.(p);
          const h = this.rayHit(p.ray, c, 10);
          if (h) {
            if (c.onDrag) c.onDrag(h.x / c.w + 0.5, h.y / c.h + 0.5);
            p.rayLength = h.dist;
          }
          p.rayMode = 'hit';
        }
        continue;
      }

      // 2) Fingertip pokes (not while pinching / making a fist / holding something).
      const canPoke = !!p.tip && !p.pinch && !p.fist && !p.holding;
      const pt = canPoke ? this.pokeTarget(p, live, st.poke?.c ?? null) : null;
      if (pt) {
        const prev = st.poke && st.poke.c === pt.c ? st.poke.s : poke0();
        const res = pokeStep(prev, pt.d, pt.inside, nowMs);
        if (st.poke?.c !== pt.c && pt.inside) {
          sfx.hover();
          p.pulse(0.1, 10);
        }
        st.poke = { c: pt.c, s: res.state };
        const u = pt.x / pt.c.w + 0.5;
        const v = pt.y / pt.c.h + 0.5;
        if (pt.inside && pokeHover(pt.d, true)) {
          hoverNow.add(pt.c);
          pt.c.onHover?.(u, v);
        }
        depth.set(pt.c, Math.max(depth.get(pt.c) ?? 0, res.depth));
        if (res.pressed && !pt.c.onDrag) this.press(pt.c, u, v, p, nowMs);
        if ((res.touching || res.pressed) && pt.c.onDrag && pt.c.state.enabled) pt.c.onDrag(Math.min(1, Math.max(0, u)), v);
        cur.show(pt.c, pt.x, pt.y, Math.min(1, Math.max(0, pt.d / POKE.hover)));
        busy.add(p.id);
        p.rayMode = 'hidden';
        st.hover = { id: null, lostAt: null };
        st.pending = null;
        continue;
      }
      st.poke = null;
      cur.hide();

      // 3) Ray: sticky hover, select on release, pinch-drag.
      const hits = live.filter((c) => !(c.ignore && c.ignore(p))).map((c) => this.rayHit(p.ray, c)).filter((h): h is RayHit => !!h);
      const top = pickNearest(hits);
      const curC = st.hover.id ? this.byId.get(st.hover.id) ?? null : null;
      const curHit = curC && live.includes(curC) ? this.rayHit(p.ray, curC, HOVER.margin) : null;
      const hitId = top && !top.c.passive ? top.id : null;
      const before = st.hover.id;
      st.hover = stickyHover(st.hover, hitId, !!curHit, nowMs);
      const hovered = st.hover.id ? this.byId.get(st.hover.id) ?? null : null;
      const at = hovered ? (hovered === curC ? curHit : hits.find((h) => h.c === hovered) ?? null) : null;
      if (hovered) {
        busy.add(p.id);
        hoverNow.add(hovered);
        if (at) {
          hovered.onHover?.(at.x / hovered.w + 0.5, at.y / hovered.h + 0.5);
          p.rayLength = at.dist;
        }
        p.rayMode = 'hit';
        if (hovered.id !== before) {
          sfx.hover();
          p.pulse(0.12, 12);
        }
      } else if (top) {
        // A passive surface (panel background) stops the ray: nothing behind it gets grabbed.
        busy.add(p.id);
        p.rayLength = top.dist;
        p.rayMode = 'hit';
      }
      if (st.pending && !p.pinch && !p.pinchUp) st.pending = null;

      if (p.pinchDown && hovered && hovered.state.enabled && (hovered.onDrag || hovered.onHoldStart)) {
        st.held = hovered;
        const point = at?.point ?? p.ray.origin.clone().addScaledVector(p.ray.direction, p.rayLength);
        hovered.onHoldStart?.(p, point);
        if (hovered.onDrag && at) hovered.onDrag(at.x / hovered.w + 0.5, at.y / hovered.h + 0.5);
        sfx.grab();
        p.pulse(0.4, 25);
        continue;
      }
      const sel = farSelect(st.pending, hovered?.id ?? null, p.pinchDown, p.pinchUp);
      st.pending = sel.pending;
      if (sel.fire) {
        const c = this.byId.get(sel.fire)!;
        const h = at ?? { x: 0, y: 0 };
        this.press(c, h.x / c.w + 0.5, h.y / c.h + 0.5, p, nowMs);
      }
      if (st.pending && hovered && st.pending === hovered.id) depth.set(hovered, Math.max(depth.get(hovered) ?? 0, 0.7));
    }

    // Pointers that disappeared release what they held.
    for (const [id, st] of this.ptr) {
      if (seen.has(id)) continue;
      st.held = null;
      st.pending = null;
      st.poke = null;
      st.hover = { id: null, lostAt: null };
      this.cursors.get(id)?.hide();
    }

    for (const c of this.controls) {
      const hv = hoverNow.has(c);
      if (c.state.hover !== hv) {
        c.state.hover = hv;
        if (!hv) c.onHover?.(null, null);
      }
      c.depth = depth.get(c) ?? 0;
      c.animate(nowMs, dt);
      c.refresh();
    }
    return busy;
  }
}

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */

export function glassRect(g: CanvasRenderingContext2D, w: number, h: number, st: ControlState, accent: string): void {
  const r = Math.min(w, h) * 0.22;
  const lw = Math.max(2, Math.min(w, h) * 0.045);
  g.beginPath();
  g.roundRect(lw, lw, w - lw * 2, h - lw * 2, r);
  g.fillStyle = st.active ? hexA(accent, 0.85) : st.pressed ? hexA(accent, 0.6) : st.hover ? 'rgba(44,58,122,0.95)' : 'rgba(12,16,40,0.88)';
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = st.enabled ? (st.hover || st.active ? accent : hexA(accent, 0.6)) : 'rgba(120,130,170,0.3)';
  g.stroke();
  if (st.hover && st.enabled) {
    g.shadowColor = accent;
    g.shadowBlur = Math.min(w, h) * 0.3;
    g.stroke();
    g.shadowBlur = 0;
  }
}

export function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, weight = 700, align: CanvasTextAlign = 'center', maxWidth?: number): void {
  const font = (px: number) => `${weight} ${Math.round(px)}px Inter, system-ui, sans-serif`;
  g.font = font(size);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  let s = text;
  const maxW = maxWidth ?? (align === 'center' ? g.canvas.width * 0.9 : g.canvas.width - x - 8);
  // Shrink the font a little before resorting to an ellipsis.
  let px = size;
  while (g.measureText(s).width > maxW && px > size * 0.72) g.font = font((px -= 1));
  while (g.measureText(s).width > maxW && s.length > 2) s = s.slice(0, -2) + '…';
  g.fillText(s, x, y);
}

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A standard labelled button. */
export function button(w: number, h: number, text: () => string, accent = '#38e1ff', id?: string): HoloControl {
  const c = new HoloControl(
    w,
    h,
    (g, cw, ch, st) => {
      glassRect(g, cw, ch, st, accent);
      const t = text();
      const color = st.active ? '#05060d' : st.enabled ? '#eef0ff' : 'rgba(200,210,240,0.35)';
      const lines = t.split('\n');
      if (lines.length > 1) {
        // Two-line label (small square buttons).
        const size = ch * 0.27;
        lines.slice(0, 2).forEach((l, i) => label(g, l, cw / 2, ch / 2 + (i - 0.5) * size * 1.15 + 1, size, color, 700, 'center', cw * 0.86));
      } else {
        const size = t.length <= 2 ? ch * 0.55 : ch * 0.36;
        label(g, t, cw / 2, ch / 2 + 1, size, color, 700, 'center', cw * 0.88);
      }
    },
    undefined,
    id,
  );
  c.labelKey = text;
  return c;
}

/** A horizontal slider; `onChange` gets 0..1. Drag it with a pinch (ray) or a finger (poke). */
export function slider(w: number, h: number, text: () => string, get: () => number, onChange: (v: number) => void, accent = '#ff3fd2', id?: string): HoloControl {
  const pad = (ch: number) => ch * 0.42;
  const c = new HoloControl(
    w,
    h,
    (g, cw, ch, st) => {
      glassRect(g, cw, ch, { ...st, active: false }, accent);
      const px = pad(ch);
      const y = ch * 0.68;
      g.lineWidth = ch * 0.09;
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.beginPath();
      g.moveTo(px, y);
      g.lineTo(cw - px, y);
      g.stroke();
      const x = px + (cw - px * 2) * st.value;
      g.strokeStyle = accent;
      g.shadowColor = accent;
      g.shadowBlur = ch * 0.25;
      g.beginPath();
      g.moveTo(px, y);
      g.lineTo(x, y);
      g.stroke();
      g.beginPath();
      g.arc(x, y, ch * (st.hover ? 0.17 : 0.13), 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.shadowBlur = 0;
      label(g, text(), px, ch * 0.3, ch * 0.26, st.enabled ? '#eef0ff' : 'rgba(200,210,240,0.35)', 700, 'left');
    },
    undefined,
    id,
  );
  c.getValue = get;
  c.labelKey = text;
  // Pointer u (0..1 over the whole control) → slider value, accounting for the track's padding.
  // Light smoothing so a jittery ray or finger doesn't make the value shimmer.
  let last: number | null = null;
  let lastT = 0;
  const set = (u: number) => {
    const padU = pad(c.h) / c.w;
    const raw = Math.min(1, Math.max(0, (u - padU) / (1 - padU * 2)));
    const now = performance.now();
    const fresh = last === null || now - lastT > 200;
    const v = fresh ? raw : last! + (raw - last!) * 0.5;
    last = v;
    lastT = now;
    onChange(Math.abs(v - raw) < 0.002 ? raw : v);
  };
  c.onDrag = (u) => set(u);
  return c;
}
