import { Group, Vector3 } from 'three';
import { L, type Text } from '../core/i18n';
import type { Lang } from '../core/state';
import { handMenuLayout } from './consoleLayout';
import { button, hexA, HoloControl, label, type HoloUI } from './HoloUI';
import { palmMenuStep, type PalmState } from './interaction';
import type { Pointer } from './XRInput';

export interface HandMenuHost {
  t(x: Text): string;
  lang(): Lang;
  prev(): void;
  next(): void;
  cycleApi(): void;
  apiLabel(): string;
  /** Bring the console to the user. */
  summon(): void;
}

/** How far above the palm the menu floats (m). */
const ABOVE = 0.085;

/**
 * A small menu above the left hand that appears when the left palm faces the user (held steady),
 * with ‹ ›, API cycle and "bring console here". Operated with the other hand (poke or ray).
 * With controllers it shows above the left controller while Y is held.
 */
export class HandMenu {
  readonly root = new Group();
  private palm: PalmState = { shown: false, since: null };
  private appear = 0;
  private target = new Vector3();
  private handId: number | null = null;
  private placed = false;

  constructor(
    private ui: HoloUI,
    private host: HandMenuHost,
  ) {
    this.root.visible = false;
    this.build();
  }

  get shown(): boolean {
    return this.palm.shown;
  }

  /** Pointer id of the hand carrying the menu while it shows (it can't press its own menu). */
  get hand(): number | null {
    return this.palm.shown ? this.handId : null;
  }

  private build(): void {
    const { t } = this.host;
    const plate = new HoloControl(
      0.118,
      0.142,
      (g, w, h) => {
        g.beginPath();
        g.roundRect(3, 3, w - 6, h - 6, 24);
        g.fillStyle = 'rgba(9,12,30,0.94)';
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = hexA('#9b7bff', 0.6);
        g.stroke();
        label(g, t(L('HANDMENY', 'HAND MENU')), w / 2, h * 0.085, h * 0.07, hexA('#c9b8ff', 0.95), 800);
      },
      undefined,
      'hm:plate',
    );
    plate.labelKey = () => this.host.lang();
    plate.passive = true;
    plate.mesh.renderOrder = 22;
    plate.root.position.set(0, 0.008, -0.002);
    this.ui.add(plate, this.root);

    const text: Record<string, () => string> = {
      'hm:prev': () => '‹',
      'hm:next': () => '›',
      'hm:api': () => this.host.apiLabel(),
      'hm:summon': () => t(L('Konsol\nhit', 'Console\nhere')),
    };
    const act: Record<string, () => void> = {
      'hm:prev': () => this.host.prev(),
      'hm:next': () => this.host.next(),
      'hm:api': () => this.host.cycleApi(),
      'hm:summon': () => this.host.summon(),
    };
    for (const it of handMenuLayout()) {
      const c = button(it.w, it.h, text[it.id], it.id === 'hm:summon' ? '#38e1ff' : '#9b7bff', it.id);
      c.root.position.set(it.x, it.y - 0.004, 0.002);
      c.onPress = act[it.id];
      c.ignore = (p: Pointer) => p.id === this.handId;
      this.ui.add(c, this.root);
    }
    // The hand menu is always the nearest UI: draw it over the console behind it.
    this.root.traverse((o) => (o.renderOrder += 30));
  }

  /** Which pointer (if any) could carry the menu, and how much its palm faces the head. */
  private candidate(pointers: Pointer[], head: Vector3): { p: Pointer; facing: number | null; pos: Vector3 } | null {
    for (const p of pointers) {
      if (p.handedness !== 'left') continue;
      if (p.kind === 'controller') {
        const pos = p.grip.clone().add(new Vector3(0, 0.05, 0));
        return { p, facing: p.menuButton ? 1 : null, pos };
      }
      if (!p.palm) return { p, facing: null, pos: this.target };
      const toHead = head.clone().sub(p.palm.pos).normalize();
      const busy = p.pinch || p.fist || p.holding;
      return { p, facing: busy ? null : p.palm.normal.dot(toHead), pos: p.palm.pos };
    }
    return null;
  }

  update(dt: number, pointers: Pointer[], head: Vector3, nowMs: number): void {
    const cand = this.candidate(pointers, head);
    const instant = cand?.p.kind === 'controller';
    const before = this.palm.shown;
    if (instant) this.palm = { shown: cand!.facing !== null, since: null };
    else this.palm = palmMenuStep(this.palm, cand?.facing ?? null, cand?.p.speed ?? 0, nowMs);
    if (cand && this.palm.shown) this.handId = cand.p.id;
    if (this.palm.shown && !before) this.placed = false;

    if (cand && this.palm.shown) {
      // Float above the hand, nudged towards the user, facing the eyes.
      const toHead = head.clone().sub(cand.pos).setY(0);
      if (toHead.lengthSq() > 1e-6) toHead.normalize();
      const goal = cand.pos.clone().add(new Vector3(0, ABOVE, 0)).addScaledVector(toHead, 0.02);
      if (!this.placed) {
        this.target.copy(goal);
        this.placed = true;
      } else this.target.lerp(goal, 1 - Math.exp(-dt / 0.06));
    }
    this.appear += ((this.palm.shown ? 1 : 0) - this.appear) * (1 - Math.exp(-dt / 0.06));
    if (!this.palm.shown && this.appear < 0.02) this.appear = 0;
    // Only interactive (and visible) while shown: no presses while it fades out under the other hand.
    this.root.visible = this.palm.shown && this.appear > 0.02;
    if (this.root.visible) {
      this.root.position.copy(this.target);
      this.root.lookAt(head);
      this.root.scale.setScalar(0.6 + 0.4 * this.appear);
    }
  }

  /** Hide right away (session end). */
  reset(): void {
    this.palm = { shown: false, since: null };
    this.appear = 0;
    this.root.visible = false;
    this.handId = null;
  }
}
