import { Vector3 } from 'three';
import { SHOWCASE_ROT_Y } from '../core/derived';
import { h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { AMBIENT, BASE_COLOR, LIGHT_DIR, SHININESS, VIEW_DIR, dot, normalize, shade } from '../pipeline/shade';
import type { V3 } from '../pipeline/transform';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { PixelCanvas } from '../views/PixelCanvas';
import { COLORS } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { RIG_EYE, centerFragment, fragCoord, fragCoordName, glowDot, linImage, lineSet, loopPts, projectionRig, setLines, vecArrow, zoomShowcase } from './14-rasterization';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/fragment-shader.css';

const f3 = (v: number, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const vec = (v: readonly number[], d = 3) => `(${v.map((x) => f3(x, d)).join(', ')})`;
const rgb = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`;
const V3of = (v: Vector3): V3 => [v.x, v.y, v.z];

/** Blinn–Phong for normal n and light l, exactly like shade() but with any light direction. */
function blinnPhong(n: V3, l: V3) {
  const hv = normalize([l[0] + VIEW_DIR[0], l[1] + VIEW_DIR[1], l[2] + VIEW_DIR[2]]);
  const diffuse = Math.max(dot(n, l), 0);
  const nh = Math.max(dot(n, hv), 0);
  const specular = diffuse > 0 ? Math.pow(nh, SHININESS) : 0;
  const color = [0, 1, 2].map((i) => Math.min(1, BASE_COLOR[i] * (AMBIENT + diffuse) + specular * 0.8)) as V3;
  return { h: hv, diffuse, nh, specular, color };
}

/** A glowing arrow in CSS pixels. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, color: string, label: string) {
  const x2 = x + dx;
  const y2 = y + dy;
  const a = Math.atan2(dy, dx);
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x2, y2);
  g.stroke();
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - 9 * Math.cos(a - 0.4), y2 - 9 * Math.sin(a - 0.4));
  g.lineTo(x2 - 9 * Math.cos(a + 0.4), y2 - 9 * Math.sin(a + 0.4));
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.font = '700 12px "JetBrains Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lx = x2 + Math.cos(a) * 12;
  const ly = y2 + Math.sin(a) * 12;
  g.fillStyle = 'rgba(5,6,13,0.75)';
  g.fillRect(lx - 8, ly - 8, 16, 16);
  g.fillStyle = color;
  g.fillText(label, lx, ly);
  g.restore();
}

/** Tween the light direction uniform of a model stage back to the app's fixed light. */
function restoreLight(ms: ModelStage, animate: boolean) {
  ms.lightOrbit(false);
  const u = ms.material.uniforms.uLightDir.value;
  if (!animate) u.set(...LIGHT_DIR);
  else ms.tween(u, { x: LIGHT_DIR[0], y: LIGHT_DIR[1], z: LIGHT_DIR[2], duration: secs(animate, 0.8), ease: 'power2.inOut', onUpdate: () => void u.normalize() });
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.12, eye: RIG_EYE, bloom: 0.4, bloomThreshold: 0.93 });
  const z = zoomShowcase(ctx);
  const frag = z ? centerFragment(z) : null;
  if (!z || !frag) {
    ms.panel(t(L('Fragment shader', 'Fragment shader')), [h('div.hint', { text: t(L('Ingen synlig triangel.', 'No visible triangle.')) })]);
    return { show() {}, destroy: () => ms.destroy() };
  }

  /* ---------- 3D: the followed fragment on the model, with its vectors ---------- */
  ms.pivot.updateMatrix();
  const M = ms.pivot.matrix;
  const vids = ctx.derived.triangleVertices(z.tri);
  const P = vids.map((i) => new Vector3(...ctx.derived.position(i)));
  const b = frag.bary;
  const pWorld = P[0].clone().multiplyScalar(b[0]).addScaledVector(P[1], b[1]).addScaledVector(P[2], b[2]).applyMatrix4(M);
  const cornersW = P.map((p) => p.clone().applyMatrix4(M));
  const rot = ms.pivot.quaternion;
  const cornerN = vids.map((i) => new Vector3(...ctx.derived.normal(i)).applyQuaternion(rot));
  const raw = frag.attrs as V3;
  const terms = shade(raw);
  const nW = new Vector3(...terms.n);
  const faceN = cornersW[1].clone().sub(cornersW[0]).cross(cornersW[2].clone().sub(cornersW[0])).normalize().multiplyScalar(0.01);
  const triLine = lineSet(ms.scene, loopPts(cornersW.map((c) => c.clone().add(faceN))), COLORS.cyan, 0.9);
  const dot3 = glowDot(ms.scene, pWorld.clone().add(faceN), COLORS.white, 0.13);
  const nArrow = vecArrow(ms.scene, COLORS.magenta, 'N', 'magenta');
  nArrow.set(pWorld, nW, 0.85);
  const cornerArrows = cornersW.map((c, i) => {
    const a = vecArrow(ms.scene, 0xc04fa8, '', 'magenta');
    a.set(c, cornerN[i], 0.4);
    return a;
  });
  const lArrow = vecArrow(ms.scene, COLORS.amber, 'L', 'amber');
  const hArrow = vecArrow(ms.scene, COLORS.cyan, 'H', 'cyan');
  const sunFixed = glowDot(ms.scene, new Vector3(...LIGHT_DIR).multiplyScalar(2.1), 0xfff1c4, 0.5);
  const lightRay = lineSet(ms.scene, [], COLORS.amber, 0.45);
  // Step 3: the whole image, every fragment shaded "at once".
  const IW = 160;
  const IH = 100;
  const image = ctx.derived.render(api, IW, IH);
  const rig = projectionRig(ms, 1.8);
  const screen = ms.screenPlane(linImage(image.color), IW, IH, rig.w);
  screen.mesh.position.copy(rig.group.position);
  screen.mesh.quaternion.copy(rig.group.quaternion);
  screen.mesh.translateZ(0.002);
  const { stats } = image;

  /* ---------- Panels ---------- */
  const numbers = ms.panel('', []);
  const numHead = numbers.querySelector('.ms-head span')!;
  const numBody = numbers.querySelector('.ms-body')!;
  const canvasHost = h('div.fs-zoom');
  const zoomPanel = ms.panel(t(L(`Närbild · triangel #${z.tri}`, `Close-up · triangle #${z.tri}`)), [canvasHost]);
  const pc = new PixelCanvas(canvasHost, z.cols, z.rows, 8);
  const view = image.matrices.view.elements;
  const screenDir = (v: V3): [number, number] => [view[0] * v[0] + view[4] * v[1] + view[8] * v[2], -(view[1] * v[0] + view[5] * v[1] + view[9] * v[2])];
  const shaded = z.frags.map((f) => shade(f.attrs as V3).color);
  const [fx, fy] = fragCoord(api, frag.x + z.x0, frag.y + z.y0, z.fullH);
  const out8 = terms.color.map((c) => Math.round(c * 255));

  let step = 0;
  let light: V3 = [...LIGHT_DIR];
  let live = blinnPhong(terms.n, light);

  const drawCrop = () => {
    pc.clear();
    pc.grid(0.08);
    z.frags.forEach((f, i) => {
      if (step >= 2) pc.fillCell(f.x, f.y, rgb(shaded[i]), 0.04);
      else pc.fillCell(f.x, f.y, f === frag ? rgb(step === 1 ? live.color : [0.6, 0.65, 1]) : 'rgba(110,130,220,0.22)', 0.08);
    });
    pc.triangle(z.verts.map((v) => [v.x, v.y] as [number, number]), 'rgba(56,225,255,0.7)', undefined, 1.5, 8);
    const [cx, cy] = pc.px(frag.x + 0.5, frag.y + 0.5);
    const g = pc.ctx;
    g.save();
    g.strokeStyle = '#fff';
    g.shadowColor = '#fff';
    g.shadowBlur = 14;
    g.lineWidth = 2;
    g.strokeRect(cx - pc.cell / 2 - 2, cy - pc.cell / 2 - 2, pc.cell + 4, pc.cell + 4);
    g.restore();
    const len = Math.min(pc.width, pc.height) * 0.3;
    const draw = (v: V3, color: string, lbl: string) => {
      const [dx, dy] = screenDir(v);
      const l = Math.hypot(dx, dy) || 1;
      const s = (len * Math.max(0.25, Math.min(1, l))) / l;
      arrow(g, cx, cy, dx * s, dy * s, color, lbl);
    };
    draw(terms.n, '#ff3fd2', 'N');
    if (step >= 1) {
      draw(light, '#ffb547', 'L');
      draw(live.h, '#38e1ff', 'H');
    }
  };
  pc.onResize(() => step <= 2 && drawCrop());

  const bar = (lbl: string, v: number, color: string, text = f3(v)) =>
    `<div class="fs-bar"><span>${lbl}</span><i><em style="width:${Math.min(100, v * 100)}%;background:${color};box-shadow:0 0 10px ${color}"></em></i><b>${text}</b></div>`;
  const row = (k: string, v: string, cls = '') => `<div class="fs-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const statRow = (items: [string, string, string?][]) => `<div class="stat-row">${items.map(([v, k, c]) => stat(v, k, c ?? '').outerHTML).join('')}</div>`;
  const titles = [
    L('Indata till ett fragment', 'Inputs of one fragment'),
    L('Blinn–Phong, live', 'Blinn–Phong, live'),
    L('Utdata', 'Output'),
    L(`Hela bilden @ ${IW}×${IH}`, `Whole image @ ${IW}×${IH}`),
  ];
  const updateSide = () => {
    numHead.textContent = t(titles[step]);
    const io = `${fragCoordName(api)} = (${f3(fx, 1)}, ${f3(fy, 1)})`;
    let html = '';
    if (step === 0) {
      const len = Math.hypot(...raw);
      html = `${statRow([[f3(len), '|vNormal|', Math.abs(len - 1) > 0.001 ? 'glow-amber' : ''], [frag.bary.map((x) => f3(x, 2)).join(' '), 'b0 b1 b2']])}
        <div class="fs-code">${io}</div>
        ${row('vNormal', vec(raw), 'c-nrm')}
        ${row('n = normalize', vec(terms.n), 'c-nrm')}
        <p class="fs-note">${t(L('Hörnnormalerna n0–n2 interpoleras till fragmentets N. Mellan hörnen blir den kortare än 1 – därför normaliserar shadern igen. Modellen visar normalen som färg.', 'The vertex normals n0–n2 are interpolated into the fragment\'s N. Between the corners it gets shorter than 1 – that is why the shader normalizes again. The model shows the normal as color.'))}</p>`;
    } else if (step === 1) {
      html = `${statRow([[f3(live.diffuse), 'N·L', 'glow-amber'], [f3(live.nh), 'N·H', 'glow-cyan']])}
        ${row('L', vec(light), 'glow-amber')}
        ${row('H = norm(L + V)', vec(live.h), 'glow-cyan')}
        ${bar('N·L', live.diffuse, '#ffb547')}
        ${bar('N·H', live.nh, '#38e1ff')}
        ${bar(`(N·H)<sup>${SHININESS}</sup>`, live.specular, '#ffffff', live.specular < 0.001 ? live.specular.toExponential(1) : f3(live.specular))}
        ${bar('ambient', AMBIENT, '#9b7bff', AMBIENT.toFixed(2))}
        <div class="fs-swatch" style="background:${rgb(live.color)}"></div>
        <p class="fs-note">${t(L('Ljuset kretsar – samma fragment, nya värden varje bildruta. V antas vara +Z, som i appens shader.', 'The light orbits – same fragment, new values every frame. V is taken as +Z, as in the app\'s shader.'))}</p>`;
    } else if (step === 2) {
      const ch = ['R', 'G', 'B'];
      const lines = [0, 1, 2]
        .map((i) => `<div class="fs-eq"><span>${ch[i]}</span>${f3(BASE_COLOR[i], 2)}·(${AMBIENT.toFixed(2)}+${f3(terms.diffuse)}) + ${f3(terms.specular)}·0.8 = <b>${f3(terms.color[i])}</b></div>`)
        .join('');
      html = `${statRow([[`${out8.join(', ')}`, t(L('RGBA8 (utan A)', 'RGBA8 (no A)')), 'glow-amber'], [String(z.frags.length), t(L('fragment i triangeln', 'fragments in triangle'))]])}
        <div class="fs-eqs">${lines}</div>
        <div class="fs-swatch" style="background:${rgb(terms.color)};box-shadow:0 0 28px ${rgb(terms.color)}"></div>
        ${row(api === 'd3d12' ? 'SV_Target0' : 'outColor (location 0)', vec([...terms.color, 1], 2))}`;
    } else {
      html = `${statRow([[stats.written.toLocaleString(), t(L('shader-anrop som skrev', 'invocations that wrote')), 'glow-magenta'], [stats.depthRejected.toLocaleString(), t(L('kastade av djuptest', 'rejected by depth test')), 'rz-neg']])}
        ${row(t(L('fragment från rasteriseraren', 'fragments from the rasterizer')), stats.fragments.toLocaleString())}
        ${row(t(L('≈ anrop vid 1920×1080', '≈ invocations at 1920×1080')), Math.round((stats.written * 1920 * 1080) / (IW * IH)).toLocaleString())}
        <p class="fs-note">${t(L('Bilden framför modellen fylls i slumpvis ordning – alla fragment kör samma program, parallellt. Med <i>early-Z</i> testas djupet före shadern, så skymda fragment aldrig behöver skuggas.', 'The image in front of the model fills in random order – every fragment runs the same program, in parallel. With <i>early-Z</i>, depth is tested before the shader, so hidden fragments never need shading.'))}</p>`;
    }
    numBody.innerHTML = html;
  };

  const aimLight = () => {
    const lv = new Vector3(...light);
    lArrow.set(pWorld, lv, 0.8);
    hArrow.set(pWorld, new Vector3(...live.h), 0.8);
    setLines(lightRay, step >= 1 && step <= 2 ? [pWorld, pWorld.clone().addScaledVector(lv, 1.9)] : []);
  };
  let frameNo = 0;
  ms.onFrame(() => {
    if (step !== 1) return;
    const u = ms.material.uniforms.uLightDir.value;
    light = [u.x, u.y, u.z];
    live = blinnPhong(terms.n, light);
    aimLight();
    if (++frameNo % 5 === 0) {
      drawCrop();
      updateSide();
    }
  });

  return {
    show(s, animate) {
      step = s;
      const fixed = s !== 1;
      if (fixed) {
        restoreLight(ms, animate && s === 2);
        light = [...LIGHT_DIR];
        live = blinnPhong(terms.n, light);
      } else ms.lightOrbit(true);
      // Model look: the interpolated normal as color (0), lit (1), shading sweeping over it (2), lit (3).
      if (s === 0) ms.setMode('normals', 1, secs(animate, 0.6));
      else if (s === 2) ms.sweep('shaded', 'normals', secs(animate, 2.4));
      else ms.setMode('shaded', 0, secs(animate, 0.6));
      ms.setLayer('wire', s === 0 ? 0.08 : 0, secs(animate, 0.4));
      triLine.visible = dot3.visible = nArrow.visible = s <= 2;
      cornerArrows.forEach((a) => (a.visible = s === 0));
      lArrow.visible = hArrow.visible = lightRay.visible = s === 1 || s === 2;
      sunFixed.visible = s === 2;
      rig.group.visible = screen.mesh.visible = s === 3;
      if (s === 3) {
        screen.reveal(animate ? 0 : 1, 0);
        if (animate) screen.reveal(1, secs(animate, 2.4));
      }
      zoomPanel.style.display = s <= 2 ? '' : 'none';
      aimLight();
      if (s <= 2) drawCrop();
      updateSide();
    },
    destroy() {
      pc.destroy();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: the spinning model, an orbiting light, shading spreading   */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, { autoRotate: 0, eye: [1.5, 1.25, 3.7], bloom: 0.45, bloomThreshold: 0.93 });
  const tri = ctx.derived.showcaseTriangle(api);
  const vids = ctx.derived.triangleVertices(tri);
  const P = vids.map((i) => new Vector3(...ctx.derived.position(i)));
  const Nn = vids.map((i) => new Vector3(...ctx.derived.normal(i)));
  // A point inside the triangle, in model space (it spins with the model).
  const pModel = P[0].clone().add(P[1]).add(P[2]).multiplyScalar(1 / 3);
  const nModel = Nn[0].clone().add(Nn[1]).add(Nn[2]).normalize();
  const dotM = glowDot(ms.pivot, pModel.clone().addScaledVector(nModel, 0.01), COLORS.white, 0.12);
  const nArrow = vecArrow(ms.pivot, COLORS.magenta, 'N', 'magenta');
  nArrow.set(pModel, nModel, 0.55);
  const lArrow = vecArrow(ms.scene, COLORS.amber, 'L', 'amber');
  const hArrow = vecArrow(ms.scene, COLORS.cyan, 'H', 'cyan');
  const lightRay = lineSet(ms.scene, [], COLORS.amber, 0.4);
  const IW = 160;
  const IH = 100;
  const image = ctx.derived.render(api, IW, IH);
  const rig = projectionRig(ms, 1.8);
  const screen = ms.screenPlane(linImage(image.color), IW, IH, rig.w);
  screen.mesh.position.copy(rig.group.position);
  screen.mesh.quaternion.copy(rig.group.quaternion);
  screen.mesh.translateZ(0.002);

  const readout = h('div.stat-row');
  const swatch = h('div.fs-swatch');
  const livePanel = ms.panel(t(L('Ett fragment', 'One fragment')), [readout, swatch]);
  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.fs-capt')], { side: 'bottom' });
  const text = caption.querySelector('.fs-capt')!;
  const captions = [
    L('Varje fragment har sin egen interpolerade normal <b style="color:var(--magenta)">N</b> – här som färg på modellen, och som igelkott.', 'Each fragment has its own interpolated normal <b style="color:var(--magenta)">N</b> – shown as color on the model, and as a hedgehog.'),
    L('Ljuset kretsar. Ljusstyrkan följer <b style="color:var(--amber)">N·L</b>; högdagern följer <b style="color:var(--cyan)">N·H</b> upphöjt till 48.', 'The light orbits. Brightness follows <b style="color:var(--amber)">N·L</b>; the highlight follows <b style="color:var(--cyan)">N·H</b> raised to 48.'),
    L('Shadern körs en gång per fragment och "målar" det – skuggningen sprider sig över modellen, fragment för fragment.', 'The shader runs once per fragment and "paints" it – the shading spreads over the model, fragment by fragment.'),
    L('Alla fragment kör <b>samma program</b> samtidigt, i tusentals trådar – bilden framför modellen fylls i godtycklig ordning.', 'All fragments run <b>the same program</b> at once, in thousands of threads – the image in front of the model fills in any order.'),
  ];

  let step = 0;
  let spin = true;
  let lastSweep = -10;
  let frameNo = 0;
  const pw = new Vector3();
  const nw = new Vector3();
  let now = 0;
  let t3 = 0;
  ms.onFrame((time, dt) => {
    now = time;
    if (step === 3) {
      screen.reveal(Math.min(1, ((time - t3) % 3.6) / 2.6), 0);
      return;
    }
    if (spin) ms.pivot.rotation.y += dt * 0.3;
    if (step === 2 && time - lastSweep > 3.6) {
      lastSweep = time;
      ms.sweep('shaded', 'normals', 2.4);
    }
    if (step === 1 || step === 2) {
      ms.pivot.updateMatrix();
      pw.copy(pModel).applyMatrix4(ms.pivot.matrix);
      nw.copy(nModel).applyQuaternion(ms.pivot.quaternion);
      const u = ms.material.uniforms.uLightDir.value;
      const r = blinnPhong(V3of(nw), [u.x, u.y, u.z]);
      lArrow.set(pw, u, 0.55);
      hArrow.set(pw, new Vector3(...r.h), 0.55);
      setLines(lightRay, [pw, pw.clone().addScaledVector(u, 1.9)]);
      if (++frameNo % 5 === 0) {
        readout.innerHTML = [stat(f3(r.diffuse), 'N·L', 'glow-amber'), stat(r.specular < 0.001 ? r.specular.toExponential(1) : f3(r.specular), `(N·H)^${SHININESS}`, 'glow-cyan')].map((e) => e.outerHTML).join('');
        swatch.style.background = rgb(r.color);
      }
    }
  });

  return {
    show(s, animate) {
      step = s;
      t3 = now;
      text.innerHTML = t(captions[s]);
      if (animate) caption.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: secs(animate, 0.4) * 1000 });
      spin = s <= 2;
      if (s === 3) {
        if (animate) ms.tween(ms.pivot.rotation, { y: SHOWCASE_ROT_Y + Math.round((ms.pivot.rotation.y - SHOWCASE_ROT_Y) / (Math.PI * 2)) * Math.PI * 2, duration: 0.9, ease: 'power2.inOut' });
        else ms.pivot.rotation.y = SHOWCASE_ROT_Y;
        restoreLight(ms, animate);
        screen.reveal(animate ? 0 : 1, 0);
      } else if (s >= 1) ms.lightOrbit(true);
      else restoreLight(ms, false);
      if (s === 0) ms.setMode('normals', 1, secs(animate, 0.6));
      else if (s === 2) {
        lastSweep = -10;
        if (!animate) ms.setMode('shaded', 0, 0);
      } else ms.setMode('shaded', 0, secs(animate, 0.6));
      ms.setLayer('normals', s === 0 ? 0.55 : 0, secs(animate, 0.5));
      dotM.visible = nArrow.visible = s <= 2;
      lArrow.visible = hArrow.visible = lightRay.visible = s === 1 || s === 2;
      livePanel.style.display = s === 1 || s === 2 ? '' : 'none';
      rig.group.visible = screen.mesh.visible = s === 3;
    },
    destroy() {
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const ld = `normalize(0.5, 0.8, 0.6)`;
  const bc = `(${BASE_COLOR.join(', ')})`;
  const sh = SHININESS.toFixed(1);
  const am = AMBIENT.toFixed(2);
  const glsl = (vk: boolean) => `#version 460
layout(location = 0) in  vec3 vNormal;   // interpolated, world space
layout(location = 0) out vec4 outColor;  // → color attachment 0

layout(${vk ? 'set = 0, binding = 0' : 'binding = 0'}, std140) uniform Light {
    vec3 lightDir;    // ${ld}
    vec3 baseColor;   // ${bc}
};

void main() {
    vec3  n    = normalize(vNormal);
    float diff = max(dot(n, lightDir), 0.0);           // N·L
    vec3  h    = normalize(lightDir + vec3(0, 0, 1));  // V = +Z
    float spec = diff > 0.0 ? pow(max(dot(n, h), 0.0), ${sh}) : 0.0;
    vec3  c    = baseColor * (${am} + diff) + spec * 0.8;
    outColor   = vec4(min(c, vec3(1.0)), 1.0);
}`;
  const hlsl = `cbuffer Light : register(b0) {
    float3 lightDir;    // ${ld}
    float3 baseColor;   // ${bc}
};
struct PSIn {
    float4 pos    : SV_Position;  // pixel center (x+0.5, y+0.5)
    float3 normal : NORMAL;       // interpolated, world space
};

float4 main(PSIn i) : SV_Target {  // → render target 0
    float3 n    = normalize(i.normal);
    float  diff = max(dot(n, lightDir), 0.0);           // N·L
    float3 h    = normalize(lightDir + float3(0, 0, 1)); // V = +Z
    float  spec = diff > 0 ? pow(max(dot(n, h), 0.0), ${sh}) : 0.0;
    float3 c    = baseColor * (${am} + diff) + spec * 0.8;
    return float4(min(c, 1.0), 1.0);
}`;
  const glHl = [[2, 11], [5, 6, 7, 12, 13, 14], [3, 15, 16], [10]];
  const hlHl = [[6, 7, 11], [1, 2, 3, 12, 13, 14], [10, 15, 16], [10]];
  return {
    opengl: {
      note: L(
        'Fragment shadern körs en gång per fragment. Den läser interpolerade varyings och uniforms och skriver en färg till varje utgång (location = färg-attachment).',
        'The fragment shader runs once per fragment. It reads interpolated varyings and uniforms and writes a color to each output (location = color attachment).',
      ),
      code: [
        { lang: 'glsl', title: L('Fragment shader', 'Fragment shader'), src: glsl(false), highlight: glHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
glShaderSource(fs, 1, &src, nullptr);
glCompileShader(fs);
glAttachShader(program, fs);
glLinkProgram(program);
glBindBufferBase(GL_UNIFORM_BUFFER, 0, lightUbo);  // binding = 0
glUseProgram(program);`,
          highlight: [[1, 2, 3], [6], [4, 5], [7]],
        },
      ],
      terms: [
        { term: 'varying / in', desc: L('Värde från vertex shadern, interpolerat perspektivkorrekt per fragment.', 'Value from the vertex shader, interpolated perspective-correctly per fragment.') },
        { term: 'gl_FragCoord', desc: L('Fragmentets fönsterposition och djup; origo nere till vänster i OpenGL.', 'The fragment\'s window position and depth; origin bottom-left in OpenGL.') },
        { term: 'discard', desc: L('Avbryter fragmentet så att inget skrivs (t.ex. alpha-test).', 'Kills the fragment so nothing is written (e.g. alpha test).') },
      ],
      you: L('skriver shadern', 'write the shader'),
      driver: L('kompilerar GLSL åt GPU:n', 'compiles the GLSL for the GPU'),
    },
    vulkan: {
      note: L(
        'Samma GLSL, men kompilerad i förväg till SPIR-V (glslc / glslangValidator). Resurser adresseras med set och binding från descriptor set layouten.',
        'Same GLSL, but compiled ahead of time to SPIR-V (glslc / glslangValidator). Resources are addressed by set and binding from the descriptor set layout.',
      ),
      code: [
        { lang: 'glsl', title: L('Fragment shader', 'Fragment shader'), src: glsl(true), highlight: glHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `// glslc -fshader-stage=frag light.frag -o light.frag.spv
VkPipelineShaderStageCreateInfo fsStage{
    VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
fsStage.stage  = VK_SHADER_STAGE_FRAGMENT_BIT;
fsStage.module = fragModule;   // vkCreateShaderModule(SPIR-V)
fsStage.pName  = "main";
// location 0 → VkPipelineRenderingCreateInfo::pColorAttachmentFormats[0]`,
          highlight: [[1, 5], [4], [7], [2, 3, 6]],
        },
      ],
      terms: [
        { term: 'SPIR-V', desc: L('Binärt mellanformat som Vulkan-drivrutinen kompilerar vidare till GPU-kod.', 'Binary intermediate format that the Vulkan driver compiles further into GPU code.') },
        { term: 'set / binding', desc: L('Var en uniform buffer finns: descriptor set nr och plats i setet.', 'Where a uniform buffer lives: descriptor set number and slot in the set.') },
        { term: 'gl_FragCoord', desc: L('I Vulkan ligger origo uppe till vänster (OriginUpperLeft i SPIR-V).', 'In Vulkan the origin is top-left (OriginUpperLeft in SPIR-V).') },
      ],
      you: L('skriver och kompilerar shadern', 'write and compile the shader'),
      driver: L('SPIR-V → GPU-kod', 'SPIR-V → GPU code'),
    },
    d3d12: {
      note: L(
        'I D3D heter det pixel shader. HLSL kompileras med dxc till DXIL (ps_6_x), och SV_Target anger vilket render target färgen hamnar i.',
        'In D3D it is called the pixel shader. HLSL is compiled with dxc to DXIL (ps_6_x), and SV_Target says which render target the color goes to.',
      ),
      code: [
        { lang: 'hlsl', title: L('Pixel shader', 'Pixel shader'), src: hlsl, highlight: hlHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `// dxc -T ps_6_6 -E main light.hlsl -Fo light.ps.cso
pso.PS = { psBlob->GetBufferPointer(), psBlob->GetBufferSize() };
pso.NumRenderTargets = 1;
pso.RTVFormats[0]    = DXGI_FORMAT_R8G8B8A8_UNORM;  // SV_Target0
// b0 = root CBV: cmd->SetGraphicsRootConstantBufferView(0, cbAddr);`,
          highlight: [[1, 2], [5], [3, 4], [2]],
        },
      ],
      terms: [
        { term: 'SV_Position', desc: L('Pixelcentrum i fönsterkoordinater (x+0.5, y+0.5), origo uppe till vänster.', 'Pixel center in window coordinates (x+0.5, y+0.5), origin top-left.') },
        { term: 'SV_Target', desc: L('Utdata till render target 0..7 (SV_Target0 … SV_Target7).', 'Output to render target 0..7 (SV_Target0 … SV_Target7).') },
        { term: 'DXIL', desc: L('D3D12:s shader-bytekod (LLVM-baserad), från dxc.', 'D3D12\'s shader bytecode (LLVM-based), from dxc.') },
      ],
      you: L('skriver och kompilerar shadern', 'write and compile the shader'),
      driver: L('DXIL → GPU-kod', 'DXIL → GPU code'),
    },
  };
}

export default standardSlide({
  id: 'fragment-shader',
  group: 'gpu-prog',
  short: L('Fragment shader', 'Fragment shader'),
  title: L('Fragment shader – en färg per fragment', 'Fragment shader – one color per fragment'),
  lead: L(
    'Fragment shadern (i D3D: <i>pixel shader</i>) är ditt program som körs för varje fragment. Den får interpolerade värden och räknar ut fragmentets färg – här med Blinn–Phong.',
    'The fragment shader (in D3D: <i>pixel shader</i>) is your program that runs for every fragment. It receives interpolated values and computes the fragment\'s color – here with Blinn–Phong.',
  ),
  bullets: [
    L(
      'Indata: pixelpositionen och de <b>interpolerade</b> varyings från vertex shadern – här världsnormalen. Den är inte längre exakt 1 lång och normaliseras om.',
      'Input: the pixel position and the <b>interpolated</b> varyings from the vertex shader – here the world normal. It is no longer exactly unit length, so it is normalized again.',
    ),
    L(
      '<b>Diffust</b> ljus = max(N·L, 0). <b>Spekulärt</b> (Blinn–Phong) = (N·H)<sup>48</sup>, där H ligger mitt emellan ljus och betraktare. Plus lite <b>ambient</b>.',
      '<b>Diffuse</b> light = max(N·L, 0). <b>Specular</b> (Blinn–Phong) = (N·H)<sup>48</sup>, where H is halfway between light and viewer. Plus a little <b>ambient</b>.',
    ),
    L(
      'Färg = bas · (ambient + diffust) + spekulärt · 0.8, klampad till [0, 1]. Den skrivs till utgång 0 och lagras som 8 bitar per kanal.',
      'Color = base · (ambient + diffuse) + specular · 0.8, clamped to [0, 1]. It is written to output 0 and stored as 8 bits per channel.',
    ),
    L(
      'Samma program körs för <b>alla</b> fragment, massivt parallellt. Fragment som djuptestet ändå skulle kasta kan sorteras bort före shadern (<i>early-Z</i>).',
      'The same program runs for <b>every</b> fragment, massively in parallel. Fragments the depth test would discard anyway can be culled before the shader (<i>early-Z</i>).',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
