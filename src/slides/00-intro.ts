import gsap from 'gsap';
import { Group } from 'three';
import { dur, h } from '../core/dom';
import { L, UI } from '../core/i18n';
import { BUILTINS, builtinMesh } from '../model/builtins';
import { formatBytes } from '../pipeline/layout';
import { COLORS, disposeScene, makeScene, shadedMesh, starfield, vertexPoints, wireframe } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { SlideContext, Visual } from './types';

/** Shared 3D hero: the loaded model spinning in a glowing star field. */
function hero(host: HTMLElement, ctx: SlideContext, concept: boolean): Visual {
  const { scene, camera } = makeScene();
  const pivot = new Group();
  const mesh = ctx.state.mesh;
  const solid = shadedMesh(mesh);
  const wire = wireframe(mesh, concept ? COLORS.magenta : COLORS.cyan, concept ? 0.55 : 0.18);
  const points = vertexPoints(mesh, COLORS.cyan, concept ? 0.05 : 0.025);
  if (!concept) pivot.add(solid);
  pivot.add(wire, points);
  const stars = starfield();
  scene.add(pivot, stars);
  pivot.rotation.x = 0.25;

  let explode = 0;
  const view = {
    scene,
    camera,
    bloom: concept ? 1.1 : 0.45,
    bloomThreshold: concept ? 0.1 : 0.82,
    orbit: true,
    onFrame: (t: number) => {
      pivot.rotation.y = t * 0.35;
      stars.tick(t);
      const pulse = 1 + Math.sin(t * 2) * 0.04 * explode;
      points.scale.setScalar(pulse + explode * 0.12);
      wire.scale.setScalar(1 + explode * 0.06);
    },
  };
  const stage = h('div.v-fill');
  host.append(stage);
  ctx.stage.attach(stage, view);

  // Model stats overlay + quick picks.
  const m = mesh;
  const overlay = h('div.intro-overlay', {}, [
    h('div.stat-row', {}, [
      stat(m.vertexCount.toLocaleString(), ctx.t(UI.vertices), 'glow-cyan'),
      stat(m.triangleCount.toLocaleString(), ctx.t(UI.triangles), 'glow-magenta'),
      stat(formatBytes(m.fileSize), `${ctx.t(UI.fileSize)} · ${m.format === 'builtin' ? 'OBJ' : m.format}`, 'glow-amber'),
    ]),
    h('div.quick', {}, [
      ...BUILTINS.map((b) =>
        h('button.quick-btn', {
          text: ctx.t(b.label),
          attrs: { 'aria-pressed': String(m.format === 'builtin' && m.name === b.id) },
          on: { click: () => ctx.set({ mesh: builtinMesh(b.id) }) },
        }),
      ),
      h('button.quick-btn.file', { text: ctx.t(UI.loadFile), on: { click: () => window.dispatchEvent(new Event('rpv:pick-file')) } }),
    ]),
  ]);
  host.append(overlay);

  return {
    show(step, animate) {
      const target = step >= 2 ? 1 : 0;
      if (animate) gsap.to({ v: explode }, { v: target, duration: dur(0.8), onUpdate() { explode = this.targets()[0].v; } });
      else explode = target;
      if (animate && step === 0) gsap.fromTo(overlay.children, { opacity: 0, y: 12 }, { opacity: 1, y: 0, stagger: 0.08, duration: dur(0.5) });
    },
    destroy() {
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
    },
  };
}

export default standardSlide({
  id: 'intro',
  group: 'cpu',
  short: L('Start', 'Start'),
  title: L('Från fil till pixel', 'From file to pixel'),
  lead: L(
    'Följ ett 3D-objekt genom hela renderingspipelinen – från bytes på disk, via buffertar, shaders och rasterisering, till färdiga pixlar på skärmen.',
    'Follow a 3D object through the entire rendering pipeline – from bytes on disk, through buffers, shaders and rasterization, to finished pixels on screen.',
  ),
  bullets: [
    L(
      '<b>Ladda in ett objekt.</b> Dra och släpp en OBJ-, glTF/GLB- eller STL-fil, eller välj ett inbyggt. Allt du ser framöver räknas fram från just det objektet.',
      '<b>Load an object.</b> Drag and drop an OBJ, glTF/GLB or STL file, or pick a built-in one. Everything you see from here on is computed from that object.',
    ),
    L(
      '<b>Välj API</b> uppe till höger. OpenGL, Vulkan och DirectX 12 gör samma jobb men fördelar ansvaret helt olika mellan dig och drivrutinen.',
      '<b>Pick an API</b> at the top right. OpenGL, Vulkan and DirectX 12 do the same job but split the responsibility between you and the driver very differently.',
    ),
    L(
      '<b>Välj läge.</b> <i>Verklig data</i> visar ditt objekts riktiga siffror, bytes och pixlar. <i>Koncept</i> visar idén bakom varje steg. Bläddra med ← →.',
      '<b>Pick a mode.</b> <i>Real data</i> shows your object\'s actual numbers, bytes and pixels. <i>Concept</i> shows the idea behind each step. Navigate with ← →.',
    ),
  ],
  apiPanel: 'none',
  data: (host, ctx) => hero(host, ctx, false),
  concept: (host, ctx) => hero(host, ctx, true),
});
