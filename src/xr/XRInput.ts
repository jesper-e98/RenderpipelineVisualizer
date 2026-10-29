import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
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
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
  type XRGripSpace,
  type XRHandSpace,
  type XRTargetRaySpace,
} from 'three';
import { classifyFist, classifyPinch } from './gestures';

export type PointerKind = 'hand' | 'controller' | 'sim';

/** One hand or controller, reduced to what the holo-lab needs. */
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
  pinch: boolean;
  fist: boolean;
  pinchDown: boolean;
  pinchUp: boolean;
  fistDown: boolean;
  fistUp: boolean;
  /** Length of the visible ray (set by whoever hit something with it). */
  rayLength: number;
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
    pinch: false,
    fist: false,
    pinchDown: false,
    pinchUp: false,
    fistDown: false,
    fistUp: false,
    rayLength: 2,
    pulse() {},
  };
}

/** Glowing hand skeleton (instanced joints + bone lines), no downloaded models needed. */
class HandViz {
  readonly group = new Group();
  private joints: InstancedMesh;
  private bones: LineSegments;
  private m = new Matrix4();

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
  }

  update(pos: Record<string, Vector3>, pinching: boolean): void {
    JOINT_NAMES.forEach((n, i) => {
      const p = pos[n];
      const tip = n.endsWith('tip');
      const r = tip ? (pinching && (n.startsWith('thumb') || n.startsWith('index')) ? 0.009 : 0.0065) : 0.005;
      this.m.makeScale(r, r, r).setPosition(p ?? new Vector3(0, -10, 0));
      this.joints.setMatrixAt(i, this.m);
    });
    this.joints.instanceMatrix.needsUpdate = true;
    const arr = this.bones.geometry.attributes.position.array as Float32Array;
    BONES.forEach(([a, b], i) => {
      const pa = pos[a];
      const pb = pos[b];
      if (!pa || !pb) return;
      arr.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
    });
    this.bones.geometry.attributes.position.needsUpdate = true;
  }
}

/** Ray + tip cursor for a pointer. */
class RayViz {
  readonly group = new Group();
  readonly line: Line;
  readonly dot: Mesh;
  constructor(color: number) {
    this.line = new Line(
      new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
    );
    this.dot = new Mesh(new SphereGeometry(0.008, 10, 8), new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false }));
    this.group.add(this.line, this.dot);
  }
  update(p: Pointer, opacity: number): void {
    const end = p.ray.origin.clone().addScaledVector(p.ray.direction, p.rayLength);
    const arr = this.line.geometry.attributes.position.array as Float32Array;
    arr.set([p.ray.origin.x, p.ray.origin.y, p.ray.origin.z, end.x, end.y, end.z]);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    (this.line.material as LineBasicMaterial).opacity = opacity;
    this.dot.position.copy(end);
    this.dot.visible = opacity > 0.05;
  }
}

/**
 * Hands and controllers as two `Pointer`s (plus simulated ones on the desktop). Call `update()`
 * once per frame; it refreshes pose, gestures and edges, and draws hands and rays.
 */
export class XRInput {
  readonly group = new Group();
  readonly pointers: Pointer[] = [makePointer(0, 'controller'), makePointer(1, 'controller')];
  private sources: (XRInputSource | null)[] = [null, null];
  private controllers: XRTargetRaySpace[] = [];
  private grips: XRGripSpace[] = [];
  private hands: XRHandSpace[] = [];
  private handViz = [new HandViz(0x38e1ff), new HandViz(0x9b7bff)];
  private rayViz = [new RayViz(0x38e1ff), new RayViz(0x9b7bff)];
  private tmp = new Vector3();
  private listening = false;

  constructor(private renderer: WebGLRenderer | null) {
    this.handViz.forEach((v) => this.group.add(v.group));
    this.rayViz.forEach((v) => this.group.add(v.group));
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
  }

  /** Desktop simulator: drive pointer `i` directly. */
  setSim(i: number, s: { origin: Vector3; dir: Vector3; tip: Vector3 | null; grip: Vector3; pinch: boolean; fist: boolean } | null): void {
    while (this.pointers.length <= i) this.pointers.push(makePointer(this.pointers.length, 'sim'));
    const p = this.pointers[i];
    if (!s) {
      p.connected = false;
      return;
    }
    p.kind = 'sim';
    p.connected = true;
    p.ray.origin.copy(s.origin);
    p.ray.direction.copy(s.dir).normalize();
    p.tip = s.tip ? s.tip.clone() : null;
    p.grip.copy(s.grip);
    p.quat.setFromUnitVectors(new Vector3(0, 0, -1), p.ray.direction);
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
    for (let i = 0; i < this.controllers.length; i++) {
      const p = this.pointers[i];
      const src = this.sources[i];
      const c = this.controllers[i];
      if (!src || !c) {
        p.connected = false;
        this.handViz[i].group.visible = false;
        continue;
      }
      // Target ray (works for both controllers and hands).
      c.updateMatrixWorld(true);
      p.ray.origin.setFromMatrixPosition(c.matrixWorld);
      p.ray.direction.set(0, 0, -1).transformDirection(c.matrixWorld);
      const hand = this.hands[i];
      const joints = (hand as unknown as { joints: Record<string, Object3D> }).joints ?? {};
      if (src.hand && joints['index-finger-tip']) {
        p.kind = 'hand';
        const pos: Record<string, Vector3> = {};
        for (const n of JOINT_NAMES) {
          const j = joints[n];
          if (j && j.visible !== false) pos[n] = j.getWorldPosition(new Vector3());
        }
        const thumb = pos['thumb-tip'];
        const index = pos['index-finger-tip'];
        const wrist = pos['wrist'];
        if (thumb && index && wrist) {
          const pinch = classifyPinch(thumb.distanceTo(index), p.pinch);
          const fist = classifyFist(
            ['middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'].filter((n) => pos[n]).map((n) => pos[n].distanceTo(wrist)),
            p.fist,
          );
          this.applyGesture(p, pinch && !fist, fist);
          p.tip = index.clone();
          p.grip.copy(thumb).add(index).multiplyScalar(0.5);
          joints['wrist'].getWorldQuaternion(p.quat);
        }
        this.handViz[i].group.visible = true;
        this.handViz[i].update(pos, p.pinch);
      } else {
        p.kind = 'controller';
        this.handViz[i].group.visible = false;
        const gp = src.gamepad;
        this.applyGesture(p, !!gp?.buttons[0]?.pressed, !!gp?.buttons[1]?.pressed);
        const g = this.grips[i];
        g.updateMatrixWorld(true);
        p.grip.setFromMatrixPosition(g.matrixWorld);
        g.getWorldQuaternion(p.quat);
        p.tip = this.tmp.copy(p.ray.origin).addScaledVector(p.ray.direction, 0.04).clone();
      }
      p.connected = true;
    }
    // Rays: hands show a faint ray, controllers a brighter one.
    this.pointers.slice(0, 2).forEach((p, i) => {
      this.rayViz[i].group.visible = p.connected;
      if (p.connected) this.rayViz[i].update(p, p.kind === 'hand' ? 0.25 : 0.6);
    });
    return this.pointers.filter((p) => p.connected);
  }

  /** Draw rays for simulated pointers too. */
  drawSim(): void {
    this.pointers.forEach((p, i) => {
      if (i > 1) return;
      this.rayViz[i].group.visible = p.connected && p.kind === 'sim';
      if (p.connected && p.kind === 'sim') this.rayViz[i].update(p, 0.6);
    });
  }
}
