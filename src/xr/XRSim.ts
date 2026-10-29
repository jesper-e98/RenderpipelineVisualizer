import { Euler, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { h } from '../core/dom';
import { L, tr } from '../core/i18n';
import type { Store } from '../core/state';
import type { ThreeStage } from '../views/ThreeStage';
import type { XRController } from './XRController';
import type { XRInput } from './XRInput';

/**
 * Desktop "headset": renders the holo-lab full screen with a mouse-driven simulated hand.
 *  - Move the mouse to aim, hold the left button to pinch (grab the hologram, press buttons, drag sliders).
 *  - Shift + left drag: two-hand grab (left/right = scale, up/down = rotate).
 *  - Alt + left drag: two fists pulling apart (exploded view).
 *  - H: hold the left palm up towards you (shows the hand menu above it).
 *  - P: poke mode – a click pushes the fingertip into the control under the cursor instead of pinching.
 *  - Right drag or arrow keys: look around. W/A/S/D: step around. Esc: leave.
 */
export class XRSim {
  private host: HTMLElement | null = null;
  private mouse = new Vector2();
  private down = false;
  private two: 'pinch' | 'fist' | null = null;
  private dragStart = new Vector2();
  private grabDist = 0.75;
  private look = { yaw: 0, pitch: -0.42, dragging: false, x: 0, y: 0 };
  private pos = new Vector3(0, 1.6, 0);
  private stepped = false;
  private keys = new Set<string>();
  private raycaster = new Raycaster();
  private palmUp = false;
  private pokeMode = false;
  /** Poke animation: 0 = fingertip hovering in front of the control, 1 = pushed in. */
  private pokeT = 0;
  private pokeHeld = false;
  private pokeLatched = false;
  /** A click shorter than a frame still reaches the XR loop as one pinched frame. */
  private clickLatched = false;
  private hint: HTMLElement | null = null;

  constructor(
    private stage: ThreeStage,
    private xr: XRController,
    private store: Store,
  ) {}

  mountButton(container: HTMLElement): void {
    container.append(h('button.btn.xr-btn.sim', { text: 'SIM', attrs: { title: 'XR simulator (desktop)' }, on: { click: () => this.start() } }));
  }

  private hintHTML(): string {
    const t = (x: Parameters<typeof tr>[0]) => tr(x, this.store.state.lang);
    const on = (b: boolean) => (b ? ' ✓' : '');
    return t(
      L(
        `<b>XR-simulator</b> · <b>vänster</b> = nyp · <b>Shift</b>+dra = två händer · <b>Alt</b>+dra = dra isär · <b>H</b> = handmeny${on(this.palmUp)} · <b>P</b> = peta${on(this.pokeMode)} · <b>höger</b>-dra/pilar = titta · WASD = gå · Esc = lämna`,
        `<b>XR simulator</b> · <b>left</b> = pinch · <b>Shift</b>+drag = two hands · <b>Alt</b>+drag = pull apart · <b>H</b> = hand menu${on(this.palmUp)} · <b>P</b> = poke${on(this.pokeMode)} · <b>right</b>-drag/arrows = look · WASD = walk · Esc = leave`,
      ),
    );
  }

  /** Simulated left palm facing the user (shows the hand menu). */
  setPalmUp(on: boolean): void {
    this.palmUp = on;
    if (this.hint) this.hint.innerHTML = this.hintHTML();
  }

  /** Clicks poke the control under the cursor with the fingertip instead of pinching. */
  setPokeMode(on: boolean): void {
    this.pokeMode = on;
    this.pokeT = 0;
    if (this.hint) this.hint.innerHTML = this.hintHTML();
  }

  start(): void {
    if (this.host) return;
    const hint = h('div.xrsim-hint', { html: this.hintHTML() });
    const host = h('div.xrsim', {}, [hint, h('button.btn.xrsim-exit', { text: '✕', on: { click: () => this.stop() } })]);
    this.hint = hint;
    document.body.append(host);
    this.host = host;
    this.pos.set(0, 1.6, 0); // the lab is placed around this spot on the first frame
    this.stepped = false;
    this.look.yaw = 0;
    this.look.pitch = -0.42; // looking down a little: console and hologram both in view
    this.applyCamera();
    // A wider view than a monitor normally gets, closer to a headset's, so the whole console fits.
    this.fov = this.stage.xrCamera.fov;
    this.stage.xrCamera.fov = 74;
    this.stage.xrCamera.updateProjectionMatrix();
    this.palmUp = false;
    this.pokeMode = false;
    this.pokeT = 0;
    this.xr.simFeed = (input) => this.feed(input);
    this.xr.startSim(host);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('rpv:xrsim-exit', this.onExit);
  }

  stop(): void {
    if (!this.host) return;
    this.xr.simFeed = null;
    this.xr.stopSim();
    this.cleanup();
  }

  private onExit = () => this.cleanup();

  private fov = 60;

  private cleanup(): void {
    this.stage.xrCamera.fov = this.fov;
    this.stage.xrCamera.updateProjectionMatrix();
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('rpv:xrsim-exit', this.onExit);
    this.host?.remove();
    this.host = null;
    this.hint = null;
  }

  private ndc(e: PointerEvent): void {
    const r = this.host!.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onMove = (e: PointerEvent) => {
    this.ndc(e);
    if (this.look.dragging) {
      this.look.yaw -= (e.clientX - this.look.x) * 0.004;
      this.look.pitch = Math.max(-1.3, Math.min(1.3, this.look.pitch - (e.clientY - this.look.y) * 0.004));
      this.look.x = e.clientX;
      this.look.y = e.clientY;
      this.applyCamera();
    }
  };

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    this.ndc(e);
    if (e.button === 2) {
      this.look.dragging = true;
      this.look.x = e.clientX;
      this.look.y = e.clientY;
      return;
    }
    if (e.button !== 0) return;
    this.down = true;
    this.two = e.shiftKey ? 'pinch' : e.altKey ? 'fist' : null;
    this.dragStart.copy(this.mouse);
    if (this.pokeMode && !this.two) {
      this.pokeHeld = true;
      this.pokeLatched = true;
    } else if (!this.two) this.clickLatched = true;
    this.grabDist = this.aimDistance();
    e.preventDefault();
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 2) this.look.dragging = false;
    if (e.button === 0) {
      this.down = false;
      this.two = null;
      this.pokeHeld = false;
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.host) return;
    if (e.key === 'Escape') {
      this.stop();
      return;
    }
    const k = e.key.toLowerCase();
    if (!e.repeat && k === 'h') this.setPalmUp(!this.palmUp);
    if (!e.repeat && k === 'p') this.setPokeMode(!this.pokeMode);
    this.keys.add(k);
    e.stopPropagation();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  /**
   * How far along the mouse ray the simulated hand aims: the UI surface under the cursor, else the
   * point level with the hologram. The hand's ray converges with the camera ray there, so what the
   * hand hits is exactly what is under the cursor.
   */
  private aimDistance(): number {
    const cam = this.stage.xrCamera;
    this.raycaster.setFromCamera(this.mouse, cam);
    const ray = this.raycaster.ray;
    const ui = this.xr.simPick(ray.origin, ray.direction);
    if (ui) return ui.dist;
    const holo = this.stage.xrAnchor.getWorldPosition(new Vector3());
    return Math.max(0.3, Math.min(2.5, holo.sub(ray.origin).dot(ray.direction)));
  }

  private applyCamera(): void {
    const cam = this.stage.xrCamera;
    cam.position.copy(this.pos);
    cam.quaternion.setFromEuler(new Euler(this.look.pitch, this.look.yaw, 0, 'YXZ'));
    cam.updateMatrixWorld(true);
  }

  /** Called every frame by the XR controller: move the camera and publish the simulated hands. */
  private feed(input: XRInput): void {
    if (!this.stepped) {
      // After the lab is placed, take half a step back so the whole table is in view.
      this.pos.z += 0.35;
      this.stepped = true;
    }
    const k = this.keys;
    const fwd = new Vector3(-Math.sin(this.look.yaw), 0, -Math.cos(this.look.yaw));
    const right = new Vector3(-fwd.z, 0, fwd.x);
    const step = 0.02;
    if (k.has('w')) this.pos.addScaledVector(fwd, step);
    if (k.has('s')) this.pos.addScaledVector(fwd, -step);
    if (k.has('a')) this.pos.addScaledVector(right, -step);
    if (k.has('d')) this.pos.addScaledVector(right, step);
    if (k.has('arrowleft')) this.look.yaw += 0.03;
    if (k.has('arrowright')) this.look.yaw -= 0.03;
    if (k.has('arrowup')) this.look.pitch = Math.min(1.3, this.look.pitch + 0.02);
    if (k.has('arrowdown')) this.look.pitch = Math.max(-1.3, this.look.pitch - 0.02);
    this.applyCamera();

    const cam = this.stage.xrCamera;
    if (!this.down) this.grabDist = this.aimDistance();
    this.raycaster.setFromCamera(this.mouse, cam);
    const ray = this.raycaster.ray;
    // The simulated hand sits a little below and in front of the eyes.
    const origin = ray.origin.clone().add(new Vector3(0, -0.12, 0).applyQuaternion(cam.quaternion));
    const point = ray.origin.clone().addScaledVector(ray.direction, this.grabDist);
    const dir = point.clone().sub(origin).normalize();

    // Left palm held up towards the face (hand menu), below-left in view.
    const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const camUp = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const camFwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const palmPos = cam.position.clone().addScaledVector(camRight, -0.15).addScaledVector(camUp, -0.2).addScaledVector(camFwd, 0.36);
    const palm = { pos: palmPos, normal: cam.position.clone().sub(palmPos).normalize() };
    const palmPointer = () =>
      input.setSim(1, { origin: palmPos, dir: camFwd, tip: null, grip: palmPos, pinch: false, fist: false, handedness: 'left', palm });

    if (this.down && this.two) {
      // Two hands either side of the grab point: spread with x, rotate with y.
      const dx = this.mouse.x - this.dragStart.x;
      const dy = this.mouse.y - this.dragStart.y;
      const sep = Math.max(0.03, 0.12 + dx * 0.6);
      const ang = dy * 2.5;
      const side = camRight.clone();
      side.y = 0;
      side.normalize().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ang));
      const centre = ray.origin.clone().addScaledVector(new Vector3().copy(ray.direction), this.grabDist);
      const fist = this.two === 'fist';
      const a = centre.clone().addScaledVector(side, -sep);
      const b = centre.clone().addScaledVector(side, sep);
      input.setSim(0, { origin, dir: a.clone().sub(origin), tip: null, grip: a, pinch: !fist, fist, handedness: 'right' });
      input.setSim(1, { origin, dir: b.clone().sub(origin), tip: null, grip: b, pinch: !fist, fist, handedness: 'left' });
      return;
    }

    if (this.pokeMode) {
      // Poke: the fingertip hovers 5 cm in front of the surface under the cursor; a click pushes it in.
      const ui = this.xr.simPick(ray.origin, ray.direction);
      const goal = this.pokeHeld || this.pokeLatched ? 1 : 0;
      this.pokeT += Math.sign(goal - this.pokeT) * Math.min(Math.abs(goal - this.pokeT), 1 / 60 / 0.09);
      if (this.pokeT >= 1) this.pokeLatched = false;
      const tip = ui ? ray.origin.clone().addScaledVector(ray.direction, ui.dist - 0.05 + this.pokeT * 0.05) : null;
      input.setSim(0, { origin, dir, tip, grip: tip ?? point, pinch: false, fist: false, handedness: 'right' });
    } else {
      input.setSim(0, { origin, dir, tip: null, grip: point, pinch: this.down || this.clickLatched, fist: false, handedness: 'right' });
      this.clickLatched = false;
    }
    if (this.palmUp) palmPointer();
    else input.setSim(1, null);
  }
}
