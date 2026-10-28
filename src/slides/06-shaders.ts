import gsap from 'gsap';
import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import glsl from 'highlight.js/lib/languages/glsl';
import llvm from 'highlight.js/lib/languages/llvm';
import { ArrowHelper, Group, Matrix3, Vector3, type Sprite, type Texture } from 'three';
import { dur, escapeHtml, h, reducedMotion } from '../core/dom';
import { L } from '../core/i18n';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import type { ApiId } from '../core/state';
import { AMBIENT, BASE_COLOR, LIGHT_DIR, SHININESS, VIEW_DIR, normalize, shade } from '../pipeline/shade';
import { modelMatrix, type V3 } from '../pipeline/transform';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { textSprite } from '../views/ThreeStage';
import { COLORS } from '../views/three-helpers';
import { stat } from '../views/widgets';
import '../styles/slides/shaders.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

if (!hljs.getLanguage('glsl')) hljs.registerLanguage('glsl', glsl);
if (!hljs.getLanguage('cpp')) hljs.registerLanguage('cpp', cpp);
if (!hljs.getLanguage('llvm')) hljs.registerLanguage('llvm', llvm);

/* ------------------------------------------------------------------ */
/* The app's real shader, written out per API                          */
/* ------------------------------------------------------------------ */
const f4 = (x: number) => x.toFixed(4);
const vec = (v: V3, ty = 'vec3') => `${ty}(${v.map(f4).join(', ')})`;
/** IEEE-754 bit pattern of a float32, as the hex literal a GPU back end would embed. */
function f32hex(x: number): string {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x);
  return '0x' + dv.getUint32(0).toString(16).padStart(8, '0');
}
/** The half vector is a compile-time constant: the front end folds it. */
const HALF: V3 = normalize([LIGHT_DIR[0] + VIEW_DIR[0], LIGHT_DIR[1] + VIEW_DIR[1], LIGHT_DIR[2] + VIEW_DIR[2]]);

interface ShaderPair {
  lang: 'glsl' | 'hlsl';
  vsName: string;
  fsName: string;
  vs: string;
  fs: string;
}

function shaderPair(api: ApiId): ShaderPair {
  const ambient = AMBIENT.toFixed(2);
  const shin = SHININESS.toFixed(1);
  if (api === 'd3d12') {
    return {
      lang: 'hlsl',
      vsName: 'shade_vs.hlsl',
      fsName: 'shade_ps.hlsl',
      vs: `cbuffer Transforms : register(b0) {
    float4x4 model;
    float4x4 view;
    float4x4 proj;
    float4x4 mvp;      // proj * view * model
};
struct VSIn  { float3 pos : POSITION;    float3 nrm : NORMAL; };
struct VSOut { float4 pos : SV_Position; float3 nrm : NORMAL; };

VSOut main(VSIn v) {
    VSOut o;
    o.pos = mul(mvp, float4(v.pos, 1.0));
    o.nrm = normalize(mul((float3x3)model, v.nrm));
    return o;
}`,
      fs: `static const float3 LIGHT_DIR = ${vec(LIGHT_DIR, 'float3')};
static const float3 BASE      = ${vec(BASE_COLOR, 'float3')};

float4 main(float4 pos : SV_Position,
            float3 nrm : NORMAL) : SV_Target {
    float3 n    = normalize(nrm);
    float  diff = max(dot(n, LIGHT_DIR), 0.0);
    float3 h    = normalize(LIGHT_DIR + float3(0, 0, 1));
    float  spec = diff > 0.0
                ? pow(max(dot(n, h), 0.0), ${shin}) : 0.0;
    float3 c    = BASE * (${ambient} + diff) + spec * 0.8;
    return float4(min(c, 1.0), 1.0);
}`,
    };
  }
  const vk = api === 'vulkan';
  const block = vk ? 'layout(set = 0, binding = 0) uniform Transforms {' : 'layout(std140, binding = 0) uniform Transforms {';
  return {
    lang: 'glsl',
    vsName: 'shade.vert',
    fsName: 'shade.frag',
    vs: `#version 460${vk ? '' : ' core'}
layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
${block}
    mat4 model;
    mat4 view;
    mat4 proj;
    mat4 mvp;          // proj * view * model
};
layout(location = 0) out vec3 vNormal;

void main() {
    vNormal     = normalize(mat3(model) * inNormal);
    gl_Position = mvp * vec4(inPosition, 1.0);
}`,
    fs: `#version 460${vk ? '' : ' core'}
layout(location = 0) in  vec3 vNormal;
layout(location = 0) out vec4 outColor;
const vec3 LIGHT_DIR = ${vec(LIGHT_DIR)};
const vec3 BASE      = ${vec(BASE_COLOR)};

void main() {
    vec3  n    = normalize(vNormal);
    float diff = max(dot(n, LIGHT_DIR), 0.0);
    vec3  h    = normalize(LIGHT_DIR + vec3(0.0, 0.0, 1.0));
    float spec = diff > 0.0
               ? pow(max(dot(n, h), 0.0), ${shin}) : 0.0;
    vec3  c    = BASE * (${ambient} + diff) + spec * 0.8;
    outColor   = vec4(min(c, vec3(1.0)), 1.0);
}`,
  };
}

/** spirv-dis style name of a float constant, e.g. %float_0_4472. */
const cname = (x: number) => `%float_${f4(x).replace('.', '_')}`;

/** Abridged SPIR-V disassembly of shade.frag (what spirv-dis prints, shortened). */
function spirvExcerpt(api: ApiId): string {
  const gl = api === 'opengl';
  return `; SPIR-V
; Version: ${gl ? '1.0' : '1.6'}
; Generator: ${gl ? 'Khronos Glslang Reference Front End' : 'Google Shaderc over Glslang'}; 11
               OpCapability Shader
          %1 = OpExtInstImport "GLSL.std.450"
               OpMemoryModel Logical GLSL450
               OpEntryPoint Fragment %main "main" %vNormal %outColor
               OpExecutionMode %main OriginUpperLeft
               OpDecorate %vNormal Location 0
               OpDecorate %outColor Location 0
     %v3float = OpTypeVector %float 3
    %float_48 = OpConstant %float ${SHININESS}
         %17 = OpConstantComposite %v3float ${LIGHT_DIR.map(cname).join(' ')} ; LIGHT_DIR
         %21 = OpConstantComposite %v3float ${HALF.map(cname).join(' ')} ; h (folded)
       %main = OpFunction %void None %3
          %5 = OpLabel
         %12 = OpLoad %v3float %vNormal
         %13 = OpExtInst %v3float %1 Normalize %12
         %16 = OpDot %float %13 %17
         %18 = OpExtInst %float %1 FMax %16 %float_0
         %22 = OpDot %float %13 %21
         %23 = OpExtInst %float %1 FMax %22 %float_0
         %24 = OpExtInst %float %1 Pow %23 %float_48
         %26 = OpFOrdGreaterThan %bool %18 %float_0
         %27 = OpSelect %float %26 %24 %float_0
               ; … BASE * (${AMBIENT} + diff) + spec * 0.8, FMin …
               OpStore %outColor %41
               OpReturn
               OpFunctionEnd`;
}

/** Abridged DXIL disassembly of shade_ps.hlsl (dxc -T ps_6_6 output, shortened). */
function dxilExcerpt(): string {
  return `; Input signature:
; Name         Index   Mask Register SysValue  Format   Used
; SV_Position      0   xyzw        0      POS   float
; NORMAL           0   xyz         1     NONE   float   xyz
; Output signature:
; SV_Target        0   xyzw        0   TARGET   float   xyzw
define void @main() {
  %1 = call float @dx.op.loadInput.f32(i32 4, i32 1, i32 0, i8 0, i32 undef)
  %2 = call float @dx.op.loadInput.f32(i32 4, i32 1, i32 0, i8 1, i32 undef)
  %3 = call float @dx.op.loadInput.f32(i32 4, i32 1, i32 0, i8 2, i32 undef)
  %4 = call float @dx.op.dot3.f32(i32 55, float %1, float %2, float %3, float %1, float %2, float %3)
  %5 = call float @dx.op.unary.f32(i32 25, float %4)  ; Rsqrt
  %6 = fmul fast float %5, %1
  ; … dot(n, LIGHT_DIR), FMax …
  %15 = call float @dx.op.unary.f32(i32 23, float %14)  ; Log (log2)
  %16 = fmul fast float %15, ${SHININESS.toExponential(6).replace('e+', 'e+0')}
  %17 = call float @dx.op.unary.f32(i32 21, float %16)  ; Exp (exp2)
  %18 = fcmp fast ogt float %11, 0.000000e+00
  %19 = select i1 %18, float %17, float 0.000000e+00
  ; … BASE * (${AMBIENT} + diff) + spec * 0.8, FMin …
  call void @dx.op.storeOutput.f32(i32 5, i32 0, i32 0, i8 0, float %30)
  ret void
}`;
}

/** Illustrative RDNA-style ISA. Real code differs per GPU and driver version. */
function isaExcerpt(): string {
  const [lx, ly, lz] = LIGHT_DIR.map(f32hex);
  const [hx, hy, hz] = HALF.map(f32hex);
  const rows: [string, string?][] = [
    ['v_mul_f32     v3, v0, v0', '|n|² = n·n'],
    ['v_fmac_f32    v3, v1, v1'],
    ['v_fmac_f32    v3, v2, v2'],
    ['v_rsq_f32     v3, v3', '1/|n|'],
    ['v_mul_f32     v0, v0, v3', 'n = normalize(n)'],
    ['v_mul_f32     v1, v1, v3'],
    ['v_mul_f32     v2, v2, v3'],
    [`v_mul_f32     v4, ${lx}, v0`, 'dot(n, LIGHT_DIR):'],
    [`v_fmac_f32    v4, ${ly}, v1`, '  LIGHT_DIR baked in'],
    [`v_fmac_f32    v4, ${lz}, v2`, '  as float literals'],
    ['v_max_f32     v4, 0, v4', 'diff'],
    [`v_mul_f32     v5, ${hx}, v0`, 'dot(n, h)'],
    [`v_fmac_f32    v5, ${hy}, v1`],
    [`v_fmac_f32    v5, ${hz}, v2`],
    ['v_max_f32     v5, 0, v5'],
    ['v_log_f32     v5, v5', `pow(x, ${SHININESS}) =`],
    [`v_mul_f32     v5, ${f32hex(SHININESS)}, v5`, `  exp2(${SHININESS} · log2 x)`],
    ['v_exp_f32     v5, v5'],
    ['v_cmp_lt_f32  vcc_lo, 0, v4', 'diff > 0 ?'],
    ['v_cndmask_b32 v5, 0, v5, vcc_lo', '  spec : 0'],
    ['', `… BASE·(${AMBIENT} + diff) + spec·0.8, v_min_f32 …`],
    ['exp           mrt0, v6, v7, v8, v9 done', 'write SV_Target / outColor'],
    ['s_endpgm'],
  ];
  return rows.map(([c, cm]) => (cm ? `${c.padEnd(34)}; ${cm}` : c)).join('\n');
}

/* ------------------------------------------------------------------ */
/* Small rendering helpers                                             */
/* ------------------------------------------------------------------ */
function codeEl(src: string, lang: 'glsl' | 'hlsl' | 'llvm'): HTMLElement {
  const language = lang === 'hlsl' ? 'cpp' : lang;
  return h(
    'pre.sh-code.hljs',
    {},
    src.split('\n').map((l) => h('div.sh-line', { html: hljs.highlight(l || ' ', { language, ignoreIllegals: true }).value })),
  );
}

/** Tiny highlighter for SPIR-V / ISA disassembly. */
function asmEl(src: string): HTMLElement {
  const lines = src.split('\n').map((line) => {
    const ci = line.indexOf(';');
    const code = ci >= 0 ? line.slice(0, ci) : line;
    const comment = ci >= 0 ? line.slice(ci) : '';
    const html = escapeHtml(code)
      .replace(/(%[\w]+)/g, '<span class="a-id">$1</span>')
      .replace(/\b(Op[A-Z]\w*)\b/g, '<span class="a-op">$1</span>')
      .replace(/^(\s*)([vs]_[a-z0-9_]+|exp)\b/, '$1<span class="a-op">$2</span>')
      .replace(/\b(0x[0-9a-f]+)\b/g, '<span class="a-lit">$1</span>')
      .replace(/\b(v\d+|vcc_lo|mrt0)\b/g, '<span class="a-reg">$1</span>')
      .replace(/(&quot;[^&]*&quot;)/g, '<span class="a-str">$1</span>');
    return h('div.sh-line', { html: html + (comment ? `<span class="a-cmt">${escapeHtml(comment)}</span>` : '') });
  });
  return h('pre.sh-code.sh-asm', {}, lines);
}

/** A stable, made-up "machine word" for a mnemonic (concept view only). */
function hexOf(str: string): string {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619);
  const w = (x >>> 0).toString(16).padStart(8, '0');
  return `${w.slice(0, 4)} ${w.slice(4)}`;
}

/** Allow long camelCase API names to wrap between words. */
const breakable = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1\u200b$2');

const lineCount = (s: string) => s.split('\n').length;
const byteCount = (s: string) => new TextEncoder().encode(s).length;

interface ChainNode {
  title: string;
  sub: string;
  build: boolean;
}

function chain(api: ApiId, t: SlideContext['t']): ChainNode[] {
  if (api === 'opengl') {
    return [
      { title: 'GLSL 4.60', sub: t(L('text i din app', 'text in your app')), build: false },
      { title: 'glCompileShader', sub: t(L('drivrutinens front end', "driver's front end")), build: false },
      { title: t(L('intern IR', 'internal IR')), sub: t(L('dold · ev. SPIR-V', 'hidden · or SPIR-V')), build: false },
      { title: 'glLinkProgram', sub: t(L('drivrutinens back end', "driver's back end")), build: false },
      { title: 'GPU ISA', sub: t(L('maskinkod', 'machine code')), build: false },
    ];
  }
  if (api === 'vulkan') {
    return [
      { title: 'GLSL 4.60', sub: 'shade.vert / .frag', build: true },
      { title: 'glslc', sub: 'glslang · dxc -spirv', build: true },
      { title: 'SPIR-V 1.6', sub: '.spv → vkCreateShaderModule', build: true },
      { title: 'vkCreateGraphicsPipelines', sub: t(L('drivrutinens back end', "driver's back end")), build: false },
      { title: 'GPU ISA', sub: t(L('maskinkod', 'machine code')), build: false },
    ];
  }
  return [
    { title: 'HLSL SM 6.6', sub: 'shade_vs / shade_ps.hlsl', build: true },
    { title: 'dxc', sub: '-T vs_6_6 / ps_6_6', build: true },
    { title: 'DXIL', sub: '.cso → D3D12_SHADER_BYTECODE', build: true },
    { title: 'CreateGraphicsPipelineState', sub: t(L('drivrutinens back end', "driver's back end")), build: false },
    { title: 'GPU ISA', sub: t(L('maskinkod', 'machine code')), build: false },
  ];
}

/** Which chain nodes are lit at each step. */
const LIT_UPTO = [0, 1, 2, 4];

function chainStrip(api: ApiId, t: SlideContext['t']): { el: HTMLElement; set: (step: number, animate: boolean) => void } {
  const nodes = chain(api, t);
  const nodeEls = nodes.map((n, i) =>
    h('div.sh-node', { dataset: { i: String(i) } }, [h('div.sh-node-t', { text: breakable(n.title) }), h('div.sh-node-s', { text: n.sub })]),
  );
  const row = h('div.sh-chain-row');
  nodeEls.forEach((n, i) => {
    row.append(n);
    if (i < nodeEls.length - 1) row.append(h('div.sh-arrow', {}, [h('span')]));
  });
  const buildCount = nodes.filter((n) => n.build).length;
  const brackets = h('div.sh-brackets', {}, [
    buildCount ? h('div.sh-bracket.build', { style: { flex: String(buildCount) }, text: t(L('byggtid – offline, en gång', 'build time – offline, once')) }) : null,
    h('div.sh-bracket.run', {
      style: { flex: String(nodes.length - buildCount) },
      text: buildCount ? t(L('körtid – i drivrutinen', 'run time – in the driver')) : t(L('allt sker vid körtid, inne i drivrutinen', 'everything happens at run time, inside the driver')),
    }),
  ]);
  const el = h('div.sh-chain', {}, [row, brackets]);
  const arrows = Array.from(row.querySelectorAll<HTMLElement>('.sh-arrow'));
  return {
    el,
    set(step, animate) {
      const upto = LIT_UPTO[step] ?? 4;
      const from = step === 0 ? 0 : LIT_UPTO[step - 1] + 1;
      nodeEls.forEach((n, i) => {
        const lit = i <= upto;
        const cur = i >= from && i <= upto;
        const was = n.classList.contains('lit');
        n.classList.toggle('lit', lit);
        n.classList.toggle('cur', cur);
        if (animate && lit && !was) gsap.fromTo(n, { scale: 0.85, opacity: 0.4 }, { scale: 1, opacity: 1, duration: dur(0.45), delay: (i - from) * 0.12, ease: 'back.out(2)' });
      });
      arrows.forEach((a, i) => a.classList.toggle('lit', i < upto));
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3D helpers: code fragments that fly into the model                   */
/* ------------------------------------------------------------------ */
const CSS = { cyan: '#38e1ff', magenta: '#ff3fd2', amber: '#ffb547', violet: '#9b7bff', green: '#5cf08f' };
const API_CSS: Record<ApiId, string> = { opengl: '#5aa9e6', vulkan: '#ff4d64', d3d12: '#6cd04a' };

type Where = () => Vector3;

/** A stream of glowing code sprites that fly from `from` into `to` (by default: points on the model). */
function codeStream(ms: ModelStage) {
  const live = new Set<Sprite>();
  let call: gsap.core.Tween | null = null;
  const targets = ms.samplePositions(64);
  /** A random vertex of the model, in world space. */
  const onModel: Where = () => {
    ms.pivot.updateMatrixWorld(true);
    return new Vector3().fromArray(targets, Math.floor(Math.random() * 64) * 3).applyMatrix4(ms.pivot.matrixWorld);
  };
  const spawn = (text: string, color: string, from: Where, to: Where) => {
    const sp = textSprite(text, color, 0.1);
    sp.material.opacity = 0;
    const v = to();
    sp.position.copy(from());
    ms.scene.add(sp);
    live.add(sp);
    const sx = sp.scale.x;
    const sy = sp.scale.y;
    const done = () => {
      live.delete(sp);
      sp.removeFromParent();
      sp.material.map?.dispose();
      sp.material.dispose();
    };
    ms.tween(sp.material, { opacity: 1, duration: dur(0.25) });
    ms.tween(sp.position, { x: v.x, y: v.y, z: v.z, duration: dur(1.3), ease: 'power2.in' });
    ms.tween(sp.scale, { x: sx * 0.25, y: sy * 0.25, duration: dur(1.3), ease: 'power2.in' });
    ms.tween(sp.material, { opacity: 0, duration: dur(0.25), delay: dur(1.1), onComplete: done });
  };
  return {
    onModel,
    start(items: string[], color: string, every: number, from: Where, to: Where = onModel) {
      this.stop();
      if (reducedMotion() || !items.length) return;
      let i = 0;
      const tick = () => {
        spawn(items[i++ % items.length], color, from, to);
        call = gsap.delayedCall(every, tick);
      };
      tick();
    },
    stop() {
      call?.kill();
      call = null;
    },
    clear() {
      this.stop();
      live.forEach((sp) => {
        gsap.killTweensOf([sp.position, sp.scale, sp.material]);
        sp.removeFromParent();
        sp.material.map?.dispose();
        sp.material.dispose();
      });
      live.clear();
    },
  };
}

/** The orbiting sun passes close to the camera and then fills the view; keep its on-screen size steady. */
function steadySun(ms: ModelStage): void {
  const sun = ms.scene.children.find((o): o is Sprite => (o as Sprite).isSprite && (o as Sprite).material.color.getHex() === 0xfff1c4);
  ms.onFrame(() => sun?.scale.setScalar(Math.min(0.45, 0.1 * sun.position.distanceTo(ms.camera.position))));
}

/** World-space light direction → model space (the arrows live in the model's pivot). */
function toModel(ms: ModelStage, dir: Vector3): Vector3 {
  return dir.clone().applyQuaternion(ms.pivot.quaternion.clone().invert()).normalize();
}

/* ------------------------------------------------------------------ */
/* Real data: the app's shader, switched on term by term on the model   */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const sp = shaderPair(api);
  const strip = chainStrip(api, t);
  const ms = createModelStage(host, ctx, { shift: -0.17, autoRotate: 0, bloom: 0.5, bloomThreshold: 0.85 });
  ms.overlay.classList.add('sh-ms');

  // The followed point: first corner of the showcase triangle.
  const tri = ctx.derived.showcaseTriangle(api);
  const vi = ctx.derived.triangleVertices(tri)[0];
  const p = ctx.derived.position(vi);
  const nObj = ctx.derived.normal(vi);
  const nm = new Matrix3().setFromMatrix4(modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X)).elements;
  const nWorld = new Vector3(
    nm[0] * nObj[0] + nm[3] * nObj[1] + nm[6] * nObj[2],
    nm[1] * nObj[0] + nm[4] * nObj[1] + nm[7] * nObj[2],
    nm[2] * nObj[0] + nm[5] * nObj[1] + nm[8] * nObj[2],
  ).normalize();
  const sh = shade([nWorld.x, nWorld.y, nWorld.z]);
  const rgb = sh.color.map((c) => Math.round(c * 255));

  const nArrow = ms.arrow(p, nObj, 0.5, COLORS.magenta, 'N');
  const lArrow = ms.arrow(p, LIGHT_DIR, 0.55, COLORS.amber, 'L');
  const hArrow = ms.arrow(p, HALF, 0.5, COLORS.cyan, 'H');
  const setArrow = (g: Group, dirWorld: Vector3, len: number) => {
    const d = toModel(ms, dirWorld);
    (g.children[0] as ArrowHelper).setDirection(d);
    g.children[1]?.position.set(p[0] + d.x * len * 1.15, p[1] + d.y * len * 1.15, p[2] + d.z * len * 1.15);
  };
  ms.markVertices([vi], COLORS.cyan);
  const stream = codeStream(ms);

  // ---- Panels: compile chain at the bottom, one panel per step on the right.
  ms.panel(t(L('Kompileringskedjan', 'The compile chain')), [strip.el], { side: 'bottom', className: 'sh-chainpanel' });
  // 1-based lines of the fragment shader that belong to each term.
  const lit = sp.lang === 'hlsl' ? { base: [2, 12], diff: [6, 7, 11], spec: [8, 9, 10] } : { base: [5, 14], diff: [8, 9, 13], spec: [10, 11, 12] };
  const fsCode = codeEl(sp.fs, sp.lang);
  const fsLines = Array.from(fsCode.children) as HTMLElement[];
  const markLines = (ls: number[]) => fsLines.forEach((el, i) => el.classList.toggle('on', ls.includes(i + 1)));
  const live = { nl: h('div.v.glow-amber', { text: '—' }), nh: h('div.v.glow-cyan', { text: '—' }), spec: h('div.v.glow-magenta', { text: '—' }) };
  const liveStat = (el: HTMLElement, k: string) => h('div.stat', {}, [el, h('div.k', { text: k })]);

  const p0 = ms.panel(`${sp.fsName} · ${lineCount(sp.fs)} ${t(L('rader', 'lines'))}`, [
    h('div.stat-row', {}, [stat(`${byteCount(sp.vs)} B`, sp.vsName, 'glow-cyan'), stat(`${byteCount(sp.fs)} B`, sp.fsName, 'glow-magenta')]),
    h('div.v-scroll.sh-scroll', {}, [fsCode]),
    h('p.hint', {
      html: t(L(
        'Vertexshadern placerar modellen (<code>mvp × position</code>). Här skriver fragmentshadern bara <code>BASE</code> – ingen belysning ännu.',
        'The vertex shader places the model (<code>mvp × position</code>). Here the fragment shader only writes <code>BASE</code> – no lighting yet.',
      )),
    }),
  ], { className: 'sh-p' });

  const cmd: Record<ApiId, string[]> = {
    opengl: ['glShaderSource(fs, 1, &src, nullptr);', 'glCompileShader(fs);   // in the driver', 'glGetShaderiv(fs, GL_COMPILE_STATUS, &ok);'],
    vulkan: ['$ glslc --target-env=vulkan1.3 -O shade.frag -o shade.frag.spv', '# or: dxc -spirv -T ps_6_6 shade_ps.hlsl'],
    d3d12: ['$ dxc -T ps_6_6 -E main shade_ps.hlsl -Fo shade_ps.cso', '# runtime: IDxcCompiler3::Compile()'],
  };
  const phases = [
    [L('Parsning → AST', 'Parse → AST'), 'max(dot(n, LIGHT_DIR), 0.0)'],
    [L('Typkontroll', 'Type check'), 'dot(vec3, vec3) → float'],
    [L('Gränssnitt VS ↔ FS', 'Interface VS ↔ FS'), sp.lang === 'glsl' ? 'location 0: vNormal' : 'semantic NORMAL'],
    [L('Konstantvikning', 'Constant folding'), `LIGHT_DIR = (${LIGHT_DIR.map((x) => x.toFixed(3)).join(', ')})`],
  ] as const;
  const p1 = ms.panel(t(L('Front end – och diffus belysning', 'Front end – and diffuse light')), [
    h('div.stat-row', {}, [liveStat(live.nl, 'diff = max(N·L, 0)'), stat(f4(sh.diffuse), t(L('med appens LIGHT_DIR', 'with the app’s LIGHT_DIR')), 'glow-amber')]),
    h('pre.sh-term', {}, cmd[api].map((l) => h('div', { text: l, attrs: { class: l.startsWith('$') ? 'cmd' : 'cmt' } }))),
    h('ol.sh-phases.one', {}, phases.map(([a, b]) => h('li.sh-phase', {}, [h('span.sh-tick', { text: '✓' }), h('b', { text: t(a) }), h('code', { text: b })]))),
    h('p.hint', {
      html: t(L(
        'Raden <code>diff = max(dot(n, LIGHT_DIR), 0)</code> slås på: ljuset (solen) kretsar runt modellen och <b>N·L</b> i den följda punkten räknas live.',
        'The line <code>diff = max(dot(n, LIGHT_DIR), 0)</code> is switched on: the light (the sun) orbits the model and <b>N·L</b> at the followed point is computed live.',
      )),
    }),
  ], { className: 'sh-p' });

  const irTitle = api === 'd3d12' ? 'shade_ps.cso – DXIL' : api === 'vulkan' ? 'shade.frag.spv – SPIR-V' : 'SPIR-V (GL_ARB_gl_spirv)';
  const irCode = api === 'd3d12' ? codeEl(dxilExcerpt(), 'llvm') : asmEl(spirvExcerpt(api));
  const p2 = ms.panel(`${irTitle} · ${t(L('utdrag', 'excerpt'))}`, [
    h('div.stat-row', {}, [liveStat(live.nh, 'N·H'), liveStat(live.spec, `spec = (N·H)^${SHININESS}`)]),
    h('div.v-scroll.sh-scroll.sh-ir', {}, [irCode]),
    h('p.hint', {
      html: t(api === 'opengl'
        ? L('I OpenGL är IR:en normalt dold i drivrutinen; med GL 4.6 kan du ge den SPIR-V. Spekulärtermen slås på – <b>H</b> ligger mitt emellan ljus och kamera.', 'In OpenGL the IR is normally hidden in the driver; GL 4.6 can take SPIR-V. The specular term is switched on – <b>H</b> sits halfway between light and camera.')
        : L(`IR: binärt, leverantörsneutralt${api === 'vulkan' ? ', magic 0x07230203' : ', signerat av validatorn'}. Spekulärtermen slås på – <b>H</b> ligger mitt emellan ljus och kamera.`, `IR: binary, vendor neutral${api === 'vulkan' ? ', magic 0x07230203' : ', signed by the validator'}. The specular term is switched on – <b>H</b> sits halfway between light and camera.`)),
    }),
  ], { className: 'sh-p' });

  const when: Record<ApiId, L> = {
    opengl: L('Vid glLinkProgram (ofta uppskjutet till första draw). glGetProgramBinary kan cacha.', 'At glLinkProgram (often deferred to the first draw). glGetProgramBinary can cache it.'),
    vulkan: L('I vkCreateGraphicsPipelines; VkPipelineCache sparar den.', 'In vkCreateGraphicsPipelines; a VkPipelineCache keeps it.'),
    d3d12: L('I CreateGraphicsPipelineState; ID3D12PipelineLibrary sparar den.', 'In CreateGraphicsPipelineState; an ID3D12PipelineLibrary keeps it.'),
  };
  const p3 = ms.panel(t(L('GPU ISA – illustrativt (RDNA-likt)', 'GPU ISA – illustrative (RDNA-like)')), [
    h('div.stat-row', {}, [stat(f4(sh.diffuse), 'diff', 'glow-amber'), stat(f4(sh.specular), 'spec', 'glow-magenta'), h('div.stat', {}, [h('div.v', {}, [h('span.sh-swatch', { style: { background: `rgb(${rgb.join(',')})` } }), ` ${rgb.join(',')}`]), h('div.k', { text: 'outColor' })])]),
    h('div.v-scroll.sh-scroll.sh-isa', {}, [asmEl(isaExcerpt())]),
    h('p.hint', {
      html: t(L(
        `Ljuset låses på appens <code>LIGHT_DIR</code> – i maskinkoden är den bara tre float-literaler. ${when[api].sv} Värdena ovan: samma shader på CPU:n för vertex ${vi}.`,
        `The light locks onto the app’s <code>LIGHT_DIR</code> – in machine code it is just three float literals. ${when[api].en} Values above: the same shader on the CPU for vertex ${vi}.`,
      )),
    }),
  ], { className: 'sh-p' });
  const panels = [p0, p1, p2, p3];

  steadySun(ms);

  // Live N·L / N·H at the followed point, plus arrows that follow the light.
  const L3 = new Vector3();
  const H3 = new Vector3();
  let frame = 0;
  let step = 0;
  ms.onFrame(() => {
    L3.copy(ms.material.uniforms.uLightDir.value).normalize();
    H3.copy(L3).add(new Vector3(0, 0, 1)).normalize();
    setArrow(lArrow, L3, 0.55);
    setArrow(hArrow, H3, 0.5);
    if (frame++ % 6) return;
    const nl = Math.max(nWorld.dot(L3), 0);
    const nh = Math.max(nWorld.dot(H3), 0);
    live.nl.textContent = nl.toFixed(3);
    live.nh.textContent = nh.toFixed(3);
    live.spec.textContent = (nl > 0 ? Math.pow(nh, SHININESS) * (step >= 2 ? 1 : 0) : 0).toFixed(3);
  });

  const frags: string[][] = [
    [],
    ['dot(n, LIGHT_DIR)', 'max(diff, 0.0)', 'normalize(vNormal)', 'BASE * (0.12 + diff)'],
    api === 'd3d12' ? ['dx.op.dot3', 'dx.op.unary Log', 'fmul fast', 'dx.op.unary Exp', 'select i1'] : ['OpDot', 'OpExtInst Pow', 'OpExtInst FMax', 'OpSelect', 'OpFOrdGreaterThan'],
    ['v_fmac_f32', 'v_log_f32', 'v_exp_f32', 'v_cndmask_b32', hexOf('v_fmac'), hexOf('v_exp'), 'v_rsq_f32', 'exp mrt0'],
  ];
  const fragColor = [CSS.cyan, CSS.cyan, API_CSS[api], CSS.magenta];
  /** Fragments leave from the code panel's edge. */
  const fromPanel: Where = () => new Vector3(1.2 + Math.random() * 0.2, -0.55 + Math.random() * 1.3, 0.35);

  return {
    show(s, animate) {
      step = s;
      strip.set(s, animate);
      panels.forEach((el, i) => (el.style.display = i === s ? '' : 'none'));
      if (animate) gsap.fromTo(panels[s], { opacity: 0, x: 14 }, { opacity: 1, x: 0, duration: dur(0.4) });
      markLines(s === 0 ? lit.base : s === 1 ? [...lit.base, ...lit.diff] : [...lit.base, ...lit.diff, ...lit.spec]);
      stream.clear();
      if (s > 0) stream.start(frags[s], fragColor[s], animate ? 0.55 : 0.8, fromPanel);

      // The shader on the model, term by term.
      ms.uniform('uDiffuseW', s >= 1 ? 1 : 0, 0);
      ms.uniform('uSpecW', s >= 2 ? 1 : 0, s === 2 ? secs(animate, 1.6) : 0);
      if (s === 0) {
        ms.setMode('unlit', 1, 0);
        if (animate) ms.sweep('unlit', 'ghost', 1.4);
      } else if (s === 1) {
        ms.setMode('shaded', 0, 0);
        if (animate) ms.sweep('shaded', 'unlit', 1.6);
      } else {
        ms.setMode('shaded', 0, 0);
      }
      nArrow.visible = true;
      lArrow.visible = s >= 1;
      hArrow.visible = s >= 2;
      // With reduced motion the light stays at the app's LIGHT_DIR instead of orbiting.
      const orbit = (s === 1 || s === 2) && !reducedMotion();
      ms.lightOrbit(orbit);
      if (!orbit && s !== 3) ms.material.uniforms.uLightDir.value.set(...LIGHT_DIR);
      if (s === 3) {
        const u = ms.material.uniforms.uLightDir.value;
        if (animate) {
          const target = new Vector3(...LIGHT_DIR);
          ms.tween(u, { x: target.x, y: target.y, z: target.z, duration: dur(1.0), ease: 'power2.inOut', onUpdate: () => u.normalize() });
          ms.sweep('shaded', 'shaded', 1.5);
          ms.material.uniforms.uSweepColor.value.set(COLORS.magenta);
        } else u.set(...LIGHT_DIR);
      }
    },
    destroy() {
      stream.clear();
      gsap.killTweensOf(panels);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: the shader text is compiled into the model                  */
/* ------------------------------------------------------------------ */
interface Tok {
  src: string;
  ast: string;
  ir: string;
  be: string;
}

function tokens(api: ApiId): Tok[] {
  const dx = api === 'd3d12';
  return [
    { src: 'normalize(vNormal)', ast: 'Call normalize : vec3', ir: dx ? 'dx.op.dot3 + Rsqrt' : 'OpExtInst Normalize', be: 'v_rsq_f32' },
    { src: 'dot(n, LIGHT_DIR)', ast: 'Call dot : float', ir: dx ? 'dx.op.dot3' : 'OpDot', be: 'v_fmac_f32' },
    { src: 'max(d, 0.0)', ast: 'Call max : float', ir: dx ? 'dx.op.binary FMax' : 'OpExtInst FMax', be: 'v_max_f32' },
    { src: 'pow(s, 48.0)', ast: 'Call pow : float', ir: dx ? 'Log · fmul · Exp' : 'OpExtInst Pow', be: 'v_log → v_exp' },
    { src: 'diff > 0.0 ? … : 0.0', ast: 'Select : float', ir: dx ? 'fcmp + select' : 'OpSelect', be: 'v_cndmask_b32' },
    { src: 'BASE * (0.12 + diff)', ast: 'Mul vec3 × float', ir: dx ? 'fmul fast' : 'OpVectorTimesScalar', be: 'v_fma_f32' },
    { src: dx ? 'return float4(c, 1)' : 'outColor = vec4(c, 1)', ast: dx ? 'Return SV_Target' : 'Assign out vec4', ir: dx ? 'dx.op.storeOutput' : 'OpStore', be: 'exp mrt0' },
  ];
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const toks = tokens(api);
  const strip = chainStrip(api, t);
  const ms = createModelStage(host, ctx, { autoRotate: 0.25, bloom: 0.6, bloomThreshold: 0.85, layers: { solid: 1, wire: 0 } });
  ms.overlay.classList.add('sh-ms', 'sh-concept');
  steadySun(ms);
  const stream = codeStream(ms);

  // A ring of tokens around the model: the shader as text, then as AST, then as IR.
  const ring = new Group();
  ms.scene.add(ring);
  const textures: Texture[] = [];
  const kindColor = [CSS.cyan, CSS.violet, API_CSS[api]];
  const ringSprites = [0, 1, 2].map((k) =>
    toks.map((tk) => {
      const spr = textSprite(k === 0 ? tk.src : k === 1 ? tk.ast : tk.ir, kindColor[k], 0.1);
      if (spr.material.map) textures.push(spr.material.map);
      spr.visible = false;
      ring.add(spr);
      return spr;
    }),
  );
  const fileName = api === 'd3d12' ? 'shade_ps.cso' : api === 'vulkan' ? 'shade.frag.spv' : t(L('drivrutinens IR', 'driver IR'));
  const filePos = new Vector3(1.45, -0.32, 0.2);
  const file = ms.box(fileName, [filePos.x, filePos.y, filePos.z], [0.62, 0.46, 0.14], API_HEX3[api]);
  let step = 0;
  let radius = 1.5;
  ms.onFrame((time) => {
    ring.rotation.y = time * 0.25;
    const set = ringSprites[Math.min(step, 2)];
    set.forEach((spr, i) => {
      const a = (i / set.length) * Math.PI * 2;
      spr.position.set(Math.cos(a) * radius, Math.sin(a * 2 + time * 0.8) * 0.22 + 0.2, Math.sin(a) * radius * 0.55);
    });
  });

  const captions = [
    L('Shadern börjar som vanlig text. Utan kompilerad kod kan GPU:n inte rita modellen – här bara ett spöke.', 'The shader starts out as plain text. Without compiled code the GPU cannot draw the model – just a ghost here.'),
    L('Front end: text → syntaxträd → typkontroll. Uttrycken blir noder med typer (lila).', 'Front end: text → syntax tree → type check. Expressions become typed nodes (violet).'),
    api === 'opengl'
      ? L('I OpenGL är IR:en drivrutinens egen och syns aldrig – med GL_ARB_gl_spirv kan du ge den SPIR-V istället.', 'In OpenGL the IR belongs to the driver and is never visible – with GL_ARB_gl_spirv you can hand it SPIR-V instead.')
      : L('IR:en packas i en fil som skeppas med spelet. Samma fil fungerar på alla GPU-tillverkare.', 'The IR is packed into a file that ships with the game. The same file works on every GPU vendor.'),
    L('Drivrutinens back end gör maskinkod för just din GPU – den strömmar in i modellen, som nu ritas på riktigt.', 'The driver’s back end makes machine code for your exact GPU – it streams into the model, which is now really drawn.'),
  ];
  const caption = h('p.sh-caption');
  ms.panel(t(L('Vad händer', 'What happens')), [caption], { side: 'bottom', className: 'sh-cap' });
  ms.panel(t(L('Kedjan', 'The chain')), [strip.el], { side: 'bottom', className: 'sh-chainpanel' });

  return {
    show(s, animate) {
      step = s;
      strip.set(s, animate);
      caption.innerHTML = t(captions[s]);
      ringSprites.forEach((set, k) => set.forEach((spr) => (spr.visible = s < 3 && k === Math.min(s, 2))));
      if (animate && s < 3) {
        const o = { r: 1.9 };
        radius = o.r;
        ms.tween(o, { r: s === 2 ? 1.25 : 1.5, duration: dur(1.2), ease: 'power2.out', onUpdate: () => (radius = o.r) });
      } else radius = s === 2 ? 1.25 : 1.5;
      file.visible = s >= 2;
      stream.clear();
      const atFile: Where = () => filePos.clone().add(new Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.2, 0));
      const onRing: Where = () => {
        const a = Math.random() * Math.PI * 2;
        return new Vector3(Math.cos(a) * radius, 0.2, Math.sin(a) * radius * 0.55).applyAxisAngle(new Vector3(0, 1, 0), ring.rotation.y);
      };
      if (s === 3) stream.start(toks.map((tk) => hexOf(tk.be)), CSS.magenta, 0.4, atFile);
      else if (s === 2) stream.start(toks.map((tk) => tk.ir), API_CSS[api], 0.7, onRing, atFile);
      ms.lightOrbit(s === 3);
      if (s < 3) {
        ms.setMode('ghost', 1, secs(animate, 0.5));
        ms.setLayer('wire', 0.18, secs(animate, 0.5));
      } else {
        ms.setLayer('wire', 0, secs(animate, 0.8));
        ms.setMode('shaded', 0, 0);
        if (animate) {
          ms.sweep('shaded', 'ghost', 1.8);
          ms.material.uniforms.uSweepColor.value.set(COLORS.magenta);
        }
      }
    },
    destroy() {
      stream.clear();
      textures.forEach((x) => x.dispose());
      ms.destroy();
    },
  };
}
const API_HEX3: Record<ApiId, number> = { opengl: 0x5aa9e6, vulkan: 0xff4d64, d3d12: 0x6cd04a };

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const glFs = shaderPair('opengl').fs;
  return {
    opengl: {
      note: L(
        'OpenGL tar emot GLSL-text vid körtid. Drivrutinen kompilerar (front end) i glCompileShader och länkar + genererar maskinkod i glLinkProgram. GL 4.6 kan också ta SPIR-V.',
        'OpenGL takes GLSL text at run time. The driver compiles it (front end) in glCompileShader and links + generates machine code in glLinkProgram. GL 4.6 can also take SPIR-V.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `GLuint vs = glCreateShader(GL_VERTEX_SHADER);
glShaderSource(vs, 1, &vsSrc, nullptr);    // GLSL text
glCompileShader(vs);                       // driver front end
GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
glShaderSource(fs, 1, &fsSrc, nullptr);
glCompileShader(fs);
GLint ok = 0;
glGetShaderiv(fs, GL_COMPILE_STATUS, &ok); // + glGetShaderInfoLog
GLuint prog = glCreateProgram();
glAttachShader(prog, vs);
glAttachShader(prog, fs);
glLinkProgram(prog);                       // match VS↔FS, back end → ISA
// Alternative, GL 4.6 (GL_ARB_gl_spirv): precompiled SPIR-V
glShaderBinary(1, &fs, GL_SHADER_BINARY_FORMAT_SPIR_V, spv, spvSize);
glSpecializeShader(fs, "main", 0, nullptr, nullptr);`,
          highlight: [[2, 5], [3, 6, 7, 8], [14, 15], [9, 10, 11, 12]],
        },
        { title: L('Fragmentshader', 'Fragment shader'), lang: 'glsl', src: glFs, highlight: [[], [4, 10], [], [11, 12]] },
      ],
      terms: [
        { term: 'GLSL', desc: L('OpenGL Shading Language – text som drivrutinen kompilerar.', 'OpenGL Shading Language – text the driver compiles.') },
        { term: 'glLinkProgram', desc: L('Kopplar ihop stegen och skapar maskinkoden (kan vara långsamt).', 'Joins the stages and produces the machine code (can be slow).') },
        { term: 'GL_ARB_gl_spirv', desc: L('Låter GL 4.6 ta emot SPIR-V 1.0 via glShaderBinary + glSpecializeShader.', 'Lets GL 4.6 take SPIR-V 1.0 via glShaderBinary + glSpecializeShader.') },
        { term: 'ISA', desc: L('Instruction Set Architecture – GPU:ns egna maskininstruktioner.', 'Instruction Set Architecture – the GPU’s own machine instructions.') },
      ],
      you: L('skriver GLSL, anropar compile/link', 'write GLSL, call compile/link'),
      driver: L('hela kompilatorn: parse → IR → ISA', 'the whole compiler: parse → IR → ISA'),
    },
    vulkan: {
      note: L(
        'Vulkan tar bara SPIR-V. Du kompilerar GLSL (eller HLSL) offline med glslc/glslangValidator/dxc, laddar orden med vkCreateShaderModule och drivrutinen gör maskinkod när pipelinen skapas.',
        'Vulkan only takes SPIR-V. You compile GLSL (or HLSL) offline with glslc/glslangValidator/dxc, load the words with vkCreateShaderModule, and the driver makes machine code when the pipeline is created.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `// build step (offline):
//   glslc --target-env=vulkan1.3 shade.vert -o shade.vert.spv
//   glslc --target-env=vulkan1.3 shade.frag -o shade.frag.spv
std::vector<uint32_t> spv = readWords("shade.frag.spv");
// spv[0] == 0x07230203 (SPIR-V magic number)
VkShaderModuleCreateInfo ci{ VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO };
ci.codeSize = spv.size() * sizeof(uint32_t);   // in bytes
ci.pCode    = spv.data();
VkShaderModule fsModule;
vkCreateShaderModule(device, &ci, nullptr, &fsModule);
VkPipelineShaderStageCreateInfo stage{
    VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO };
stage.stage  = VK_SHADER_STAGE_FRAGMENT_BIT;
stage.module = fsModule;
stage.pName  = "main";
// → VkGraphicsPipelineCreateInfo::pStages; the driver's back end
//   produces GPU ISA inside vkCreateGraphicsPipelines (next slide)`,
          highlight: [[1, 2, 3], [2, 3], [4, 5, 6, 7, 8, 9, 10], [11, 12, 13, 14, 15, 16, 17]],
        },
        { title: L('Fragmentshader', 'Fragment shader'), lang: 'glsl', src: shaderPair('vulkan').fs, highlight: [[], [4, 10], [], [11, 12]] },
      ],
      terms: [
        { term: 'SPIR-V', desc: L('Binär, leverantörsneutral IR – en ström av 32-bitars ord.', 'Binary, vendor-neutral IR – a stream of 32-bit words.') },
        { term: 'glslc / glslangValidator', desc: L('Khronos/Googles GLSL → SPIR-V-kompilatorer.', 'Khronos/Google GLSL → SPIR-V compilers.') },
        { term: 'VkShaderModule', desc: L('Ett inläst SPIR-V-paket. Ännu ingen maskinkod.', 'A loaded SPIR-V blob. No machine code yet.') },
        { term: 'VkPipelineCache', desc: L('Cache för färdig maskinkod mellan körningar.', 'Cache for finished machine code between runs.') },
      ],
      you: L('kompilerar till SPIR-V offline', 'compile to SPIR-V offline'),
      driver: L('SPIR-V → GPU ISA vid pipeline-skapandet', 'SPIR-V → GPU ISA at pipeline creation'),
    },
    d3d12: {
      note: L(
        'D3D12 tar DXIL. DXC kompilerar HLSL (Shader Model 6.x) till DXIL, bytekoden läggs direkt i PSO-beskrivningen och drivrutinen gör maskinkod i CreateGraphicsPipelineState.',
        'D3D12 takes DXIL. DXC compiles HLSL (Shader Model 6.x) to DXIL, the bytecode goes straight into the PSO description, and the driver makes machine code in CreateGraphicsPipelineState.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `// build step (offline):
//   dxc -T vs_6_6 -E main shade_vs.hlsl -Fo shade_vs.cso
//   dxc -T ps_6_6 -E main shade_ps.hlsl -Fo shade_ps.cso
std::vector<char> vs = readFile("shade_vs.cso");   // DXIL container
std::vector<char> ps = readFile("shade_ps.cso");
D3D12_GRAPHICS_PIPELINE_STATE_DESC pso = {};
pso.VS = { vs.data(), vs.size() };   // D3D12_SHADER_BYTECODE
pso.PS = { ps.data(), ps.size() };
// ... root signature, input layout, raster/depth/blend state ...
ComPtr<ID3D12PipelineState> pipeline;
device->CreateGraphicsPipelineState(&pso, IID_PPV_ARGS(&pipeline));
// ↑ the driver compiles DXIL → GPU ISA here
// run-time alternative: IDxcCompiler3::Compile(...)`,
          highlight: [[1, 2, 3], [2, 3, 13], [4, 5, 6, 7, 8], [10, 11, 12]],
        },
        { title: L('Pixelshader', 'Pixel shader'), lang: 'hlsl', src: shaderPair('d3d12').fs, highlight: [[], [1, 8], [], [9, 10]] },
      ],
      terms: [
        { term: 'DXIL', desc: L('DirectX Intermediate Language – LLVM-baserad bitkod.', 'DirectX Intermediate Language – LLVM-based bitcode.') },
        { term: 'dxc', desc: L('DirectX Shader Compiler (Clang/LLVM). -T ps_6_6 = pixelshader, SM 6.6.', 'DirectX Shader Compiler (Clang/LLVM). -T ps_6_6 = pixel shader, SM 6.6.') },
        { term: 'SV_Target', desc: L('Systemvärde: utdata till render target 0.', 'System value: output to render target 0.') },
        { term: 'D3D12_SHADER_BYTECODE', desc: L('Pekare + längd till DXIL-bytekoden.', 'Pointer + length to the DXIL bytecode.') },
      ],
      you: L('kompilerar HLSL → DXIL med dxc', 'compile HLSL → DXIL with dxc'),
      driver: L('DXIL → GPU ISA i CreateGraphicsPipelineState', 'DXIL → GPU ISA in CreateGraphicsPipelineState'),
    },
  };
}

export default standardSlide({
  id: 'shaders',
  group: 'api',
  short: L('Shaders', 'Shaders'),
  title: L('Shaders – skriva och kompilera', 'Shaders – writing and compiling'),
  lead: L(
    'En shader är ett litet program som GPU:n kör för varje vertex och varje pixel. Innan den kan köras måste den översättas från text till GPU:ns egen maskinkod – i flera steg.',
    'A shader is a small program the GPU runs for every vertex and every pixel. Before it can run it has to be translated from text into the GPU’s own machine code – in several steps.',
  ),
  bullets: [
    L('Appen använder ett shaderpar: en <b>vertexshader</b> (MVP-transform, normal till world space) och en <b>fragmentshader</b> (Blinn–Phong). GLSL för OpenGL/Vulkan, HLSL för D3D12.', 'The app uses one shader pair: a <b>vertex shader</b> (MVP transform, normal to world space) and a <b>fragment shader</b> (Blinn–Phong). GLSL for OpenGL/Vulkan, HLSL for D3D12.'),
    L('En <b>front end</b> parsar, typkontrollerar och optimerar. I OpenGL sker det i drivrutinen vid <code>glCompileShader</code>; för Vulkan och D3D12 kör du <code>glslc</code> eller <code>dxc</code> när du bygger.', 'A <b>front end</b> parses, type-checks and optimizes. In OpenGL this happens in the driver at <code>glCompileShader</code>; for Vulkan and D3D12 you run <code>glslc</code> or <code>dxc</code> at build time.'),
    L('Resultatet är en <b>IR</b>: SPIR-V (Vulkan, valfritt i GL 4.6) eller DXIL (D3D12) – binärt, leverantörsneutralt och färdigvaliderat.', 'The result is an <b>IR</b>: SPIR-V (Vulkan, optional in GL 4.6) or DXIL (D3D12) – binary, vendor neutral and already validated.'),
    L('Drivrutinens <b>back end</b> översätter IR till GPU:ns <b>ISA</b> – vid <code>glLinkProgram</code>, <code>vkCreateGraphicsPipelines</code> eller <code>CreateGraphicsPipelineState</code>. Dyrt, så resultatet cachas.', 'The driver’s <b>back end</b> translates IR into the GPU’s <b>ISA</b> – at <code>glLinkProgram</code>, <code>vkCreateGraphicsPipelines</code> or <code>CreateGraphicsPipelineState</code>. Expensive, so the result is cached.'),
  ],
  api: apis(),
  data: dataVisual,
  concept: conceptVisual,
});
