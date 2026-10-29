import { CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, Plane, PlaneGeometry, Raycaster, SRGBColorSpace, Vector3, type Object3D } from 'three';
import { pokeHover, pokeStep, type PokeState } from './gestures';
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

const PX_PER_M = 1700;

/** A flat interactive surface: a button, slider, tile, handle or a whole panel. Local +z is its front. */
export class HoloControl {
  readonly mesh: Mesh;
  readonly state: ControlState = { hover: false, pressed: false, active: false, enabled: true, value: 0 };
  private canvas: HTMLCanvasElement | null = null;
  private tex: CanvasTexture | null = null;
  private drawn = '';
  onPress?: (u: number, v: number, p: Pointer) => void;
  onHover?: (u: number | null, v: number | null) => void;
  onDrag?: (u: number, v: number) => void;
  /** Grabbing this control moves `dragTarget` (a panel's handle). */
  dragTarget?: Object3D;
  isActive?: () => boolean;
  isEnabled?: () => boolean;
  getValue?: () => number;
  /** Decoration only: drawn, but never hovered or pressed. */
  passive = false;

  constructor(
    readonly w: number,
    readonly h: number,
    private draw?: DrawFn,
    mesh?: Mesh,
  ) {
    if (mesh) {
      this.mesh = mesh;
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = Math.max(32, Math.round(w * PX_PER_M));
      this.canvas.height = Math.max(16, Math.round(h * PX_PER_M));
      this.tex = new CanvasTexture(this.canvas);
      this.tex.colorSpace = SRGBColorSpace;
      this.mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: this.tex, transparent: true, side: DoubleSide, depthWrite: false }));
      this.mesh.renderOrder = 30;
    }
    this.mesh.userData.holoControl = this;
  }

  /** Re-render the canvas if anything visible changed. */
  refresh(force = false): void {
    if (this.isActive) this.state.active = this.isActive();
    if (this.isEnabled) this.state.enabled = this.isEnabled();
    if (this.getValue) this.state.value = this.getValue();
    if (!this.canvas || !this.draw) return;
    const key = JSON.stringify(this.state) + (this.labelKey?.() ?? '');
    if (!force && key === this.drawn) return;
    this.drawn = key;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.draw(g, this.canvas.width, this.canvas.height, this.state);
    this.tex!.needsUpdate = true;
  }
  /** Extra input to the redraw key (e.g. a label that depends on language). */
  labelKey?: () => string;
}

interface Held {
  control: HoloControl;
  dist: number;
  offset: Vector3;
}

/**
 * Drives every HoloControl from the pointers: fingertip pokes, ray hover + pinch to press,
 * pinch-drag for sliders and panel handles. Returns which pointers are busy with the UI so
 * they don't also grab the hologram.
 */
export class HoloUI {
  readonly root = new Group();
  readonly controls: HoloControl[] = [];
  private pokes = new Map<string, PokeState>();
  private held = new Map<number, Held>();
  private hovered = new Map<number, HoloControl | null>();
  private raycaster = new Raycaster();
  private plane = new Plane();

  add(c: HoloControl, parent: Object3D = this.root): HoloControl {
    this.controls.push(c);
    parent.add(c.mesh);
    c.refresh(true);
    return c;
  }

  refreshAll(force = false): void {
    for (const c of this.controls) c.refresh(force);
  }

  private visible(c: HoloControl): boolean {
    let o: Object3D | null = c.mesh;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  private press(c: HoloControl, u: number, v: number, p: Pointer): void {
    if (!c.state.enabled) return;
    c.state.pressed = true;
    setTimeout(() => {
      c.state.pressed = false;
      c.refresh();
    }, 160);
    c.onPress?.(u, v, p);
    sfx.press();
    p.pulse(0.5, 30);
  }

  update(pointers: Pointer[], nowMs: number, head: Vector3): Set<number> {
    this.root.updateMatrixWorld(true);
    const busy = new Set<number>();
    const live = this.controls.filter((c) => !c.passive && this.visible(c));
    const hoverNow = new Set<HoloControl>();

    for (const p of pointers) {
      // 1) Something held by this pointer (slider / panel handle).
      const held = this.held.get(p.id);
      if (held) {
        busy.add(p.id);
        hoverNow.add(held.control);
        if (!p.pinch && !p.fist) {
          this.held.delete(p.id);
          sfx.release();
        } else if (held.control.dragTarget) {
          const target = held.control.dragTarget;
          const pos = p.ray.origin.clone().addScaledVector(p.ray.direction, held.dist).add(held.offset);
          target.parent!.worldToLocal(pos);
          target.position.copy(pos);
          const headLocal = target.parent!.worldToLocal(head.clone());
          target.lookAt(target.parent!.localToWorld(new Vector3(headLocal.x, target.position.y, headLocal.z)));
          p.rayLength = held.dist;
        } else if (held.control.onDrag) {
          const uv = this.planeUV(held.control, p);
          if (uv) held.control.onDrag(uv[0], uv[1]);
        }
        continue;
      }

      // 2) Fingertip pokes.
      let poking = false;
      if (p.tip && p.kind !== 'sim') {
        for (const c of live) {
          const local = c.mesh.worldToLocal(p.tip.clone());
          const inside = Math.abs(local.x) <= c.w / 2 && Math.abs(local.y) <= c.h / 2;
          const key = `${p.id}:${c.mesh.id}`;
          const st = this.pokes.get(key) ?? { armed: false, lastPress: -1e9 };
          const res = pokeStep(st, local.z, inside, nowMs);
          this.pokes.set(key, res.state);
          const u = local.x / c.w + 0.5;
          const v = local.y / c.h + 0.5;
          if (pokeHover(local.z, inside)) {
            hoverNow.add(c);
            c.onHover?.(u, v);
            poking = true;
            if (local.z < 0 && c.onDrag) c.onDrag(u, v);
          }
          if (res.pressed) this.press(c, u, v, p);
        }
      }
      if (poking) {
        busy.add(p.id);
        continue;
      }

      // 3) Ray hover, pinch to press / grab a handle or slider.
      this.raycaster.set(p.ray.origin, p.ray.direction);
      const hits = this.raycaster.intersectObjects(live.map((c) => c.mesh), false);
      const hit = hits[0];
      const c = hit ? (hit.object.userData.holoControl as HoloControl) : null;
      const prev = this.hovered.get(p.id) ?? null;
      if (c !== prev && c) sfx.hover();
      this.hovered.set(p.id, c);
      if (c && hit?.uv) {
        busy.add(p.id);
        hoverNow.add(c);
        p.rayLength = hit.distance;
        c.onHover?.(hit.uv.x, hit.uv.y);
        if (p.pinchDown) {
          if (c.dragTarget || c.onDrag) {
            const target = c.dragTarget;
            const offset = target ? target.getWorldPosition(new Vector3()).sub(hit.point) : new Vector3();
            this.held.set(p.id, { control: c, dist: hit.distance, offset });
            if (c.onDrag) c.onDrag(hit.uv.x, hit.uv.y);
            sfx.grab();
            p.pulse(0.4, 25);
          } else {
            this.press(c, hit.uv.x, hit.uv.y, p);
          }
        }
      } else if (!p.pinch) {
        p.rayLength = 1.6;
      }
    }

    for (const c of this.controls) {
      const hv = hoverNow.has(c);
      if (c.state.hover !== hv) {
        c.state.hover = hv;
        if (!hv) c.onHover?.(null, null);
      }
      c.refresh();
    }
    return busy;
  }

  private planeUV(c: HoloControl, p: Pointer): [number, number] | null {
    const n = new Vector3(0, 0, 1).transformDirection(c.mesh.matrixWorld);
    const o = c.mesh.getWorldPosition(new Vector3());
    this.plane.setFromNormalAndCoplanarPoint(n, o);
    const pt = new Vector3();
    if (!p.ray.intersectPlane(this.plane, pt)) return null;
    const local = c.mesh.worldToLocal(pt);
    return [local.x / c.w + 0.5, local.y / c.h + 0.5];
  }
}

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */

export function glassRect(g: CanvasRenderingContext2D, w: number, h: number, st: ControlState, accent: string): void {
  const r = Math.min(w, h) * 0.22;
  g.beginPath();
  g.roundRect(3, 3, w - 6, h - 6, r);
  g.fillStyle = st.active ? hexA(accent, 0.85) : st.pressed ? hexA(accent, 0.55) : st.hover ? 'rgba(40,52,110,0.92)' : 'rgba(10,14,34,0.82)';
  g.fill();
  g.lineWidth = Math.max(2, h * 0.04);
  g.strokeStyle = st.enabled ? (st.hover || st.active ? accent : hexA(accent, 0.55)) : 'rgba(120,130,170,0.3)';
  g.stroke();
  if (st.hover && st.enabled) {
    g.shadowColor = accent;
    g.shadowBlur = h * 0.3;
    g.stroke();
    g.shadowBlur = 0;
  }
}

export function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, weight = 700, align: CanvasTextAlign = 'center'): void {
  g.font = `${weight} ${Math.round(size)}px Inter, system-ui, sans-serif`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  let s = text;
  const maxW = align === 'center' ? g.canvas.width * 0.92 : g.canvas.width - x - 8;
  while (g.measureText(s).width > maxW && s.length > 2) s = s.slice(0, -2) + '…';
  g.fillText(s, x, y);
}

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A standard labelled button. */
export function button(w: number, h: number, text: () => string, accent = '#38e1ff'): HoloControl {
  const c = new HoloControl(w, h, (g, cw, ch, st) => {
    glassRect(g, cw, ch, st, accent);
    label(g, text(), cw / 2, ch / 2 + 1, ch * 0.38, st.active ? '#05060d' : st.enabled ? '#e8ebff' : 'rgba(200,210,240,0.35)');
  });
  c.labelKey = text;
  return c;
}

/** A horizontal slider; `onChange` gets 0..1. */
export function slider(w: number, h: number, text: () => string, get: () => number, onChange: (v: number) => void, accent = '#ff3fd2'): HoloControl {
  const c = new HoloControl(w, h, (g, cw, ch, st) => {
    glassRect(g, cw, ch, { ...st, active: false }, accent);
    const pad = ch * 0.35;
    const y = ch * 0.68;
    g.lineWidth = ch * 0.08;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.beginPath();
    g.moveTo(pad, y);
    g.lineTo(cw - pad, y);
    g.stroke();
    const x = pad + (cw - pad * 2) * st.value;
    g.strokeStyle = accent;
    g.shadowColor = accent;
    g.shadowBlur = ch * 0.25;
    g.beginPath();
    g.moveTo(pad, y);
    g.lineTo(x, y);
    g.stroke();
    g.beginPath();
    g.arc(x, y, ch * 0.13, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.shadowBlur = 0;
    label(g, text(), pad, ch * 0.3, ch * 0.24, st.enabled ? '#e8ebff' : 'rgba(200,210,240,0.35)', 700, 'left');
  });
  c.getValue = get;
  c.labelKey = text;
  const set = (u: number) => onChange(Math.min(1, Math.max(0, (u * c.w - c.h * 0.35 / 1) / (c.w - c.h * 0.7))));
  c.onDrag = (u) => set(u);
  c.onPress = (u) => set(u);
  return c;
}
