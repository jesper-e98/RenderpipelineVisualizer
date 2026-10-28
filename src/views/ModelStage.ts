import gsap from 'gsap';
import {
  AdditiveBlending,
  ArrowHelper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  BackSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RGBAFormat,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  WireframeGeometry,
  type Object3D,
} from 'three';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h } from '../core/dom';
import { meshToGeometry } from '../model/normalize';
import type { SlideContext } from '../slides/types';
import { DEFAULT_CAMERA, type V3 } from '../pipeline/transform';
import { pipelineGeometry, pipelineMaterial, VIEW_MODE, type PipelineMaterial, type ViewMode } from './pipelineMaterial';
import { COLORS, disposeScene, glowTexture, label, makeScene, starfield } from './three-helpers';
import type { StageView } from './ThreeStage';

export type LayerName = 'solid' | 'wire' | 'points' | 'normals';

export interface ModelStageOptions {
  /** Bloom strength (default 0.5). */
  bloom?: number;
  /** Bloom threshold (default 0.85 – the lit model must not blow out). */
  bloomThreshold?: number;
  /** Idle spin in rad/s (default 0.2). 0 keeps the showcase pose the data slides agree on. */
  autoRotate?: number;
  /** Drifting star field behind the model (default true). */
  starfield?: boolean;
  /** Shift the model sideways, as a fraction of the view width (e.g. -0.18 = left, to make room for a panel). */
  shift?: number;
  /** Camera position / target (default: the pipeline's DEFAULT_CAMERA). */
  eye?: V3;
  target?: V3;
  /** Initial layer opacities (default: solid 1, everything else 0). */
  layers?: Partial<Record<LayerName, number>>;
  /** Let the user orbit with the mouse (default true). */
  orbit?: boolean;
}

export interface Particles {
  points: Points;
  /** Set start and end positions (xyz per particle, model space). */
  setTargets(from: Float32Array, to: Float32Array): void;
  /** Animate the flight (0 = at `from`, 1 = at `to`). */
  progress(p: number, seconds?: number): void;
  readonly count: number;
}

export interface ScreenPlane {
  mesh: Mesh;
  /** Reveal fraction of the pixels (0..1), in a shuffled order. */
  reveal(p: number, seconds?: number): void;
  setImage(rgba: Uint8ClampedArray): void;
}

export interface PipelineState {
  cull?: 'back' | 'front' | 'none';
  depthTest?: boolean;
  wireframe?: boolean;
  /** Alpha for alpha blending, or false for opaque. */
  blend?: number | false;
}

export interface ModelStage {
  ctx: SlideContext;
  scene: import('three').Scene;
  camera: import('three').PerspectiveCamera;
  view: StageView;
  /** Rotates with the showcase pose (and auto-rotation). Add model-space helpers here. */
  pivot: Group;
  material: PipelineMaterial;
  layers: { solid: Mesh; wire: LineSegments; points: Points; normals: LineSegments };
  /** HTML layer on top of the 3D view for glass panels. */
  overlay: HTMLElement;

  setLayer(name: LayerName, opacity: number, seconds?: number): void;
  /** Tween any uniform of the model material. */
  uniform(name: keyof PipelineMaterial['uniforms'], value: number, seconds?: number): void;
  /** Show the solid layer in another mode (normals, uv, depth, …), mixed by `mix`. */
  setMode(mode: ViewMode, mix?: number, seconds?: number): void;
  /** Sweep a glowing plane bottom→top; below it the new mode, above it `from`. */
  sweep(to: ViewMode, from?: ViewMode, seconds?: number): void;
  state(s: PipelineState): void;
  explode(amount: number, seconds?: number): void;
  /** Draw only the first `count` triangles (index order). */
  drawTriangles(count: number, seconds?: number): void;
  highlightTriangle(tri: number | null, color?: number): void;
  /** Glowing markers (+ optional labels) at mesh vertices. Replaces earlier marks. */
  markVertices(indices: number[], color?: number, labels?: string[]): Group;
  clearMarks(): void;
  /** An arrow in model space. */
  arrow(from: V3, dir: V3, length: number, color?: number, text?: string): Group;
  /** Particles in model space (rotate with the model) or world space (stay put). */
  particles(count: number, color?: number, size?: number, space?: 'model' | 'world'): Particles;
  /** Sample `count` positions from the mesh vertices (model space). */
  samplePositions(count: number): Float32Array;
  /** Show a visible light that orbits and drives the shading. */
  lightOrbit(on: boolean): void;
  /** A framebuffer-like plane showing an RGBA image as big pixels. World space. */
  screenPlane(rgba: Uint8ClampedArray, cols: number, rows: number, width?: number): ScreenPlane;
  /** A labelled glowing wire box in world space (RAM, VRAM, queue …). */
  box(text: string, position: V3, size: V3, color?: number): Group;
  /** A glass panel on the overlay. */
  panel(title: string, content: (Node | string)[], opts?: { side?: 'right' | 'left' | 'bottom' | 'top'; className?: string; collapsed?: boolean }): HTMLElement;
  onFrame(cb: (t: number, dt: number) => void): void;
  /** gsap tween that is cleaned up automatically. */
  tween(target: object, vars: gsap.TweenVars): gsap.core.Tween;
  destroy(): void;
}

export { glowTexture } from './three-helpers';

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aTo;
attribute float aDelay;
uniform float uProgress;
uniform float uSize;
uniform float uArc;
varying float vT;
void main() {
  float t = smoothstep(aDelay, aDelay + 0.35, uProgress);
  vec3 p = mix(position, aTo, t);
  p.y += sin(t * 3.14159) * uArc;
  vT = t;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // uSize is the particle diameter in world units; 600 ≈ pixels per unit at distance 1.
  gl_PointSize = uSize * 600.0 / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
}
`;
const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
varying float vT;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(mix(uColor, uColor2, vT * 0.35) * a, a * 0.85);
}
`;

const SCREEN_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uGrid;
uniform float uReveal;
uniform float uTime;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cell = floor(vUv * uGrid);
  vec2 f = fract(vUv * uGrid);
  float edge = step(0.92, max(f.x, f.y));
  vec4 tex = texture2D(uTex, (cell + 0.5) / uGrid);
  float shown = step(hash(cell), uReveal);
  float lum = dot(tex.rgb, vec3(0.3, 0.59, 0.11));
  float isBg = step(lum, 0.09);
  vec3 c = tex.rgb * shown * (1.0 - edge * 0.5);
  float a = mix(0.18, mix(0.95, 0.35, isBg), shown);
  c += vec3(0.22, 0.88, 1.0) * edge * 0.12;
  gl_FragColor = vec4(c, a);
}
`;

/** Build a standard 3D view of the loaded model inside `host`. */
export function createModelStage(host: HTMLElement, ctx: SlideContext, opts: ModelStageOptions = {}): ModelStage {
  const mesh = ctx.state.mesh;
  const { scene, camera } = makeScene();
  const eye = opts.eye ?? DEFAULT_CAMERA.eye;
  const target = opts.target ?? [0, 0, 0];
  camera.position.set(...eye);
  camera.lookAt(...target);

  const pivot = new Group();
  pivot.rotation.order = 'YXZ'; // modelMatrix() = Ry · Rx
  pivot.rotation.set(SHOWCASE_ROT_X, SHOWCASE_ROT_Y, 0);
  scene.add(pivot);

  const material = pipelineMaterial();
  const solid = new Mesh(pipelineGeometry(mesh), material);
  const wireGeo = mesh.triangleCount > 20000 ? new EdgesGeometry(meshToGeometry(mesh), 25) : new WireframeGeometry(meshToGeometry(mesh));
  const wire = new LineSegments(wireGeo, new LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0, depthWrite: false }));
  const ptsGeo = new BufferGeometry();
  ptsGeo.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  const points = new Points(
    ptsGeo,
    new PointsMaterial({ color: COLORS.cyan, size: 0.03, map: glowTexture(), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
  );
  // Normal "hedgehog", sampled for big meshes.
  const step = Math.max(1, Math.ceil(mesh.vertexCount / 6000));
  const hedge: number[] = [];
  for (let i = 0; i < mesh.vertexCount; i += step) {
    const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    const n = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
    hedge.push(...p, p[0] + n[0] * 0.12, p[1] + n[1] * 0.12, p[2] + n[2] * 0.12);
  }
  const hedgeGeo = new BufferGeometry();
  hedgeGeo.setAttribute('position', new BufferAttribute(new Float32Array(hedge), 3));
  const normals = new LineSegments(hedgeGeo, new LineBasicMaterial({ color: COLORS.magenta, transparent: true, opacity: 0, depthWrite: false }));
  pivot.add(solid, wire, points, normals);
  const layers = { solid, wire, points, normals };

  const stars = opts.starfield === false ? null : starfield();
  if (stars) {
    stars.userData.xrHideInAR = true;
    scene.add(stars);
  }

  // Depth range for the depth view mode: camera distance ± model radius.
  const camDist = new Vector3(...eye).distanceTo(new Vector3(...target));
  material.uniforms.uDepthRange.value.set(camDist - 1.05, camDist + 1.05);

  const tweens: gsap.core.Tween[] = [];
  const frameCbs: ((t: number, dt: number) => void)[] = [];
  const tween = (targetObj: object, vars: gsap.TweenVars) => {
    const tw = gsap.to(targetObj, vars);
    tweens.push(tw);
    if (tweens.length > 200) tweens.splice(0, tweens.length - 200).forEach((x) => x.progress() < 1 || x.kill());
    return tw;
  };

  let autoRotate = opts.autoRotate ?? 0.2;
  const onPointer = () => (autoRotate = 0);
  host.addEventListener('pointerdown', onPointer);

  let lightOn = false;
  const sun = new Sprite(new SpriteMaterial({ map: glowTexture(), color: 0xfff1c4, blending: AdditiveBlending, depthWrite: false }));
  sun.scale.setScalar(0.45);
  sun.visible = false;
  scene.add(sun);

  const shift = opts.shift ?? 0;
  const view: StageView = {
    scene,
    camera,
    bloom: opts.bloom ?? 0.5,
    bloomThreshold: opts.bloomThreshold ?? 0.85,
    orbit: opts.orbit ?? true,
    orbitTarget: target,
    onResize: (w, hh) => {
      if (shift) {
        camera.setViewOffset(w, hh, -shift * w, 0, w, hh);
        camera.updateProjectionMatrix();
      }
    },
    onFrame: (t, dt) => {
      material.uniforms.uTime.value = t;
      if (autoRotate) pivot.rotation.y += autoRotate * dt;
      stars?.tick(t);
      if (lightOn) {
        const a = t * 0.6;
        const lp = new Vector3(Math.cos(a) * 2.2, 1.4 + Math.sin(t * 0.4) * 0.4, Math.sin(a) * 2.2);
        sun.position.copy(lp);
        material.uniforms.uLightDir.value.copy(lp).normalize();
      }
      frameCbs.forEach((cb) => cb(t, dt));
    },
  };

  const stageEl = h('div.v-fill');
  const overlay = h('div.ms-overlay');
  host.append(stageEl, overlay);
  ctx.stage.attach(stageEl, view);

  let blendOn = false;
  const initial = { solid: 1, wire: 0, points: 0, normals: 0, ...opts.layers };
  const opacityOf = (o: Object3D) => ((o as Mesh).material as { opacity: number });
  const setLayer = (name: LayerName, opacity: number, seconds = 0.6) => {
    const obj = layers[name];
    if (name === 'solid') {
      material.transparent = opacity < 1 || material.transparent;
      const u = material.uniforms.uOpacity;
      obj.visible = true;
      if (seconds <= 0 || dur(1) < 0.01) {
        u.value = opacity;
        obj.visible = opacity > 0.001;
        material.transparent = opacity < 1 || blendOn;
      } else {
        tween(u, {
          value: opacity,
          duration: dur(seconds),
          onComplete: () => {
            obj.visible = opacity > 0.001;
            material.transparent = opacity < 1 || blendOn;
          },
        });
      }
      return;
    }
    const m = opacityOf(obj);
    obj.visible = true;
    if (seconds <= 0) {
      m.opacity = opacity;
      obj.visible = opacity > 0.001;
    } else {
      tween(m, { opacity, duration: dur(seconds), onComplete: () => (obj.visible = opacity > 0.001) });
    }
  };
  (Object.keys(initial) as LayerName[]).forEach((k) => setLayer(k, initial[k]!, 0));

  const uniform = (name: keyof PipelineMaterial['uniforms'], value: number, seconds = 0.6) => {
    const u = material.uniforms[name] as { value: number };
    if (seconds <= 0) u.value = value;
    else tween(u, { value, duration: dur(seconds), ease: 'power2.inOut' });
  };

  const marks = new Group();
  pivot.add(marks);
  const clearMarks = () => {
    marks.children.slice().forEach((c) => {
      c.traverse((o) => {
        (o as Mesh).geometry?.dispose?.();
        // CSS2D labels only leave the DOM when they themselves are removed.
        (o as Object3D & { element?: HTMLElement }).element?.remove();
      });
      c.removeFromParent();
    });
  };

  const stage: ModelStage = {
    ctx,
    scene,
    camera,
    view,
    pivot,
    material,
    layers,
    overlay,
    setLayer,
    uniform,
    setMode(mode, mix = 1, seconds = 0.6) {
      material.uniforms.uMode.value = VIEW_MODE[mode];
      uniform('uModeMix', mode === 'shaded' ? 0 : mix, seconds);
    },
    sweep(to, from = 'ghost', seconds = 1.4) {
      material.uniforms.uSweepMode.value = VIEW_MODE[from];
      material.uniforms.uMode.value = VIEW_MODE[to];
      material.uniforms.uModeMix.value = to === 'shaded' ? 0 : 1;
      material.uniforms.uSweepColor.value.set(COLORS.cyan);
      const u = material.uniforms.uSweep;
      if (seconds <= 0 || dur(1) < 0.01) {
        u.value = 100;
        return;
      }
      u.value = -1.1;
      tween(u, { value: 1.1, duration: dur(seconds), ease: 'power1.inOut', onComplete: () => (u.value = 100) });
    },
    state(s) {
      if (s.cull) material.side = s.cull === 'back' ? FrontSide : s.cull === 'front' ? BackSide : DoubleSide;
      if (s.cull) uniform('uBackTint', s.cull === 'none' ? 0.55 : 0, 0.3);
      if (s.depthTest !== undefined) {
        material.depthTest = s.depthTest;
        material.depthWrite = s.depthTest;
      }
      if (s.wireframe !== undefined) material.wireframe = s.wireframe;
      if (s.blend !== undefined) {
        blendOn = s.blend !== false;
        material.transparent = blendOn;
        material.depthWrite = !blendOn && material.depthTest;
        uniform('uOpacity', blendOn ? (s.blend as number) : 1, 0.4);
      }
      material.needsUpdate = true;
    },
    explode(amount, seconds = 0.8) {
      uniform('uExplode', amount, seconds);
    },
    drawTriangles(count, seconds = 0) {
      const u = material.uniforms.uDrawTris;
      if (seconds <= 0) u.value = count;
      else {
        if (u.value > mesh.triangleCount) u.value = 0;
        tween(u, { value: count, duration: dur(seconds), ease: 'none' });
      }
    },
    highlightTriangle(tri, color = COLORS.cyan) {
      material.uniforms.uHighlightTri.value = tri ?? -10;
      material.uniforms.uHighlightColor.value.set(color);
    },
    markVertices(indices, color = COLORS.cyan, labels) {
      clearMarks();
      const g = new Group();
      indices.forEach((vi, k) => {
        const sp = new Sprite(new SpriteMaterial({ map: glowTexture(), color, blending: AdditiveBlending, depthWrite: false, depthTest: false }));
        sp.scale.setScalar(0.16);
        sp.position.set(mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]);
        g.add(sp);
        if (labels?.[k]) {
          const l = label(labels[k], 'cyan');
          l.position.copy(sp.position).multiplyScalar(1.12);
          g.add(l);
        }
      });
      marks.add(g);
      return g;
    },
    clearMarks,
    arrow(from, dir, length, color = COLORS.magenta, text) {
      const g = new Group();
      const a = new ArrowHelper(new Vector3(...dir).normalize(), new Vector3(...from), length, color, length * 0.22, length * 0.12);
      g.add(a);
      if (text) {
        const l = label(text, 'magenta');
        l.position.copy(new Vector3(...from).add(new Vector3(...dir).normalize().multiplyScalar(length * 1.15)));
        g.add(l);
      }
      pivot.add(g);
      return g;
    },
    particles(count, color = COLORS.cyan, size = 0.03, space = 'model') {
      const geo = new BufferGeometry();
      const from = new Float32Array(count * 3);
      const to = new Float32Array(count * 3);
      const delay = new Float32Array(count);
      for (let i = 0; i < count; i++) delay[i] = Math.random() * 0.65;
      geo.setAttribute('position', new BufferAttribute(from, 3));
      geo.setAttribute('aTo', new BufferAttribute(to, 3));
      geo.setAttribute('aDelay', new BufferAttribute(delay, 1));
      const mat = new ShaderMaterial({
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uProgress: { value: 0 },
          uSize: { value: size },
          uArc: { value: 0.35 },
          uColor: { value: new Color(color) },
          uColor2: { value: new Color(COLORS.magenta) },
        },
      });
      const pts = new Points(geo, mat);
      pts.frustumCulled = false;
      (space === 'world' ? scene : pivot).add(pts);
      return {
        points: pts,
        count,
        setTargets(f, t) {
          (geo.attributes.position.array as Float32Array).set(f.subarray(0, count * 3));
          (geo.attributes.aTo.array as Float32Array).set(t.subarray(0, count * 3));
          geo.attributes.position.needsUpdate = true;
          geo.attributes.aTo.needsUpdate = true;
        },
        progress(p, seconds = 1.6) {
          if (seconds <= 0) mat.uniforms.uProgress.value = p;
          else tween(mat.uniforms.uProgress, { value: p, duration: dur(seconds), ease: 'power1.inOut' });
        },
      };
    },
    samplePositions(count) {
      const out = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / count) * mesh.vertexCount) % mesh.vertexCount;
        out[i * 3] = mesh.positions[vi * 3];
        out[i * 3 + 1] = mesh.positions[vi * 3 + 1];
        out[i * 3 + 2] = mesh.positions[vi * 3 + 2];
      }
      return out;
    },
    lightOrbit(on) {
      lightOn = on;
      sun.visible = on;
    },
    screenPlane(rgba, cols, rows, width = 2.4) {
      const data = new Uint8Array(cols * rows * 4);
      const fill = (src: Uint8ClampedArray) => {
        // Image rows are top-down; textures are bottom-up.
        for (let y = 0; y < rows; y++) data.set(src.subarray((rows - 1 - y) * cols * 4, (rows - y) * cols * 4), y * cols * 4);
      };
      fill(rgba);
      const tex = new DataTexture(data, cols, rows, RGBAFormat);
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.needsUpdate = true;
      const mat = new ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: SCREEN_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: { uTex: { value: tex }, uGrid: { value: [cols, rows] }, uReveal: { value: 1 }, uTime: { value: 0 } },
      });
      const plane = new Mesh(new PlaneGeometry(width, (width * rows) / cols), mat);
      scene.add(plane);
      return {
        mesh: plane,
        reveal(p, seconds = 1.5) {
          if (seconds <= 0) mat.uniforms.uReveal.value = p;
          else tween(mat.uniforms.uReveal, { value: p, duration: dur(seconds), ease: 'power1.inOut' });
        },
        setImage(src) {
          fill(src);
          tex.needsUpdate = true;
        },
      };
    },
    box(text, position, size, color = COLORS.violet) {
      const g = new Group();
      const geo = new BoxGeometry(...size);
      const edges = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      const fill = new Mesh(geo, new MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false }));
      g.add(edges, fill);
      const l = label(text, 'big');
      l.position.set(0, size[1] / 2 + 0.18, 0);
      g.add(l);
      g.position.set(...position);
      scene.add(g);
      return g;
    },
    panel(title, content, o = {}) {
      const side = o.side ?? 'right';
      let slot = overlay.querySelector<HTMLElement>(`.ms-slot.${side}`);
      if (!slot) {
        slot = h(`div.ms-slot.${side}`);
        overlay.append(slot);
      }
      const body = h('div.ms-body', {}, content);
      const head = h('button.ms-head', { attrs: { type: 'button' } }, [h('span', { text: title }), h('span.ms-chev', { text: '▾' })]);
      const el = h(`div.ms-panel${o.className ? '.' + o.className : ''}`, {}, [head, body]);
      if (o.collapsed) el.classList.add('collapsed');
      head.addEventListener('click', () => el.classList.toggle('collapsed'));
      slot.append(el);
      return el;
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    tween,
    destroy() {
      tweens.forEach((tw) => tw.kill());
      host.removeEventListener('pointerdown', onPointer);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
    },
  };
  return stage;
}

/** Convenience for slides: run `fn` either animated or instantly depending on `animate`. */
export const secs = (animate: boolean, s: number) => (animate ? s : 0);
