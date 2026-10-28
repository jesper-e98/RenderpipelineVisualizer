import { CanvasTexture, Group, PerspectiveCamera, Scene, Sprite, SpriteMaterial, Timer, Vector2, WebGLRenderer, type Camera } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface StageView {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Bloom strength (0 or undefined = off). */
  bloom?: number;
  /** Luminance above which pixels glow (0..1, default 0.2). Use ~0.7 for lit, solid meshes. */
  bloomThreshold?: number;
  /** Let the user orbit the camera by dragging. */
  orbit?: boolean;
  /** Point the orbit controls circle around (default: the origin). */
  orbitTarget?: [number, number, number];
  /** Called every frame before rendering. `t` = seconds since attach. */
  onFrame?: (t: number, dt: number) => void;
  /** Called when the host is resized. */
  onResize?: (width: number, height: number) => void;
}

/**
 * One shared WebGL renderer for the whole app (browsers limit WebGL contexts). The canvas is
 * moved into whichever slide is active; the slide that leaves keeps a frozen snapshot so the
 * slide transition still looks right.
 */
export class ThreeStage {
  readonly renderer: WebGLRenderer | null;
  private composer?: EffectComposer;
  private renderPass?: RenderPass;
  private bloomPass?: UnrealBloomPass;
  private labels = new CSS2DRenderer();
  private clock = new Timer();
  private current: { host: HTMLElement; view: StageView; ro: ResizeObserver; controls?: OrbitControls; t: number } | null = null;
  private wrap = document.createElement('div');
  /** XR: the world the headset sees; the active slide's scene is parented under `xrAnchor`. */
  readonly xrWorld = new Scene();
  readonly xrAnchor = new Group();
  /** Base camera for XR; the headset pose is applied on top of it by three.js. */
  readonly xrCamera = new PerspectiveCamera(60, 1, 0.02, 200);
  /** Called every frame while presenting (controllers, panel). */
  xrFrame: ((dt: number) => void) | null = null;
  /** Scene to show in XR when the current slide has no 3D view. */
  xrFallback: (() => Scene) | null = null;
  private xrShown: Scene | null = null;
  /** In AR, objects tagged `userData.xrHideInAR` (star fields, backdrops) are hidden. */
  xrHideTagged = false;
  private labelSyncT = 0;

  constructor() {
    let renderer: WebGLRenderer | null = null;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.xr.enabled = true;
      this.renderPass = new RenderPass(new Scene(), new PerspectiveCamera());
      this.bloomPass = new UnrealBloomPass(new Vector2(256, 256), 0.8, 0.5, 0.15);
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch (err) {
      console.warn('WebGL unavailable – 3D views are disabled', err);
    }
    this.renderer = renderer;
    this.wrap.className = 'three-wrap';
    if (renderer) this.wrap.append(renderer.domElement);
    this.labels.domElement.className = 'three-labels';
    this.wrap.append(this.labels.domElement);
    this.xrWorld.add(this.xrAnchor, this.xrCamera);
    renderer?.setAnimationLoop(() => this.frame());
  }

  get presenting(): boolean {
    return !!this.renderer?.xr.isPresenting;
  }

  /** Put the 3D canvas into `host` and start rendering `view`. */
  attach(host: HTMLElement, view: StageView): void {
    this.detach();
    if (!this.renderer) {
      host.append(Object.assign(document.createElement('div'), { className: 'no-webgl', textContent: 'WebGL 2 is not available in this browser.' }));
      return;
    }
    host.append(this.wrap);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    let controls: OrbitControls | undefined;
    if (view.orbit) {
      controls = new OrbitControls(view.camera, this.labels.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 1.5;
      controls.maxDistance = 12;
      if (view.orbitTarget) controls.target.set(...view.orbitTarget);
    }
    this.current = { host, view, ro, controls, t: 0 };
    this.renderPass!.scene = view.scene;
    this.renderPass!.camera = view.camera;
    this.bloomPass!.enabled = !!view.bloom;
    this.bloomPass!.strength = view.bloom ?? 0;
    this.bloomPass!.threshold = view.bloomThreshold ?? 0.2;
    this.clock.update();
    this.resize();
    this.frame();
  }

  /** Stop rendering into the current host, leaving a still image behind. */
  detach(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.ro.disconnect();
    cur.controls?.dispose();
    const canvas = this.renderer!.domElement;
    if (this.presenting) {
      this.wrap.remove();
      return;
    }
    try {
      // Render once more and copy synchronously (the drawing buffer is still valid).
      this.render(cur.view);
      const snap = document.createElement('canvas');
      snap.className = 'three-snapshot';
      snap.width = canvas.width;
      snap.height = canvas.height;
      snap.getContext('2d')?.drawImage(canvas, 0, 0);
      cur.host.append(snap);
    } catch {
      /* snapshot is cosmetic */
    }
    this.wrap.remove();
    this.labels.domElement.replaceChildren();
  }

  isAttachedTo(view: StageView): boolean {
    return this.current?.view === view;
  }

  private resize(): void {
    const cur = this.current;
    if (!cur || !this.renderer || this.presenting) return;
    const w = Math.max(1, cur.host.clientWidth);
    const h = Math.max(1, cur.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer!.setSize(w, h);
    this.labels.setSize(w, h);
    cur.view.camera.aspect = w / h;
    cur.view.camera.updateProjectionMatrix();
    cur.view.onResize?.(w, h);
  }

  private render(view: StageView): void {
    if (this.presenting) return this.renderXR(view.scene);
    if (view.bloom) this.composer!.render();
    else this.renderer!.render(view.scene, view.camera as Camera);
    this.labels.render(view.scene, view.camera);
  }

  private frame(): void {
    const cur = this.current;
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.presenting) {
      this.xrFrame?.(dt);
      if (!cur) {
        const fb = this.xrFallback?.();
        if (fb) this.renderXR(fb);
        return;
      }
    }
    if (!cur) return;
    cur.t += dt;
    cur.view.onFrame?.(cur.t, dt);
    if (!this.presenting) cur.controls?.update();
    this.render(cur.view);
  }

  /** Render `scene` inside the XR world (bloom and CSS labels don't work in XR, sprites stand in). */
  private renderXR(scene: Scene): void {
    if (this.xrShown !== scene) {
      this.xrShown?.removeFromParent();
      this.xrAnchor.add(scene);
      this.xrShown = scene;
      scene.traverse((o) => {
        if (o.userData.xrHideInAR) o.visible = !this.xrHideTagged;
      });
      this.labelSyncT = 0;
    }
    this.labelSyncT -= 1;
    if (this.labelSyncT <= 0) {
      syncLabelSprites(scene);
      this.labelSyncT = 30;
    }
    this.renderer!.render(this.xrWorld, this.xrCamera);
  }

  /** Called by the XR controller when a session ends: hand the scene back to the page. */
  endXR(): void {
    this.xrShown?.removeFromParent();
    this.xrShown = null;
    hideLabelSprites(this.current?.view.scene);
    this.resize();
  }
}

/** In XR, every CSS2D label gets a sprite twin with the same text. */
function syncLabelSprites(scene: Scene): void {
  scene.traverse((o) => {
    if (!(o instanceof CSS2DObject)) return;
    const text = o.element.textContent ?? '';
    let sp = o.userData.xrSprite as Sprite | undefined;
    if (sp && sp.userData.text === text) {
      sp.visible = o.visible;
      return;
    }
    if (sp) {
      sp.material.map?.dispose();
      sp.material.dispose();
      sp.removeFromParent();
    }
    sp = textSprite(text, getComputedStyle(o.element).color || '#e8ebff');
    sp.userData.text = text;
    o.userData.xrSprite = sp;
    o.add(sp);
  });
}

function hideLabelSprites(scene?: Scene): void {
  scene?.traverse((o) => {
    if (o instanceof CSS2DObject && o.userData.xrSprite) (o.userData.xrSprite as Sprite).visible = false;
  });
}

export function textSprite(text: string, color = '#e8ebff', worldHeight = 0.16): Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = '600 40px "JetBrains Mono", monospace';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = Math.max(32, w);
  c.height = 60;
  g.font = font;
  g.fillStyle = 'rgba(5,6,13,0.8)';
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 12);
  g.fill();
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 14, 31);
  const tex = new CanvasTexture(c);
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((worldHeight * c.width) / c.height, worldHeight, 1);
  sp.renderOrder = 10;
  return sp;
}
