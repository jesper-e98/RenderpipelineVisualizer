import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Ray,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
  type XRGripSpace,
  type XRHandSpace,
  type XRTargetRaySpace,
} from 'three';
import { FILTER_PRESETS, OneEuroQuat, OneEuroVec3, type OneEuroParams } from './filters';
import { fistStep, latch0, pinchStep, pinchStrength, type LatchState } from './gestures';

export type PointerKind = 'hand' | 'controller' | 'sim';
/** How the pointer's ray is drawn this frame: faint, ending on something it hits, or not at all. */
export type RayMode = 'idle' | 'hit' | 'hidden';

/** One hand or controller, reduced to what the holo-lab needs. Poses are filtered (de-jittered). */
export interface Pointer {
  id: number;
  kind: PointerKind;
  handedness: 'left' | 'right' | 'none';
  connected: boolean;
  ray: Ray;
  /** Index fingertip (hands) or a point just in front of the controller – used for poking. */
  tip: Vector3 | null;
  /** Where something grabbed is held (pinch point / grip), and the hand's orientation. */
  grip: Vector3;
  quat: Quaternion;
  /** Speed of the grip point (m/s). */
  speed: number;
  pinch: boolean;
  fist: boolean;
  pinchDown: boolean;
  pinchUp: boolean;
  fistDown: boolean;
  fistUp: boolean;
  /** 0 = fingers open … 1 = pinching (for cursor feedback). */
  pinchStrength: number;
  /** Palm centre and normal (pointing out of the palm), for the hand menu. Hands only. */
  palm: { pos: Vector3; normal: Vector3 } | null;
  /** Controllers: the menu (Y / B) button is held. */
  menuButton: boolean;
  /** Set by whoever owns this pointer: it holds something (wider release threshold next frame). */
  holding: boolean;
  /** Length of the visible ray and how it is drawn (set by whoever hit something with it). */
  rayLength: number;
  rayMode: RayMode;
  pulse(intensity: number, ms: number): void;
}

const FINGERS = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;
const JOINT_NAMES: string[] = ['wrist'];
const BONES: [string, string][] = [];
for (const f of FINGERS) {
  const parts = f === 'thumb' ? ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'] : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
  let prev = 'wrist';
  for (const p of parts) {
    const name = `${f}-${p}`;
    JOINT_NAMES.push(name);
    BONES.push([prev, name]);
    prev = name;
  }
}

function makePointer(id: number, kind: PointerKind): Pointer {
  return {
    id,
    kind,
    handedness: 'none',
    connected: false,
    ray: new Ray(),
    tip: null,
    grip: new Vector3(),
    quat: new Quaternion(),
    speed: 0,
    pinch: false,
    fist: false,
    pinchDown: false,
    pinchUp: false,
    fistDown: false,
    fistUp: false,
    pinchStrength: 0,
    palm: null,
    menuButton: false,
    holding: false,
    rayLength: 1.2,
    rayMode: 'idle',
    pulse() {},
  };
}

/** Per-hand filter bank and gesture state. Everything is reset when tracking is lost. */
class Track {
  joints = new Map<string, OneEuroVec3>();
  origin = new OneEuroVec3(FILTER_PRESETS.rayOrigin);
  dir = new OneEuroVec3(FILTER_PRESETS.rayDir);
  tip = new OneEuroVec3(FILTER_PRESETS.tip);
  grip = new OneEuroVec3(FILTER_PRESETS.grip);
  quat = new OneEuroQuat(FILTER_PRESETS.rotation);
  pinch: LatchState = latch0();
  fist: LatchState = latch0();
  size: number | null = null;
  lostSince: number | null = null;
  kind: 'hand' | 'controller' | null = null;

  joint(name: string): OneEuroVec3 {
    let f = this.joints.get(name);
    if (!f) {
      f = new OneEuroVec3(FILTER_PRESETS.joint);
      this.joints.set(name, f);
    }
    return f;
  }

  /** Switch filter settings between hands and controllers. */
  setKind(kind: 'hand' | 'controller'): void {
    if (this.kind === kind) return;
    this.kind = kind;
    const pos: OneEuroParams = kind === 'hand' ? FILTER_PRESETS.grip : FILTER_PRESETS.controller;
    this.grip.params = pos;
    this.tip.params = kind === 'hand' ? FILTER_PRESETS.tip : FILTER_PRESETS.controller;
    this.origin.params = kind === 'hand' ? FILTER_PRESETS.rayOrigin : FILTER_PRESETS.controller;
    this.dir.params = kind === 'hand' ? FILTER_PRESETS.rayDir : FILTER_PRESETS.controllerDir;
    this.reset();
  }

  reset(): void {
    this.joints.forEach((f) => f.reset());
    this.origin.reset();
    this.dir.reset();
    this.tip.reset();
    this.grip.reset();
    this.quat.reset();
    this.pinch = latch0();
    this.fist = latch0();
    this.lostSince = null;
  }
}

/** Glowing hand skeleton (instanced joints + bone lines), no downloaded models needed. */
class HandViz {
  readonly group = new Group();
  private joints: InstancedMesh;
  private bones: LineSegments;
  private m = new Matrix4();
  private hidden = new Vector3(0, -10, 0);

  constructor(color: number) {
    this.joints = new InstancedMesh(
      new SphereGeometry(1, 10, 8),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
      JOINT_NAMES.length,
    );
    this.joints.frustumCulled = false;
    const bg = new BufferGeometry();
    bg.setAttribute('position', new BufferAttribute(new Float32Array(BONES.length * 6), 3));
    this.bones = new LineSegments(bg, new LineBasicMaterial({ color, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }));
    this.bones.frustumCulled = false;
    this.group.add(this.joints, this.bones);
    // Hidden until a tracked hand shows up (the instances start as 1 m spheres at the origin).
    this.group.visible = false;
  }

  update(pos: Map<string, Vector3>, strength: number, pinching: boolean): void {
    JOINT_NAMES.forEach((n, i) => {
      const p = pos.get(n);
      const tip = n.endsWith('tip');
      const pinchTip = n === 'thumb-tip' || n === 'index-finger-tip';
      // Thumb and index tips grow as they approach a pinch, and pop when it engages.
      const r = tip ? (pinchTip ? (pinching ? 0.0095 : 0.0062 + strength * 0.0022) : 0.006) : 0.0048;
      this.m.makeScale(r, r, r).setPosition(p ?? this.hidden);
      this.joints.setMatrixAt(i, this.m);
    });
    this.joints.instanceMatrix.needsUpdate = true;
    const arr = this.bones.geometry.attributes.position.array as Float32Array;
    BONES.forEach(([a, b], i) => {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) return;
      arr.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
    });
    this.bones.geometry.attributes.position.needsUpdate = true;
  }
}

/** Ray + end cursor for a pointer. The cursor ring closes as the fingers approach a pinch. */
class RayViz {
  readonly group = new Group();
  readonly line: Line;
  readonly dot: Mesh;
  readonly ring: Mesh;
  private end = new Vector3();
  private start = new Vector3();
  constructor(color: number) {
    this.line = new Line(
      new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
    );
    this.line.frustumCulled = false;
    const mat = () => new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, depthTest: false });
    this.dot = new Mesh(new SphereGeometry(0.0045, 10, 8), mat());
    this.ring = new Mesh(new RingGeometry(0.009, 0.0115, 32), mat());
    (this.ring.material as MeshBasicMaterial).side = DoubleSide;
    this.dot.renderOrder = this.ring.renderOrder = 45;
    this.group.add(this.line, this.dot, this.ring);
  }
  update(p: Pointer, head: Vector3 | null): void {
    const hand = p.kind === 'hand';
    const mode = p.rayMode;
    this.group.visible = mode !== 'hidden';
    if (mode === 'hidden') return;
    const len = mode === 'hit' ? p.rayLength : hand ? 0.35 : 0.6;
    // Hands: the ray starts a little ahead of the hand so it doesn't cover the fingers.
    this.start.copy(p.ray.origin).addScaledVector(p.ray.direction, hand ? Math.min(0.06, len * 0.5) : 0);
    this.end.copy(p.ray.origin).addScaledVector(p.ray.direction, len);
    const arr = this.line.geometry.attributes.position.array as Float32Array;
    arr.set([this.start.x, this.start.y, this.start.z, this.end.x, this.end.y, this.end.z]);
    this.line.geometry.attributes.position.needsUpdate = true;
    (this.line.material as LineBasicMaterial).opacity = mode === 'hit' ? (hand ? 0.4 : 0.65) : hand ? 0.14 : 0.35;
    const hit = mode === 'hit';
    this.dot.visible = hit;
    this.ring.visible = hit;
    if (hit) {
      this.dot.position.copy(this.end);
      this.ring.position.copy(this.end);
      if (head) this.ring.lookAt(head);
      const s = p.pinch ? 0.55 : 1.25 - p.pinchStrength * 0.6;
      this.ring.scale.setScalar(s * Math.max(0.6, Math.min(2.2, len / 0.7)));
      this.dot.scale.setScalar(Math.max(0.6, Math.min(2.2, len / 0.7)) * (p.pinch ? 1.5 : 1));
    }
  }
}

const tmpA = new Vector3();
const tmpB = new Vector3();

/** Palm normal (out of the palm) from wrist + index and little-finger metacarpals. */
export function palmNormal(wrist: Vector3, indexMeta: Vector3, pinkyMeta: Vector3, handedness: 'left' | 'right' | 'none'): Vector3 {
  const a = tmpA.copy(indexMeta).sub(wrist);
  const b = tmpB.copy(pinkyMeta).sub(wrist);
  const n = handedness === 'left' ? b.clone().cross(a) : a.clone().cross(b);
  return n.normalize();
}

/**
 * Hands and controllers as two `Pointer`s (plus simulated ones on the desktop). Call `update()`
 * once per frame; it refreshes pose (filtered), gestures and edges. Call `draw()` after the UI and
 * hologram have set each pointer's `rayMode` / `rayLength`.
 */
export class XRInput {
  readonly group = new Group();
  readonly pointers: Pointer[] = [makePointer(0, 'controller'), makePointer(1, 'controller')];
  private sources: (XRInputSource | null)[] = [null, null];
  private controllers: XRTargetRaySpace[] = [];
  private grips: XRGripSpace[] = [];
  private hands: XRHandSpace[] = [];
  private tracks = [new Track(), new Track()];
  private handViz = [new HandViz(0x38e1ff), new HandViz(0x9b7bff)];
  private rayViz = [new RayViz(0x38e1ff), new RayViz(0x9b7bff)];
  private simViz = [0, 1].map(() => this.makePalmViz());
  private simLast = new Map<number, { grip: Vector3; t: number }>();
  private jointPos = new Map<string, Vector3>();
  private listening = false;
  private lastT = 0;

  constructor(private renderer: WebGLRenderer | null) {
    this.handViz.forEach((v) => this.group.add(v.group));
    this.rayViz.forEach((v) => this.group.add(v.group));
    this.simViz.forEach((v) => this.group.add(v));
  }

  private makePalmViz(): Mesh {
    const m = new Mesh(new CircleGeometry(0.035, 32), new MeshBasicMaterial({ color: 0x9b7bff, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
    m.add(new Mesh(new RingGeometry(0.034, 0.038, 40), new MeshBasicMaterial({ color: 0xc9b8ff, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })));
    m.visible = false;
    return m;
  }

  /** Hook up the real XR controllers/hands (call when a session starts). */
  attach(world: Object3D): void {
    const r = this.renderer;
    if (!r) return;
    if (this.listening) {
      // three.js hands out the same controller objects every session; just re-add them.
      [...this.controllers, ...this.grips, ...this.hands].forEach((o) => world.add(o));
      return;
    }
    this.listening = true;
    for (let i = 0; i < 2; i++) {
      const c = r.xr.getController(i);
      const g = r.xr.getControllerGrip(i);
      const hnd = r.xr.getHand(i);
      c.addEventListener('connected', (e) => {
        const src = (e as unknown as { data: XRInputSource }).data;
        this.sources[i] = src;
        this.tracks[i].reset();
        const p = this.pointers[i];
        p.connected = true;
        p.kind = src.hand ? 'hand' : 'controller';
        p.handedness = (src.handedness as Pointer['handedness']) ?? 'none';
        p.pulse = (intensity, ms) => {
          const act = src.gamepad?.hapticActuators?.[0] as { pulse?: (i: number, d: number) => Promise<boolean> } | undefined;
          void act?.pulse?.(intensity, ms);
        };
      });
      c.addEventListener('disconnected', () => {
        this.sources[i] = null;
        this.pointers[i].connected = false;
        this.tracks[i].reset();
      });
      world.add(c, g, hnd);
      this.controllers[i] = c;
      this.grips[i] = g;
      this.hands[i] = hnd;
    }
  }

  detach(): void {
    [...this.controllers, ...this.grips, ...this.hands].forEach((o) => o.removeFromParent());
    this.sources = [null, null];
    this.pointers.forEach((p) => (p.connected = false));
    this.tracks.forEach((t) => t.reset());
  }

  /** Desktop simulator: drive pointer `i` directly (no filtering, no gesture timing). */
  setSim(
    i: number,
    s: {
      origin: Vector3;
      dir: Vector3;
      tip: Vector3 | null;
      grip: Vector3;
      pinch: boolean;
      fist: boolean;
      handedness?: Pointer['handedness'];
      palm?: { pos: Vector3; normal: Vector3 } | null;
    } | null,
  ): void {
    while (this.pointers.length <= i) this.pointers.push(makePointer(this.pointers.length, 'sim'));
    const p = this.pointers[i];
    if (!s) {
      p.connected = false;
      this.simLast.delete(i);
      return;
    }
    p.kind = 'sim';
    p.connected = true;
    p.handedness = s.handedness ?? 'none';
    p.ray.origin.copy(s.origin);
    p.ray.direction.copy(s.dir).normalize();
    p.tip = s.tip ? s.tip.clone() : null;
    const now = performance.now();
    const last = this.simLast.get(i);
    p.speed = last && now > last.t ? Math.min(5, last.grip.distanceTo(s.grip) / ((now - last.t) / 1000)) : 0;
    this.simLast.set(i, { grip: s.grip.clone(), t: now });
    p.grip.copy(s.grip);
    p.quat.setFromUnitVectors(new Vector3(0, 0, -1), p.ray.direction);
    p.palm = s.palm ? { pos: s.palm.pos.clone(), normal: s.palm.normal.clone().normalize() } : null;
    p.pinchStrength = s.pinch ? 1 : 0;
    this.applyGesture(p, s.pinch, s.fist);
  }

  private applyGesture(p: Pointer, pinch: boolean, fist: boolean): void {
    p.pinchDown = !p.pinch && pinch;
    p.pinchUp = p.pinch && !pinch;
    p.fistDown = !p.fist && fist;
    p.fistUp = p.fist && !fist;
    p.pinch = pinch;
    p.fist = fist;
  }

  update(): Pointer[] {
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 1 / 72;
    this.lastT = now;
    for (let i = 0; i < this.controllers.length; i++) {
      const p = this.pointers[i];
      const src = this.sources[i];
      const c = this.controllers[i];
      const tr = this.tracks[i];
      if (!src || !c) {
        p.connected = false;
        this.handViz[i].group.visible = false;
        continue;
      }
      // Target ray (works for both controllers and hands), filtered.
      c.updateMatrixWorld(true);
      const rawOrigin = tmpA.setFromMatrixPosition(c.matrixWorld);
      p.ray.origin.copy(tr.origin.filter(rawOrigin, dt));
      const rawDir = tmpB.set(0, 0, -1).transformDirection(c.matrixWorld);
      p.ray.direction.copy(tr.dir.filter(rawDir, dt)).normalize();
      const hand = this.hands[i];
      const joints = (hand as unknown as { joints: Record<string, Object3D> }).joints ?? {};
      p.menuButton = false;
      if (src.hand && joints['index-finger-tip']) {
        p.kind = 'hand';
        tr.setKind('hand');
        this.updateHand(p, tr, joints, src, now, dt);
        this.handViz[i].group.visible = true;
        this.handViz[i].update(this.jointPos, p.pinchStrength, p.pinch);
      } else {
        p.kind = 'controller';
        tr.setKind('controller');
        this.handViz[i].group.visible = false;
        const gp = src.gamepad;
        this.applyGesture(p, !!gp?.buttons[0]?.pressed, !!gp?.buttons[1]?.pressed);
        p.pinchStrength = gp?.buttons[0]?.value ?? (p.pinch ? 1 : 0);
        p.menuButton = !!gp?.buttons[5]?.pressed;
        const g = this.grips[i];
        g.updateMatrixWorld(true);
        p.grip.copy(tr.grip.filter(tmpA.setFromMatrixPosition(g.matrixWorld), dt));
        p.speed = tr.grip.speed;
        p.quat.copy(tr.quat.filter(g.getWorldQuaternion(new Quaternion()), dt));
        p.tip = (p.tip ?? new Vector3()).copy(p.ray.origin).addScaledVector(p.ray.direction, 0.04);
        p.palm = null;
      }
      p.connected = true;
    }
    for (const p of this.pointers) {
      p.rayMode = 'idle';
      p.rayLength = 1.2;
    }
    return this.pointers.filter((p) => p.connected);
  }

  /** Joints → filtered skeleton, pinch point, fingertip, palm and gestures. */
  private updateHand(p: Pointer, tr: Track, joints: Record<string, Object3D>, src: XRInputSource, now: number, dt: number): void {
    const raw = new Map<string, Vector3>();
    for (const n of JOINT_NAMES) {
      const j = joints[n];
      if (j && j.visible !== false) raw.set(n, j.getWorldPosition(new Vector3()));
      else tr.joint(n).reset();
    }
    const thumb = raw.get('thumb-tip');
    const index = raw.get('index-finger-tip');
    const wrist = raw.get('wrist');
    const tracked = !!(thumb && index && wrist);
    if (tracked) {
      tr.lostSince = null;
    } else {
      tr.lostSince ??= now;
      // Lost for a while: forget the filters so the hand doesn't glide in from where it vanished.
      if (now - tr.lostSince > 300) {
        tr.joints.forEach((f) => f.reset());
        tr.grip.reset();
        tr.tip.reset();
        tr.quat.reset();
      }
    }

    // Filtered skeleton (only joints tracked this frame).
    this.jointPos.clear();
    for (const [n, v] of raw) this.jointPos.set(n, tr.joint(n).filter(v, dt).clone());

    // Hand size: wrist → index metacarpal → index knuckle, averaged slowly (it doesn't change).
    const meta = raw.get('index-finger-metacarpal');
    const knuckle = raw.get('index-finger-phalanx-proximal');
    if (wrist && meta && knuckle) {
      const len = wrist.distanceTo(meta) + meta.distanceTo(knuckle);
      tr.size = tr.size === null ? len : tr.size + (len - tr.size) * 0.03;
    }

    if (tracked) {
      const pinchPoint = thumb!.clone().add(index!).multiplyScalar(0.5);
      p.grip.copy(tr.grip.filter(pinchPoint, dt));
      p.tip = (p.tip ?? new Vector3()).copy(tr.tip.filter(index!, dt));
      const wj = joints['wrist'];
      if (wj) p.quat.copy(tr.quat.filter(wj.getWorldQuaternion(new Quaternion()), dt));
    }
    p.speed = tr.grip.speed;

    // Gestures (raw distances; the latch handles noise, dropouts and grace).
    const tips = ['middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'].map((n) => raw.get(n)).filter((v): v is Vector3 => !!v);
    tr.fist = fistStep(tr.fist, { tipToWrist: wrist && tips.length ? tips.map((t) => t.distanceTo(wrist)) : null, size: tr.size, held: p.holding, nowMs: now });
    const dist = thumb && index ? thumb.distanceTo(index) : null;
    const sysSelect = !!src.gamepad?.buttons[0]?.pressed;
    tr.pinch = pinchStep(tr.pinch, { distance: dist, size: tr.size, held: p.holding, speed: p.speed, nowMs: now, suppress: tr.fist.on, systemHold: sysSelect });
    p.pinchStrength = tr.pinch.on ? 1 : pinchStrength(dist, tr.size);
    this.applyGesture(p, tr.pinch.on, tr.fist.on);
    if (!tracked && !tr.pinch.on) p.tip = null;

    // Palm (for the hand menu).
    const w = this.jointPos.get('wrist');
    const im = this.jointPos.get('index-finger-metacarpal');
    const pm = this.jointPos.get('pinky-finger-metacarpal');
    const mk = this.jointPos.get('middle-finger-phalanx-proximal');
    if (w && im && pm && mk) {
      const normal = palmNormal(w, im, pm, p.handedness);
      const pos = w.clone().add(mk).multiplyScalar(0.5);
      p.palm = { pos, normal };
    } else p.palm = null;
  }

  /** Draw rays (and the simulator's palm markers) after the frame's interaction set `rayMode`. */
  draw(head: Vector3 | null = null): void {
    this.pointers.forEach((p, i) => {
      if (i > 1) return;
      const viz = this.rayViz[i];
      if (!p.connected) {
        viz.group.visible = false;
        this.simViz[i].visible = false;
        return;
      }
      viz.update(p, head);
      const sv = this.simViz[i];
      sv.visible = p.kind === 'sim' && !!p.palm;
      if (sv.visible && p.palm) {
        sv.position.copy(p.palm.pos);
        sv.lookAt(p.palm.pos.clone().add(p.palm.normal));
      }
    });
  }
}
