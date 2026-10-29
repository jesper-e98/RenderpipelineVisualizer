import { Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Scene, Sphere, Vector3, DoubleSide } from 'three';
import { h } from '../core/dom';
import { L, tr, type Text } from '../core/i18n';
import { API_LIST, type Store } from '../core/state';
import type { SlideEngine } from '../core/SlideEngine';
import { BUILTINS, builtinMesh, type BuiltinId } from '../model/builtins';
import { shadedMesh } from '../views/three-helpers';
import type { ThreeStage, XRLayer } from '../views/ThreeStage';
import { HoloLab, LAB } from './HoloLab';
import { button, glassRect, HoloControl, HoloUI, hexA, label, slider } from './HoloUI';
import { clamp, decaySpin, explodeFromHands, oneHandPose, twoHandPose, yawVelocity, type Pose } from './manipulate';
import { axisAction, carouselPosition, hitTest, type PanelAction, type PanelInfo } from './panelLayout';
import { sfx } from './sounds';
import { XRInput, type Pointer } from './XRInput';
import { XRPanel } from './XRPanel';

type XRMode = 'immersive-vr' | 'immersive-ar';

const GROUP_COLOR: Record<string, string> = { cpu: '#38e1ff', api: '#9b7bff', 'gpu-prog': '#ff3fd2', 'gpu-fixed': '#ffb547' };
const MAX_EXPLODE = 1.0;

type Grab =
  | { mode: 'one'; a: Pointer; handStart: Matrix4; objStart: Matrix4 }
  | { mode: 'two'; a: Pointer; b: Pointer; a0: Vector3; b0: Vector3; start: Pose }
  | { mode: 'explode'; a: Pointer; b: Pointer; d0: number; e0: number };

/**
 * The XR "holo-lab": a holographic table with the current slide's scene floating above it,
 * grabbable / rotatable / scalable / explodable with hands or controllers, surrounded by a stage
 * carousel, a tool palette and the info panel. Also drives the desktop simulator (`?xrsim`).
 */
export class XRController {
  private session: XRSession | null = null;
  private mode: XRMode = 'immersive-vr';
  private simulating = false;
  private panel = new XRPanel(0.86);
  private lab = new HoloLab();
  private ui = new HoloUI();
  private input: XRInput;
  private labRoot = new Group();
  private infoGroup = new Group();
  private placed = false;
  private latch = new Map<number, boolean>();
  private fallbackScene: Scene | null = null;
  private fallbackMesh: unknown = null;
  private buttons: HTMLButtonElement[] = [];
  private grab: Grab | null = null;
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
    this.labRoot.add(this.lab.root, this.ui.root);
    world.add(this.labRoot, this.input.group);
    this.labRoot.visible = false;
    this.input.group.visible = false;
    this.buildUI();
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
    this.spin = 0;
    this.userExplode = 0;
    this.labRoot.visible = true;
    this.input.group.visible = true;
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
    this.input.group.visible = false;
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

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */

  private buildUI(): void {
    const ui = this.ui;
    const t = this.t;

    // Info panel (big holo-screen behind the hologram) with a grab handle.
    const info = new HoloControl(0.86, (0.86 * 640) / 1024, undefined, this.panel.mesh);
    info.onPress = (u, v) => {
      const a = hitTest(this.panel.regions, u, v);
      if (a) this.run(a);
    };
    info.onHover = (u, v) => this.panel.setHover(u === null || v === null ? null : hitTest(this.panel.regions, u, v));
    this.infoGroup.position.set(0, 1.72, -1.3);
    this.infoGroup.lookAt(0, 1.72, 0);
    this.labRoot.add(this.infoGroup);
    ui.add(info, this.infoGroup);
    const handle = new HoloControl(0.22, 0.032, (g, w, hh, st) => {
      glassRect(g, w, hh, st, '#9b7bff');
      label(g, '⠿  ' + t(L('flytta', 'move')), w / 2, hh / 2 + 1, hh * 0.55, '#c9c2ff');
    });
    handle.labelKey = () => this.store.state.lang;
    handle.dragTarget = this.infoGroup;
    handle.mesh.position.set(0, -0.3, 0.002);
    ui.add(handle, this.infoGroup);

    // Stage carousel: two arcs around the user at chest height.
    const slides = this.engine.slides;
    const carousel = new Group();
    this.labRoot.add(carousel);
    slides.forEach((s, i) => {
      const tile = new HoloControl(0.082, 0.058, (g, w, hh, st) => {
        const col = GROUP_COLOR[s.group] ?? '#38e1ff';
        glassRect(g, w, hh, st, col);
        label(g, String(i), w * 0.14, hh * 0.28, hh * 0.24, st.active ? '#05060d' : col, 800, 'left');
        label(g, t(s.short), w / 2, hh * 0.64, hh * 0.22, st.active ? '#05060d' : '#e8ebff', 700);
      });
      tile.labelKey = () => this.store.state.lang;
      tile.isActive = () => this.engine.index === i;
      tile.onPress = () => this.engine.go(i, 0);
      tile.mesh.position.set(...carouselPosition(i));
      tile.mesh.lookAt(0, 1.4, 0);
      ui.add(tile, carousel);
    });

    // Tool palette on the table's front edge, tilted towards the user.
    const pal = new Group();
    pal.position.set(0, LAB.tableHeight + 0.09, -0.4);
    pal.rotation.x = -0.85;
    this.labRoot.add(pal);
    const plate = new Mesh(
      new PlaneGeometry(0.5, 0.3),
      new MeshBasicMaterial({ color: 0x0a0f2a, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false }),
    );
    plate.position.z = -0.004;
    pal.add(plate);
    const hooks = () => this.stage.xrHooks;
    const exp = slider(
      0.46,
      0.05,
      () => `${t(L('Dra isär', 'Pull apart'))} · ${Math.round((this.userExplode / MAX_EXPLODE) * 100)} %`,
      () => this.userExplode / MAX_EXPLODE,
      (v) => {
        this.userExplode = v * MAX_EXPLODE;
        this.applyExplode();
      },
    );
    exp.isEnabled = () => !!hooks();
    exp.mesh.position.set(0, 0.105, 0);
    ui.add(exp, pal);
    const layers: [XRLayer, Text][] = [
      ['solid', L('Solid', 'Solid')],
      ['wire', L('Wire', 'Wire')],
      ['points', L('Punkter', 'Points')],
      ['normals', L('Normaler', 'Normals')],
    ];
    layers.forEach(([name, txt], i) => {
      const b = button(0.108, 0.046, () => t(txt), '#38e1ff');
      b.isEnabled = () => !!hooks();
      b.isActive = () => (hooks()?.getLayer(name) ?? 0) > 0.05;
      b.onPress = () => {
        const hk = hooks();
        if (!hk) return;
        const on = hk.getLayer(name) > 0.05;
        hk.setLayer(name, on ? 0 : name === 'solid' ? 1 : 0.6);
      };
      b.mesh.position.set(-0.174 + i * 0.116, 0.045, 0);
      ui.add(b, pal);
    });
    const SHORT: Record<BuiltinId, Text> = {
      teapot: L('Tekanna', 'Teapot'),
      cube: L('Kub', 'Cube'),
      sphere: L('Sfär', 'Sphere'),
      torusknot: L('Knut', 'Knot'),
      ico: L('Ikosa', 'Ico'),
      triangle: L('Triangel', 'Triangle'),
    };
    BUILTINS.forEach((m, i) => {
      const b = button(0.072, 0.044, () => t(SHORT[m.id]), '#ffb547');
      b.isActive = () => this.store.state.mesh.format === 'builtin' && this.store.state.mesh.name === m.id;
      b.onPress = () => this.store.set({ mesh: builtinMesh(m.id) });
      b.mesh.position.set(-0.19 + i * 0.076, -0.015, 0);
      ui.add(b, pal);
    });
    const row: [() => string, number, () => void, string][] = [
      [() => '‹', 0.066, () => this.engine.prev(), '#9b7bff'],
      [() => '›', 0.066, () => this.engine.next(), '#9b7bff'],
      [() => t(L('Återställ vy', 'Reset view')), 0.12, () => this.resetView(), '#38e1ff'],
      [() => (sfx.muted ? '🔇' : '🔊'), 0.06, () => sfx.setMuted(!sfx.muted), '#38e1ff'],
      [() => t(L('Avsluta', 'Exit')), 0.1, () => this.exit(), '#ff5a6e'],
    ];
    let x = -0.23;
    for (const [txt, w, fn, col] of row) {
      const b = button(w, 0.046, txt, col);
      b.onPress = fn;
      b.mesh.position.set(x + w / 2, -0.078, 0);
      x += w + 0.012;
      ui.add(b, pal);
    }
    const title = new HoloControl(0.46, 0.03, (g, _w, hh) => {
      label(g, t(L('HOLO-KONTROLL', 'HOLO CONTROLS')), 8, hh / 2, hh * 0.6, hexA('#38e1ff', 0.8), 800, 'left');
    });
    title.labelKey = () => this.store.state.lang;
    title.mesh.position.set(0, 0.145, 0);
    title.passive = true;
    ui.add(title, pal);
  }

  private run(action: PanelAction): void {
    if (action === 'next') this.engine.next();
    else if (action === 'prev') this.engine.prev();
    else if (action === 'mode') this.store.set({ mode: this.store.state.mode === 'data' ? 'concept' : 'data' });
    else if (action === 'exit') this.exit();
    else this.store.set({ api: action.slice(4) as never });
  }

  /* ------------------------------------------------------------------ */
  /* Placement & hologram manipulation                                   */
  /* ------------------------------------------------------------------ */

  private headPose(): { pos: Vector3; dir: Vector3 } {
    const cam = this.simulating ? this.stage.xrCamera : this.stage.renderer!.xr.getCamera();
    const pos = cam.getWorldPosition(new Vector3());
    const dir = cam.getWorldDirection(new Vector3());
    return { pos, dir };
  }

  private homePose(): Pose {
    this.labRoot.updateMatrixWorld(true);
    return {
      position: this.labRoot.localToWorld(LAB.holoHome.clone()),
      quaternion: this.labRoot.quaternion.clone(),
      scale: LAB.holoScale,
    };
  }

  /** Put the lab around the user: they stand at its origin looking at the table. */
  private place(): void {
    const { pos, dir } = this.headPose();
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    this.labRoot.position.set(pos.x, 0, pos.z);
    this.labRoot.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
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
    this.manipulated = false;
    if (animate) this.lab.pulse();
  }

  private holoSphere(): Sphere {
    const a = this.stage.xrAnchor;
    return new Sphere(a.getWorldPosition(new Vector3()), a.scale.x * 1.25 + 0.06);
  }

  private applyExplode(): void {
    this.stage.xrHooks?.explode(this.userExplode);
  }

  private anchorMatrix(): Matrix4 {
    const a = this.stage.xrAnchor;
    return new Matrix4().compose(a.position, a.quaternion, a.scale);
  }

  private setAnchor(m: Matrix4): void {
    const a = this.stage.xrAnchor;
    const s = new Vector3();
    m.decompose(a.position, a.quaternion, s);
    a.scale.setScalar(clamp(s.x, 0.04, 1));
  }

  private handMatrix(p: Pointer): Matrix4 {
    return new Matrix4().compose(p.grip, p.quat, new Vector3(1, 1, 1));
  }

  private manipulate(pointers: Pointer[], busy: Set<number>, dt: number): void {
    const free = pointers.filter((p) => !busy.has(p.id) || this.grabUses(p));
    const sphere = this.holoSphere();
    const near = (p: Pointer) => sphere.containsPoint(p.grip) || !!p.ray.intersectSphere(sphere, new Vector3());
    const g = this.grab;

    // Two fists anywhere → pull apart.
    const fists = free.filter((p) => p.fist);
    if (fists.length >= 2 && this.stage.xrHooks && g?.mode !== 'explode') {
      const [a, b] = fists;
      this.grab = { mode: 'explode', a, b, d0: a.grip.distanceTo(b.grip), e0: this.userExplode };
      sfx.explode();
      a.pulse(0.6, 60);
      b.pulse(0.6, 60);
      return;
    }
    if (g?.mode === 'explode') {
      if (!g.a.fist || !g.b.fist) {
        this.grab = null;
        sfx.release();
        return;
      }
      this.userExplode = explodeFromHands(g.d0, g.a.grip.distanceTo(g.b.grip), g.e0, 1.6, MAX_EXPLODE);
      this.applyExplode();
      return;
    }

    // Pinch grabs (one or two hands).
    const grabbing = free.filter((p) => p.pinch);
    if (g?.mode === 'one' && !g.a.pinch) {
      // Release: keep spinning if thrown.
      this.grab = null;
      const h0 = this.history[0];
      const h1 = this.history[this.history.length - 1];
      if (h0 && h1 && h1.t - h0.t > 0.02) {
        const w = yawVelocity(h0.q, h1.q, h1.t - h0.t);
        this.spin = Math.abs(w) > 0.8 ? clamp(w, -6, 6) : 0;
      }
      sfx.release();
    } else if (g?.mode === 'two' && (!g.a.pinch || !g.b.pinch)) {
      const rest = g.a.pinch ? g.a : g.b.pinch ? g.b : null;
      this.grab = rest ? { mode: 'one', a: rest, handStart: this.handMatrix(rest), objStart: this.anchorMatrix() } : null;
    }
    const cur = this.grab;
    if (!cur) {
      const starter = grabbing.find((p) => p.pinchDown && near(p));
      const partner = starter && grabbing.find((p) => p !== starter && p.pinch);
      if (starter && partner) {
        const a = this.stage.xrAnchor;
        this.grab = {
          mode: 'two',
          a: starter,
          b: partner,
          a0: starter.grip.clone(),
          b0: partner.grip.clone(),
          start: { position: a.position.clone(), quaternion: a.quaternion.clone(), scale: a.scale.x },
        };
        this.spin = 0;
        this.manipulated = true;
        sfx.grab();
      } else if (starter) {
        this.grab = { mode: 'one', a: starter, handStart: this.handMatrix(starter), objStart: this.anchorMatrix() };
        this.spin = 0;
        this.manipulated = true;
        this.history = [];
        sfx.grab();
        starter.pulse(0.5, 40);
      }
    } else if (cur.mode === 'one') {
      const second = grabbing.find((p) => p !== cur.a && p.pinch);
      if (second) {
        const a = this.stage.xrAnchor;
        this.grab = {
          mode: 'two',
          a: cur.a,
          b: second,
          a0: cur.a.grip.clone(),
          b0: second.grip.clone(),
          start: { position: a.position.clone(), quaternion: a.quaternion.clone(), scale: a.scale.x },
        };
        second.pulse(0.5, 40);
      } else {
        this.setAnchor(oneHandPose(cur.handStart, cur.objStart, this.handMatrix(cur.a)));
        this.history.push({ q: this.stage.xrAnchor.quaternion.clone(), t: this.time });
        while (this.history.length > 2 && this.time - this.history[0].t > 0.12) this.history.shift();
      }
    } else if (cur.mode === 'two') {
      const pose = twoHandPose(cur.a0, cur.b0, cur.a.grip, cur.b.grip, cur.start);
      const a = this.stage.xrAnchor;
      a.position.copy(pose.position);
      a.quaternion.copy(pose.quaternion);
      a.scale.setScalar(pose.scale);
    }

    // Throw spin.
    if (!this.grab && this.spin) {
      this.stage.xrAnchor.rotateOnWorldAxis(new Vector3(0, 1, 0), this.spin * dt);
      this.spin = decaySpin(this.spin, dt);
    }
  }

  private grabUses(p: Pointer): boolean {
    const g = this.grab;
    return !!g && (g.a === p || ('b' in g && g.b === p));
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  private frame(dt: number): void {
    this.time += dt;
    if (!this.placed) this.place();
    this.lab.update(dt);
    // Materialize the hologram during the boot sequence.
    if (!this.manipulated && this.lab.materialize < 1) this.stage.xrAnchor.scale.setScalar(Math.max(0.001, LAB.holoScale * this.lab.materialize));
    else if (!this.manipulated && this.stage.xrAnchor.scale.x < LAB.holoScale * 0.999) this.stage.xrAnchor.scale.setScalar(LAB.holoScale);

    this.simFeed?.(this.input);
    const pointers = this.input.update();
    if (this.simulating) this.input.drawSim();
    const head = this.headPose().pos;
    const busy = this.grab ? new Set<number>() : this.ui.update(pointers, performance.now(), head);
    if (this.grab) this.ui.update([], performance.now(), head);
    this.manipulate(pointers, busy, dt);

    // Thumbsticks: API left/right, mode up/down.
    const sources = this.session?.inputSources ?? [];
    let i = 0;
    for (const src of sources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const res = axisAction(gp.axes[2], gp.axes[3], this.latch.get(i) ?? false);
      this.latch.set(i, res.latched);
      if (res.action === 'mode') this.run('mode');
      else if (res.action) {
        const idx = API_LIST.findIndex((a) => a.id === this.store.state.api);
        const next = API_LIST[(idx + (res.action === 'api-next' ? 1 : API_LIST.length - 1)) % API_LIST.length];
        this.store.set({ api: next.id });
      }
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
    this.panel.draw(this.info());
    this.ui.refreshAll();
  }

  /** Read what the panel should show from the live slide DOM. */
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
        tr(L('Nyp eller tryck på › för att gå vidare.', 'Pinch or press › to continue.'), s.lang),
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

  /** For tests/debugging: the current hologram state. */
  debugState() {
    const a = this.stage.xrAnchor;
    return {
      grab: this.grab?.mode ?? null,
      scale: a.scale.x,
      position: a.position.toArray(),
      explode: this.userExplode,
      spin: this.spin,
      index: this.engine.index,
    };
  }
}
