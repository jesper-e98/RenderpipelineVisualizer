import { Group, Matrix4, Quaternion, Ray, Scene, Sphere, Vector3 } from 'three';
import { h } from '../core/dom';
import { tr, type Text } from '../core/i18n';
import { API_LIST, type ApiId, type Store } from '../core/state';
import type { SlideEngine } from '../core/SlideEngine';
import { builtinMesh } from '../model/builtins';
import { shadedMesh } from '../views/three-helpers';
import type { ThreeStage } from '../views/ThreeStage';
import { GrabVolume, type VolumeState } from './GrabVolume';
import { HandMenu } from './HandMenu';
import { HoloConsole } from './HoloConsole';
import { HoloLab, LAB } from './HoloLab';
import { HoloUI } from './HoloUI';
import {
  clamp,
  dampPose,
  decaySpin,
  EXPLODE_GATE,
  explodeFromHands,
  farGrabPosition,
  heldSince,
  oneHandPose,
  poseSettled,
  SCALE_LIMITS,
  twoHandPose,
  yawVelocity,
  type Pose,
} from './manipulate';
import { axisAction, type PanelInfo } from './panelLayout';
import { sfx } from './sounds';
import { XRInput, type Pointer } from './XRInput';

type XRMode = 'immersive-vr' | 'immersive-ar';

const MAX_EXPLODE = 1.0;
/** Time constant (s) with which the hologram follows the hands. */
const FOLLOW_TAU = 0.05;
/** Hands this close to the grab volume (m) make it light up. */
const APPROACH = 0.08;

type Grab =
  | { mode: 'one'; a: Pointer; handStart: Matrix4; objStart: Matrix4 }
  | { mode: 'far'; a: Pointer; dist: number; reach0: number; offset: Vector3; quat: Quaternion; scale: number }
  | { mode: 'two'; a: Pointer; b: Pointer; aFar: boolean; bFar: boolean; a0: Vector3; b0: Vector3; start: Pose }
  | { mode: 'explode'; a: Pointer; b: Pointer; d0: number; e0: number };

type Reach = { kind: 'near' | 'approach' | 'far'; point: Vector3; dist: number };
type Feel = 'none' | 'hover' | 'grab' | 'explode';

/**
 * The XR "holo-lab": a holographic table with the current slide's scene floating above it,
 * grabbable / rotatable / scalable / explodable with hands or controllers, and one holo-console
 * (info, stage strip, tools) in front of the user plus a palm-up hand menu. Also drives the
 * desktop simulator (`?xrsim`).
 */
export class XRController {
  private session: XRSession | null = null;
  private mode: XRMode = 'immersive-vr';
  private simulating = false;
  private lab = new HoloLab();
  private ui = new HoloUI();
  private console: HoloConsole;
  private handMenu: HandMenu;
  private volume = new GrabVolume();
  private input: XRInput;
  private labRoot = new Group();
  private placed = false;
  private latch = new Map<number, boolean>();
  private fallbackScene: Scene | null = null;
  private fallbackMesh: unknown = null;
  private buttons: HTMLButtonElement[] = [];
  private grab: Grab | null = null;
  private target: Pose | null = null;
  private fistSince: number | null = null;
  private feel = new Map<number, Feel>();
  private userExplode = 0;
  private spin = 0;
  private history: { q: Quaternion; t: number }[] = [];
  private manipulated = false;
  private time = 0;
  /** Called at the start of each XR frame by the desktop simulator to feed its pointers. */
  simFeed: ((input: XRInput) => void) | null = null;

  constructor(
    private stage: ThreeStage,
    private engine: SlideEngine,
    private store: Store,
  ) {
    this.input = new XRInput(stage.renderer);
    const world = stage.xrWorld;
    this.labRoot.add(this.lab.root);
    world.add(this.labRoot, this.ui.root, this.volume.group, this.input.group);
    this.console = new HoloConsole(this.ui, {
      t: this.t,
      lang: () => this.store.state.lang,
      slides: () => this.engine.slides,
      index: () => this.engine.index,
      go: (i) => this.engine.go(i, 0),
      prev: () => this.engine.prev(),
      next: () => this.engine.next(),
      api: () => this.store.state.api,
      setApi: (a) => this.store.set({ api: a }),
      mode: () => this.store.state.mode,
      setMode: (m) => this.store.set({ mode: m }),
      explode: () => this.userExplode / MAX_EXPLODE,
      setExplode: (v) => {
        this.userExplode = v * MAX_EXPLODE;
        this.applyExplode();
      },
      hooks: () => this.stage.xrHooks,
      model: () => (this.store.state.mesh.format === 'builtin' ? this.store.state.mesh.name : null),
      setModel: (id) => this.store.set({ mesh: builtinMesh(id) }),
      resetView: () => this.resetView(),
      exit: () => this.exit(),
    });
    this.ui.root.add(this.console.root);
    this.handMenu = new HandMenu(this.ui, {
      t: this.t,
      lang: () => this.store.state.lang,
      prev: () => this.engine.prev(),
      next: () => this.engine.next(),
      cycleApi: () => this.cycleApi(1),
      apiLabel: () => API_LIST.find((a) => a.id === this.store.state.api)?.label.replace('DirectX ', 'DX') ?? 'API',
      summon: () => {
        const head = this.headPose();
        this.console.summon(head.pos, head.yaw);
      },
    });
    this.ui.root.add(this.handMenu.root);
    this.labRoot.visible = false;
    this.ui.root.visible = false;
    this.volume.group.visible = false;
    this.input.group.visible = false;
    stage.xrFrame = (dt) => this.frame(dt);
    stage.xrFallback = () => this.fallback();
    stage.xrSceneChanged = () => {
      this.lab.pulse();
      this.applyExplode();
      this.ui.refreshAll();
    };
    engine.onChange(() => {
      if (this.active) sfx.step();
      this.refreshSoon();
    });
    store.on(() => this.refreshSoon());
  }

  get active(): boolean {
    return !!this.session || this.simulating;
  }

  private t = (x: Text) => tr(x, this.store.state.lang);

  /* ------------------------------------------------------------------ */
  /* Session                                                             */
  /* ------------------------------------------------------------------ */

  /** Add VR / AR buttons to `container` for the session types this browser supports. */
  async mountButtons(container: HTMLElement): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || !this.stage.renderer) return;
    for (const mode of ['immersive-vr', 'immersive-ar'] as XRMode[]) {
      let ok = false;
      try {
        ok = await xr.isSessionSupported(mode);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const b = h('button.btn.xr-btn', {
        text: mode === 'immersive-vr' ? 'VR' : 'AR',
        dataset: { mode },
        attrs: { title: mode === 'immersive-vr' ? 'Holo-lab (VR)' : 'Holo-lab (AR / passthrough)' },
        on: { click: () => (this.session ? this.session.end() : this.start(mode)) },
      });
      this.buttons.push(b);
      container.append(b);
    }
  }

  async start(mode: XRMode): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    const renderer = this.stage.renderer;
    if (!xr || !renderer || this.active) return;
    try {
      const session = await xr.requestSession(mode, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      this.mode = mode;
      this.session = session;
      renderer.xr.setReferenceSpaceType('local-floor');
      // Listen for controllers / hands before the session starts so no 'connected' event is missed.
      this.input.attach(this.stage.xrWorld);
      await renderer.xr.setSession(session);
      session.addEventListener('end', () => this.onEnd());
      this.onStart();
    } catch (err) {
      console.warn('Could not start XR session', err);
      window.dispatchEvent(new CustomEvent('rpv:toast', { detail: String((err as Error).message ?? err) }));
    }
  }

  /** Desktop simulator: render the holo-lab into `host` with a mouse-driven camera. */
  startSim(host: HTMLElement): void {
    if (this.active) return;
    this.simulating = true;
    this.mode = 'immersive-vr';
    this.stage.setSimHost(host);
    this.onStart();
  }

  stopSim(): void {
    if (!this.simulating) return;
    this.simulating = false;
    this.stage.setSimHost(null);
    this.onEnd();
  }

  private onStart(): void {
    this.placed = false;
    this.manipulated = false;
    this.grab = null;
    this.target = null;
    this.spin = 0;
    this.userExplode = 0;
    this.fistSince = null;
    this.feel.clear();
    this.labRoot.visible = true;
    this.ui.root.visible = true;
    this.volume.group.visible = true;
    this.input.group.visible = true;
    this.handMenu.reset();
    this.lab.setAR(this.mode === 'immersive-ar');
    this.stage.xrHideTagged = true; // the lab has its own ambience
    this.lab.boot();
    sfx.boot();
    this.buttons.forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    document.body.classList.add('xr-presenting');
    this.refresh();
  }

  private onEnd(): void {
    this.session = null;
    this.input.detach();
    this.labRoot.visible = false;
    this.ui.root.visible = false;
    this.volume.group.visible = false;
    this.input.group.visible = false;
    this.handMenu.reset();
    this.stage.xrHideTagged = false;
    this.stage.xrHooks?.explode(0);
    this.stage.endXR();
    this.buttons.forEach((b) => b.classList.remove('on'));
    document.body.classList.remove('xr-presenting');
  }

  private exit(): void {
    if (this.simulating) {
      window.dispatchEvent(new Event('rpv:xrsim-exit'));
      this.stopSim();
    } else this.session?.end();
  }

  private cycleApi(dir: number): void {
    const idx = API_LIST.findIndex((a) => a.id === this.store.state.api);
    const next = API_LIST[(idx + dir + API_LIST.length) % API_LIST.length];
    this.store.set({ api: next.id as ApiId });
  }

  /* ------------------------------------------------------------------ */
  /* Placement & hologram manipulation                                   */
  /* ------------------------------------------------------------------ */

  private headPose(): { pos: Vector3; dir: Vector3; yaw: number } {
    const cam = this.simulating || !this.stage.renderer ? this.stage.xrCamera : this.stage.renderer.xr.getCamera();
    const pos = cam.getWorldPosition(new Vector3());
    const dir = cam.getWorldDirection(new Vector3());
    const flat = dir.clone().setY(0);
    const yaw = flat.lengthSq() > 1e-6 ? Math.atan2(-flat.x, -flat.z) : 0;
    return { pos, dir, yaw };
  }

  private homePose(): Pose {
    this.labRoot.updateMatrixWorld(true);
    return {
      position: this.labRoot.localToWorld(LAB.holoHome.clone()),
      quaternion: this.labRoot.quaternion.clone(),
      scale: LAB.holoScale,
    };
  }

  /** Put the lab around the user: they stand at its origin looking at the table, the console in front. */
  private place(): void {
    const { pos, yaw } = this.headPose();
    this.labRoot.position.set(pos.x, 0, pos.z);
    this.labRoot.rotation.set(0, yaw, 0);
    this.console.place(pos, yaw);
    this.resetView(false);
    this.placed = true;
  }

  private resetView(animate = true): void {
    const home = this.homePose();
    const a = this.stage.xrAnchor;
    a.position.copy(home.position);
    a.quaternion.copy(home.quaternion);
    a.scale.setScalar(home.scale);
    this.spin = 0;
    this.grab = null;
    this.target = null;
    this.manipulated = false;
    if (animate) this.lab.pulse();
  }

  /** The grab volume: a sphere around the hologram. */
  private holoSphere(): Sphere {
    const a = this.stage.xrAnchor;
    return new Sphere(a.getWorldPosition(new Vector3()), a.scale.x * 1.1 + 0.04);
  }

  private applyExplode(): void {
    this.stage.xrHooks?.explode(this.userExplode);
  }

  private anchorPose(): Pose {
    const a = this.stage.xrAnchor;
    return { position: a.position.clone(), quaternion: a.quaternion.clone(), scale: a.scale.x };
  }

  private anchorMatrix(): Matrix4 {
    const a = this.stage.xrAnchor;
    return new Matrix4().compose(a.position, a.quaternion, a.scale);
  }

  private handMatrix(p: Pointer): Matrix4 {
    return new Matrix4().compose(p.grip, p.quat, new Vector3(1, 1, 1));
  }

  private poseFromMatrix(m: Matrix4): Pose {
    const position = new Vector3();
    const quaternion = new Quaternion();
    const s = new Vector3();
    m.decompose(position, quaternion, s);
    return { position, quaternion, scale: clamp(s.x, SCALE_LIMITS.min, SCALE_LIMITS.max) };
  }

  private grabUses(p: Pointer): boolean {
    const g = this.grab;
    return !!g && (g.a === p || ('b' in g && g.b === p));
  }

  private reach(p: Pointer, sphere: Sphere): Reach | null {
    const d = sphere.distanceToPoint(p.grip);
    if (d <= 0) return { kind: 'near', point: p.grip.clone(), dist: 0 };
    if (d < APPROACH) return { kind: 'approach', point: p.grip.clone(), dist: d };
    const hit = p.ray.intersectSphere(sphere, new Vector3());
    if (hit) return { kind: 'far', point: hit, dist: hit.distanceTo(p.ray.origin) };
    return null;
  }

  private startOne(p: Pointer, r: Reach, head: Vector3): Grab {
    if (r.kind === 'far') {
      const a = this.stage.xrAnchor;
      return {
        mode: 'far',
        a: p,
        dist: r.dist,
        reach0: p.grip.distanceTo(head),
        offset: a.position.clone().sub(r.point),
        quat: a.quaternion.clone(),
        scale: a.scale.x,
      };
    }
    return { mode: 'one', a: p, handStart: this.handMatrix(p), objStart: this.anchorMatrix() };
  }

  private startTwo(a: Pointer, b: Pointer, aFar: boolean, bFar: boolean): Grab {
    return { mode: 'two', a, b, aFar, bFar, a0: a.grip.clone(), b0: b.grip.clone(), start: this.anchorPose() };
  }

  private manipulate(pointers: Pointer[], busy: Set<number>, dt: number, nowMs: number, head: Vector3): void {
    const free = pointers.filter((p) => !busy.has(p.id) || this.grabUses(p));
    const sphere = this.holoSphere();
    const reaches = new Map<number, Reach | null>();
    for (const p of free) reaches.set(p.id, this.reach(p, sphere));
    const grabbable = (p: Pointer) => {
      const r = reaches.get(p.id);
      return r && r.kind !== 'approach' ? r : null;
    };
    const hooks = this.stage.xrHooks;
    let g = this.grab;

    // Two fists, closed and held still for a moment → pull apart.
    if (g?.mode !== 'explode') {
      const fists = free.filter((p) => p.fist);
      const ok = fists.length >= 2 && !!hooks && fists[0].speed < EXPLODE_GATE.maxSpeed && fists[1].speed < EXPLODE_GATE.maxSpeed;
      this.fistSince = heldSince(this.fistSince, ok, nowMs);
      if (ok && nowMs - this.fistSince! >= EXPLODE_GATE.steadyMs) {
        const [a, b] = fists;
        this.grab = g = { mode: 'explode', a, b, d0: a.grip.distanceTo(b.grip), e0: this.userExplode };
        this.target = null;
        sfx.explode();
        a.pulse(0.6, 60);
        b.pulse(0.6, 60);
      }
    } else if (!g.a.fist || !g.b.fist) {
      this.grab = g = null;
      this.fistSince = null;
    } else {
      this.userExplode = explodeFromHands(g.d0, g.a.grip.distanceTo(g.b.grip), g.e0, 1.6, MAX_EXPLODE);
      this.applyExplode();
      this.ui.refreshAll();
    }

    if (g?.mode !== 'explode') {
      // Releases.
      if (g && (g.mode === 'one' || g.mode === 'far') && !g.a.pinch) {
        this.grab = g = null;
        const h0 = this.history[0];
        const h1 = this.history[this.history.length - 1];
        if (h0 && h1 && h1.t - h0.t > 0.02) {
          const w = yawVelocity(h0.q, h1.q, h1.t - h0.t);
          this.spin = Math.abs(w) > 0.8 ? clamp(w, -6, 6) : 0;
          if (this.spin) this.target = null;
        }
      } else if (g?.mode === 'two' && (!g.a.pinch || !g.b.pinch)) {
        const rest = g.a.pinch ? g.a : g.b.pinch ? g.b : null;
        const far = rest === g.a ? g.aFar : g.bFar;
        this.grab = g = rest ? this.startOne(rest, { kind: far ? 'far' : 'near', point: far ? this.farPoint(rest, sphere) : rest.grip.clone(), dist: far ? this.farPoint(rest, sphere).distanceTo(rest.ray.origin) : 0 }, head) : null;
        this.history = [];
      }

      // Starts.
      if (!g) {
        const starter = free.find((p) => p.pinchDown && grabbable(p));
        if (starter) {
          const r = grabbable(starter)!;
          const partner = free.find((p) => p !== starter && p.pinch && !p.fist && (p.pinchDown ? grabbable(p) : reaches.get(p.id)?.kind === 'near'));
          this.grab = g = partner ? this.startTwo(starter, partner, r.kind === 'far', grabbable(partner)?.kind === 'far') : this.startOne(starter, r, head);
          this.spin = 0;
          this.manipulated = true;
          this.history = [];
        }
      } else if (g.mode === 'one' || g.mode === 'far') {
        const second = free.find((p) => p !== g!.a && p.pinchDown && grabbable(p));
        if (second) {
          this.grab = g = this.startTwo(g.a, second, g.mode === 'far', grabbable(second)!.kind === 'far');
        }
      }

      // Targets.
      if (g?.mode === 'one') this.target = this.poseFromMatrix(oneHandPose(g.handStart, g.objStart, this.handMatrix(g.a)));
      else if (g?.mode === 'far')
        this.target = {
          position: farGrabPosition(g.a.ray.origin, g.a.ray.direction, g.dist, g.reach0, g.a.grip.distanceTo(head), g.offset),
          quaternion: g.quat.clone(),
          scale: g.scale,
        };
      else if (g?.mode === 'two') this.target = twoHandPose(g.a0, g.b0, g.a.grip, g.b.grip, g.start);
      if (g && (g.mode === 'one' || g.mode === 'far') && this.target) {
        this.history.push({ q: this.target.quaternion.clone(), t: this.time });
        while (this.history.length > 2 && this.time - this.history[0].t > 0.12) this.history.shift();
      }
    }

    // The hologram glides after its target (smooths the last bit of hand jitter).
    if (this.target) {
      const a = this.stage.xrAnchor;
      const cur = dampPose(this.anchorPose(), this.target, dt, FOLLOW_TAU);
      a.position.copy(cur.position);
      a.quaternion.copy(cur.quaternion);
      a.scale.setScalar(cur.scale);
      if (!this.grab && poseSettled(cur, this.target)) this.target = null;
    }
    // Throw spin.
    if (!this.grab && this.spin) {
      this.stage.xrAnchor.rotateOnWorldAxis(new Vector3(0, 1, 0), this.spin * dt);
      this.spin = decaySpin(this.spin, dt);
    }

    this.feedback(pointers, free, reaches, sphere, dt, head);
  }

  /** Where `p`'s ray meets the grab volume (or the closest point on the ray to its centre). */
  private farPoint(p: Pointer, sphere: Sphere): Vector3 {
    return p.ray.intersectSphere(sphere, new Vector3()) ?? p.ray.closestPointToPoint(sphere.center, new Vector3());
  }

  /** Grab volume glow, cursors, rays, and a sound + haptic tick on every hover → grab → release change. */
  private feedback(pointers: Pointer[], free: Pointer[], reaches: Map<number, Reach | null>, sphere: Sphere, dt: number, head: Vector3): void {
    const g = this.grab;
    let state: VolumeState = 'idle';
    if (g?.mode === 'explode') state = 'explode';
    else if (g) state = 'grab';
    else if (free.some((p) => reaches.get(p.id))) state = 'near';
    this.volume.update(dt, this.time, sphere.center, sphere.radius, state);

    for (const p of pointers) {
      const slot = p.id % 2;
      const r = reaches.get(p.id) ?? null;
      const using = this.grabUses(p);
      let feel: Feel = 'none';
      if (using) feel = g?.mode === 'explode' ? 'explode' : 'grab';
      else if (r && free.includes(p)) feel = 'hover';
      const before = this.feel.get(p.id) ?? 'none';
      if (feel !== before) {
        if (feel === 'grab') {
          sfx.grab();
          p.pulse(0.6, 40);
        } else if (before === 'grab' || before === 'explode') {
          sfx.release();
          p.pulse(0.3, 25);
        } else if (feel === 'hover') {
          sfx.hover();
          p.pulse(0.15, 15);
        }
        this.feel.set(p.id, feel);
      }
      // Cursor at the grab point and the pointer's ray.
      if (using && g && g.mode === 'far') {
        const at = this.stage.xrAnchor.position.clone().sub(g.offset);
        this.volume.cursor(slot, at, head, true);
        p.rayMode = 'hit';
        p.rayLength = at.distanceTo(p.ray.origin);
      } else if (using) {
        this.volume.cursor(slot, g?.mode === 'explode' ? null : p.grip, head, true);
        if (g?.mode !== 'two' || !(g.a === p ? g.aFar : g.bFar)) p.rayMode = 'hidden';
      } else if (r && free.includes(p) && !p.fist) {
        this.volume.cursor(slot, r.point, head, false);
        if (r.kind === 'far') {
          p.rayMode = 'hit';
          p.rayLength = r.dist;
        } else p.rayMode = 'hidden';
      } else if (!pointers.some((q) => q !== p && q.id % 2 === slot && this.grabUses(q))) {
        this.volume.cursor(slot, null, head, false);
      }
    }
    if (pointers.length === 0) [0, 1].forEach((i) => this.volume.cursor(i, null, head, false));
    this.volume.twoHand(g?.mode === 'two' ? g.a.grip : null, g?.mode === 'two' ? g.b.grip : null);
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  private frame(dt: number): void {
    this.time += dt;
    const now = performance.now();
    if (!this.placed) this.place();
    this.lab.update(dt);
    // Materialize the hologram during the boot sequence.
    if (!this.manipulated && !this.target && this.lab.materialize < 1) this.stage.xrAnchor.scale.setScalar(Math.max(0.001, LAB.holoScale * this.lab.materialize));
    else if (!this.manipulated && !this.target && this.stage.xrAnchor.scale.x < LAB.holoScale * 0.999) this.stage.xrAnchor.scale.setScalar(LAB.holoScale);

    this.simFeed?.(this.input);
    const pointers = this.input.update();
    const head = this.headPose();
    this.console.update(dt, head.pos, head.yaw);
    this.handMenu.update(dt, pointers, head.pos, now);
    const menuHand = this.handMenu.hand;

    // Pointers the UI must leave alone: the hand carrying the hand menu, hands holding the hologram,
    // and hands reaching into the grab volume (unless the fingertip is right at a console control).
    const exclude = new Set<number>();
    if (menuHand !== null) exclude.add(menuHand);
    const sphere = this.holoSphere();
    for (const p of pointers) {
      if (this.grabUses(p)) exclude.add(p.id);
      else if (sphere.containsPoint(p.grip) && !this.ui.nearUI(p)) exclude.add(p.id);
    }
    const busy = this.ui.update(pointers, now, exclude);
    if (menuHand !== null) busy.add(menuHand);
    this.manipulate(pointers, busy, dt, now, head.pos);
    for (const p of pointers) {
      if (p.id === menuHand) p.rayMode = 'hidden';
      p.holding = this.grabUses(p) || this.ui.holding(p.id);
    }
    this.input.draw(head.pos);

    // Thumbsticks: API left/right, mode up/down.
    const sources = this.session?.inputSources ?? [];
    let i = 0;
    for (const src of sources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const res = axisAction(gp.axes[2], gp.axes[3], this.latch.get(i) ?? false);
      this.latch.set(i, res.latched);
      if (res.action === 'mode') this.store.set({ mode: this.store.state.mode === 'data' ? 'concept' : 'data' });
      else if (res.action) this.cycleApi(res.action === 'api-next' ? 1 : -1);
      i++;
    }
  }

  private refreshT = 0;
  private refreshSoon(): void {
    if (!this.active) return;
    clearTimeout(this.refreshT);
    this.refresh();
    // The new slide's DOM appears a moment later; draw again once it's there.
    this.refreshT = window.setTimeout(() => this.refresh(), 250);
  }

  private refresh(): void {
    if (!this.active) return;
    this.console.draw(this.info());
    this.ui.refreshAll();
  }

  /** Read what the info screen should show from the live slide DOM. */
  private info(): PanelInfo {
    const s = this.store.state;
    const slide = document.querySelector('.slide:not(.leaving)');
    const def = this.engine.slides[this.engine.index];
    const facts = Array.from(slide?.querySelectorAll<HTMLElement>('.ms-panel:not(.collapsed) .stat') ?? [])
      .filter((st) => st.offsetParent !== null)
      .slice(0, 3)
      .map((st) => `${st.querySelector('.v')?.textContent ?? ''}  ${st.querySelector('.k')?.textContent ?? ''}`.trim());
    return {
      group: def.group,
      title: slide?.querySelector('.title')?.textContent ?? tr(def.title, s.lang),
      bullet:
        slide?.querySelector('.bullet.current')?.textContent ??
        this.t({ sv: 'Tryck på › eller välj ett steg i raden nedanför.', en: 'Press › or pick a stage in the strip below.' }),
      step: this.engine.step,
      steps: def.steps,
      index: this.engine.index,
      total: this.engine.slides.length,
      api: s.api,
      mode: s.mode,
      lang: s.lang,
      facts,
    };
  }

  /** Shown when the current slide has no 3D scene of its own. */
  private fallback(): Scene {
    if (this.fallbackScene && this.fallbackMesh === this.store.state.mesh) return this.fallbackScene;
    const scene = new Scene();
    scene.add(shadedMesh(this.store.state.mesh));
    this.fallbackScene = scene;
    this.fallbackMesh = this.store.state.mesh;
    return scene;
  }

  /* ------------------------------------------------------------------ */
  /* Simulator & debugging                                               */
  /* ------------------------------------------------------------------ */

  /** Desktop simulator: distance along a ray to the nearest UI surface, if any. */
  simPick(origin: Vector3, dir: Vector3): { id: string; dist: number } | null {
    if (!this.active) return null;
    return this.ui.pick(new Ray(origin.clone(), dir.clone().normalize()));
  }

  /** For tests/debugging: world positions of the holo-UI controls. */
  debugControls(): { id: string; pos: number[]; normal: number[]; visible: boolean }[] {
    this.ui.root.updateMatrixWorld(true);
    return this.ui.controls.map((c) => ({
      id: c.id,
      pos: c.root.getWorldPosition(new Vector3()).toArray(),
      normal: new Vector3(0, 0, 1).transformDirection(c.root.matrixWorld).toArray(),
      visible: this.ui.visible(c),
    }));
  }

  /** For tests/debugging: the current hologram and UI state. */
  debugState() {
    const a = this.stage.xrAnchor;
    return {
      grab: this.grab?.mode ?? null,
      scale: a.scale.x,
      position: a.position.toArray(),
      explode: this.userExplode,
      spin: this.spin,
      index: this.engine.index,
      api: this.store.state.api,
      mode: this.store.state.mode,
      handMenu: this.handMenu.shown,
      console: this.console.debug(),
      hovered: this.ui.hoveredIds(),
      lastPress: this.ui.lastPress,
    };
  }
}
