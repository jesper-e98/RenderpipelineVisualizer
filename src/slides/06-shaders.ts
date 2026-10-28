import gsap from 'gsap';
import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import glsl from 'highlight.js/lib/languages/glsl';
import llvm from 'highlight.js/lib/languages/llvm';
import { Matrix3 } from 'three';
import { dur, escapeHtml, h, reducedMotion } from '../core/dom';
import { L } from '../core/i18n';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import type { ApiId } from '../core/state';
import { AMBIENT, BASE_COLOR, LIGHT_DIR, SHININESS, VIEW_DIR, normalize, shade } from '../pipeline/shade';
import { modelMatrix, type V3 } from '../pipeline/transform';
import { card } from '../views/widgets';
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
         %17 = OpConstantComposite %v3float ${LIGHT_DIR.map(f4).join(' ')} ; LIGHT_DIR
         %21 = OpConstantComposite %v3float ${HALF.map(f4).join(' ')} ; h (folded)
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
  return `v_mul_f32     v3, v0, v0              ; |n|² = n·n
v_fmac_f32    v3, v1, v1
v_fmac_f32    v3, v2, v2
v_rsq_f32     v3, v3                  ; 1/|n|
v_mul_f32     v0, v0, v3              ; n = normalize(n)
v_mul_f32     v1, v1, v3
v_mul_f32     v2, v2, v3
v_mul_f32     v4, ${lx}, v0     ; dot(n, LIGHT_DIR)
v_fmac_f32    v4, ${ly}, v1     ;   literals = LIGHT_DIR
v_fmac_f32    v4, ${lz}, v2
v_max_f32     v4, 0, v4               ; diff
v_mul_f32     v5, ${hx}, v0     ; dot(n, h)
v_fmac_f32    v5, ${hy}, v1
v_fmac_f32    v5, ${hz}, v2
v_max_f32     v5, 0, v5
v_log_f32     v5, v5                  ; pow(x, 48) =
v_mul_f32     v5, ${f32hex(SHININESS)}, v5     ;   exp2(48 · log2 x)
v_exp_f32     v5, v5
v_cmp_lt_f32  vcc_lo, 0, v4           ; diff > 0 ?
v_cndmask_b32 v5, 0, v5, vcc_lo
; … BASE * (${AMBIENT} + diff) + spec·0.8, v_min_f32 …
exp           mrt0, v6, v7, v8, v9 done
s_endpgm`;
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
  return `${w.slice(0, 4)} ${w.slice(4)} · ${str.split(' ')[0]}`;
}

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
    h('div.sh-node', { dataset: { i: String(i) } }, [h('div.sh-node-t', { text: n.title }), h('div.sh-node-s', { text: n.sub })]),
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
/* Real data: the actual shader, its IR and an ISA excerpt              */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const sp = shaderPair(api);
  const strip = chainStrip(api, t);

  // Step 0 – the source pair.
  const srcPanel = h('div.sh-panel.sh-two', {}, [
    card(`${sp.vsName} · ${lineCount(sp.vs)} ${t(L('rader', 'lines'))} · ${byteCount(sp.vs)} B`, [h('div.v-scroll.sh-scroll', {}, [codeEl(sp.vs, sp.lang)])], 'sh-card'),
    card(`${sp.fsName} · ${lineCount(sp.fs)} ${t(L('rader', 'lines'))} · ${byteCount(sp.fs)} B`, [h('div.v-scroll.sh-scroll', {}, [codeEl(sp.fs, sp.lang)])], 'sh-card'),
  ]);

  // Step 1 – front end.
  const cmd: Record<ApiId, string[]> = {
    opengl: [
      '// at run time, inside your process:',
      'glShaderSource(fs, 1, &src, nullptr);',
      'glCompileShader(fs);',
      'glGetShaderiv(fs, GL_COMPILE_STATUS, &ok);  // GL_TRUE',
      '// optional (GL 4.6 / GL_ARB_gl_spirv), offline:',
      '// glslangValidator -G shade.frag -o shade.frag.spv',
    ],
    vulkan: [
      '$ glslc --target-env=vulkan1.3 -O shade.vert -o shade.vert.spv',
      '$ glslc --target-env=vulkan1.3 -O shade.frag -o shade.frag.spv',
      '# or:  glslangValidator -V --target-env vulkan1.3 shade.frag',
      '# or:  dxc -spirv -T ps_6_6 -E main shade_ps.hlsl',
    ],
    d3d12: [
      '$ dxc -T vs_6_6 -E main shade_vs.hlsl -Fo shade_vs.cso',
      '$ dxc -T ps_6_6 -E main shade_ps.hlsl -Fo shade_ps.cso',
      '# runtime alternative: IDxcCompiler3::Compile()',
    ],
  };
  const phases = [
    [L('Förprocessor', 'Preprocess'), sp.lang === 'glsl' ? '#version 460, #define' : '#include, #define'],
    [L('Parsning → AST', 'Parse → AST'), 'pow(max(dot(n, h), 0.0), 48.0)'],
    [L('Typkontroll', 'Type check'), 'dot(vec3, vec3) → float'],
    [L('Gränssnitt VS ↔ FS', 'Interface VS ↔ FS'), sp.lang === 'glsl' ? 'location 0: vNormal' : 'semantic NORMAL'],
    [L('Optimering', 'Optimize'), t(L('konstantvikning, död kod', 'constant folding, dead code'))],
    [L('Generera IR', 'Emit IR'), api === 'd3d12' ? 'DXIL (LLVM bitcode)' : api === 'vulkan' ? 'SPIR-V words' : t(L('drivrutinens egen IR', "driver's own IR"))],
  ] as const;
  const phaseEls = phases.map(([a, b]) => h('li.sh-phase', {}, [h('span.sh-tick', { text: '✓' }), h('b', { text: t(a) }), h('code', { text: b })]));
  const fePanel = h('div.sh-panel.sh-fe', {}, [
    card(api === 'opengl' ? t(L('Kompilering vid körtid', 'Compiling at run time')) : t(L('Byggsteg', 'Build step')), [
      h('pre.sh-term', {}, cmd[api].map((l) => h('div', { text: l, attrs: { class: l.startsWith('$') ? 'cmd' : 'cmt' } }))),
      h('ol.sh-phases', {}, phaseEls),
    ], 'sh-card'),
    card(t(L('Konstantvikning – riktiga värden', 'Constant folding – real values')), [
      h('div.sh-fold', {}, [
        h('code', { text: `LIGHT_DIR = normalize(0.5, 0.8, 0.6)` }),
        h('div.sh-fold-arrow', { text: '↓' }),
        h('code.glow-cyan', { text: `(${LIGHT_DIR.map(f4).join(', ')})` }),
        h('code', { text: `h = normalize(LIGHT_DIR + (0, 0, 1))`, style: { marginTop: '10px' } }),
        h('div.sh-fold-arrow', { text: '↓' }),
        h('code.glow-magenta', { text: `(${HALF.map(f4).join(', ')})` }),
        h('p.hint', {
          html: t(L(
            `Beräknas en gång vid kompilering, inte för varje pixel. <code>pow(x, ${SHININESS}.0)</code> blir kvar – back end skriver om den.`,
            `Computed once at compile time, not per pixel. <code>pow(x, ${SHININESS}.0)</code> stays – the back end rewrites it.`,
          )),
        }),
      ]),
    ], 'sh-card'),
  ]);

  // Step 2 – IR.
  const irTitle = api === 'd3d12' ? 'shade_ps.cso – DXIL' : 'shade.frag.spv – SPIR-V';
  const irFacts: Record<ApiId, [string, string][]> = {
    opengl: [
      [t(L('Normalfall', 'Normal path')), t(L('IR:en är dold i drivrutinen (t.ex. Mesa: GLSL IR → NIR).', 'The IR is hidden inside the driver (e.g. Mesa: GLSL IR → NIR).'))],
      ['GL_ARB_gl_spirv', t(L('Core i GL 4.6: glShaderBinary(GL_SHADER_BINARY_FORMAT_SPIR_V) + glSpecializeShader. Bara SPIR-V 1.0.', 'Core in GL 4.6: glShaderBinary(GL_SHADER_BINARY_FORMAT_SPIR_V) + glSpecializeShader. SPIR-V 1.0 only.'))],
      ['magic', '0x07230203'],
    ],
    vulkan: [
      ['magic', '0x07230203'],
      ['version', '0x00010600 (1.6)'],
      [t(L('format', 'format')), t(L('ström av 32-bitars ord, SSA-form, leverantörsneutral', 'stream of 32-bit words, SSA form, vendor neutral'))],
      [t(L('laddas med', 'loaded by')), 'vkCreateShaderModule(codeSize, pCode)'],
    ],
    d3d12: [
      ['container', "'DXBC' + DXIL-part"],
      [t(L('innehåll', 'content')), t(L('LLVM 3.7-bitkod med dx.op-intrinsics', 'LLVM 3.7 bitcode with dx.op intrinsics'))],
      [t(L('validering', 'validation')), t(L('signeras av validatorn (dxil.dll)', 'signed by the validator (dxil.dll)'))],
      [t(L('används i', 'used in')), 'D3D12_SHADER_BYTECODE { pShaderBytecode, BytecodeLength }'],
    ],
  };
  const irCode = api === 'd3d12' ? codeEl(dxilExcerpt(), 'llvm') : asmEl(spirvExcerpt(api));
  const irPanel = h('div.sh-panel.sh-side', {}, [
    card(`${irTitle} · ${t(L('utdrag (förkortat)', 'excerpt (abridged)'))}${api === 'opengl' ? ' · GL_ARB_gl_spirv' : ''}`, [h('div.v-scroll.sh-scroll', {}, [irCode])], 'sh-card'),
    card(t(L('Fakta', 'Facts')), [h('dl.kv.sh-kv', {}, irFacts[api].flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))], 'sh-card'),
  ]);

  // Step 3 – ISA + the shader evaluated on the CPU for the showcase triangle.
  const tri = ctx.derived.showcaseTriangle(api);
  const vi = ctx.derived.triangleVertices(tri)[0];
  const nObj = ctx.derived.normal(vi);
  const nm = new Matrix3().setFromMatrix4(modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X)).elements;
  const nWorld: V3 = [
    nm[0] * nObj[0] + nm[3] * nObj[1] + nm[6] * nObj[2],
    nm[1] * nObj[0] + nm[4] * nObj[1] + nm[7] * nObj[2],
    nm[2] * nObj[0] + nm[5] * nObj[1] + nm[8] * nObj[2],
  ];
  const sh = shade(nWorld);
  const rgb = sh.color.map((c) => Math.round(c * 255));
  const when: Record<ApiId, string> = {
    opengl: t(L('vid glLinkProgram – ofta uppskjutet till första draw-anropet, och ibland om igen när state ändras (hack i bilden). glGetProgramBinary kan cacha.', 'at glLinkProgram – often deferred to the first draw, and sometimes again when state changes (a hitch). glGetProgramBinary can cache it.')),
    vulkan: t(L('i vkCreateGraphicsPipelines, när all state är känd. VkPipelineCache sparar resultatet till nästa körning.', 'in vkCreateGraphicsPipelines, once all state is known. A VkPipelineCache keeps the result for the next run.')),
    d3d12: t(L('i CreateGraphicsPipelineState, när all state är känd. ID3D12PipelineLibrary / GetCachedBlob sparar resultatet.', 'in CreateGraphicsPipelineState, once all state is known. ID3D12PipelineLibrary / GetCachedBlob keeps the result.')),
  };
  const isaPanel = h('div.sh-panel.sh-side', {}, [
    card(t(L('GPU ISA – illustrativt utdrag (RDNA-liknande)', 'GPU ISA – illustrative excerpt (RDNA-like)')), [h('div.v-scroll.sh-scroll', {}, [asmEl(isaExcerpt())])], 'sh-card.sh-isa'),
    card(t(L('När skapas maskinkoden?', 'When is machine code made?')), [
      h('p.sh-when', { text: when[api] }),
      h('div.sh-eval', {}, [
        h('div.hint', { text: t(L(`Samma shader körd på CPU:n – triangel #${tri}, vertex ${vi}:`, `Same shader run on the CPU – triangle #${tri}, vertex ${vi}:`)) }),
        h('dl.kv', {}, [
          h('dt', { text: 'n (world)' }),
          h('dd', { text: sh.n.map((x) => x.toFixed(3)).join(', ') }),
          h('dt', { text: 'diff' }),
          h('dd.glow-cyan', { text: sh.diffuse.toFixed(4) }),
          h('dt', { text: 'spec' }),
          h('dd.glow-magenta', { text: sh.specular.toExponential(3) }),
          h('dt', { text: 'outColor' }),
          h('dd', {}, [h('span.sh-swatch', { style: { background: `rgb(${rgb.join(',')})` } }), ` ${sh.color.map((c) => c.toFixed(3)).join(', ')}`]),
        ]),
      ]),
    ], 'sh-card'),
  ]);

  const panels = [srcPanel, fePanel, irPanel, isaPanel];
  const body = h('div.sh-body', {}, panels);
  host.append(h('div.sh-data', {}, [strip.el, body]));
  let shown = -1;

  return {
    show(step, animate) {
      strip.set(step, animate);
      panels.forEach((p, i) => p.classList.toggle('on', i === step));
      const p = panels[step];
      if (animate && shown !== step) {
        gsap.fromTo(p, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
        const lines = p.querySelectorAll('.sh-line');
        if (lines.length) gsap.fromTo(lines, { opacity: 0, x: -8 }, { opacity: 1, x: 0, stagger: 0.012, duration: dur(0.25) });
        if (step === 1) gsap.fromTo(phaseEls, { opacity: 0.15 }, { opacity: 1, stagger: 0.16, duration: dur(0.3), delay: 0.2 });
      } else {
        gsap.set(p, { opacity: 1, y: 0 });
        gsap.set(p.querySelectorAll('.sh-line'), { opacity: 1, x: 0 });
        if (step === 1) gsap.set(phaseEls, { opacity: 1 });
      }
      shown = step;
    },
    destroy() {
      gsap.killTweensOf(panels);
      gsap.killTweensOf(phaseEls);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: source text flowing through a compiler chain               */
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
  const nodes = chain(api, t);
  const toks = tokens(api);
  const kinds = ['src', 'ast', 'ir', 'be', 'isa'] as const;

  const stage = h('div.v-fill.shc-stage');
  const caption = h('div.pack-caption.shc-caption');
  host.append(stage, caption);

  const stations = nodes.map((n, i) =>
    h(`div.shc-station.k-${kinds[i]}`, {}, [h('div.shc-st-t', { text: n.title }), h('div.shc-st-s', { text: n.sub })]),
  );
  const track = h('div.shc-track');
  stage.append(track, ...stations);
  const brackets = h('div.shc-brackets');
  stage.append(brackets);
  const buildCount = nodes.filter((n) => n.build).length;
  const bBuild = h('div.shc-bracket.build', { text: t(L('byggtid', 'build time')) });
  const bRun = h('div.shc-bracket.run', { text: t(L('körtid · drivrutin', 'run time · driver')) });
  if (buildCount) brackets.append(bBuild);
  brackets.append(bRun);

  // IR "file" badge and the machine-code grid.
  const file = h('div.shc-file', {}, [h('span', { text: api === 'd3d12' ? '.cso' : api === 'vulkan' ? '.spv' : 'IR' }), h('small', { text: t(L('portabel', 'portable')) })]);
  stage.append(file);
  const GRID = 16;
  const gridCells = Array.from({ length: GRID }, (_, i) => h('span.shc-cell', { text: (((i + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 4) }));
  const grid = h('div.shc-grid', {}, gridCells);
  stage.append(grid);
  const vendors = h('div.shc-vendors', {}, ['AMD', 'NVIDIA', 'Intel', 'Qualcomm'].map((v) => h('span', { text: v })));
  stage.append(vendors);

  let geo = { W: 0, H: 0, sx: [] as number[], sw: 0, y: 0, top: 0, sh: 0 };
  let step = 0;
  let gridFill = 0;
  const live = new Map<HTMLElement, gsap.core.Timeline | null>();
  let spawnCall: gsap.core.Tween | null = null;
  let spawnIdx = 0;
  const motion = !reducedMotion();

  const layout = () => {
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    const gap = Math.max(14, W * 0.025);
    const sw = (W - 32 - gap * 4) / 5;
    const sh = Math.min(170, H * 0.5);
    const top = Math.max(12, H * 0.08);
    const sx = stations.map((_, i) => 16 + i * (sw + gap));
    geo = { W, H, sx, sw, y: top + sh * 0.42, top, sh };
    stations.forEach((s, i) => gsap.set(s, { x: sx[i], y: top, width: sw, height: sh }));
    gsap.set(track, { x: sx[0] + sw / 2, y: geo.y, width: sx[4] - sx[0] });
    const by = top + sh + 8;
    const bw = sx[buildCount - 1] + sw - sx[0];
    if (buildCount) gsap.set(bBuild, { x: sx[0], y: by, width: bw });
    gsap.set(bRun, { x: sx[buildCount], y: by, width: sx[4] + sw - sx[buildCount] });
    gsap.set(file, { x: sx[2] + sw / 2 - 34, y: top + sh - 56 });
    gsap.set(grid, { x: sx[4] + 8, y: top + sh * 0.56, width: sw - 16 });
    gsap.set(vendors, { x: sx[3] + 6, y: top + sh * 0.62, width: sw - 12 });
  };

  const maxStation = () => [0, 2, 2, 4][step];

  const label = (tk: Tok, k: number) => (k === 0 ? tk.src : k === 1 ? tk.ast : k === 2 ? tk.ir : tk.be);

  const spawn = () => {
    if (!geo.W) return;
    const tk = toks[spawnIdx++ % toks.length];
    const el = h('div.shc-tok.k-src', { text: tk.src });
    stage.append(el);
    const last = maxStation();
    const cx = (k: number) => geo.sx[k] + geo.sw / 2;
    const tl = gsap.timeline({
      onComplete: () => {
        live.delete(el);
        el.remove();
      },
    });
    live.set(el, tl);
    tl.set(el, { x: geo.sx[0] - 30, y: geo.y - 13, opacity: 0, xPercent: -50 });
    tl.to(el, { x: cx(0), opacity: 1, duration: dur(0.6), ease: 'power2.out' });
    if (last === 0) {
      tl.to(el, { y: geo.y - 13 + 22 + (spawnIdx % 3) * 20, duration: dur(1.2), ease: 'sine.inOut' });
    }
    for (let k = 1; k <= last; k++) {
      tl.to(el, { x: cx(k), duration: dur(0.75), ease: 'power1.inOut' });
      tl.add(() => {
        el.className = `shc-tok k-${kinds[k]}`;
        el.textContent = k === 4 ? hexOf(tk.be) : label(tk, k);
        if (k === 4) {
          const c = gridCells[gridFill++ % GRID];
          c.classList.remove('hot');
          void c.offsetWidth;
          c.classList.add('on', 'hot');
        }
      });
      tl.to(el, { scale: 1.12, duration: dur(0.12), yoyo: true, repeat: 1 });
      if (k === 2 && last === 2) tl.to(el, { y: geo.top + geo.sh - 40, scale: 0.5, duration: dur(0.5), ease: 'power2.in' });
    }
    if (last === 4) tl.to(el, { y: geo.top + geo.sh * 0.6, scale: 0.4, duration: dur(0.4), ease: 'power2.in' });
    tl.to(el, { opacity: 0, duration: dur(0.3) });
  };

  const loop = () => {
    spawn();
    spawnCall = gsap.delayedCall(step === 0 ? 0.9 : 0.55, loop);
  };

  const clearTokens = () => {
    live.forEach((tl, el) => {
      tl?.kill();
      el.remove();
    });
    live.clear();
  };

  const captions = [
    L('Shadern börjar som vanlig text – här appens Blinn–Phong-fragmentshader.', 'The shader starts out as plain text – here the app’s Blinn–Phong fragment shader.'),
    L('Front end: text → syntaxträd → typkontroll → IR. Uttrycken blir enkla operationer i SSA-form.', 'Front end: text → syntax tree → type check → IR. Expressions become simple operations in SSA form.'),
    api === 'opengl'
      ? L('I OpenGL är IR:en drivrutinens egen och syns aldrig – med GL_ARB_gl_spirv kan du ge den SPIR-V istället.', 'In OpenGL the IR belongs to the driver and is never visible – with GL_ARB_gl_spirv you can hand it SPIR-V instead.')
      : L('IR:en sparas som en fil och skeppas med spelet. Samma fil fungerar på alla GPU-tillverkare.', 'The IR is saved as a file and shipped with the game. The same file works on every GPU vendor.'),
    L('Drivrutinens back end översätter IR till just din GPU:s instruktioner: register, scheduling, maskinkod.', 'The driver’s back end translates IR into your exact GPU’s instructions: registers, scheduling, machine code.'),
  ];

  const apply = (animate: boolean) => {
    const upto = LIT_UPTO[step];
    stations.forEach((s, i) => {
      s.classList.toggle('lit', i <= upto);
      s.classList.toggle('cur', i === upto || (step === 3 && i === 3));
    });
    track.style.setProperty('--fill', String(upto / 4));
    const fileOn = step >= 2;
    const vendOn = step >= 3;
    if (animate) {
      gsap.to(file, { opacity: fileOn ? 1 : 0, scale: fileOn ? 1 : 0.6, duration: dur(0.4), ease: 'back.out(2)' });
      gsap.to(grid, { opacity: vendOn ? 1 : 0, duration: dur(0.4) });
      gsap.to(vendors, { opacity: vendOn ? 1 : 0, duration: dur(0.4), delay: 0.1 });
    } else {
      gsap.set(file, { opacity: fileOn ? 1 : 0, scale: 1 });
      gsap.set(grid, { opacity: vendOn ? 1 : 0 });
      gsap.set(vendors, { opacity: vendOn ? 1 : 0 });
    }
    if (!motion || !animate) gridCells.forEach((c, i) => c.classList.toggle('on', vendOn && i < GRID * 0.6));
    caption.innerHTML = t(captions[step]);
  };

  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);
  layout();

  return {
    show(s, animate) {
      step = s;
      clearTokens();
      spawnCall?.kill();
      layout();
      apply(animate);
      if (motion) loop();
      else {
        // Static picture for reduced motion: one token parked at each lit station.
        const upto = maxStation();
        for (let k = 0; k <= upto; k++) {
          const el = h(`div.shc-tok.k-${kinds[k]}`, { text: k === 4 ? hexOf(toks[k].be) : label(toks[k], k) });
          stage.append(el);
          live.set(el, null);
          gsap.set(el, { x: geo.sx[k] + geo.sw / 2, y: geo.y - 13, xPercent: -50 });
        }
      }
    },
    destroy() {
      spawnCall?.kill();
      clearTokens();
      ro.disconnect();
      gsap.killTweensOf([file, grid, vendors, ...stations]);
    },
  };
}

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
