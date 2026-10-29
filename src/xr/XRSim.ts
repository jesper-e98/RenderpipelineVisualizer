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
 *  - Right drag or arrow keys: look around. W/A/S/D: step around. Esc: leave.
 */
export class XRSim {
  private host: HTMLElement | null = null;
  private mouse = new Vector2();
  private down = false;
  private two: 'pinch' | 'fist' | null = null;
  private dragStart = new Vector2();
  private grabDist = 0.75;
  private look = { yaw: 0, pitch: -0.2, dragging: false, x: 0, y: 0 };
  private pos = new Vector3(0, 1.6, 0);
  private stepped = false;
  private keys = new Set<string>();
  private raycaster = new Raycaster();

  constructor(
    private stage: ThreeStage,
    private xr: XRController,
    private store: Store,
  ) {}

  mountButton(container: HTMLElement): void {
    container.append(h('button.btn.xr-btn.sim', { text: 'SIM', attrs: { title: 'XR simulator (desktop)' }, on: { click: () => this.start() } }));
  }

  start(): void {
    if (this.host) return;
    const t = (x: Parameters<typeof tr>[0]) => tr(x, this.store.state.lang);
    const host = h('div.xrsim', {}, [
      h('div.xrsim-hint', {
        html: t(
          L(
            '<b>XR-simulator</b> · sikta med musen · <b>håll vänster</b> = nyp (greppa/tryck) · <b>Shift</b>+dra = två händer (skala/vrid) · <b>Alt</b>+dra = dra isär · <b>höger</b>-dra/pilar = titta · WASD = gå · Esc = lämna',
            '<b>XR simulator</b> · aim with the mouse · <b>hold left</b> = pinch (grab/press) · <b>Shift</b>+drag = two hands (scale/rotate) · <b>Alt</b>+drag = pull apart · <b>right</b>-drag/arrows = look · WASD = walk · Esc = leave',
          ),
        ),
      }),
      h('button.btn.xrsim-exit', { text: '✕', on: { click: () => this.stop() } }),
    ]);
    document.body.append(host);
    this.host = host;
    this.pos.set(0, 1.6, 0); // the lab is placed around this spot on the first frame
    this.stepped = false;
    this.look.yaw = 0;
    this.look.pitch = -0.2;
    this.applyCamera();
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

  private cleanup(): void {
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('rpv:xrsim-exit', this.onExit);
    this.host?.remove();
    this.host = null;
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
    // Hold the grabbed point at the distance where the ray first meets the hologram (or 0.75 m).
    const cam = this.stage.xrCamera;
    this.raycaster.setFromCamera(this.mouse, cam);
    const holo = this.stage.xrAnchor.getWorldPosition(new Vector3());
    const toHolo = holo.clone().sub(this.raycaster.ray.origin);
    this.grabDist = Math.max(0.3, Math.min(2.5, toHolo.dot(this.raycaster.ray.direction)));
    e.preventDefault();
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 2) this.look.dragging = false;
    if (e.button === 0) {
      this.down = false;
      this.two = null;
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.host) return;
    if (e.key === 'Escape') {
      this.stop();
      return;
    }
    this.keys.add(e.key.toLowerCase());
    e.stopPropagation();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

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
    this.raycaster.setFromCamera(this.mouse, cam);
    const ray = this.raycaster.ray;
    // The simulated hand sits a little below and in front of the eyes.
    const origin = ray.origin.clone().add(new Vector3(0, -0.12, 0).applyQuaternion(cam.quaternion));
    const point = ray.origin.clone().addScaledVector(ray.direction, this.grabDist);
    const dir = point.clone().sub(origin).normalize();

    if (this.down && this.two) {
      // Two hands either side of the grab point: spread with x, rotate with y.
      const dx = this.mouse.x - this.dragStart.x;
      const dy = this.mouse.y - this.dragStart.y;
      const sep = Math.max(0.03, 0.12 + dx * 0.6);
      const ang = dy * 2.5;
      const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      camRight.y = 0;
      camRight.normalize().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ang));
      const centre = ray.origin.clone().addScaledVector(new Vector3().copy(ray.direction), this.grabDist);
      const fist = this.two === 'fist';
      const a = centre.clone().addScaledVector(camRight, -sep);
      const b = centre.clone().addScaledVector(camRight, sep);
      input.setSim(0, { origin, dir: a.clone().sub(origin), tip: null, grip: a, pinch: !fist, fist });
      input.setSim(1, { origin, dir: b.clone().sub(origin), tip: null, grip: b, pinch: !fist, fist });
      return;
    }
    input.setSim(0, { origin, dir, tip: null, grip: point, pinch: this.down, fist: false });
    input.setSim(1, null);
  }
}
