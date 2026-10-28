import gsap from 'gsap';
import { AdditiveBlending, BackSide, BoxGeometry, EdgesGeometry, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Vector3, type Texture } from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { dur, h, reducedMotion } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { DEFAULT_CAMERA } from '../pipeline/transform';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { textSprite } from '../views/ThreeStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import '../styles/slides/pipeline-state.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/** The viewport every API-level slide assumes (also used by the descriptors and commands slides). */
const VIEWPORT = { w: 1920, h: 1080 };

type Kind = 'baked' | 'dynamic' | 'global' | 'fb' | 'cmd';

interface StateRow {
  what: Text;
  value: Text;
  spell: Record<ApiId, string>;
  kind: Record<ApiId, Kind>;
  /** GL default value, so the app never has to call it. */
  glDefault?: boolean;
}

/** The pipeline state this app really uses, spelled out in each API. */
function stateRows(ctx: SlideContext): StateRow[] {
  const lay = ctx.derived.layout;
  const sems = lay.attributes.map((a) => a.semantic).join(', ');
  const idx = ctx.state.mesh.indices.length;
  const B: Record<ApiId, Kind> = { opengl: 'global', vulkan: 'baked', d3d12: 'baked' };
  return [
    {
      what: L('Shaders', 'Shaders'),
      value: 'shade VS + FS',
      spell: { opengl: 'glUseProgram(prog)', vulkan: 'stageCount = 2, pStages = { vert, frag }', d3d12: 'VS = shade_vs.cso, PS = shade_ps.cso' },
      kind: B,
    },
    {
      what: L('Vertexindata', 'Vertex input'),
      value: `${lay.attributes.length} attr · stride ${lay.stride} B`,
      spell: {
        opengl: 'glBindVertexArray(vao)   // VAO holds the format',
        vulkan: `pVertexInputState: 1 binding, ${lay.attributes.length} attributes`,
        d3d12: `InputLayout = { ${sems} }`,
      },
      kind: B,
    },
    {
      what: L('Topologi', 'Topology'),
      value: L('triangellista', 'triangle list'),
      spell: {
        opengl: `glDrawElements(GL_TRIANGLES, ${idx}, …)`,
        vulkan: 'topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST',
        d3d12: 'PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE',
      },
      kind: { opengl: 'cmd', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Culling', 'Culling'),
      value: L('baksidor bort', 'cull back faces'),
      spell: { opengl: 'glEnable(GL_CULL_FACE); glCullFace(GL_BACK)', vulkan: 'cullMode = VK_CULL_MODE_BACK_BIT', d3d12: 'CullMode = D3D12_CULL_MODE_BACK' },
      kind: B,
    },
    {
      what: L('Framsida', 'Front face'),
      value: L('moturs (CCW)', 'counter-clockwise'),
      spell: { opengl: 'glFrontFace(GL_CCW)', vulkan: 'frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE', d3d12: 'FrontCounterClockwise = TRUE' },
      kind: B,
    },
    {
      what: L('Polygonläge', 'Polygon mode'),
      value: L('fyllt', 'fill'),
      spell: { opengl: 'glPolygonMode(GL_FRONT_AND_BACK, GL_FILL)   // default', vulkan: 'polygonMode = VK_POLYGON_MODE_FILL', d3d12: 'FillMode = D3D12_FILL_MODE_SOLID' },
      kind: B,
      glDefault: true,
    },
    {
      what: L('Djuptest', 'Depth test'),
      value: 'on · LESS',
      spell: {
        opengl: 'glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LESS)',
        vulkan: 'depthTestEnable = VK_TRUE, depthCompareOp = VK_COMPARE_OP_LESS',
        d3d12: 'DepthEnable = TRUE, DepthFunc = D3D12_COMPARISON_FUNC_LESS',
      },
      kind: B,
    },
    {
      what: L('Djupskrivning', 'Depth write'),
      value: 'on',
      spell: { opengl: 'glDepthMask(GL_TRUE)', vulkan: 'depthWriteEnable = VK_TRUE', d3d12: 'DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL' },
      kind: B,
    },
    {
      what: L('Blending', 'Blending'),
      value: 'off · RGBA write',
      spell: {
        opengl: 'glDisable(GL_BLEND); glColorMask(1, 1, 1, 1)',
        vulkan: 'blendEnable = VK_FALSE, colorWriteMask = R|G|B|A',
        d3d12: 'BlendEnable = FALSE, RenderTargetWriteMask = ALL',
      },
      kind: B,
    },
    {
      what: L('Färgformat', 'Color format'),
      value: 'RGBA8 sRGB',
      spell: {
        opengl: 'FBO: GL_SRGB8_ALPHA8 + glEnable(GL_FRAMEBUFFER_SRGB)',
        vulkan: 'pColorAttachmentFormats = { VK_FORMAT_R8G8B8A8_SRGB }',
        d3d12: 'NumRenderTargets = 1, RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB',
      },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Djupformat', 'Depth format'),
      value: 'D32 float',
      spell: { opengl: 'FBO: GL_DEPTH_COMPONENT32F', vulkan: 'depthAttachmentFormat = VK_FORMAT_D32_SFLOAT', d3d12: 'DSVFormat = DXGI_FORMAT_D32_FLOAT' },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Multisampling', 'Multisampling'),
      value: '1 sample',
      spell: { opengl: 'FBO: samples = 0 (no MSAA)', vulkan: 'rasterizationSamples = VK_SAMPLE_COUNT_1_BIT', d3d12: 'SampleDesc = { 1, 0 }, SampleMask = UINT_MAX' },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Resurslayout', 'Resource layout'),
      value: 'UBO/CBV @ 0',
      spell: { opengl: 'glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo)', vulkan: 'layout = pipelineLayout   // set 0: 1 UBO', d3d12: 'pRootSignature = rootSig   // b0: root CBV' },
      kind: B,
    },
    {
      what: L('Viewport / scissor', 'Viewport / scissor'),
      value: `${VIEWPORT.w} × ${VIEWPORT.h}`,
      spell: {
        opengl: `glViewport(0, 0, ${VIEWPORT.w}, ${VIEWPORT.h})`,
        vulkan: 'VK_DYNAMIC_STATE_VIEWPORT, _SCISSOR → vkCmdSetViewport',
        d3d12: 'RSSetViewports / RSSetScissorRects (command list)',
      },
      kind: { opengl: 'global', vulkan: 'dynamic', d3d12: 'cmd' },
    },
  ];
}

const KIND_LABEL: Record<Kind, Text> = {
  baked: L('bakad', 'baked'),
  dynamic: L('dynamisk', 'dynamic'),
  global: L('global', 'global'),
  fb: L('framebuffer', 'framebuffer'),
  cmd: L('per anrop', 'per call'),
};

/* ------------------------------------------------------------------ */
/* The 3D scene: the model with live pipeline state (both modes)       */
/* ------------------------------------------------------------------ */
const API_HEX: Record<ApiId, number> = { opengl: 0x5aa9e6, vulkan: 0xff4d64, d3d12: 0x6cd04a };
const CSS_HEX = (c: number) => '#' + c.toString(16).padStart(6, '0');

interface Look {
  cull: 'back' | 'front' | 'none';
  depth: boolean;
  wire: boolean;
  blend: number | false;
}
/** The state this app really draws with. */
const GOOD: Look = { cull: 'back', depth: true, wire: false, blend: false };
/** What an earlier draw (a debug overlay, a UI pass) can leave behind in a GL context. */
const LEFTOVER: Look = { cull: 'none', depth: false, wire: true, blend: 0.45 };
/** A second, wireframe "debug" pipeline to switch to on the Vulkan/D3D12 step. */
const DEBUG: Look = { cull: 'none', depth: true, wire: true, blend: false };

interface Demo {
  /** Row in stateRows() that the demo is about. */
  row: number;
  bad: Partial<Look>;
  /** Pull the triangles apart a little so the back faces can be seen through the gaps. */
  explode?: number;
  spell: Record<ApiId, [string, string]>;
  plain: [Text, Text];
}

/** Step 0: one state at a time is switched to a wrong value and back, on the model. */
const DEMOS: Demo[] = [
  {
    row: 3,
    bad: { cull: 'none' },
    explode: 0.22,
    spell: {
      opengl: ['glDisable(GL_CULL_FACE)', 'glEnable(GL_CULL_FACE)'],
      vulkan: ['cullMode = VK_CULL_MODE_NONE', 'cullMode = VK_CULL_MODE_BACK_BIT'],
      d3d12: ['CullMode = D3D12_CULL_MODE_NONE', 'CullMode = D3D12_CULL_MODE_BACK'],
    },
    plain: [L('culling av – baksidorna ritas också (röda)', 'culling off – back faces are drawn too (red)'), L('culling på – baksidorna slängs', 'culling on – back faces are dropped')],
  },
  {
    row: 4,
    bad: { cull: 'front' },
    spell: {
      opengl: ['glFrontFace(GL_CW)', 'glFrontFace(GL_CCW)'],
      vulkan: ['frontFace = VK_FRONT_FACE_CLOCKWISE', 'frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE'],
      d3d12: ['FrontCounterClockwise = FALSE', 'FrontCounterClockwise = TRUE'],
    },
    plain: [L('fel varvordning – fel sida slängs, insidan syns', 'wrong winding – the wrong side is dropped, you see the inside'), L('moturs = framsida', 'counter-clockwise = front')],
  },
  {
    row: 5,
    bad: { wire: true },
    spell: {
      opengl: ['glPolygonMode(GL_FRONT_AND_BACK, GL_LINE)', 'glPolygonMode(GL_FRONT_AND_BACK, GL_FILL)'],
      vulkan: ['polygonMode = VK_POLYGON_MODE_LINE', 'polygonMode = VK_POLYGON_MODE_FILL'],
      d3d12: ['FillMode = D3D12_FILL_MODE_WIREFRAME', 'FillMode = D3D12_FILL_MODE_SOLID'],
    },
    plain: [L('polygonläge: linjer', 'polygon mode: lines'), L('polygonläge: fyllt', 'polygon mode: filled')],
  },
  {
    row: 6,
    bad: { depth: false, cull: 'none' },
    spell: {
      opengl: ['glDisable(GL_DEPTH_TEST) + no culling', 'glEnable(GL_DEPTH_TEST)'],
      vulkan: ['depthTestEnable = VK_FALSE + CULL_MODE_NONE', 'depthTestEnable = VK_TRUE'],
      d3d12: ['DepthEnable = FALSE + CULL_MODE_NONE', 'DepthEnable = TRUE'],
    },
    plain: [L('inget djuptest – ritordningen avgör vad som syns', 'no depth test – draw order decides what shows'), L('djuptest LESS – närmast vinner', 'depth test LESS – the nearest wins')],
  },
  {
    row: 8,
    bad: { blend: 0.45 },
    spell: {
      opengl: ['glEnable(GL_BLEND)', 'glDisable(GL_BLEND)'],
      vulkan: ['blendEnable = VK_TRUE', 'blendEnable = VK_FALSE'],
      d3d12: ['BlendEnable = TRUE', 'BlendEnable = FALSE'],
    },
    plain: [L('blending på – modellen blir genomskinlig', 'blending on – the model turns see-through'), L('blending av – opak', 'blending off – opaque')],
  },
];

/** Step 1: the GL calls that repair the leftover state, one at a time. */
const GL_SEQ: { call: string; look: Partial<Look> }[] = [
  { call: 'glPolygonMode(GL_FRONT_AND_BACK, GL_FILL)', look: { wire: false } },
  { call: 'glDisable(GL_BLEND)', look: { blend: false } },
  { call: 'glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LESS)', look: { depth: true } },
  { call: 'glEnable(GL_CULL_FACE); glCullFace(GL_BACK)', look: { cull: 'back' } },
];

const CHIPS: Record<ApiId | 'plain', string[]> = {
  vulkan: ['vert + frag', 'TRIANGLE_LIST', 'CULL_MODE_BACK_BIT', 'COUNTER_CLOCKWISE', 'POLYGON_MODE_FILL', 'COMPARE_OP_LESS', 'blendEnable = FALSE', 'R8G8B8A8_SRGB', 'D32_SFLOAT', 'SAMPLE_COUNT_1_BIT'],
  d3d12: ['VS + PS (DXIL)', 'TOPOLOGY_TYPE_TRIANGLE', 'CULL_MODE_BACK', 'FrontCounterClockwise', 'FILL_MODE_SOLID', 'COMPARISON_FUNC_LESS', 'BlendEnable = FALSE', 'R8G8B8A8_UNORM_SRGB', 'D32_FLOAT', 'SampleDesc { 1, 0 }'],
  opengl: ['shaders', 'triangle list', 'cull back', 'CCW', 'fill', 'depth LESS', 'blend off', 'RGBA8 sRGB', 'D32F', '1 sample'],
  plain: ['shaders', 'topology', 'cull back', 'CCW', 'fill', 'depth LESS', 'blend off', 'color format', 'depth format', 'samples'],
};

interface StateScene {
  ms: ModelStage;
  /** Called by show(): which step, animated or not. Hooks let the visual update its panels. */
  show(step: number, animate: boolean): void;
  destroy(): void;
}

interface Hooks {
  /** Step 0 demo i is showing its wrong (bad = true) or right value. */
  demo?: (i: number, bad: boolean) => void;
  /** Step 1: GL call k (−1 = leftover state, GL_SEQ.length = the draw) has run. */
  glCall?: (k: number) => void;
  callout: (step: number, k: number, bad: boolean) => string;
}

function stateScene(host: HTMLElement, ctx: SlideContext, concept: boolean, hooks: Hooks): StateScene {
  const api = ctx.state.api;
  const apiC = API_HEX[api];
  const motion = !reducedMotion();
  const ms = createModelStage(host, ctx, { shift: -0.13, autoRotate: concept ? 0.22 : 0, bloom: 0.55, bloomThreshold: 0.85 });
  ms.overlay.classList.add('ps-ms');

  // Back faces as an additive red x-ray: what gets rasterized (and then hidden) when culling is off.
  const xrayMat = new MeshBasicMaterial({ color: COLORS.red, side: BackSide, transparent: true, opacity: 0, blending: AdditiveBlending, depthTest: false, depthWrite: false });
  const xray = new Mesh(ms.layers.solid.geometry, xrayMat);
  xray.renderOrder = 2;
  ms.pivot.add(xray);

  const callout = label('', 'big ps-callout');
  ms.scene.add(callout);
  const say = (text: string, tone: 'ok' | 'bad' | 'warn' | 'api' | 'info' = 'info') => {
    callout.element.textContent = text;
    callout.element.className = `three-label big ps-callout ${tone}`;
  };

  let step = 0;
  let cur: Look = { ...GOOD };
  const look = (l: Partial<Look>, s = 0.3) => {
    cur = { ...cur, ...l };
    ms.state({ cull: cur.cull, depthTest: cur.depth, wireframe: cur.wire, blend: cur.blend }, Math.min(s, 0.15));
    const o = step === 1 && cur.cull === 'none' ? 0.3 : 0;
    if (s > 0) ms.tween(xrayMat, { opacity: o, duration: dur(s) });
    else xrayMat.opacity = o;
  };

  // The pipeline object (steps 2–3).
  const objName = api === 'vulkan' ? 'VkPipeline' : api === 'd3d12' ? 'ID3D12PipelineState' : 'VkPipeline / ID3D12PipelineState';
  const box = ms.box(objName, [0, 0, 0], [2.1, 2.1, 2.1], apiC);
  const boxEdges = (box.children[0] as LineSegments).material as LineBasicMaterial;
  const boxFill = (box.children[1] as Mesh).material as MeshBasicMaterial;
  const boxLabel = box.children[2] as CSS2DObject;
  boxLabel.element.classList.add('ps-boxlabel');
  const textures: Texture[] = [];
  const sprite = (text: string, color: string, hgt = 0.12) => {
    const sp = textSprite(text, color, hgt);
    if (sp.material.map) textures.push(sp.material.map);
    return sp;
  };
  const chipTexts = concept ? CHIPS.plain : CHIPS[api];
  const chips = chipTexts.map((c) => sprite(c, CSS_HEX(apiC), 0.115));
  const scatter = chips.map((_, i) => {
    const a = (i / chips.length) * Math.PI * 2 + 0.4;
    return new Vector3(Math.cos(a) * 1.75, ((i * 7) % 5) * 0.45 - 0.9, Math.sin(a) * 0.6);
  });
  const sink = chips.map((_, i) => new Vector3(((i % 5) - 2) * 0.35, i < 5 ? 0.6 : -0.6, 0.2));
  chips.forEach((c) => {
    c.visible = false;
    ms.scene.add(c);
  });

  // Dynamic state chips + the pipeline cache (step 3).
  const dynNames = api === 'opengl' ? ['glViewport', 'glScissor'] : api === 'vulkan' ? ['vkCmdSetViewport', 'vkCmdSetScissor'] : ['RSSetViewports', 'RSSetScissorRects'];
  const dyn = (concept ? ['viewport', 'scissor'] : dynNames).map((n) => sprite(n, '#5cf08f', 0.12));
  dyn.forEach((d) => {
    d.visible = false;
    ms.scene.add(d);
  });
  const cacheName = api === 'vulkan' ? 'VkPipelineCache' : api === 'd3d12' ? 'ID3D12PipelineLibrary' : 'pipeline cache';
  const cache = ms.box(cacheName, [1.45, -1.2, 0.45], [0.6, 0.38, 0.38], COLORS.amber);
  const ghostMat = new LineBasicMaterial({ color: apiC, transparent: true, opacity: 0 });
  const ghost = new LineSegments(new EdgesGeometry(new BoxGeometry(2.1, 2.1, 2.1)), ghostMat);
  ms.scene.add(ghost);

  ms.onFrame((time) => {
    if (step !== 3) return;
    const tt = motion ? time : 0.8;
    dyn.forEach((d, k) => {
      const a = tt * 0.6 + k * Math.PI;
      d.position.set(Math.cos(a) * 1.7, 0.35 - k * 0.7, Math.sin(a) * 1.7);
      d.material.opacity = 0.55 + 0.45 * Math.abs(Math.sin(tt * 2.2 + k));
    });
  });

  const base = new Vector3(...DEFAULT_CAMERA.eye);
  const dolly = (k: number, s: number) => {
    const p = base.clone().multiplyScalar(k);
    if (s > 0) ms.tween(ms.camera.position, { x: p.x, y: p.y, z: p.z, duration: dur(s), ease: 'power2.inOut' });
    else ms.camera.position.copy(p);
  };

  const validate = () => {
    ms.sweep('shaded', 'shaded', 1.0);
    ms.material.uniforms.uSweepColor.value.set(COLORS.amber);
  };

  let tl: gsap.core.Timeline | null = null;
  const stopLoop = () => {
    tl?.kill();
    tl = null;
  };
  const loop = (build: (tl: gsap.core.Timeline) => number) => {
    stopLoop();
    if (!motion) return false;
    tl = gsap.timeline({ repeat: -1 });
    const end = build(tl);
    tl.set({}, {}, end);
    return true;
  };

  const sealBox = (on: boolean, color = apiC) => {
    box.visible = on;
    boxEdges.color.set(color);
    boxEdges.opacity = 0.95;
    boxFill.color.set(color);
    boxFill.opacity = 0.035;
  };

  return {
    ms,
    show(s, animate) {
      const prev = step;
      step = s;
      stopLoop();
      gsap.killTweensOf(chips.map((c) => c.position));
      ms.setMode('shaded', 0, 0);
      ms.explode(0, 0);
      chips.forEach((c) => (c.visible = false));
      dyn.forEach((d) => (d.visible = s === 3));
      cache.visible = s === 3;
      ghostMat.opacity = 0;
      dolly(s >= 2 ? 1.45 : 1, secs(animate, 1.0));
      callout.position.set(0, s >= 2 ? (concept ? -1.3 : -1.42) : concept ? -1.0 : -1.18, s >= 2 ? 0.5 : 0.3);
      sealBox(s >= 2);

      if (s === 0) {
        look(GOOD, 0);
        say(hooks.callout(0, -1, false), 'ok');
        loop((tl) => {
          DEMOS.forEach((d, i) => {
            const t0 = 0.6 + i * 2.8;
            if (d.explode) tl.call(() => ms.explode(d.explode!, 0.5), [], t0 - 0.5);
            tl.call(() => {
              look(d.bad);
              say(hooks.callout(0, i, true), 'bad');
              hooks.demo?.(i, true);
            }, [], t0);
            tl.call(() => {
              look(GOOD);
              say(hooks.callout(0, i, false), 'ok');
              hooks.demo?.(i, false);
            }, [], t0 + 1.5);
            if (d.explode) tl.call(() => ms.explode(0, 0.4), [], t0 + 2.4);
          });
          return 0.6 + DEMOS.length * 2.8;
        });
        hooks.demo?.(-1, false);
      } else if (s === 1) {
        const run = loop((tl) => {
          tl.call(() => {
            look(LEFTOVER, 0);
            say(hooks.callout(1, -1, true), 'bad');
            hooks.glCall?.(-1);
          }, [], 0);
          GL_SEQ.forEach((g, k) => {
            tl.call(() => {
              look(g.look);
              say(hooks.callout(1, k, false), k === GL_SEQ.length - 1 ? 'ok' : 'api');
              hooks.glCall?.(k);
            }, [], 1.6 + k * 1.3);
          });
          const tDraw = 1.6 + GL_SEQ.length * 1.3 + 0.2;
          tl.call(() => {
            validate();
            say(hooks.callout(1, GL_SEQ.length, false), 'warn');
            hooks.glCall?.(GL_SEQ.length);
          }, [], tDraw);
          return tDraw + 2.8;
        });
        if (!run) {
          look(GOOD, 0);
          say(hooks.callout(1, GL_SEQ.length, false), 'warn');
          hooks.glCall?.(GL_SEQ.length);
        }
      } else if (s === 2) {
        const gather = animate && motion && prev < 2;
        const bindLoop = (t0: number) =>
          loop((tl) => {
            tl.call(() => {
              look(DEBUG, 0);
              sealBox(true, COLORS.amber);
              say(hooks.callout(2, 1, true), 'warn');
            }, [], t0);
            tl.call(() => {
              look(GOOD, 0);
              sealBox(true);
              say(hooks.callout(2, 2, false), 'api');
            }, [], t0 + 2.2);
            return t0 + 4.4;
          });
        if (gather) {
          look(LEFTOVER, 0);
          ms.setMode('ghost', 1, 0);
          boxEdges.opacity = 0.25;
          say(hooks.callout(2, 0, true), 'info');
          chips.forEach((c, i) => {
            c.visible = true;
            c.position.copy(scatter[i]);
            c.material.opacity = 0;
            ms.tween(c.material, { opacity: 1, duration: dur(0.3), delay: i * 0.04 });
            ms.tween(c.position, { x: sink[i].x, y: sink[i].y, z: sink[i].z, duration: dur(1.0), delay: 0.5 + i * 0.07, ease: 'power3.in' });
            ms.tween(c.material, { opacity: 0, duration: dur(0.25), delay: 1.35 + i * 0.07 });
          });
          tl = gsap.timeline();
          tl.call(() => {
            chips.forEach((c) => (c.visible = false));
            look(GOOD, 0);
            ms.setMode('shaded', 0, 0);
            sealBox(true);
            boxFill.opacity = 0.3;
            ms.tween(boxFill, { opacity: 0.035, duration: dur(0.9) });
            say(hooks.callout(2, 0, false), 'api');
          }, [], 2.3);
          tl.call(() => bindLoop(0), [], 4.4);
        } else {
          look(GOOD, 0);
          say(hooks.callout(2, 0, false), 'api');
          bindLoop(1.6);
        }
      } else {
        look(GOOD, 0);
        say(hooks.callout(3, 0, false), 'ok');
        loop((tl) => {
          tl.call(() => {
            ghost.position.set(0, 0, 0);
            ghost.scale.setScalar(1);
            ghostMat.opacity = 0.9;
          }, [], 0.4);
          tl.to(ghost.position, { x: cache.position.x, y: cache.position.y, z: cache.position.z, duration: dur(1.3), ease: 'power2.in' }, 0.5);
          tl.to(ghost.scale, { x: 0.2, y: 0.12, z: 0.12, duration: dur(1.3), ease: 'power2.in' }, 0.5);
          tl.to(ghostMat, { opacity: 0, duration: dur(0.3) }, 1.6);
          tl.call(() => {
            const m = (cache.children[1] as Mesh).material as MeshBasicMaterial;
            m.opacity = 0.35;
            ms.tween(m, { opacity: 0.08, duration: dur(0.7) });
          }, [], 1.8);
          return 3.6;
        });
      }
    },
    destroy() {
      stopLoop();
      gsap.killTweensOf(chips.map((c) => c.position));
      textures.forEach((x) => x.dispose());
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Real data: the state, spelled out per API, next to the model         */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const rows = stateRows(ctx);
  const st = ctx.derived.render(api, 160, 100).stats;
  const stNoCull = ctx.derived.render(api, 160, 100, { cullBack: false }).stats;
  const extraFrags = Math.max(0, stNoCull.fragments - st.fragments);
  const idx = ctx.state.mesh.indices.length;
  const calls = rows.reduce((n, row) => n + (row.kind.opengl === 'global' && !row.glDefault ? row.spell.opengl.split(';').length : 0), 0);
  const baked = rows.filter((row) => row.kind[api] === 'baked').length;

  let scene: StateScene | null = null;

  // Panel 0: this app's state; the row being demonstrated lights up.
  const p0Rows = rows.map((row) => h('tr', {}, [h('td.ps-what', { text: t(row.what) }), h('td.ps-val', { text: t(row.value) })]));
  const p0 = h('div', {}, [
    h('div.stat-row', {}, [
      stat(`${st.culled}/${st.trianglesIn}`, t(L('trianglar cullade', 'triangles culled')), 'glow-cyan'),
      stat(`+${extraFrags.toLocaleString('en-US')}`, t(L('fragment utan culling', 'fragments without culling')), 'glow-magenta'),
    ]),
    h('table.ps-table.ps-compact', {}, [h('tbody', {}, p0Rows)]),
    h('p.ps-note', {
      html: t(L(
        `Testrendering 160×100: djuptestet stoppade ${st.depthRejected} fragment. Modellen visar ett värde i taget fel – och sedan rätt igen.`,
        `Test render 160×100: the depth test rejected ${st.depthRejected} fragments. The model shows one value at a time set wrong – then right again.`,
      )),
    }),
  ]);

  // Panel 1: the GL calls, flipped one at a time.
  const callEls = [...GL_SEQ.map((g) => g.call), `glDrawElements(GL_TRIANGLES, ${idx}, …)`].map((c, i) =>
    h(`div.ps-call${i === GL_SEQ.length ? '.draw' : ''}`, {}, [h('span.ps-sw', {}, [h('span.ps-knob')]), h('code', { text: c })]),
  );
  const p1 = h('div', {}, [
    h('div.stat-row', {}, [stat(String(calls), t(L('state-anrop / draw', 'state calls / draw')), 'glow-amber'), stat('0', t(L('kontrollerade före draw', 'checked before the draw')), 'glow-magenta')]),
    h('div.ps-calls', {}, callEls),
    h('p.ps-note', {
      html: t(L(
        'Allt är global kontext-state: det förra draw-anropet lämnade <i>linjer, blending, inget djup</i>. Först vid <code>glDrawElements</code> ser drivrutinen hela kombinationen – och kan behöva kompilera en ny shadervariant.',
        'Everything is global context state: the previous draw left <i>lines, blending, no depth</i>. Only at <code>glDrawElements</code> does the driver see the whole combination – and it may need to compile a new shader variant.',
      )),
    }),
  ]);

  // Panel 2: the whole create-info, spelled out in the current API.
  const kinds = Array.from(new Set(rows.map((r) => r.kind[api])));
  const legend = h('div.ps-legend', {}, kinds.map((k) => h(`span.ps-kind.k-${k}`, { text: t(KIND_LABEL[k]) })));
  const spellRows = (filter: (r: StateRow) => boolean) =>
    rows.filter(filter).map((row) =>
      h(`tr.k-${row.kind[api]}`, {}, [h('td.ps-what', { text: t(row.what) }), h('td.ps-spell', { text: row.spell[api] })]),
    );
  const p2 = h('div', {}, [
    h('div.stat-row', {}, [
      api === 'opengl'
        ? stat(String(calls), t(L('separata anrop', 'separate calls')), 'glow-amber')
        : stat(`${baked}/${rows.length}`, t(L('bakade i objektet', 'baked into the object')), 'glow-cyan'),
      stat(api === 'opengl' ? '—' : '1', api === 'opengl' ? t(L('inget pipeline-objekt', 'no pipeline object')) : t(L('bind / draw', 'bind / draw')), 'glow-magenta'),
    ]),
    legend,
    h('div.v-scroll.ps-scroll2', {}, [h('table.ps-table.ps-spelled', {}, [h('tbody', {}, spellRows(() => true))])]),
    h('p.ps-note', {
      html: t(api === 'opengl'
        ? L('OpenGL har inget pipeline-objekt – Vulkan och D3D12 samlar allt detta i <b>ett</b> anrop. Modellen visar hur ett helt objekt byts på en gång.', 'OpenGL has no pipeline object – Vulkan and D3D12 put all of this into <b>one</b> call. The model shows a whole object being swapped at once.')
        : L(`Alla ${rows.length} rader i en struct, ett anrop. Att byta till en annan pipeline (här en wireframe-variant) ändrar allt på en gång.`, `All ${rows.length} rows in one struct, one call. Switching to another pipeline (here a wireframe variant) changes everything at once.`)),
    }),
  ]);

  // Panel 3: what stays dynamic, and the cache.
  const dynKinds: Kind[] = ['dynamic', 'cmd'];
  const p3 = h('div', {}, [
    h('div.stat-row', {}, [
      stat(String(rows.filter((r) => dynKinds.includes(r.kind[api])).length), t(L('dynamiska / per anrop', 'dynamic / per call')), 'glow-green'),
      stat(api === 'vulkan' ? 'VkPipelineCache' : api === 'd3d12' ? 'PipelineLibrary' : 'ProgramBinary', t(L('cache', 'cache')), 'glow-amber'),
    ]),
    h('table.ps-table.ps-spelled', {}, [h('tbody', {}, spellRows((r) => dynKinds.includes(r.kind[api]) || r.what === rows[rows.length - 1].what))]),
    h('p.ps-note', {
      html: t(api === 'opengl'
        ? L('I OpenGL är allt "dynamiskt" – därför kan drivrutinen behöva kompilera om. <code>glGetProgramBinary</code> kan spara den länkade maskinkoden till nästa start.', 'In OpenGL everything is "dynamic" – which is why the driver may have to recompile. <code>glGetProgramBinary</code> can save the linked machine code for the next launch.')
        : api === 'vulkan'
          ? L('Viewport och scissor är <code>VK_DYNAMIC_STATE_*</code> och sätts med <code>vkCmdSet*</code> varje frame. Pipelinen skapas vid laddning med en <code>VkPipelineCache</code> som sparas till disk.', 'Viewport and scissor are <code>VK_DYNAMIC_STATE_*</code>, set with <code>vkCmdSet*</code> every frame. The pipeline is created at load time with a <code>VkPipelineCache</code> saved to disk.')
          : L('Viewport, scissor och exakt topologi sätts på command listen. <code>ID3D12PipelineLibrary</code> eller <code>GetCachedBlob</code> sparar PSO:n till nästa start.', 'Viewport, scissor and the exact topology are set on the command list. <code>ID3D12PipelineLibrary</code> or <code>GetCachedBlob</code> keeps the PSO for the next launch.')),
    }),
  ]);

  const objTitle = api === 'opengl' ? t(L('OpenGL – samma state, utspritt', 'OpenGL – the same state, spread out')) : api === 'vulkan' ? 'VkGraphicsPipelineCreateInfo' : 'D3D12_GRAPHICS_PIPELINE_STATE_DESC';
  const titles = [t(L('Den här appens pipeline state', 'This app’s pipeline state')), t(L('OpenGL – en brytare i taget', 'OpenGL – one switch at a time')), objTitle, t(L('Dynamisk state & cache', 'Dynamic state & cache'))];

  scene = stateScene(host, ctx, false, {
    demo: (i, bad) => {
      p0Rows.forEach((r, k) => {
        r.classList.toggle('hot', i >= 0 && k === DEMOS[i].row);
        r.classList.toggle('bad', i >= 0 && bad && k === DEMOS[i].row);
      });
    },
    glCall: (k) => callEls.forEach((el, i) => {
      el.classList.toggle('done', i <= k);
      el.classList.toggle('cur', i === k);
    }),
    callout: (step, k, bad) => {
      if (step === 0) return k < 0 ? t(L('alla värden rätt', 'all values correct')) : DEMOS[k].spell[api][bad ? 0 : 1];
      if (step === 1) {
        if (k < 0) return t(L('kvar från förra draw: LINE · BLEND · inget djup · ingen culling', 'left from the last draw: LINE · BLEND · no depth · no culling'));
        if (k < GL_SEQ.length) return GL_SEQ[k].call;
        return t(L(`glDrawElements → validera all state… ⚠ ny shadervariant`, `glDrawElements → validate all state… ⚠ new shader variant`));
      }
      if (step === 2) {
        const bind = api === 'd3d12' ? 'SetPipelineState' : 'vkCmdBindPipeline';
        if (k === 0) return bad ? t(L('fyller i create-info…', 'filling in the create info…')) : api === 'd3d12' ? 'CreateGraphicsPipelineState → PSO' : api === 'vulkan' ? 'vkCreateGraphicsPipelines → VkPipeline' : t(L('skapas en gång → ett objekt', 'created once → one object'));
        return k === 1 ? `${bind}(wirePipeline)` : `${bind}(pipeline)`;
      }
      return api === 'opengl' ? 'glViewport · glScissor → global' : api === 'vulkan' ? 'vkCmdSetViewport · vkCmdSetScissor' : 'RSSetViewports · RSSetScissorRects';
    },
  });
  const ms = scene.ms;
  const panels = [p0, p1, p2, p3].map((c, i) => ms.panel(titles[i], [c], { className: 'ps-panel' }));

  return {
    show(step, animate) {
      panels.forEach((p, i) => (p.style.display = i === step ? '' : 'none'));
      if (animate) gsap.fromTo(panels[step], { opacity: 0, x: 14 }, { opacity: 1, x: 0, duration: dur(0.4) });
      scene!.show(step, animate);
    },
    destroy() {
      gsap.killTweensOf(panels);
      scene!.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: switches flipped one by one vs one sealed object            */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const captions = [
    L('Samma frågor måste besvaras för varje draw: culling, varvordning, fyllt eller linjer, djup, blending… Modellen visar vad varje inställning gör.', 'The same questions must be answered for every draw: culling, winding, filled or lines, depth, blending… The model shows what each setting does.'),
    L('OpenGL: brytare som slås om en i taget, och de gäller tills någon ändrar dem. Först vid draw-anropet ser drivrutinen helheten – och kan behöva kompilera om (spiken i frame-tiden).', 'OpenGL: switches flipped one at a time, and they stay until someone changes them. Only at the draw call does the driver see the whole – and it may have to recompile (the spike in frame time).'),
    L('Vulkan/D3D12: allt förseglas i ett oföränderligt objekt i förväg. Att byta pipeline byter <b>all</b> state på en gång.', 'Vulkan/D3D12: everything is sealed into one immutable object up front. Switching pipelines swaps <b>all</b> the state at once.'),
    L('Lite state får vara dynamisk (viewport, scissor – de gröna). Färdiga pipelines sparas i en cache så nästa start går snabbt.', 'A little state may stay dynamic (viewport, scissor – the green ones). Finished pipelines are saved in a cache so the next launch is fast.'),
  ];
  const caption = h('p.ps-caption');
  const bars = Array.from({ length: 18 }, (_, i) => h('span.ps-bar', { style: { height: `${24 + ((i * 37) % 19)}%` } }));
  const spike = h('span.ps-bar.spike', { style: { height: '24%' } });
  const framePanelBody = h('div.ps-frames', {}, [...bars, spike]);
  const swNames = [L('polygonläge: fyllt', 'polygon mode: fill'), L('blending: av', 'blending: off'), L('djuptest: på', 'depth test: on'), L('culling: på', 'culling: on')];
  const switches = GL_SEQ.map((_, i) => h('div.ps-call', {}, [h('span.ps-sw', {}, [h('span.ps-knob')]), h('code', { text: t(swNames[i]) })]));

  const scene = stateScene(host, ctx, true, {
    glCall: (k) => {
      switches.forEach((el, i) => el.classList.toggle('done', i <= k));
      if (k === GL_SEQ.length) gsap.fromTo(spike, { height: '24%' }, { height: '95%', duration: dur(0.2), yoyo: true, repeat: 1, repeatDelay: 0.9 });
      else if (k < 0) gsap.set(spike, { height: '24%' });
    },
    callout: (step, k, bad) => {
      if (step === 0) return k < 0 ? t(L('rätt state', 'correct state')) : t(DEMOS[k].plain[bad ? 0 : 1]);
      if (step === 1) {
        if (k < 0) return t(L('kvar från förra draw-anropet', 'left over from the previous draw'));
        if (k < GL_SEQ.length) return t([L('fyllt', 'filled'), L('ingen blending', 'no blending'), L('djuptest på', 'depth test on'), L('culling på', 'culling on')][k]);
        return t(L('draw → validera… ⚠ kompilera om', 'draw → validate… ⚠ recompile'));
      }
      if (step === 2) {
        if (k === 0) return bad ? t(L('allt samlas…', 'gathering everything…')) : t(L('ett förseglat objekt', 'one sealed object'));
        return k === 1 ? t(L('byt pipeline → wireframe', 'switch pipeline → wireframe')) : t(L('byt pipeline → vanlig', 'switch pipeline → normal'));
      }
      return t(L('viewport & scissor sätts per frame', 'viewport & scissor set per frame'));
    },
  });
  const ms = scene.ms;
  ms.panel(t(L('Vad händer', 'What happens')), [caption], { side: 'bottom' });
  const sidePanel = ms.panel(t(L('Brytare · frame-tid', 'Switches · frame time')), [h('div.ps-calls.plain', {}, switches), framePanelBody], { className: 'ps-panel' });

  return {
    show(step, animate) {
      caption.innerHTML = t(captions[step]);
      sidePanel.style.display = step === 1 ? '' : 'none';
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: dur(0.35) });
      scene.show(step, animate);
    },
    destroy() {
      gsap.killTweensOf([caption, spike]);
      scene.destroy();
    },
  };
}


/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const lay = ctx.derived.layout;
  const idx = ctx.state.mesh.indices.length;
  const idxType = lay.indexType === 'uint16' ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT';
  const sems = lay.attributes.map((a) => a.semantic).join(', ');
  return {
    opengl: {
      note: L(
        'OpenGL har ingen pipeline-objekt: state är globala inställningar i kontexten som ändras en i taget. Drivrutinen validerar kombinationen först när du ritar.',
        'OpenGL has no pipeline object: state is global settings in the context, changed one at a time. The driver validates the combination only when you draw.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `glUseProgram(prog);                    // shaders (+ uniform blocks)
glBindVertexArray(vao);                // vertex input format + buffers
glEnable(GL_DEPTH_TEST);
glDepthFunc(GL_LESS);
glDepthMask(GL_TRUE);
glEnable(GL_CULL_FACE);
glCullFace(GL_BACK);
glFrontFace(GL_CCW);
glDisable(GL_BLEND);
glEnable(GL_FRAMEBUFFER_SRGB);         // RGBA8 sRGB render target
glViewport(0, 0, ${VIEWPORT.w}, ${VIEWPORT.h});
// Nothing has been checked yet. Here the driver validates the
// whole combination – and may compile a new shader variant:
glDrawElements(GL_TRIANGLES, ${idx}, ${idxType}, nullptr);`,
          highlight: [[1, 2, 3, 6, 9], [3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14], [12, 13, 14], [11]],
        },
      ],
      terms: [
        { term: ctx.t(L('state-maskin', 'state machine')), desc: L('Globala inställningar som gäller tills någon ändrar dem.', 'Global settings that stay in effect until someone changes them.') },
        { term: 'glEnable / glDisable', desc: L('Slår på/av en fast funktion, t.ex. GL_DEPTH_TEST.', 'Turns a fixed function on/off, e.g. GL_DEPTH_TEST.') },
        { term: ctx.t(L('shadervariant', 'shader variant')), desc: L('Drivrutinen bakar ibland in state i maskinkoden och måste kompilera om när den ändras.', 'Drivers sometimes bake state into the machine code and must recompile when it changes.') },
      ],
      you: L('ställer in varje state separat', 'set every state separately'),
      driver: L('validerar vid draw, kompilerar varianter', 'validates at draw, compiles variants'),
    },
    vulkan: {
      note: L(
        'I Vulkan beskrivs nästan all state i en VkGraphicsPipelineCreateInfo och bakas in i en oföränderlig VkPipeline. Med dynamic rendering anges bara attachment-formaten (VkPipelineRenderingCreateInfo), ingen render pass.',
        'In Vulkan almost all state is described in one VkGraphicsPipelineCreateInfo and baked into an immutable VkPipeline. With dynamic rendering you only give the attachment formats (VkPipelineRenderingCreateInfo), no render pass.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkPipelineRasterizationStateCreateInfo rs{ VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO };
rs.polygonMode = VK_POLYGON_MODE_FILL;   rs.lineWidth = 1.0f;
rs.cullMode    = VK_CULL_MODE_BACK_BIT;
rs.frontFace   = VK_FRONT_FACE_COUNTER_CLOCKWISE;
VkPipelineDepthStencilStateCreateInfo ds{ VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO };
ds.depthTestEnable  = VK_TRUE;  ds.depthWriteEnable = VK_TRUE;
ds.depthCompareOp   = VK_COMPARE_OP_LESS;
VkPipelineColorBlendAttachmentState att{ .blendEnable = VK_FALSE, .colorWriteMask = 0xF };
VkDynamicState dyn[] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
VkFormat colorFmt = VK_FORMAT_R8G8B8A8_SRGB;
VkPipelineRenderingCreateInfo rendering{ VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO };
rendering.colorAttachmentCount    = 1;
rendering.pColorAttachmentFormats = &colorFmt;
rendering.depthAttachmentFormat   = VK_FORMAT_D32_SFLOAT;
VkGraphicsPipelineCreateInfo pci{ VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO };
pci.pNext = &rendering;          pci.stageCount = 2;  pci.pStages = stages;
pci.pVertexInputState = &vi;     pci.pInputAssemblyState = &ia;  // TRIANGLE_LIST
pci.pViewportState = &vp;        pci.pRasterizationState = &rs;
pci.pMultisampleState = &ms;     pci.pDepthStencilState = &ds;   // 1 sample
pci.pColorBlendState = &cb;      pci.pDynamicState = &dynInfo;   // dyn[]
pci.layout = pipelineLayout;     // descriptor set layouts (next slide)
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pci, nullptr, &pipeline);`,
          highlight: [[15, 16, 17, 18, 19, 20, 21], [1, 2, 3, 4, 5, 6, 7, 8], [10, 11, 12, 13, 14, 22], [9, 20, 22]],
        },
      ],
      terms: [
        { term: 'VkPipeline', desc: L('Oföränderligt objekt med shaders + all fast-funktions-state.', 'Immutable object with shaders + all fixed-function state.') },
        { term: 'VkDynamicState', desc: L('State som undantas från bakningen och sätts med vkCmdSet*.', 'State left out of the bake and set with vkCmdSet*.') },
        { term: 'VkPipelineRenderingCreateInfo', desc: L('Dynamic rendering (1.3): attachment-format istället för VkRenderPass.', 'Dynamic rendering (1.3): attachment formats instead of a VkRenderPass.') },
        { term: 'VkPipelineCache', desc: L('Återanvänder kompilerad maskinkod, kan sparas till disk.', 'Reuses compiled machine code, can be saved to disk.') },
      ],
      you: L('beskriver all state i förväg', 'describe all state up front'),
      driver: L('kompilerar en gång, binder billigt', 'compiles once, binds cheaply'),
    },
    d3d12: {
      note: L(
        'I D3D12 fylls en D3D12_GRAPHICS_PIPELINE_STATE_DESC och CreateGraphicsPipelineState skapar ett PSO. Viewport, scissor och exakt topologi sätts på command listen.',
        'In D3D12 you fill a D3D12_GRAPHICS_PIPELINE_STATE_DESC and CreateGraphicsPipelineState creates a PSO. Viewport, scissor and the exact topology are set on the command list.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `D3D12_GRAPHICS_PIPELINE_STATE_DESC d = {};
d.pRootSignature = rootSig.Get();                  // b0: Transforms
d.VS = { vs.data(), vs.size() };                   // DXIL bytecode
d.PS = { ps.data(), ps.size() };
d.InputLayout = { elements, ${lay.attributes.length} };                    // ${sems}
d.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
d.RasterizerState = CD3DX12_RASTERIZER_DESC(D3D12_DEFAULT);  // SOLID
d.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
d.RasterizerState.FrontCounterClockwise = TRUE;    // CCW = front
d.DepthStencilState.DepthEnable    = TRUE;
d.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
d.DepthStencilState.DepthFunc      = D3D12_COMPARISON_FUNC_LESS;
d.BlendState = CD3DX12_BLEND_DESC(D3D12_DEFAULT);  // BlendEnable = FALSE
d.SampleMask = UINT_MAX;
d.NumRenderTargets = 1;
d.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
d.DSVFormat     = DXGI_FORMAT_D32_FLOAT;
d.SampleDesc    = { 1, 0 };
device->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&pso));
// not in the PSO: RSSetViewports, RSSetScissorRects, IASetPrimitiveTopology`,
          highlight: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13], [14, 15, 16, 17, 18, 19], [19, 20]],
        },
      ],
      terms: [
        { term: 'PSO', desc: L('Pipeline State Object – shaders + all fast-funktions-state i ett.', 'Pipeline State Object – shaders + all fixed-function state in one.') },
        { term: 'PrimitiveTopologyType', desc: L('Bara typen (triangel) bakas; listan/stripen väljs med IASetPrimitiveTopology.', 'Only the type (triangle) is baked; list vs strip is chosen with IASetPrimitiveTopology.') },
        { term: 'ID3D12PipelineLibrary', desc: L('Cache för PSO:er mellan körningar.', 'Cache for PSOs between runs.') },
      ],
      you: L('fyller desc:en i förväg', 'fill in the desc up front'),
      driver: L('kompilerar en gång, binder billigt', 'compiles once, binds cheaply'),
    },
  };
}

export default standardSlide({
  id: 'pipeline-state',
  group: 'api',
  short: L('Pipeline state', 'Pipeline state'),
  title: L('Pipeline state – hur ska det ritas?', 'Pipeline state – how should it be drawn?'),
  lead: L(
    'Shaders räcker inte. GPU:n måste också veta hur vertices ska läsas, vilka trianglar som ska bort, hur djup och färg skrivs och till vilka format.',
    'Shaders are not enough. The GPU also needs to know how to read vertices, which triangles to drop, how depth and color are written and in which formats.',
  ),
  bullets: [
    L('Den här appen: triangellista, <b>cull back</b>, framsida <b>moturs</b>, djuptest <code>LESS</code> + skrivning, <b>ingen blending</b>, RGBA8 sRGB-färg + D32-djup.', 'This app: triangle list, <b>cull back</b>, front face <b>counter-clockwise</b>, depth test <code>LESS</code> + write, <b>no blending</b>, RGBA8 sRGB color + D32 depth.'),
    L('<b>OpenGL</b> är en global state-maskin: <code>glEnable</code>, <code>glDepthFunc</code>, <code>glCullFace</code>… Drivrutinen ser kombinationen först vid draw och kan behöva kompilera om – <i>hitches</i>.', '<b>OpenGL</b> is a global state machine: <code>glEnable</code>, <code>glDepthFunc</code>, <code>glCullFace</code>… The driver sees the combination only at draw time and may have to recompile – <i>hitches</i>.'),
    L('<b>Vulkan</b> och <b>D3D12</b> bakar allt i ett oföränderligt objekt – <code>VkPipeline</code> / <code>ID3D12PipelineState</code> – som skapas i förväg.', '<b>Vulkan</b> and <b>D3D12</b> bake everything into one immutable object – <code>VkPipeline</code> / <code>ID3D12PipelineState</code> – created up front.'),
    L('Lite state är <b>dynamisk</b> (viewport, scissor). Pipelines cachas (<code>VkPipelineCache</code>, <code>ID3D12PipelineLibrary</code>) så de inte kompileras om vid nästa start.', 'Some state is <b>dynamic</b> (viewport, scissor). Pipelines are cached (<code>VkPipelineCache</code>, <code>ID3D12PipelineLibrary</code>) so they are not recompiled on the next launch.'),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
