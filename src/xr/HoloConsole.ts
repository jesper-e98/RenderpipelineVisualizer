import { Group, Vector3 } from 'three';
import { L, type Text } from '../core/i18n';
import type { ApiId, Lang, Mode } from '../core/state';
import type { XRHooks, XRLayer } from '../views/ThreeStage';
import { API_IDS, consoleHeight, consoleLayout, CONSOLE, FACET, followStep, itemPose, LABEL_Y, LAYER_IDS, MODEL_IDS, type ConsoleItem } from './consoleLayout';
import { button, glassRect, HoloControl, hexA, label, slider, type HoloUI } from './HoloUI';
import { springAngle, springStep } from './manipulate';
import type { PanelInfo } from './panelLayout';
import { sfx } from './sounds';
import type { Pointer } from './XRInput';
import { GROUP_COLOR, XRPanel } from './XRPanel';

/** What the console needs from the app. */
export interface ConsoleHost {
  t(x: Text): string;
  lang(): Lang;
  slides(): { group: string; short: Text }[];
  index(): number;
  go(i: number): void;
  prev(): void;
  next(): void;
  api(): ApiId;
  setApi(a: ApiId): void;
  mode(): Mode;
  setMode(m: Mode): void;
  /** Pull-apart amount 0..1. */
  explode(): number;
  setExplode(v: number): void;
  hooks(): XRHooks | undefined;
  /** Id of the built-in model on show, or null for a loaded file. */
  model(): string | null;
  setModel(id: (typeof MODEL_IDS)[number]): void;
  resetView(): void;
  exit(): void;
}

const API_LABEL: Record<string, string> = { opengl: 'OpenGL', vulkan: 'Vulkan', d3d12: 'DX12' };
const MODEL_LABEL: Record<string, Text> = {
  teapot: L('Tekanna', 'Teapot'),
  cube: L('Kub', 'Cube'),
  sphere: L('Sfär', 'Sphere'),
  torusknot: L('Knut', 'Knot'),
  ico: L('Ikosaeder', 'Icosa'),
  triangle: L('Triangel', 'Triangle'),
};
const LAYER_LABEL: Record<XRLayer, Text> = {
  solid: L('Solid', 'Solid'),
  wire: L('Wire', 'Wire'),
  points: L('Punkter', 'Points'),
  normals: L('Normaler', 'Normals'),
};

/** Distance the controls float in front of their facet plate (m). */
const LIFT = 0.004;

function forward(yaw: number): Vector3 {
  return new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/**
 * The holo-console: all XR UI in one gently curved desk in front of and below the hologram, within
 * arm's reach – info screen, a stage strip with all 20 stages, and the tools. It lazily follows
 * when the user turns away (> 35°), can be moved with its handle, and pinned in place.
 */
export class HoloConsole {
  /** At the user's feet, rotated to face where the user looks; the console sits in front of it. */
  readonly root = new Group();
  private body = new Group();
  readonly panel = new XRPanel(FACET.centerW, FACET.h);
  readonly items = consoleLayout(20);
  pinned = false;
  following = false;
  private yaw = 0;
  private yawV = 0;
  private user = new Vector3();
  private userV = new Vector3();
  private userTarget = new Vector3();
  private height = 1.05;
  private moving = false;
  private drag: { centre: Vector3; grab: Vector3; dist: number; height: number } | null = null;
  private head = new Vector3(0, 1.6, 0);

  constructor(
    private ui: HoloUI,
    private host: ConsoleHost,
  ) {
    this.root.add(this.body);
    this.build();
  }

  /* ---------------------------------------------------------------- */
  /* Placement & follow                                                */
  /* ---------------------------------------------------------------- */

  /** Put the console in front of the user right away. */
  place(head: Vector3, headYaw: number): void {
    this.yaw = headYaw;
    this.yawV = 0;
    this.user.set(head.x, 0, head.z);
    this.userTarget.copy(this.user);
    this.userV.set(0, 0, 0);
    this.height = consoleHeight(head.y);
    this.following = false;
    this.moving = false;
    this.drag = null;
    this.apply();
  }

  /** "Bring the console here": glide to in front of the user and start following again. */
  summon(head: Vector3, headYaw: number): void {
    this.pinned = false;
    this.drag = null;
    this.moving = true;
    this.userTarget.set(head.x, 0, head.z);
    this.height = consoleHeight(head.y);
    this.yawTarget = headYaw;
    this.ui.refreshAll();
  }
  private yawTarget: number | null = null;

  /** Console centre (the stage strip's midpoint) in world space. */
  centre(): Vector3 {
    return this.user.clone().addScaledVector(forward(this.yaw), CONSOLE.distance).setY(this.height);
  }

  update(dt: number, head: Vector3, headYaw: number): void {
    this.head.copy(head);
    if (!this.pinned && !this.drag) {
      // Turn: lazy follow of the head's yaw (or glide to where "bring console here" asked).
      let target: number;
      if (this.yawTarget !== null) {
        target = this.yawTarget;
        if (Math.abs(Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw))) < CONSOLE.settleAngle) this.yawTarget = null;
      } else {
        const f = followStep(this.yaw, headYaw, this.following);
        this.following = f.following;
        target = f.target;
      }
      [this.yaw, this.yawV] = springAngle(this.yaw, this.yawV, target, 5, dt);
      // Walk: follow once the user has stepped away.
      const flat = new Vector3(head.x, 0, head.z);
      if (flat.distanceTo(this.userTarget) > CONSOLE.followMove || this.following) {
        this.userTarget.copy(flat);
        this.moving = true;
      }
    }
    if (this.moving && !this.drag) {
      for (const k of ['x', 'z'] as const) [this.user[k], this.userV[k]] = springStep(this.user[k], this.userV[k], this.userTarget[k], 5, dt);
      if (this.user.distanceTo(this.userTarget) < 0.002 && this.userV.length() < 0.01) this.moving = false;
    }
    this.apply();
  }

  private apply(): void {
    this.root.position.copy(this.user);
    this.root.rotation.set(0, this.yaw, 0);
    this.body.position.y = this.height;
  }

  /* ---------------------------------------------------------------- */
  /* Info                                                              */
  /* ---------------------------------------------------------------- */

  draw(info: PanelInfo): void {
    this.panel.draw(info);
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  private place3D(c: HoloControl, it: ConsoleItem): void {
    const pose = itemPose(it, 0);
    const lift = it.kind === 'plate' || it.kind === 'info' || it.facet === 'strip' || it.facet === 'top' ? 0 : LIFT;
    c.root.position.set(pose.position[0] + pose.normal[0] * lift, pose.position[1] + pose.normal[1] * lift, pose.position[2] + pose.normal[2] * lift);
    c.root.rotation.set(pose.tilt, pose.yaw, 0, 'YXZ');
    c.setHit(it.hitW, it.hitH);
  }

  private build(): void {
    const { t } = this.host;
    const h = this.host;
    const lang = () => h.lang();
    for (const it of this.items) {
      let c: HoloControl;
      const [kind, arg] = it.id.split(':') as [string, string | undefined];
      if (it.kind === 'info') {
        c = new HoloControl(it.w, it.h, undefined, this.panel.mesh, it.id);
        c.passive = true;
      } else if (it.kind === 'plate') {
        const title = it.facet === 'left' ? L('API · LÄGE · MODELL', 'API · MODE · MODEL') : L('LAGER · VY', 'LAYERS · VIEW');
        const accent = it.facet === 'left' ? '#9b7bff' : '#38e1ff';
        c = new HoloControl(
          it.w,
          it.h,
          (g, w, hh) => {
            g.beginPath();
            g.roundRect(3, 3, w - 6, hh - 6, 26);
            g.fillStyle = 'rgba(9,12,30,0.82)';
            g.fill();
            g.lineWidth = 3;
            g.strokeStyle = hexA(accent, 0.45);
            g.stroke();
            const ly = ((it.h / 2 - LABEL_Y) / it.h) * hh;
            label(g, t(title), w * 0.05, ly, hh * 0.055, hexA(accent, 0.9), 800, 'left');
          },
          undefined,
          it.id,
        );
        c.labelKey = lang;
        c.passive = true;
        c.mesh.renderOrder = 22;
      } else if (it.kind === 'tile') {
        c = this.tile(it);
      } else if (it.kind === 'slider') {
        c = slider(
          it.w,
          it.h,
          () => `${t(L('Dra isär', 'Pull apart'))} · ${Math.round(h.explode() * 100)} %`,
          () => h.explode(),
          (v) => h.setExplode(v),
          '#ff3fd2',
          it.id,
        );
        c.isEnabled = () => !!h.hooks();
      } else if (it.kind === 'handle') {
        c = this.handle(it);
      } else if (kind === 'api') {
        const a = arg as ApiId;
        c = button(it.w, it.h, () => API_LABEL[a], '#9b7bff', it.id);
        c.isActive = () => h.api() === a;
        c.onPress = () => h.setApi(a);
      } else if (kind === 'mode') {
        const m = arg as Mode;
        c = button(it.w, it.h, () => (m === 'data' ? t(L('Verklig data', 'Real data')) : t(L('Koncept', 'Concept'))), '#9b7bff', it.id);
        c.isActive = () => h.mode() === m;
        c.onPress = () => h.setMode(m);
      } else if (kind === 'model') {
        const m = arg as (typeof MODEL_IDS)[number];
        c = button(it.w, it.h, () => t(MODEL_LABEL[m]), '#ffb547', it.id);
        c.isActive = () => h.model() === m;
        c.onPress = () => h.setModel(m);
      } else if (kind === 'layer') {
        const l = arg as XRLayer;
        c = button(it.w, it.h, () => t(LAYER_LABEL[l]), '#38e1ff', it.id);
        c.isEnabled = () => !!h.hooks();
        c.isActive = () => (h.hooks()?.getLayer(l) ?? 0) > 0.05;
        c.onPress = () => {
          const hk = h.hooks();
          if (!hk) return;
          hk.setLayer(l, hk.getLayer(l) > 0.05 ? 0 : l === 'solid' ? 1 : 0.6);
        };
      } else if (it.id === 'reset') {
        c = button(it.w, it.h, () => t(L('Återställ vy', 'Reset view')), '#38e1ff', it.id);
        c.onPress = () => h.resetView();
      } else if (it.id === 'sound') {
        c = button(it.w, it.h, () => (sfx.muted ? t(L('Ljud: av', 'Sound: off')) : t(L('Ljud: på', 'Sound: on'))), '#38e1ff', it.id);
        c.onPress = () => sfx.setMuted(!sfx.muted);
      } else if (it.id === 'pin') {
        c = button(it.w, it.h, () => (this.pinned ? t(L('Fäst', 'Pinned')) : t(L('Följer dig', 'Following'))), '#38e1ff', it.id);
        c.isActive = () => this.pinned;
        // Unpinning lets the lazy follow bring it back to the user.
        c.onPress = () => (this.pinned = !this.pinned);
      } else if (it.id === 'exit') {
        c = button(it.w, it.h, () => t(L('Avsluta', 'Exit')), '#ff5a6e', it.id);
        c.onPress = () => h.exit();
      } else if (it.id === 'prev' || it.id === 'next') {
        const next = it.id === 'next';
        c = button(it.w, it.h, () => (next ? '›' : '‹'), '#9b7bff', it.id);
        c.onPress = () => (next ? h.next() : h.prev());
      } else {
        continue;
      }
      this.place3D(c, it);
      this.ui.add(c, this.body);
    }
  }

  private tile(it: ConsoleItem): HoloControl {
    const i = it.index!;
    const h = this.host;
    const c = new HoloControl(
      it.w,
      it.h,
      (g, w, hh, st) => {
        const s = h.slides()[i];
        const col = GROUP_COLOR[s?.group ?? 'cpu'] ?? '#38e1ff';
        glassRect(g, w, hh, st, col);
        const dark = st.active;
        label(g, String(i + 1), w / 2, hh * 0.4, hh * 0.38, dark ? '#05060d' : col, 800);
        label(g, s ? h.t(s.short) : '', w / 2, hh * 0.76, hh * 0.15, dark ? 'rgba(5,6,13,0.85)' : 'rgba(225,230,255,0.8)', 600, 'center', w * 0.86);
      },
      undefined,
      it.id,
    );
    c.labelKey = () => h.lang();
    c.isActive = () => h.index() === i;
    c.onPress = () => h.go(i);
    c.onHover = (u) => {
      const s = h.slides()[i];
      this.panel.setPreview(u === null || !s ? null : { index: i, short: h.t(s.short), group: s.group });
    };
    return c;
  }

  /** Grab handle: pinch it with the ray (or reach and pinch) and move the whole console. */
  private handle(it: ConsoleItem): HoloControl {
    const { t } = this.host;
    const c = new HoloControl(
      it.w,
      it.h,
      (g, w, hh, st) => {
        glassRect(g, w, hh, st, '#9b7bff');
        g.fillStyle = st.hover ? '#e6deff' : '#b8a8ff';
        for (let k = 0; k < 3; k++)
          for (let r = 0; r < 2; r++) {
            g.beginPath();
            g.arc(hh * 0.45 + k * hh * 0.22, hh * (0.36 + r * 0.28), hh * 0.06, 0, Math.PI * 2);
            g.fill();
          }
        label(g, t(L('Flytta konsolen', 'Move console')), w * 0.56, hh / 2 + 1, hh * 0.42, '#ddd6ff', 700, 'center', w * 0.7);
      },
      undefined,
      it.id,
    );
    c.labelKey = () => this.host.lang();
    c.onHoldStart = (p: Pointer, point: Vector3) => {
      this.drag = { centre: this.centre(), grab: point.clone(), dist: point.distanceTo(p.ray.origin), height: this.height };
      this.pinned = true;
      this.following = false;
      this.yawTarget = null;
      this.moving = false;
    };
    c.onHoldMove = (p: Pointer) => {
      const d = this.drag;
      if (!d) return;
      const now = p.ray.origin.clone().addScaledVector(p.ray.direction, d.dist);
      const delta = now.sub(d.grab);
      const centre = d.centre.clone().add(delta);
      const toC = centre.clone().sub(this.head).setY(0);
      if (toC.lengthSq() > 0.01) this.yaw = Math.atan2(-toC.x, -toC.z);
      this.yawV = 0;
      this.height = Math.min(1.8, Math.max(0.4, d.height + delta.y));
      this.user.copy(centre.setY(0)).addScaledVector(forward(this.yaw), -CONSOLE.distance);
      this.userTarget.copy(this.user);
      this.userV.set(0, 0, 0);
      this.apply();
    };
    c.onHoldEnd = () => {
      this.drag = null;
      this.ui.refreshAll();
    };
    return c;
  }

  /** For tests/debugging. */
  debug() {
    return { pinned: this.pinned, following: this.following, yaw: this.yaw, height: this.height, centre: this.centre().toArray() };
  }
}

export { API_IDS, LAYER_IDS, MODEL_IDS };
