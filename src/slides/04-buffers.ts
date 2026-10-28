import gsap from 'gsap';
import {
  AdditiveBlending,
  BoxGeometry,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes, type VertexLayout } from '../pipeline/layout';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { VIEW_MODE } from '../views/pipelineMaterial';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, Visual } from './types';
import '../styles/slides/buffers.css';

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */
const PCIE_BYTES_PER_S = 25e9; // PCIe 4.0 x16: 31.5 GB/s raw, ≈25 GB/s in practice
const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

interface Alloc {
  vb: number;
  ib: number;
  exact: boolean; // false = driver internal, unknown
  rule: Text;
}

/** How much VRAM each buffer actually occupies, per API. */
function allocation(api: ApiId, l: VertexLayout): Alloc {
  if (api === 'd3d12') {
    return {
      vb: alignUp(l.vertexBytes, 65536),
      ib: alignUp(l.indexBytes, 65536),
      exact: true,
      rule: L('committed resource → egen heap, avrundas till 64 KiB (D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT)', 'committed resource → its own heap, rounded up to 64 KiB (D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT)'),
    };
  }
  if (api === 'vulkan') {
    return {
      vb: alignUp(l.vertexBytes, 256),
      ib: alignUp(l.indexBytes, 256),
      exact: false,
      rule: L('req.size / req.alignment – typiskt 16–256 B beroende på GPU (uppskattat med 256 B)', 'req.size / req.alignment – typically 16–256 B depending on the GPU (estimated with 256 B)'),
    };
  }
  return {
    vb: l.vertexBytes,
    ib: l.indexBytes,
    exact: false,
    rule: L('drivrutinen väljer minne och avrundning – inte synligt för dig', 'the driver chooses memory and rounding – not visible to you'),
  };
}

function fmtTime(sec: number): string {
  if (sec < 1e-6) return `${(sec * 1e9).toFixed(0)} ns`;
  if (sec < 1e-3) return `${(sec * 1e6).toFixed(1)} µs`;
  return `${(sec * 1e3).toFixed(2)} ms`;
}

const ATTR_CLS = { position: 'pos', normal: 'nrm', uv: 'uv' } as const;

/** First `n` bytes of the vertex buffer as colored hex cells. */
function firstBytes(l: VertexLayout, n: number): HTMLElement {
  const bytes = new Uint8Array(l.vertexBuffer, 0, Math.min(n, l.vertexBytes));
  const cls = (off: number) => {
    const o = off % l.stride;
    const a = [...l.attributes].reverse().find((x) => x.offset <= o)!;
    return ATTR_CLS[a.name];
  };
  return h('div.bf-hex', {}, Array.from(bytes, (b, i) => h(`span.mem-cell.${cls(i)}`, { text: b.toString(16).padStart(2, '0') })));
}

/* ------------------------------------------------------------------ */
/* Particles that follow a PCIe lane: staging → lane → VRAM            */
/* ------------------------------------------------------------------ */
const LANE_VERT = /* glsl */ `
attribute vec3 aTo;
attribute float aDelay;
attribute float aLane;
uniform float uProgress;
uniform float uSize;
uniform float uX0;
uniform float uX1;
varying float vT;
void main() {
  float t = smoothstep(aDelay, aDelay + 0.4, uProgress);
  vec3 a = vec3(uX0, aLane, 0.0);
  vec3 b = vec3(uX1, aLane, 0.0);
  vec3 p;
  if (t < 0.15) p = mix(position, a, smoothstep(0.0, 1.0, t / 0.15));
  else if (t < 0.8) p = mix(a, b, (t - 0.15) / 0.65);
  else p = mix(b, aTo, smoothstep(0.0, 1.0, (t - 0.8) / 0.2));
  vT = t;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * 600.0 / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
}
`;
const LANE_FRAG = /* glsl */ `
uniform vec3 uLaneColor;
uniform vec3 uEndColor;
varying float vT;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  float onLane = step(0.15, vT) * (1.0 - step(0.8, vT));
  vec3 c = mix(uEndColor, uLaneColor, onLane);
  gl_FragColor = vec4(c * a, a * 0.9);
}
`;

const API_COLOR: Record<ApiId, number> = { opengl: 0x5aa9e6, vulkan: 0xff4d64, d3d12: 0x6cd04a };

/* ------------------------------------------------------------------ */
/* Both modes: the model streams RAM → staging → PCIe → VRAM           */
/** Pull the camera back on narrow views so `halfWidth` world units (around the origin) stay in frame. */
function fitWidth(ms: ModelStage, halfWidth: number): void {
  const base = ms.camera.position.length();
  const prev = ms.view.onResize;
  ms.view.onResize = (w, hh) => {
    prev?.(w, hh);
    const tanH = Math.tan((ms.camera.fov * Math.PI) / 360);
    const need = halfWidth / (tanH * Math.max(0.3, w / hh)) + 0.6;
    ms.camera.position.setLength(Math.max(base, Math.min(12, need)));
  };
}

/* ------------------------------------------------------------------ */
function uploadVisual(host: HTMLElement, ctx: SlideContext, concept: boolean): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const gl = api === 'opengl';
  const m = ctx.state.mesh;
  const l = ctx.derived.layout;
  const total = l.vertexBytes + l.indexBytes;
  const al = allocation(api, l);
  const seconds = total / PCIE_BYTES_PER_S;
  const ms = createModelStage(host, ctx, {
    eye: [0, 1.0, 5.6],
    autoRotate: 0,
    bloom: 0.6,
    bloomThreshold: 0.84,
    layers: { solid: 1, wire: 0.12, points: 0, normals: 0 },
    orbit: true,
  });
  ms.overlay.classList.add('bf-ms');
  fitWidth(ms, 3.0);
  const u = ms.material.uniforms;
  const v = new Vector3();

  /* ---- layout (world units) ---- */
  const S_MODEL = 0.62;
  const Y0 = 0.22; // lift the scene into the band between the panels
  const RAM_C: [number, number, number] = [-1.8, Y0, 0];
  const VRAM_C: [number, number, number] = [1.95, Y0, 0];
  const LANE_X0 = -0.65;
  const LANE_X1 = 1.15;
  const STG_C: [number, number, number] = [-1.02, Y0 - 0.4, 0.05];
  const LANE_Y = (i: number) => Y0 - 0.62 + (i / 7) * 0.36;

  ms.pivot.position.set(-2.28, Y0 + 0.1, 0);
  ms.pivot.scale.setScalar(S_MODEL);

  const ramBox = ms.box(t(L('System-RAM · CPU', 'System RAM · CPU')), RAM_C, [2.3, 1.6, 1.0], COLORS.cyan);
  const vramName = gl ? t(L('VRAM · drivrutinen väljer', 'VRAM · driver decides')) : api === 'vulkan' ? 'VRAM · DEVICE_LOCAL' : 'VRAM · DEFAULT heap';
  const vramBox = ms.box(vramName, VRAM_C, [1.6, 1.6, 1.0], COLORS.magenta);
  const stgName = gl ? t(L('drivrutinens kopia', "driver's copy")) : api === 'vulkan' ? 'staging · HOST_VISIBLE' : 'UPLOAD heap';
  const stgBox = ms.box(stgName, STG_C, [0.55, 0.42, 0.42], gl ? COLORS.violet : API_COLOR[api]);
  [ramBox, vramBox, stgBox].forEach((g) =>
    g.traverse((o) => {
      if (o instanceof Mesh) (o.material as MeshBasicMaterial).opacity = 0.012;
    }),
  );
  const boxEdges = (g: Group) => g.children.find((o) => o instanceof LineSegments) as LineSegments;
  const edgeMat = (g: Group) => boxEdges(g).material as LineBasicMaterial;

  // PCIe lanes: thin glowing bars between the two boxes.
  const laneMat = new MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false });
  const lanes = new Group();
  for (let i = 0; i < 8; i++) {
    const bar = new Mesh(new BoxGeometry(LANE_X1 - LANE_X0, 0.014, 0.014), laneMat);
    bar.position.set((LANE_X0 + LANE_X1) / 2, LANE_Y(i), 0);
    lanes.add(bar);
  }
  const copyName = gl ? t(L('DMA · drivrutinen', 'DMA · driver')) : api === 'vulkan' ? 'vkCmdCopyBuffer' : 'CopyBufferRegion';
  const laneLbl = label(`PCIe 4.0 ×16 · ${copyName}`, 'amber');
  laneLbl.position.set((LANE_X0 + LANE_X1) / 2, LANE_Y(0) - 0.2, 0);
  lanes.add(laneLbl);
  ms.scene.add(lanes);

  // The model again, in VRAM: same geometry, its own opacity / mode.
  const vMat = ms.material.clone() as typeof ms.material;
  vMat.uniforms = { ...u, uOpacity: { value: 0 }, uMode: { value: 0 }, uModeMix: { value: 0 }, uSweep: { value: 100 } };
  vMat.transparent = true;
  const vWireMat = new LineBasicMaterial({ color: COLORS.magenta, transparent: true, opacity: 0, depthWrite: false });
  const vModel = new Group();
  vModel.rotation.order = 'YXZ';
  vModel.rotation.copy(ms.pivot.rotation);
  vModel.position.set(VRAM_C[0], Y0 + 0.1, 0);
  vModel.scale.setScalar(S_MODEL);
  const vSolid = new Mesh(ms.layers.solid.geometry, vMat);
  vModel.add(vSolid, new LineSegments(ms.layers.wire.geometry, vWireMat));
  ms.scene.add(vModel);

  // Allocation in VRAM: the data (solid outline) inside what was really allocated (dashed, with padding).
  ms.scene.updateMatrixWorld(true);
  const bb = new Box3().setFromObject(vSolid, true);
  const bc = bb.getCenter(new Vector3());
  const bs = bb.getSize(new Vector3()).addScalar(0.08);
  // Volume ∝ bytes; tiny paddings are exaggerated a little so they stay visible (the label has the truth).
  const padded = al.vb + al.ib > total;
  const allocK = padded ? Math.min(1.3, Math.max(1.07, Math.cbrt((al.vb + al.ib) / Math.max(1, total)))) : 1;
  const dataEdges = new LineSegments(new EdgesGeometry(new BoxGeometry(bs.x, bs.y, bs.z)), new LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0 }));
  const allocEdges = new LineSegments(new EdgesGeometry(new BoxGeometry(bs.x * allocK, bs.y * allocK, bs.z * allocK)), new LineDashedMaterial({ color: COLORS.magenta, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0 }));
  allocEdges.computeLineDistances();
  const alloc = new Group();
  alloc.add(dataEdges, allocEdges);
  alloc.position.copy(bc);
  const allocLbl = label(
    padded ? `${al.exact ? '' : '≈ '}${formatBytes(al.vb + al.ib)} ${t(L('allokerat', 'allocated'))} · +${formatBytes(al.vb + al.ib - total)} padding` : `${formatBytes(total)} · ${t(L('ingen synlig avrundning', 'no visible rounding'))}`,
    'magenta',
  );
  allocLbl.position.set(0, (bs.y * allocK) / 2 + 0.1, 0);
  alloc.add(allocLbl);
  ms.scene.add(alloc);
  const allocState = { k: 0 };
  const applyAlloc = () => {
    const k = allocState.k;
    alloc.visible = k > 0.01;
    alloc.scale.setScalar(0.3 + 0.7 * k);
    (dataEdges.material as LineBasicMaterial).opacity = 0.6 * k;
    (allocEdges.material as LineDashedMaterial).opacity = 0.9 * k;
    allocLbl.visible = k > 0.5 && step < 3;
  };

  // The barrier: a gate in front of the VRAM copy, closed (red) until the copy is visible.
  const gate = new Group();
  gate.position.set(VRAM_C[0], Y0, 0.56);
  const gateMat = new MeshBasicMaterial({ color: COLORS.red, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide });
  const gateEdgeMat = new LineBasicMaterial({ color: COLORS.red, transparent: true, opacity: 0.9 });
  const halves = [-1, 1].map((sgn) => {
    const hinge = new Group();
    hinge.position.x = sgn * 0.74;
    const pg = new PlaneGeometry(0.74, 1.46);
    const leaf = new Mesh(pg, gateMat);
    leaf.position.x = -sgn * 0.37;
    const edge = new LineSegments(new EdgesGeometry(pg), gateEdgeMat);
    edge.position.copy(leaf.position);
    // Horizontal bars, like a shutter.
    const barsGeo = new BufferGeometry();
    const pts: number[] = [];
    for (let k = 1; k < 8; k++) pts.push(-0.37, -0.73 + k * 0.1825, 0, 0.37, -0.73 + k * 0.1825, 0);
    barsGeo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    const bars = new LineSegments(barsGeo, gateEdgeMat);
    bars.position.copy(leaf.position);
    hinge.add(leaf, edge, bars);
    gate.add(hinge);
    return hinge;
  });
  const gateName = gl ? t(L('implicit synk · drivrutinen', 'implicit sync · driver')) : api === 'vulkan' ? 'vkCmdPipelineBarrier2' : 'ResourceBarrier';
  const gateLbl = label(gateName, 'big');
  gateLbl.position.set(0, -0.98, 0);
  gate.add(gateLbl);
  ms.scene.add(gate);
  const gateState = { open: 0 };
  const red = new Color(COLORS.red);
  const green = new Color(COLORS.green);
  const applyGate = () => {
    const k = gateState.open;
    halves.forEach((hg) => (hg.scale.x = Math.max(0.04, 1 - k)));
    gateMat.color.copy(red).lerp(green, Math.min(1, k * 2));
    gateEdgeMat.color.copy(gateMat.color);
    gateMat.opacity = 0.16 * (1 - k * 0.6);
  };

  /* ---- particle streams ---- */
  const N = Math.min(2000, Math.max(400, m.vertexCount));
  const side = Math.ceil(Math.cbrt(N));
  const lattice = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    lattice[i * 3] = STG_C[0] + ((i % side) / (side - 1 || 1) - 0.5) * 0.44;
    lattice[i * 3 + 1] = STG_C[1] + ((Math.floor(i / side) % side) / (side - 1 || 1) - 0.5) * 0.34;
    lattice[i * 3 + 2] = STG_C[2] + ((Math.floor(i / (side * side)) % side) / (side - 1 || 1) - 0.5) * 0.34;
  }
  const samples = ms.samplePositions(N);
  const inWorld = (obj: Group) => {
    obj.updateMatrixWorld(true);
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) v.fromArray(samples, i * 3).applyMatrix4(obj.matrixWorld).toArray(out, i * 3);
    return out;
  };
  // memcpy: app arrays → staging.
  const memcpy = ms.particles(N, gl ? COLORS.violet : API_COLOR[api], 0.026, 'world');
  // DMA: staging → lanes → VRAM.
  const busGeo = new BufferGeometry();
  const busTo = new Float32Array(N * 3);
  const busDelay = new Float32Array(N);
  const busLane = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    busDelay[i] = (i / N) * 0.6;
    busLane[i] = LANE_Y(i % 8);
  }
  busGeo.setAttribute('position', new BufferAttribute(lattice.slice(), 3));
  busGeo.setAttribute('aTo', new BufferAttribute(busTo, 3));
  busGeo.setAttribute('aDelay', new BufferAttribute(busDelay, 1));
  busGeo.setAttribute('aLane', new BufferAttribute(busLane, 1));
  const busMat = new ShaderMaterial({
    vertexShader: LANE_VERT,
    fragmentShader: LANE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uProgress: { value: 0 },
      uSize: { value: 0.03 },
      uX0: { value: LANE_X0 },
      uX1: { value: LANE_X1 },
      uLaneColor: { value: new Color(COLORS.amber) },
      uEndColor: { value: new Color(COLORS.cyan) },
    },
  });
  const bus = new Points(busGeo, busMat);
  bus.frustumCulled = false;
  ms.scene.add(bus);

  /* ---- panels ---- */
  const keyStats: HTMLElement[][] = [
    [stat(formatBytes(l.vertexBytes), `vertex buffer · ${l.stride} B × ${m.vertexCount.toLocaleString('en-US')}`, 'glow-cyan'), stat(formatBytes(l.indexBytes), `index buffer · ${l.indexType}`, 'glow-green')],
    [stat(`${al.exact ? '' : '≈ '}${formatBytes(al.vb + al.ib)}`, t(L('allokerat i VRAM', 'allocated in VRAM')), 'glow-magenta'), stat(`+${formatBytes(al.vb + al.ib - total)}`, 'padding'), stat(api === 'd3d12' ? '64 KiB' : api === 'vulkan' ? 'req.alignment' : t(L('dolt', 'hidden')), 'alignment')],
    [stat(formatBytes(total), 'memcpy', 'glow-cyan'), stat(gl ? t(L('i drivrutinen', 'in the driver')) : api === 'vulkan' ? 'HOST_VISIBLE' : 'UPLOAD', 'staging')],
    [stat(`≈ ${fmtTime(seconds)}`, t(L('över PCIe', 'over PCIe')), 'glow-amber'), stat(formatBytes(total), t(L('kopieras', 'copied'))), stat('≈ 25 GB/s', 'PCIe 4.0 ×16')],
    [stat(gl ? t(L('implicit', 'implicit')) : t(L('explicit', 'explicit')), t(L('barriär', 'barrier')), 'glow-green'), stat(`${al.exact ? '' : '≈ '}${formatBytes(al.vb + al.ib)}`, t(L('redo i VRAM', 'ready in VRAM')), 'glow-magenta')],
  ];
  const keyPanel = ms.panel(t(L('Nyckeltal', 'Key numbers')), [h('div.stat-row.bf-keys')], { side: 'top', className: 'bf-key' });
  const keyRow = keyPanel.querySelector('.bf-keys')!;

  const details: HTMLElement[] = [];
  let caption: Element | null = null;
  const fills: HTMLElement[] = [];
  let stagingEl: HTMLElement | null = null;
  let stateEls: HTMLElement[] = [];
  if (!concept) {
    const maxBytes = Math.max(al.vb, al.ib, l.vertexBytes, l.indexBytes);
    const pct = (n: number) => `${Math.max(1.5, (100 * n) / maxBytes)}%`;
    const bar = (lbl: string, bytes: number, cls: string, allocB?: number) =>
      h(`div.bf-buf.${cls}`, {}, [
        h('div.bf-buf-head', {}, [h('span', { text: lbl }), h('b.mono', { text: formatBytes(bytes) })]),
        h('div.bf-track', {}, [allocB && allocB > bytes ? h('i.bf-pad', { style: { width: pct(allocB) } }) : null, h('i.bf-fill', { style: { width: pct(bytes) } })]),
        allocB !== undefined && allocB > bytes ? h('div.bf-buf-sub', { text: `${t(L('allokerat', 'allocated'))} ${formatBytes(allocB)} · +${formatBytes(allocB - bytes)}${al.exact ? '' : ' (≈)'}` }) : null,
      ]);
    const stagingFlags: Record<ApiId, string> = {
      opengl: t(L('görs inuti glNamedBufferStorage', 'made inside glNamedBufferStorage')),
      vulkan: 'HOST_VISIBLE | HOST_COHERENT',
      d3d12: 'D3D12_HEAP_TYPE_UPLOAD',
    };
    stagingEl = h('div.bf-staging', {}, [h('div.bf-tag', { text: stgName }), h('div.bf-flags.mono', { text: stagingFlags[api] }), h('div.bf-buf-sub', { text: `memcpy ${formatBytes(total)}` })]);
    const ramPanel = ms.panel(t(L('System-RAM · CPU', 'System RAM · CPU')), [
      bar(`vertices · ${l.stride} B × ${m.vertexCount.toLocaleString('en-US')}`, l.vertexBytes, 'vb'),
      bar(`indices · ${l.indexType}`, l.indexBytes, 'ib'),
      h('div.bf-hex-wrap', {}, [h('div.bf-hex-k', { text: t(L('första 16 bytes', 'first 16 bytes')) }), firstBytes(l, 16)]),
      stagingEl,
    ], { side: 'bottom', className: 'bf-detail.bf-c-ram' });
    const pciePanel = ms.panel(t(gl ? L('PCIe · drivrutinens DMA', 'PCIe · driver DMA') : L('PCIe · kopiering', 'PCIe · copy')), [
      h('div.bf-speed', {}, [
        h('div.mono', { text: 'PCIe 4.0 ×16 ≈ 25 GB/s' }),
        h('div.bf-time.glow-amber', { text: `≈ ${fmtTime(seconds)}` }),
        h('div.bf-buf-sub', { text: `${formatBytes(total)} · ${t(L('teoretiskt; + några µs uppstart per kopia', 'theoretical; + a few µs setup per copy'))}` }),
      ]),
    ], { side: 'bottom', className: 'bf-detail.bf-c-pcie' });
    const states: Record<ApiId, [string, string][]> = {
      opengl: [[t(L('implicit synk', 'implicit sync')), t(L('drivrutinen väntar in kopian före första draw', 'the driver waits for the copy before the first draw'))]],
      vulkan: [
        ['TRANSFER_WRITE → VERTEX_ATTRIBUTE_READ', 'VkBufferMemoryBarrier2'],
        ['TRANSFER_WRITE → INDEX_READ', 'VkBufferMemoryBarrier2'],
      ],
      d3d12: [
        ['COPY_DEST → VERTEX_AND_CONSTANT_BUFFER', 'ResourceBarrier'],
        ['COPY_DEST → INDEX_BUFFER', 'ResourceBarrier'],
      ],
    };
    stateEls = states[api].map(([a, b]) => h('div.bf-state', {}, [h('span.mono', { text: a }), h('small', { text: b })]));
    const vb = bar('vertex buffer', l.vertexBytes, 'vb', al.vb);
    const ib = bar('index buffer', l.indexBytes, 'ib', al.ib);
    fills.push(...[vb, ib].map((x) => x.querySelector<HTMLElement>('.bf-fill')!));
    const vramPanel = ms.panel(vramName, [vb, ib, h('div.bf-rule', { text: t(al.rule) }), h('div.bf-states', {}, stateEls)], { side: 'bottom', className: 'bf-detail.bf-c-vram' });
    details.push(ramPanel, pciePanel, vramPanel);
  } else {
    const cap = ms.panel(t(L('Vad händer', 'What happens')), [h('p.bf-cap')], { side: 'bottom' });
    caption = cap.querySelector('.bf-cap');
  }
  const captions: Text[] = [
    L('Vertices och index ligger i vanligt RAM – på ett separat grafikkort når GPU:n dem bara över PCIe-bussen.', 'Vertices and indices sit in ordinary RAM – on a discrete graphics card the GPU can only reach them over the PCIe bus.'),
    gl
      ? L('glCreateBuffers + glNamedBufferStorage: drivrutinen reserverar minne åt dig, oftast i VRAM.', 'glCreateBuffers + glNamedBufferStorage: the driver reserves memory for you, usually in VRAM.')
      : L('Du reserverar själv en buffert i GPU-lokalt minne – med GPU:ns krav på storlek och alignment (streckat: det som faktiskt allokeras).', "You reserve a buffer in GPU-local memory yourself – with the GPU's size and alignment requirements (dashed: what is actually allocated)."),
    gl
      ? L('Drivrutinen kopierar dina bytes till en egen staging-yta innan anropet returnerar.', 'The driver copies your bytes into its own staging area before the call returns.')
      : L('Map + memcpy: bytesen skrivs till en CPU-synlig staging-buffert. Originalet finns kvar.', 'Map + memcpy: the bytes are written into a CPU-visible staging buffer. The original stays.'),
    gl
      ? L('I bakgrunden flyttar en DMA-motor datan över PCIe till VRAM, där modellen byggs upp igen.', 'In the background a DMA engine moves the data across PCIe into VRAM, where the model is rebuilt.')
      : L('Ett kopieringskommando (DMA) flyttar datan över PCIe in i VRAM, där modellen byggs upp igen.', 'A copy command (DMA) moves the data across PCIe into VRAM, where the model is rebuilt.'),
    gl
      ? L('Drivrutinen ser till att kopian är klar innan första draw-anropet läser bufferten – grinden öppnas av sig själv.', 'The driver makes sure the copy has finished before the first draw reads the buffer – the gate opens by itself.')
      : L('En barriär öppnar grinden: kopian är klar och synlig för vertex-steget. Sedan kan staging-bufferten släppas.', 'A barrier opens the gate: the copy is finished and visible to the vertex stage. Then the staging buffer can be freed.'),
  ];
  const CUR_DETAIL = [0, 2, 0, 1, 2];

  /* ---- animation ---- */
  let step = -1;
  const timers: gsap.core.Tween[] = [];
  const later = (animate: boolean, s: number, fn: () => void) => {
    if (!animate) fn();
    else timers.push(gsap.delayedCall(dur(s), fn));
  };
  const vOpacity = (o: number, s: number) => {
    vSolid.visible = true;
    if (s <= 0) vMat.uniforms.uOpacity.value = o;
    else ms.tween(vMat.uniforms.uOpacity, { value: o, duration: dur(s) });
  };
  ms.onFrame((time) => {
    if (concept) {
      ms.pivot.rotation.y = SHOWCASE_ROT_Y + Math.sin(time * 0.4) * 0.35;
      vModel.rotation.y = ms.pivot.rotation.y;
    }
    laneMat.opacity = step === 3 ? 0.45 + 0.25 * Math.sin(time * 6) : 0.16;
    vSolid.visible = vMat.uniforms.uOpacity.value > 0.01;
  });
  const prog = (memcpy.points.material as ShaderMaterial).uniforms.uProgress;

  return {
    show(stp, animate) {
      step = stp;
      const S = (s: number) => secs(animate, s);
      timers.splice(0).forEach((x) => x.kill());
      gsap.killTweensOf([...Object.values(u), ...Object.values(ms.layers).map((x) => x.material), vMat.uniforms.uOpacity, vMat.uniforms.uMode, vMat.uniforms.uModeMix, vWireMat, prog, busMat.uniforms.uProgress, allocState, gateState, ...details]);
      u.uSweep.value = 100;
      vMat.uniforms.uSweep.value = 100;

      // Panels
      keyRow.replaceChildren(...keyStats[step]);
      if (caption) caption.innerHTML = t(captions[step]);
      details.forEach((el, i) => {
        el.classList.toggle('collapsed', i !== CUR_DETAIL[step]);
        el.classList.toggle('cur', i === CUR_DETAIL[step]);
      });
      if (stagingEl) stagingEl.classList.toggle('off', step < 2);
      fills.forEach((f) => (f.style.transform = `scaleX(${step >= 3 ? 1 : 0})`));
      stateEls.forEach((e) => e.classList.toggle('off', step < 4));
      if (animate) gsap.fromTo(keyPanel, { opacity: 0.3 }, { opacity: 1, duration: dur(0.4) });

      // Box highlights
      edgeMat(ramBox).opacity = step === 0 || step === 2 ? 1 : 0.45;
      edgeMat(vramBox).opacity = step === 1 || step >= 3 ? 1 : 0.4;
      stgBox.visible = step >= 2;
      edgeMat(stgBox).opacity = step === 4 ? 0.25 : 1;
      lanes.visible = true;
      laneLbl.visible = step >= 3;

      // The app's copy in RAM stays (memcpy copies); it dims once the GPU has its own.
      ms.setLayer('solid', step >= 3 ? 0.55 : 1, S(0.5));
      ms.setLayer('wire', step === 2 ? 0.3 : 0.12, S(0.5));
      if (step >= 3) ms.setMode('ghost', 0.6, S(0.5));
      else ms.setMode('shaded', 0, S(0.5));

      // Allocation (step ≥ 1)
      if (animate && step === 1) {
        allocState.k = 0;
        ms.tween(allocState, { k: 1, duration: dur(0.9), ease: 'back.out(1.6)', onUpdate: applyAlloc });
      } else allocState.k = step >= 1 ? 1 : 0;
      applyAlloc();

      // Gate: closed during the copy, open after the barrier.
      gate.visible = step >= 3;
      if (animate && step === 4) {
        gateState.open = 0;
        ms.tween(gateState, { open: 1, duration: dur(1.2), delay: dur(0.3), ease: 'power2.inOut', onUpdate: applyGate });
      } else gateState.open = step >= 4 ? 1 : 0;
      applyGate();

      // Streams
      memcpy.points.visible = step === 2;
      bus.visible = step === 3;
      memcpy.setTargets(inWorld(ms.pivot), lattice);
      busGeo.attributes.aTo.array.set(inWorld(vModel));
      busGeo.attributes.aTo.needsUpdate = true;
      vWireMat.opacity = 0;
      if (step < 3) vOpacity(0, 0);
      if (step === 2) {
        memcpy.progress(0, 0);
        memcpy.progress(1, S(2.2));
      } else if (step === 3) {
        busMat.uniforms.uProgress.value = 0;
        vMat.uniforms.uMode.value = VIEW_MODE.ghost;
        vMat.uniforms.uModeMix.value = 1;
        vOpacity(0, 0);
        if (animate) ms.tween(busMat.uniforms.uProgress, { value: 1, duration: dur(3.2), ease: 'none' });
        else busMat.uniforms.uProgress.value = 1;
        later(animate, 2.6, () => {
          vOpacity(1, S(0.8));
          ms.tween(vWireMat, { opacity: 0.35, duration: dur(0.8) });
        });
        later(animate, 3.7, () => (bus.visible = false));
      } else if (step === 4) {
        // Visible to the vertex stage: the VRAM copy lights up.
        vMat.uniforms.uMode.value = VIEW_MODE.ghost;
        vMat.uniforms.uModeMix.value = 1;
        vOpacity(1, 0);
        vWireMat.opacity = 0.2;
        later(animate, 1.0, () => {
          if (animate) ms.tween(vMat.uniforms.uModeMix, { value: 0, duration: dur(0.9) });
          else vMat.uniforms.uModeMix.value = 0;
          if (animate) ms.tween(vWireMat, { opacity: 0.05, duration: dur(0.9) });
          else vWireMat.opacity = 0.05;
        });
      }
    },
    destroy() {
      timers.forEach((x) => x.kill());
      gsap.killTweensOf(keyPanel);
      vMat.dispose();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
type Line = [string, ...number[]];
function snippet(lang: CodeSnippet['lang'], lines: Line[], steps: number, title?: Text): CodeSnippet {
  const highlight = Array.from({ length: steps }, (_, st) => lines.flatMap(([, ...on], i) => (on.includes(st) ? [i + 1] : [])));
  return { lang, title, src: lines.map((x) => x[0]).join('\n'), highlight };
}

function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const l = ctx.derived.layout;
  const vb = l.vertexBytes;
  const ib = l.indexBytes;
  const S = 5;
  return {
    opengl: {
      note: L(
        'I OpenGL är uppladdning ett enda anrop. glNamedBufferStorage kopierar dina bytes innan den returnerar; drivrutinen väljer minnestyp, sköter staging, DMA-kopian och synkroniseringen åt dig.',
        'In OpenGL an upload is a single call. glNamedBufferStorage copies your bytes before it returns; the driver picks the memory type and handles staging, the DMA copy and synchronization for you.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices (${vb} B) and indices (${ib} B) live in system RAM`, 0],
          ['GLuint vbo, ibo;'],
          ['glCreateBuffers(1, &vbo);', 1],
          [`glNamedBufferStorage(vbo, ${vb}, vertices.data(), 0); // flags 0: immutable, GPU-only`, 1, 2, 3],
          ['glCreateBuffers(1, &ibo);', 1],
          [`glNamedBufferStorage(ibo, ${ib}, indices.data(), 0);`, 1, 2, 3],
          ['// returns once your bytes are copied – vertices may be freed now', 2],
          ['// the driver places the buffer (usually VRAM) and DMAs it over PCIe', 3],
          ['// the first draw that reads vbo waits for that copy (implicit sync)', 4],
          [`glVertexArrayVertexBuffer(vao, 0, vbo, 0, ${l.stride});  // next slide`, 4],
          ['// GL 3.x style: glGenBuffers + glBindBuffer + glBufferData(…, GL_STATIC_DRAW)'],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'glNamedBufferStorage', desc: L('Immutable storage (GL 4.4/4.5 DSA): storleken kan inte ändras – drivrutinen kan placera den optimalt.', 'Immutable storage (GL 4.4/4.5 DSA): the size can never change – the driver can place it optimally.') },
        { term: 'flags = 0', desc: L('Ingen GL_MAP_*/GL_DYNAMIC_STORAGE_BIT → CPU:n skriver aldrig igen → VRAM.', 'No GL_MAP_*/GL_DYNAMIC_STORAGE_BIT → the CPU never writes again → VRAM.') },
        { term: 'DMA', desc: L('Kopieringsmotor på GPU:n som flyttar data över PCIe utan CPU:n.', 'Copy engine on the GPU that moves data across PCIe without the CPU.') },
      ],
      you: L('ett anrop per buffert', 'one call per buffer'),
      driver: L('minnestyp, staging, kopia, synk', 'memory type, staging, copy, sync'),
    },
    vulkan: {
      note: L(
        'I Vulkan gör du allt själv: skapa bufferten, fråga efter minneskrav, välj minnestyp, allokera och bind. Data går via en HOST_VISIBLE staging-buffert, vkCmdCopyBuffer flyttar den till DEVICE_LOCAL, och en barriär gör den synlig för vertex input.',
        'In Vulkan you do everything: create the buffer, query memory requirements, choose a memory type, allocate and bind. Data goes through a HOST_VISIBLE staging buffer, vkCmdCopyBuffer moves it to DEVICE_LOCAL, and a barrier makes it visible to vertex input.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices: std::vector<Vertex> in system RAM, ${vb} B`, 0],
          ['VkBufferCreateInfo bi{ VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };', 1],
          [`bi.size  = ${vb};`, 1],
          ['bi.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;', 1],
          ['vkCreateBuffer(dev, &bi, nullptr, &vertexBuffer);', 1],
          ['VkMemoryRequirements req;   // size, alignment, memoryTypeBits', 1],
          ['vkGetBufferMemoryRequirements(dev, vertexBuffer, &req);', 1],
          ['VkMemoryAllocateInfo ai{ VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };', 1],
          ['ai.allocationSize  = req.size;', 1],
          ['ai.memoryTypeIndex = findMemoryType(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);', 1],
          ['vkAllocateMemory(dev, &ai, nullptr, &vertexMemory);   // real apps: VMA', 1],
          ['vkBindBufferMemory(dev, vertexBuffer, vertexMemory, 0);', 1],
          ['// staging buffer: TRANSFER_SRC, HOST_VISIBLE | HOST_COHERENT (same steps)', 2],
          [`void* p;  vkMapMemory(dev, stagingMemory, 0, ${vb}, 0, &p);`, 2],
          [`memcpy(p, vertices.data(), ${vb});  vkUnmapMemory(dev, stagingMemory);`, 2],
          [`VkBufferCopy region{ 0, 0, ${vb} };   // srcOffset, dstOffset, size`, 3],
          ['vkCmdCopyBuffer(cmd, stagingBuffer, vertexBuffer, 1, &region);', 3],
          ['VkBufferMemoryBarrier2 b{ VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER_2 };', 4],
          ['b.srcStageMask = VK_PIPELINE_STAGE_2_COPY_BIT;  b.srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;', 4],
          ['b.dstStageMask = VK_PIPELINE_STAGE_2_VERTEX_ATTRIBUTE_INPUT_BIT;  b.dstAccessMask = VK_ACCESS_2_VERTEX_ATTRIBUTE_READ_BIT;', 4],
          ['b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;', 4],
          ['b.buffer = vertexBuffer;  b.size = VK_WHOLE_SIZE;', 4],
          ['VkDependencyInfo dep{ VK_STRUCTURE_TYPE_DEPENDENCY_INFO, nullptr, 0, 0, nullptr, 1, &b };', 4],
          ['vkCmdPipelineBarrier2(cmd, &dep);   // then vkQueueSubmit2, wait, free staging', 4],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'memory type', desc: L('Kombination av flaggor (DEVICE_LOCAL, HOST_VISIBLE, HOST_COHERENT …) i en minnes-heap.', 'A combination of flags (DEVICE_LOCAL, HOST_VISIBLE, HOST_COHERENT …) within a memory heap.') },
        { term: 'VMA', desc: L('Vulkan Memory Allocator: suballokerar ur stora block – maxMemoryAllocationCount är ofta bara 4096.', 'Vulkan Memory Allocator: sub-allocates from big blocks – maxMemoryAllocationCount is often only 4096.') },
        { term: 'staging buffer', desc: L('CPU-skrivbar mellanbuffert i system-RAM som GPU:n kopierar från.', 'CPU-writable intermediate buffer in system RAM that the GPU copies from.') },
        { term: 'ReBAR', desc: L('Med Resizable BAR finns DEVICE_LOCAL | HOST_VISIBLE – då kan CPU:n skriva direkt i VRAM.', 'With Resizable BAR there is DEVICE_LOCAL | HOST_VISIBLE – the CPU can then write straight into VRAM.') },
      ],
      you: L('allokering, staging, kopia, barriär', 'allocation, staging, copy, barrier'),
      driver: L('nästan inget – det är poängen', 'almost nothing – that is the point'),
    },
    d3d12: {
      note: L(
        'I D3D12 skapar du två resurser: en i DEFAULT-heapen (VRAM) och en i UPLOAD-heapen (CPU-skrivbar). Map + memcpy, CopyBufferRegion på en command list, och en ResourceBarrier från COPY_DEST till VERTEX_AND_CONSTANT_BUFFER.',
        'In D3D12 you create two resources: one in the DEFAULT heap (VRAM) and one in the UPLOAD heap (CPU-writable). Map + memcpy, CopyBufferRegion on a command list, and a ResourceBarrier from COPY_DEST to VERTEX_AND_CONSTANT_BUFFER.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices: std::vector<Vertex> in system RAM, ${vb} B`, 0],
          [`auto desc = CD3DX12_RESOURCE_DESC::Buffer(${vb});`, 1],
          ['CD3DX12_HEAP_PROPERTIES vram(D3D12_HEAP_TYPE_DEFAULT), upload(D3D12_HEAP_TYPE_UPLOAD);', 1, 2],
          ['device->CreateCommittedResource(&vram, D3D12_HEAP_FLAG_NONE, &desc,', 1],
          [`    D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&vertexBuffer)); // ${formatBytes(alignUp(vb, 65536))} heap`, 1],
          ['device->CreateCommittedResource(&upload, D3D12_HEAP_FLAG_NONE, &desc,', 2],
          ['    D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&staging));', 2],
          ['void* p;  CD3DX12_RANGE noRead(0, 0);   // the CPU will not read', 2],
          ['staging->Map(0, &noRead, &p);', 2],
          [`memcpy(p, vertices.data(), ${vb});`, 2],
          ['staging->Unmap(0, nullptr);', 2],
          [`cmdList->CopyBufferRegion(vertexBuffer.Get(), 0, staging.Get(), 0, ${vb});`, 3],
          ['auto toVB = CD3DX12_RESOURCE_BARRIER::Transition(vertexBuffer.Get(),', 4],
          ['    D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER);', 4],
          ['cmdList->ResourceBarrier(1, &toVB);  // index buffer → D3D12_RESOURCE_STATE_INDEX_BUFFER', 4],
          ['cmdList->Close();', 3],
          ['queue->ExecuteCommandLists(1, CommandListCast(cmdList.GetAddressOf()));', 3],
          ['// Signal a fence and wait before releasing `staging`', 4],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'D3D12_HEAP_TYPE_UPLOAD', desc: L('CPU-skrivbart (write-combined) system-RAM som GPU:n läser över PCIe.', 'CPU-writable (write-combined) system RAM that the GPU reads over PCIe.') },
        { term: 'D3D12_HEAP_TYPE_DEFAULT', desc: L('GPU-lokalt minne (VRAM); CPU:n kan inte mappa det.', 'GPU-local memory (VRAM); the CPU cannot map it.') },
        { term: '64 KiB', desc: L('Buffertar placeras alltid med 64 KiB alignment – många små committed resources slösar minne.', 'Buffers are always placed with 64 KiB alignment – many small committed resources waste memory.') },
        { term: 'COMMON → COPY_DEST', desc: L('Buffertar skapas i COMMON och befordras implicit till COPY_DEST vid kopian.', 'Buffers are created in COMMON and implicitly promoted to COPY_DEST by the copy.') },
        { term: 'enhanced barriers', desc: L('Agility SDK: ID3D12GraphicsCommandList7::Barrier med ACCESS_COPY_DEST → ACCESS_VERTEX_BUFFER.', 'Agility SDK: ID3D12GraphicsCommandList7::Barrier with ACCESS_COPY_DEST → ACCESS_VERTEX_BUFFER.') },
      ],
      you: L('heaps, kopia, barriär, fence', 'heaps, copy, barrier, fence'),
      driver: L('sidtabeller och residency', 'page tables and residency'),
    },
  };
}

export default standardSlide({
  id: 'buffers',
  group: 'api',
  short: L('Buffertar', 'Buffers'),
  title: L('Buffertar & uppladdning', 'Buffers & upload'),
  lead: L(
    'Vertices och index måste flyttas från system-RAM till grafikkortets eget minne. Här skiljer sig API:erna som mest: OpenGL gör det åt dig, Vulkan och D3D12 låter dig styra varje byte.',
    'Vertices and indices have to move from system RAM into the graphics card\'s own memory. This is where the APIs differ the most: OpenGL does it for you, Vulkan and D3D12 let you control every byte.',
  ),
  bullets: [
    L('Datan ligger i <b>system-RAM</b> som vanliga C++-arrayer. Ett separat grafikkort når den bara via PCIe-bussen.', 'The data sits in <b>system RAM</b> as ordinary C++ arrays. A discrete graphics card can only reach it over the PCIe bus.'),
    L('<b>Skapa bufferten</b> i GPU-minne. Minnet har krav på <i>alignment</i> – D3D12 avrundar committed buffers till 64 KiB, Vulkan rapporterar sina krav i <code>VkMemoryRequirements</code>.', '<b>Create the buffer</b> in GPU memory. Memory has <i>alignment</i> requirements – D3D12 rounds committed buffers up to 64 KiB, Vulkan reports its needs in <code>VkMemoryRequirements</code>.'),
    L('<b>Staging</b>: bytesen skrivs med <code>memcpy</code> till ett CPU-synligt minne (UPLOAD-heap / HOST_VISIBLE). I OpenGL gör drivrutinen den kopian.', '<b>Staging</b>: the bytes are written with <code>memcpy</code> into CPU-visible memory (UPLOAD heap / HOST_VISIBLE). In OpenGL the driver makes that copy.'),
    L('<b>Kopiering</b> över PCIe till VRAM med en DMA-motor: <code>vkCmdCopyBuffer</code> / <code>CopyBufferRegion</code>.', '<b>Copy</b> across PCIe into VRAM with a DMA engine: <code>vkCmdCopyBuffer</code> / <code>CopyBufferRegion</code>.'),
    L('<b>Barriär</b>: kopian måste vara klar och synlig innan vertex-steget läser. Explicit i Vulkan/D3D12, implicit i OpenGL.', '<b>Barrier</b>: the copy must be finished and visible before the vertex stage reads. Explicit in Vulkan/D3D12, implicit in OpenGL.'),
  ],
  api: apis,
  data: (host, ctx) => uploadVisual(host, ctx, false),
  concept: (host, ctx) => uploadVisual(host, ctx, true),
});
