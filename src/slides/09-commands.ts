import gsap from 'gsap';
import { AdditiveBlending, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h, reducedMotion } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { createModelStage, glowTexture } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import '../styles/slides/commands.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/** Same viewport and frame count as the pipeline-state and descriptors slides. */
const VW = 1920;
const VH = 1080;
const FIF = 2; // frames in flight
const CLEAR = '0.03, 0.04, 0.08, 1.0'; // the clear color the software renderer uses

const API_HEX: Record<ApiId, string> = { opengl: '#5aa9e6', vulkan: '#ff4d64', d3d12: '#6cd04a' };
const C = { cyan: '#38e1ff', magenta: '#ff3fd2', amber: '#ffb547', violet: '#9b7bff', green: '#5cf08f', muted: '#9aa3c7', dim: '#646d94', text: '#e8ebff' };

type Kind = 'sync' | 'rec' | 'barrier' | 'pass' | 'state' | 'bind' | 'draw' | 'submit';
interface Cmd {
  call: string;
  args: string;
  kind: Kind;
  note?: string;
}

/** The real command stream for one frame of this mesh. */
function commandStream(ctx: SlideContext, api: ApiId): Cmd[] {
  const lay = ctx.derived.layout;
  const idx = ctx.state.mesh.indices.length;
  const u16 = lay.indexType === 'uint16';
  const vb = `${lay.vertexBytes.toLocaleString('en-US')} B`;
  const ib = `${lay.indexBytes.toLocaleString('en-US')} B`;
  if (api === 'opengl') {
    return [
      { call: 'glBindFramebuffer', args: 'GL_DRAW_FRAMEBUFFER, 0', kind: 'pass' },
      { call: 'glViewport', args: `0, 0, ${VW}, ${VH}`, kind: 'state' },
      { call: 'glClearColor', args: CLEAR, kind: 'state' },
      { call: 'glClear', args: 'GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT', kind: 'pass' },
      { call: 'glUseProgram', args: 'prog', kind: 'bind' },
      { call: 'glBindVertexArray', args: 'vao', kind: 'bind', note: `VB ${vb} · IB ${ib}` },
      { call: 'glBindBufferBase', args: 'GL_UNIFORM_BUFFER, 0, ubo', kind: 'bind', note: '256 B' },
      { call: 'glDrawElements', args: `GL_TRIANGLES, ${idx}, ${u16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT'}, nullptr`, kind: 'draw' },
      { call: 'SwapBuffers', args: 'hdc', kind: 'submit', note: 'implicit flush + present' },
    ];
  }
  if (api === 'vulkan') {
    return [
      { call: 'vkWaitForFences', args: 'device, 1, &inFlight[f], VK_TRUE, UINT64_MAX', kind: 'sync' },
      { call: 'vkAcquireNextImageKHR', args: 'device, swapchain, UINT64_MAX, imageAvailable[f], VK_NULL_HANDLE, &img', kind: 'sync' },
      { call: 'vkResetFences', args: 'device, 1, &inFlight[f]', kind: 'sync' },
      { call: 'vkResetCommandPool', args: 'device, pool[f], 0', kind: 'rec' },
      { call: 'vkBeginCommandBuffer', args: 'cmd, ONE_TIME_SUBMIT', kind: 'rec' },
      { call: 'vkCmdPipelineBarrier2', args: 'UNDEFINED → COLOR_ATTACHMENT_OPTIMAL', kind: 'barrier' },
      { call: 'vkCmdBeginRendering', args: `${VW}×${VH}, clear (${CLEAR}), depth 1.0`, kind: 'pass' },
      { call: 'vkCmdBindPipeline', args: 'cmd, GRAPHICS, pipeline', kind: 'bind' },
      { call: 'vkCmdSetViewport', args: `cmd, 0, 1, {0, 0, ${VW}, ${VH}, 0, 1}`, kind: 'state' },
      { call: 'vkCmdSetScissor', args: `cmd, 0, 1, {{0, 0}, {${VW}, ${VH}}}`, kind: 'state' },
      { call: 'vkCmdBindVertexBuffers', args: 'cmd, 0, 1, &vb, &offset0', kind: 'bind', note: vb },
      { call: 'vkCmdBindIndexBuffer', args: `cmd, ib, 0, ${u16 ? 'VK_INDEX_TYPE_UINT16' : 'VK_INDEX_TYPE_UINT32'}`, kind: 'bind', note: ib },
      { call: 'vkCmdBindDescriptorSets', args: 'cmd, GRAPHICS, layout, 0, 1, &set[f], 0, nullptr', kind: 'bind' },
      { call: 'vkCmdDrawIndexed', args: `cmd, ${idx}, 1, 0, 0, 0`, kind: 'draw' },
      { call: 'vkCmdEndRendering', args: 'cmd', kind: 'pass' },
      { call: 'vkCmdPipelineBarrier2', args: 'COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR', kind: 'barrier' },
      { call: 'vkEndCommandBuffer', args: 'cmd', kind: 'rec' },
      { call: 'vkQueueSubmit2', args: 'queue, 1, &submit, inFlight[f]', kind: 'submit', note: 'wait imageAvailable · signal renderFinished' },
      { call: 'vkQueuePresentKHR', args: 'queue, &present', kind: 'submit', note: 'wait renderFinished' },
    ];
  }
  return [
    { call: 'fence->SetEventOnCompletion', args: 'frameFence[f], ev', kind: 'sync', note: 'if GetCompletedValue() < frameFence[f]: WaitForSingleObject' },
    { call: 'allocator[f]->Reset', args: '', kind: 'rec' },
    { call: 'cmdList->Reset', args: 'allocator[f].Get(), nullptr', kind: 'rec' },
    { call: 'SetGraphicsRootSignature', args: 'rootSig.Get()', kind: 'bind' },
    { call: 'SetPipelineState', args: 'pso.Get()', kind: 'bind' },
    { call: 'SetGraphicsRootConstantBufferView', args: '0, cbVA + f × 256', kind: 'bind' },
    { call: 'RSSetViewports', args: `1, {0, 0, ${VW}, ${VH}, 0, 1}`, kind: 'state' },
    { call: 'RSSetScissorRects', args: `1, {0, 0, ${VW}, ${VH}}`, kind: 'state' },
    { call: 'ResourceBarrier', args: 'PRESENT → RENDER_TARGET', kind: 'barrier' },
    { call: 'OMSetRenderTargets', args: '1, &rtv, FALSE, &dsv', kind: 'pass' },
    { call: 'ClearRenderTargetView', args: `rtv, {${CLEAR}}, 0, nullptr`, kind: 'pass' },
    { call: 'ClearDepthStencilView', args: 'dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr', kind: 'pass' },
    { call: 'IASetPrimitiveTopology', args: 'D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST', kind: 'state' },
    { call: 'IASetVertexBuffers', args: `0, 1, &vbv`, kind: 'bind', note: `${vb}, stride ${lay.stride}` },
    { call: 'IASetIndexBuffer', args: '&ibv', kind: 'bind', note: `${ib}, ${u16 ? 'R16_UINT' : 'R32_UINT'}` },
    { call: 'DrawIndexedInstanced', args: `${idx}, 1, 0, 0, 0`, kind: 'draw' },
    { call: 'ResourceBarrier', args: 'RENDER_TARGET → PRESENT', kind: 'barrier' },
    { call: 'cmdList->Close', args: '', kind: 'rec' },
    { call: 'queue->ExecuteCommandLists', args: '1, lists', kind: 'submit' },
    { call: 'swapChain->Present', args: '1, 0', kind: 'submit' },
    { call: 'queue->Signal', args: 'fence, ++fenceValue  → frameFence[f]', kind: 'sync' },
  ];
}

/* ------------------------------------------------------------------ */
/* CPU/GPU timeline (shared by data and concept views)                  */
/* ------------------------------------------------------------------ */
interface Frame {
  ws: number; // CPU free (previous frame recorded)
  cs: number; // CPU starts recording (after waiting for the fence)
  ce: number; // CPU submits
  gs: number; // GPU starts
  ge: number; // GPU done → fence signalled
}

function schedule(n: number, cpu: number, gpu: number, fif: number): Frame[] {
  const out: Frame[] = [];
  for (let k = 0; k < n; k++) {
    const ws = k ? out[k - 1].ce : 0;
    const fence = k >= fif ? out[k - fif].ge : 0;
    const cs = Math.max(ws, fence);
    const ce = cs + cpu * (1 + 0.12 * Math.sin(k * 1.7));
    const gs = Math.max(ce + 0.06, k ? out[k - 1].ge : 0);
    const ge = gs + gpu * (1 + 0.08 * Math.sin(k * 2.3 + 1));
    out.push({ ws, cs, ce, gs, ge });
  }
  return out;
}
const SCHED = schedule(600, 1.0, 1.3, FIF);

/** Draw `text` (or the shorter `alt`) only if it fits in `maxW`. */
function fitText(g: CanvasRenderingContext2D, text: string, alt: string, x: number, y: number, maxW: number) {
  if (g.measureText(text).width <= maxW - 8) g.fillText(text, x, y);
  else if (g.measureText(alt).width <= maxW - 8) g.fillText(alt, x, y);
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, Math.max(0, w), h, Math.min(r, Math.max(0, w) / 2));
}

interface TimelineOpts {
  api: ApiId;
  cpuLabel: (k: number) => string;
  gpuLabel: (k: number) => string;
  lanes: [string, string, string];
  waitLabel: string;
  fenceLabel: string;
}

/** Draw the live CPU / queue / GPU timeline ending at time `now`. */
function drawTimeline(g: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number, now: number, o: TimelineOpts) {
  const apiC = API_HEX[o.api];
  const labelW = 54;
  const px = (W - labelW - 8) / (W < 560 ? 3.4 : 5.4);
  const nowX = x0 + W - 26;
  const X = (t: number) => nowX - (now - t) * px;
  const laneH = Math.max(18, Math.min(54, (H - 40) / 2.7));
  const yCpu = y0 + 10;
  const yQ = yCpu + laneH + 10;
  const qH = laneH * 0.5;
  const yGpu = yQ + qH + 10;
  g.save();
  g.font = '600 10.5px Inter, system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.fillStyle = C.muted;
  g.fillText(o.lanes[0], x0, yCpu + laneH / 2);
  g.fillText(o.lanes[1], x0, yQ + qH / 2);
  g.fillText(o.lanes[2], x0, yGpu + laneH / 2);
  g.beginPath();
  g.rect(x0 + labelW, y0, W - labelW, H);
  g.clip();
  // lane backgrounds
  g.fillStyle = 'rgba(255,255,255,0.03)';
  [yCpu, yGpu].forEach((y) => g.fillRect(x0 + labelW, y, W - labelW, laneH));
  g.fillRect(x0 + labelW, yQ, W - labelW, qH);
  const tMin = now - (W - labelW) / px - 1;
  g.font = '600 10px JetBrains Mono, ui-monospace, monospace';
  for (let k = 0; k < SCHED.length; k++) {
    const f = SCHED[k];
    if (f.ws > now) break;
    if (f.ge < tMin) continue;
    const slotC = k % 2 ? C.violet : C.cyan;
    // CPU wait (blocked on the fence of frame k − FIF)
    if (f.cs - f.ws > 0.02 && f.ws < now) {
      const xa = X(f.ws);
      const xb = X(Math.min(f.cs, now));
      g.fillStyle = 'rgba(255,181,71,0.14)';
      g.strokeStyle = 'rgba(255,181,71,0.55)';
      rrect(g, xa, yCpu + 4, xb - xa, laneH - 8, 4);
      g.fill();
      g.stroke();
      g.fillStyle = C.amber;
      fitText(g, o.waitLabel, '…', xa + 5, yCpu + laneH / 2, xb - xa);
    }
    // CPU recording
    if (f.cs < now) {
      const xa = X(f.cs);
      const xb = X(Math.min(f.ce, now));
      g.shadowColor = slotC;
      g.shadowBlur = 12;
      g.fillStyle = `${slotC}33`;
      g.strokeStyle = slotC;
      rrect(g, xa, yCpu, xb - xa, laneH, 6);
      g.fill();
      g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = C.text;
      fitText(g, o.cpuLabel(k), `F${k}`, xa + 6, yCpu + laneH / 2, xb - xa);
    }
    // queued + submit arrow
    if (f.ce < now) {
      const xa = X(f.ce);
      const xb = X(Math.min(f.gs, now));
      g.fillStyle = 'rgba(155,123,255,0.25)';
      rrect(g, xa, yQ + 2, xb - xa, qH - 4, 3);
      g.fill();
      g.strokeStyle = 'rgba(232,235,255,0.55)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(xa, yCpu + laneH);
      g.lineTo(xa, yQ + qH / 2);
      g.stroke();
      g.setLineDash([]);
    }
    // GPU execution
    if (f.gs < now) {
      const xa = X(f.gs);
      const xb = X(Math.min(f.ge, now));
      g.shadowColor = apiC;
      g.shadowBlur = 16;
      g.fillStyle = `${apiC}38`;
      g.strokeStyle = apiC;
      rrect(g, xa, yGpu, xb - xa, laneH, 6);
      g.fill();
      g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = slotC;
      g.fillRect(xa + 1, yGpu + laneH - 4, Math.max(0, xb - xa - 2), 3);
      g.fillStyle = C.text;
      fitText(g, o.gpuLabel(k), `F${k}`, xa + 6, yGpu + laneH / 2 - 1, xb - xa);
    }
    // fence signal → wakes the CPU that waits for it
    if (f.ge < now) {
      const xf = X(f.ge);
      g.fillStyle = C.amber;
      g.shadowColor = C.amber;
      g.shadowBlur = 10;
      g.beginPath();
      g.moveTo(xf, yGpu - 6);
      g.lineTo(xf + 5, yGpu - 1);
      g.lineTo(xf, yGpu + 4);
      g.lineTo(xf - 5, yGpu - 1);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      const waiter = SCHED[k + FIF];
      if (waiter && waiter.cs - waiter.ws > 0.02 && Math.abs(waiter.cs - f.ge) < 1e-6) {
        g.strokeStyle = 'rgba(255,181,71,0.8)';
        g.beginPath();
        g.moveTo(xf, yGpu - 6);
        g.lineTo(xf, yCpu + laneH);
        g.stroke();
        g.beginPath();
        g.moveTo(xf - 4, yCpu + laneH + 6);
        g.lineTo(xf, yCpu + laneH);
        g.lineTo(xf + 4, yCpu + laneH + 6);
        g.stroke();
      }
    }
  }
  g.restore();
  // "now" line
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.setLineDash([2, 4]);
  g.beginPath();
  g.moveTo(nowX, y0);
  g.lineTo(nowX, yGpu + laneH + 6);
  g.stroke();
  g.setLineDash([]);
  g.font = '600 10px Inter, system-ui, sans-serif';
  g.fillStyle = C.dim;
  g.fillText(o.fenceLabel, x0 + labelW, yGpu + laneH + 16);
}

/** A canvas that redraws every frame (or once with reduced motion) and keeps itself sized. */
function liveCanvas(host: HTMLElement, draw: (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void) {
  const canvas = h('canvas.cmd-canvas');
  host.append(canvas);
  const g = canvas.getContext('2d');
  let w = 0;
  let hh = 0;
  let raf = 0;
  let running = false;
  const t0 = performance.now();
  const motion = !reducedMotion();
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = host.clientWidth;
    hh = host.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hh * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hh}px`;
    g?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const paint = (t: number) => {
    if (!g || !w || !hh) return;
    g.clearRect(0, 0, w, hh);
    draw(g, w, hh, t);
  };
  const tick = () => {
    paint((performance.now() - t0) / 1000);
    if (running) raf = requestAnimationFrame(tick);
  };
  const ro = new ResizeObserver(() => {
    size();
    if (!running) paint(motion ? (performance.now() - t0) / 1000 : 9.3);
  });
  ro.observe(host);
  size();
  return {
    start() {
      if (!motion) {
        paint(9.3);
        return;
      }
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    redraw() {
      paint(motion ? (performance.now() - t0) / 1000 : 9.3);
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}

/* ------------------------------------------------------------------ */
/* The 3D scene: commands recorded, submitted and executed on the model */
/* ------------------------------------------------------------------ */
const KIND_HEX: Record<Kind, number> = { sync: 0xffb547, rec: 0x38e1ff, barrier: 0xff8a5c, pass: 0x9b7bff, state: 0x8fb4ff, bind: 0x5cf08f, draw: 0xff3fd2, submit: 0xffffff };
const API_NUM: Record<ApiId, number> = { opengl: 0x5aa9e6, vulkan: 0xff4d64, d3d12: 0x6cd04a };
/** Commands that end up inside the command buffer (CPU waits and queue operations don't). */
const RECORDED: Kind[] = ['rec', 'barrier', 'pass', 'state', 'bind', 'draw'];

interface CmdHooks {
  /** Command i is being executed (step 0) or recorded (steps 1–2); −1 = none. */
  row?: (i: number) => void;
  /** Called every frame with the number of triangles drawn so far. */
  drawn?: (n: number) => void;
  /** Step 3: frame k was just presented. */
  presented?: (k: number) => void;
}

function cmdScene(host: HTMLElement, ctx: SlideContext, concept: boolean, cmds: Cmd[], hooks: CmdHooks) {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const N = mesh.triangleCount;
  const motion = !reducedMotion();
  const ms = createModelStage(host, ctx, { shift: concept ? 0 : -0.15, autoRotate: 0, bloom: 0.55, bloomThreshold: 0.85 });
  ms.overlay.classList.add('cmd-ms');

  // CPU → command buffer → queue, in a row under the model (the model itself is the GPU's output).
  const y = -1.18;
  const z = 0.35;
  const gl = api === 'opengl';
  const bufName = (hidden: boolean) =>
    hidden ? t(L('drivrutinens buffert (dold)', 'driver buffer (hidden)')) : concept ? t(L('kommandobuffert', 'command buffer')) : api === 'vulkan' ? 'VkCommandBuffer' : api === 'd3d12' ? 'ID3D12GraphicsCommandList' : 'VkCommandBuffer / CommandList';
  const cpu = ms.box('CPU', [-1.5, y, z], [0.42, 0.26, 0.22], COLORS.cyan);
  const buf = ms.box(bufName(false), [-0.62, y, z], [1.0, 0.3, 0.22], API_NUM[api]);
  const queue = ms.box(api === 'd3d12' && !concept ? 'ID3D12CommandQueue' : api === 'vulkan' && !concept ? 'VkQueue' : t(L('kö', 'queue')), [0.38, y, z], [0.5, 0.26, 0.22], COLORS.violet);
  const bufLabel = buf.children[2] as CSS2DObject;
  const bufEdges = (buf.children[0] as LineSegments).material as LineBasicMaterial;
  const bufFill = (buf.children[1] as Mesh).material as MeshBasicMaterial;
  const boxes = [cpu, buf, queue];
  const callout = label('', 'cmd-callout');
  callout.position.set(-0.55, y - 0.32, z);
  ms.scene.add(callout);
  const say = (s: string, kind?: Kind) => {
    callout.element.textContent = s;
    callout.element.className = `three-label cmd-callout${kind ? ' k-' + kind : ''}`;
  };

  // Packets: one glowing dot per recorded command.
  const packets = cmds.map((c) => {
    const sp = new Sprite(new SpriteMaterial({ map: glowTexture(), color: KIND_HEX[c.kind], blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0 }));
    sp.scale.setScalar(c.kind === 'draw' ? 0.17 : 0.11);
    sp.visible = false;
    ms.scene.add(sp);
    return sp;
  });
  const recIdx = cmds.map((c, i) => (RECORDED.includes(c.kind) ? i : -1)).filter((i) => i >= 0);
  const slotOf = (j: number): Vector3 => {
    const cols = Math.ceil(recIdx.length / 2);
    return new Vector3(-0.62 - 0.42 + ((j % cols) + 0.5) * (0.84 / cols), y + (j < cols ? 0.06 : -0.06), z);
  };
  const cpuPos = new Vector3(-1.5, y, z);
  const qPos = new Vector3(0.38, y, z);
  const gpuPos = new Vector3(0, 0, 0);

  let step = 0;
  let presentedK = -1;
  const t0 = performance.now();
  const now = () => 2.6 + ((performance.now() - t0) / 1000) * 1.1;
  ms.onFrame(() => {
    const u = ms.material.uniforms.uDrawTris.value;
    if (step !== 3) {
      const n = Math.min(N, Math.floor(u));
      ms.highlightTriangle(n > 0 && n < N ? n - 1 : null, COLORS.cyan);
      hooks.drawn?.(n);
      return;
    }
    // Frames in flight: the model shows the last frame the GPU finished (fence signalled), one pose per frame.
    const tn = now();
    let k = presentedK < 0 ? 0 : presentedK;
    while (k + 1 < SCHED.length && SCHED[k + 1].ge <= tn) k++;
    if (k !== presentedK && SCHED[k].ge <= tn) {
      presentedK = k;
      ms.pivot.rotation.y = SHOWCASE_ROT_Y + (k % 64) * 0.098;
      hooks.presented?.(k);
      say(t(L(`GPU klar med F${k} → visas · CPU spelar in F${k + FIF}`, `GPU done with F${k} → shown · CPU records F${k + FIF}`)), 'submit');
    }
  });

  let tl: gsap.core.Timeline | null = null;
  let cur: gsap.core.Timeline | null = null;
  let pending: gsap.core.Tween | null = null;
  const stopLoop = () => {
    tl?.kill();
    pending?.kill();
    tl = cur = pending = null;
  };
  const resetPackets = () =>
    packets.forEach((p) => {
      gsap.killTweensOf([p.position, p.material, p.scale]);
      p.visible = false;
      p.material.opacity = 0;
    });
  const drawAll = (s: number) => {
    ms.setMode('shaded', 0, 0);
    ms.drawTriangles(0, 0);
    ms.drawTriangles(N, s);
  };
  const pulse = (m: MeshBasicMaterial, to = 0.35) => {
    m.opacity = to;
    ms.tween(m, { opacity: 0.08, duration: dur(0.6) });
  };

  /** Step 0: the GPU executes the list; the draw call draws the triangles in index order. */
  const execute = (tl: gsap.core.Timeline) => {
    let at = 0.4;
    cmds.forEach((c, i) => {
      tl.call(() => {
        hooks.row?.(i);
        say(`${c.call}(${c.args.length > 46 ? c.args.slice(0, 44) + '…' : c.args})`, c.kind);
        if (c.kind === 'pass' && /clear|Clear|BeginRendering/.test(c.call + c.args)) {
          ms.drawTriangles(0, 0);
          ms.setMode('ghost', 1, 0);
          ms.drawTriangles(N, 0);
        }
        if (c.kind === 'bind' && /Vertex|VertexArray|vao/.test(c.call + c.args)) {
          ms.setLayer('points', 0.7, 0);
          ms.setLayer('points', 0, 0.9);
        }
        if (c.kind === 'bind' && /Index/.test(c.call)) {
          ms.setLayer('wire', 0.5, 0);
          ms.setLayer('wire', 0, 0.9);
        }
        if (c.kind === 'draw') drawAll(2.8);
      }, [], at);
      at += c.kind === 'draw' ? 3.2 : 0.32;
    });
    tl.call(() => hooks.row?.(-1), [], at + 0.6);
    return at + 1.6;
  };

  /** Steps 1–2 (and concept step 0): record into a buffer, submit, execute. */
  const record = (tl: gsap.core.Timeline, hidden: boolean) => {
    let at = 0.3;
    tl.call(() => {
      resetPackets();
      ms.setMode('ghost', 1, 0);
      ms.drawTriangles(N, 0);
      bufEdges.opacity = hidden ? 0.35 : 0.95;
    }, [], 0);
    let j = 0;
    cmds.forEach((c, i) => {
      const p = packets[i];
      const rec = RECORDED.includes(c.kind);
      const slot = rec ? slotOf(j++) : null;
      tl.call(() => {
        hooks.row?.(i);
        say(concept ? c.call + (c.args ? ` · ${c.args}` : '') : `${c.call}(…)`, c.kind);
        if (c.kind === 'sync') pulse((cpu.children[1] as Mesh).material as MeshBasicMaterial, 0.5);
        if (slot) {
          p.visible = true;
          p.position.copy(cpuPos);
          p.material.opacity = 1;
          ms.tween(p.position, { x: slot.x, y: slot.y, z: slot.z, duration: dur(0.35), ease: 'power2.out' });
          if (hidden) ms.tween(p.material, { opacity: 0.18, duration: dur(0.3), delay: dur(0.35) });
        }
        if (c.kind === 'submit' && /Submit|Execute|SwapBuffers|^submit/.test(c.call)) {
          // The whole buffer goes to the queue, then to the GPU.
          pulse(bufFill, 0.4);
          packets.forEach((q, k) => {
            if (!q.visible) return;
            q.material.opacity = 1;
            ms.tween(q.position, { x: qPos.x + ((k % 5) - 2) * 0.06, y: qPos.y, z: qPos.z, duration: dur(0.4), ease: 'power2.in' });
            ms.tween(q.position, { x: gpuPos.x, y: gpuPos.y, z: gpuPos.z, duration: dur(0.45), delay: dur(0.5), ease: 'power2.in' });
            ms.tween(q.material, { opacity: 0, duration: dur(0.2), delay: dur(0.8) });
          });
          tl.pause();
          pending = gsap.delayedCall(dur(0.9), () => {
            if (tl !== cur) return;
            drawAll(1.6);
            pulse((queue.children[1] as Mesh).material as MeshBasicMaterial, 0.4);
            tl.resume();
          });
        }
      }, [], at);
      at += c.kind === 'submit' ? 2.4 : 0.2;
    });
    tl.call(() => hooks.row?.(-1), [], at + 0.4);
    return at + 1.4;
  };
  const startLoop = (build: (tl: gsap.core.Timeline) => number) => {
    stopLoop();
    if (!motion) return;
    tl = gsap.timeline({ repeat: -1 });
    cur = tl;
    tl.set({}, {}, build(tl));
  };

  return {
    ms,
    show(s: number, _animate: boolean) {
      step = s;
      stopLoop();
      resetPackets();
      ms.setLayer('points', 0, 0);
      ms.setLayer('wire', 0, 0);
      ms.pivot.rotation.y = SHOWCASE_ROT_Y;
      presentedK = -1;
      const recSteps = concept ? s <= 2 : s === 1 || s === 2;
      boxes.forEach((b) => (b.visible = recSteps));
      const hidden = concept ? s === 1 : gl && s === 1;
      bufLabel.element.textContent = bufName(hidden);
      if (s === 3) {
        ms.setMode('shaded', 0, 0);
        ms.drawTriangles(N, 0);
        ms.highlightTriangle(null);
        callout.position.set(-0.2, -1.12, 0.35);
        return;
      }
      callout.position.set(recSteps ? -0.55 : -0.2, recSteps ? y - 0.32 : -1.12, z);
      ms.setMode('shaded', 0, 0);
      ms.drawTriangles(N, 0);
      if (!concept && s === 0) startLoop(execute);
      else startLoop((tl) => record(tl, hidden));
      if (!motion) {
        hooks.row?.(-1);
        say(concept ? '' : `${cmds.find((c) => c.kind === 'draw')!.call}(${cmds.find((c) => c.kind === 'draw')!.args})`, 'draw');
      }
    },
    destroy() {
      stopLoop();
      resetPackets();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Real data: this frame's command stream, live on the model            */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const cmds = commandStream(ctx, api);
  const mesh = ctx.state.mesh;
  const idx = mesh.indices.length;
  const count = (k: Kind[]) => cmds.filter((c) => k.includes(c.kind)).length;

  const rows = cmds.map((c, i) =>
    h(`div.cmd-row.k-${c.kind}`, {}, [h('span.cmd-i', { text: String(i + 1).padStart(2, '0') }), h('span.cmd-call', { text: c.call }), h('span.cmd-args', { text: c.args ? `(${c.args})` : '()' })]),
  );
  const list = h('div.v-scroll.cmd-list', {}, rows);
  const drawnEl = h('div.v.glow-magenta', { text: '0' });
  const legend = () => h('div.cmd-legend', {}, (['sync', 'rec', 'barrier', 'pass', 'state', 'bind', 'draw', 'submit'] as Kind[]).filter((k) => count([k])).map((k) => h(`span.k-${k}`, { text: `${k} ${count([k])}` })));

  const listTitle = api === 'opengl' ? t(L('Dina GL-anrop för en frame', 'Your GL calls for one frame')) : api === 'vulkan' ? t(L('VkCommandBuffer + submit', 'VkCommandBuffer + submit')) : t(L('Command list + submit', 'Command list + submit'));
  const p0 = h('div', {}, [
    h('div.stat-row', {}, [
      stat(String(cmds.length), t(L('anrop / frame', 'calls / frame')), 'glow-cyan'),
      stat(idx.toLocaleString('en-US'), 'indexCount', 'glow-amber'),
      h('div.stat', {}, [drawnEl, h('div.k', { text: t(L(`av ${mesh.triangleCount.toLocaleString('en-US')} trianglar ritade`, `of ${mesh.triangleCount.toLocaleString('en-US')} triangles drawn`)) })]),
    ]),
    list,
    legend(),
  ]);

  const hiddenGl = [
    t(L('validerar all state (förra bilden)', 'validates all state (previous slide)')),
    t(L('kodar GPU-paket i en intern kommandobuffert', 'encodes GPU packets into an internal command buffer')),
    t(L('lägger in barriärer / layoutbyten själv', 'inserts barriers / layout changes itself')),
    t(L('väntar eller byter buffert om du skriver i en buffert GPU:n läser', 'stalls or renames if you write a buffer the GPU is reading')),
    t(L('skickar när bufferten är full, vid glFlush eller SwapBuffers', 'flushes when the buffer is full, at glFlush or at SwapBuffers')),
  ];
  const p1 =
    api === 'opengl'
      ? h('div', {}, [h('ol.cmd-hidden', {}, hiddenGl.map((x) => h('li', { text: x })))])
      : h('div', {}, [
          h('div.stat-row', {}, [
            stat(String(count(['sync'])), t(L('synk-anrop', 'sync calls')), 'glow-amber'),
            stat(String(count(['barrier'])), t(L('barriärer', 'barriers')), 'glow-magenta'),
            stat(String(count(['rec'])), t(L('inspelning', 'recording')), 'glow-cyan'),
          ]),
          h('p.cmd-p', {
            html: t(api === 'vulkan'
              ? L('OpenGL gömde allt detta. Här skriver du själv fences och semaforer, bildlayouter (<code>UNDEFINED → COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR</code>) och kommandopoolens livscykel.', 'OpenGL hid all of this. Here you write the fences and semaphores, image layouts (<code>UNDEFINED → COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR</code>) and the command pool’s life cycle yourself.')
              : L('OpenGL gömde allt detta. Här skriver du själv fence-väntan, resurstillstånd (<code>PRESENT → RENDER_TARGET → PRESENT</code>) och allokatorns livscykel.', 'OpenGL hid all of this. Here you write the fence waits, resource states (<code>PRESENT → RENDER_TARGET → PRESENT</code>) and the allocator’s life cycle yourself.')),
          }),
        ]);
  const subTxt: Record<ApiId, Text> = {
    opengl: L('Ingen explicit submit: drivrutinen skickar sin interna buffert vid <code>SwapBuffers</code> (eller när den är full).', 'No explicit submit: the driver sends its internal buffer at <code>SwapBuffers</code> (or when it fills up).'),
    vulkan: L('<code>vkQueueSubmit2</code> väntar på <code>imageAvailable[f]</code>, signalerar <code>renderFinished</code> och fencen <code>inFlight[f]</code>.', '<code>vkQueueSubmit2</code> waits on <code>imageAvailable[f]</code>, signals <code>renderFinished</code> and the fence <code>inFlight[f]</code>.'),
    d3d12: L('<code>ExecuteCommandLists</code> köar listan; <code>Signal(fence, ++value)</code> säger när GPU:n är klar så allokatorn kan återanvändas.', '<code>ExecuteCommandLists</code> queues the list; <code>Signal(fence, ++value)</code> tells when the GPU is done so the allocator can be reused.'),
  };
  const p2 = h('div', {}, [
    h('div.stat-row', {}, [
      stat(String(cmds.filter((c) => RECORDED.includes(c.kind)).length), t(L('inspelade kommandon', 'recorded commands')), 'glow-cyan'),
      stat(api === 'opengl' ? 'SwapBuffers' : api === 'vulkan' ? 'vkQueueSubmit2' : 'ExecuteCommandLists', 'submit', 'glow-amber'),
    ]),
    h('p.cmd-p', { html: t(subTxt[api]) }),
    legend(),
  ]);
  const titles = [listTitle, api === 'opengl' ? t(L('Det drivrutinen gör bakom dina anrop', 'What the driver does behind your calls')) : t(L('Det OpenGL gömde – nu ditt ansvar', 'What OpenGL hid – now your job')), t(L('Spela in → stäng → skicka', 'Record → close → submit'))];

  // Step 3: the live CPU / queue / GPU timeline in a bottom panel.
  const tlHost = h('div.cmd-tl');
  const presEl = h('div.v.glow-cyan', { text: 'F0' });
  const p3 = h('div.cmd-tlwrap', {}, [
    tlHost,
    h('div.cmd-tlside', {}, [
      h('div.stat', {}, [presEl, h('div.k', { text: t(L('visas nu', 'on screen')) })]),
      stat(String(FIF), t(L('frames i flykten', 'frames in flight')), 'glow-amber'),
      h('p.cmd-p.small', {
        text: t(api === 'opengl'
          ? L('Drivrutinen sköter detta åt dig (ofta 2–3 frames före).', 'The driver manages this for you (often 2–3 frames ahead).')
          : L(`Fence f blockerar CPU:n innan slot f = n mod ${FIF} återanvänds.`, `Fence f blocks the CPU before slot f = n mod ${FIF} is reused.`)),
      }),
    ]),
  ]);

  let lastRow = -2;
  const sc = cmdScene(host, ctx, false, cmds, {
    row: (i) => {
      if (i === lastRow) return;
      lastRow = i;
      rows.forEach((r, k) => r.classList.toggle('mark', k === i));
      const r = rows[i];
      if (r) list.scrollTop = Math.max(0, r.offsetTop - list.offsetTop - list.clientHeight / 2);
    },
    drawn: (n) => (drawnEl.textContent = n.toLocaleString('en-US')),
    presented: (k) => (presEl.textContent = `F${k}`),
  });
  const ms = sc.ms;
  const panels = [p0, p1, p2].map((c, i) => ms.panel(titles[i], [c], { className: 'cmd-p' + i }));
  const tlPanel = ms.panel(t(L(`CPU och GPU parallellt – ${FIF} frames i flykten`, `CPU and GPU in parallel – ${FIF} frames in flight`)), [p3], { side: 'bottom', className: 'cmd-tlpanel' });
  const lanes: [string, string, string] = ['CPU', t(L('kö', 'queue')), 'GPU'];
  const tl = liveCanvas(tlHost, (g, w, hh, time) =>
    drawTimeline(g, 0, 0, w, hh, 2.6 + time * 1.1, {
      api,
      lanes,
      cpuLabel: (k) => `F${k} · ${cmds.length} ${t(L('anrop', 'calls'))}`,
      gpuLabel: (k) => `F${k} · ${idx} idx`,
      waitLabel: t(L('väntar fence', 'wait fence')),
      fenceLabel: t(L('◆ fence signaleras när GPU:n är klar', '◆ fence signalled when the GPU is done')),
    }),
  );

  return {
    show(step, animate) {
      lastRow = -2;
      panels.forEach((p, i) => (p.style.display = i === step || (i === 0 && step < 3) ? '' : 'none'));
      tlPanel.style.display = step === 3 ? '' : 'none';
      if (step === 3) tl.start();
      else tl.stop();
      if (step === 1 || step === 2) {
        const mark = (c: Cmd) => (step === 1 ? (api === 'opengl' ? true : c.kind === 'sync' || c.kind === 'barrier') : c.kind === 'rec' || c.kind === 'submit');
        rows.forEach((r, i) => r.classList.toggle('sel', mark(cmds[i])));
      } else rows.forEach((r) => r.classList.remove('sel'));
      if (animate) gsap.fromTo(step === 3 ? tlPanel : panels[step], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
      sc.show(step, animate);
    },
    destroy() {
      tl.destroy();
      gsap.killTweensOf([...panels, tlPanel]);
      sc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: packets → command buffer → queue → GPU, and two timelines   */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const idx = ctx.state.mesh.indices.length;
  // A generic command stream – the idea, not one API's spelling.
  const cmds: Cmd[] = [
    { call: t(L('vänta på frame-slot', 'wait for frame slot')), args: '', kind: 'sync' },
    { call: t(L('börja spela in', 'begin recording')), args: '', kind: 'rec' },
    { call: t(L('barriär', 'barrier')), args: '', kind: 'barrier' },
    { call: t(L('börja rendering · rensa', 'begin rendering · clear')), args: '', kind: 'pass' },
    { call: t(L('bind pipeline', 'bind pipeline')), args: '', kind: 'bind' },
    { call: 'viewport', args: '', kind: 'state' },
    { call: t(L('bind vertexbuffert', 'bind vertex buffer')), args: '', kind: 'bind' },
    { call: t(L('bind indexbuffert', 'bind index buffer')), args: '', kind: 'bind' },
    { call: t(L('bind uniforms', 'bind uniforms')), args: '', kind: 'bind' },
    { call: 'draw', args: `${idx} index`, kind: 'draw' },
    { call: t(L('avsluta rendering', 'end rendering')), args: '', kind: 'pass' },
    { call: t(L('stäng bufferten', 'close the buffer')), args: '', kind: 'rec' },
    { call: 'submit', args: t(L('till kön', 'to the queue')), kind: 'submit' },
  ];
  const captions = [
    L('GPU:n kör inte dina funktionsanrop direkt. Kommandon samlas i en <b>kommandobuffert</b>, skickas till en <b>kö</b> – och först då ritar GPU:n trianglarna, i indexordning.', 'The GPU does not run your function calls directly. Commands are collected in a <b>command buffer</b> and sent to a <b>queue</b> – only then does the GPU draw the triangles, in index order.'),
    L('OpenGL: drivrutinen spelar in i en dold buffert bakom dina <code>glDraw*</code>-anrop och skickar den när den vill – synk sker automatiskt.', 'OpenGL: the driver records into a hidden buffer behind your <code>glDraw*</code> calls and sends it when it likes – sync is automatic.'),
    L('Vulkan/D3D12: du äger bufferten. Du spelar in, stänger och skickar den själv – och kan spela in flera parallellt på olika trådar.', 'Vulkan/D3D12: you own the buffer. You record it, close it and submit it yourself – and can record several in parallel on different threads.'),
    L(`CPU:n spelar in frame N+1 medan GPU:n kör frame N. Med ${FIF} frames i flykten väntar CPU:n på en <b>fence</b> innan den återanvänder en frames resurser. Modellen visar varje färdig frame.`, `The CPU records frame N+1 while the GPU executes frame N. With ${FIF} frames in flight the CPU waits on a <b>fence</b> before it reuses a frame’s resources. The model shows each finished frame.`),
  ];
  const caption = h('p.cmd-caption');
  // Each step gets the stream that fits it: GL for step 1, explicit for the others.
  const scenes = [cmdScene(host, ctx, true, cmds, {})];
  const ms = scenes[0].ms;
  ms.panel(t(L('Vad händer', 'What happens')), [caption], { side: 'bottom', className: 'cmd-cap' });
  const tlHost = h('div.cmd-tl.small');
  const tlPanel = ms.panel(t(L('CPU · kö · GPU', 'CPU · queue · GPU')), [tlHost], { side: 'bottom', className: 'cmd-tlpanel' });
  const lanes: [string, string, string] = ['CPU', t(L('kö', 'queue')), 'GPU'];
  const tl = liveCanvas(tlHost, (g, w, hh, time) =>
    drawTimeline(g, 0, 0, w, hh, 2.6 + time * 1.1, {
      api,
      lanes,
      cpuLabel: (k) => `${t(L('spelar in', 'record'))} F${k}`,
      gpuLabel: (k) => `${t(L('kör', 'run'))} F${k}`,
      waitLabel: t(L('väntar på fence', 'wait on fence')),
      fenceLabel: t(L('◆ fence: GPU klar → CPU får återanvända slotten', '◆ fence: GPU done → the CPU may reuse the slot')),
    }),
  );
  return {
    show(step, animate) {
      caption.innerHTML = t(captions[step]);
      tlPanel.style.display = step === 3 ? '' : 'none';
      if (step === 3) tl.start();
      else tl.stop();
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: dur(0.35) });
      scenes[0].show(step, animate);
    },
    destroy() {
      tl.destroy();
      gsap.killTweensOf(caption);
      scenes[0].destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const lay = ctx.derived.layout;
  const idx = ctx.state.mesh.indices.length;
  const u16 = lay.indexType === 'uint16';
  return {
    opengl: {
      note: L(
        'I OpenGL finns ingen kommandobuffert du ser. Varje anrop går till drivrutinen, som spelar in GPU-kommandon i en egen buffert och skickar den vid SwapBuffers eller glFlush. Synkronisering sker implicit.',
        'In OpenGL there is no command buffer you can see. Every call goes to the driver, which records GPU commands into its own buffer and sends it at SwapBuffers or glFlush. Synchronization is implicit.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `// one frame – every call is recorded by the driver, not executed
glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
glViewport(0, 0, ${VW}, ${VH});
glClearColor(${CLEAR});
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
glUseProgram(prog);
glBindVertexArray(vao);
glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo);
glDrawElements(GL_TRIANGLES, ${idx}, ${u16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT'}, nullptr);
SwapBuffers(hdc);          // flush to the GPU + present (implicit sync)
// explicit sync exists, but is optional:
GLsync s = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
glClientWaitSync(s, GL_SYNC_FLUSH_COMMANDS_BIT, UINT64_MAX);`,
          highlight: [[9], [1, 2, 3, 4, 5, 6, 7, 8, 9], [10], [10, 12, 13]],
        },
      ],
      terms: [
        { term: 'command stream', desc: L('Drivrutinens interna lista med GPU-paket.', 'The driver’s internal list of GPU packets.') },
        { term: 'glFlush / SwapBuffers', desc: L('Tvingar drivrutinen att skicka det som spelats in.', 'Forces the driver to send what has been recorded.') },
        { term: 'glFenceSync', desc: L('Valfri explicit synk – en fence i GL.', 'Optional explicit sync – a fence in GL.') },
      ],
      you: L('anropar glDraw* i ordning', 'call glDraw* in order'),
      driver: L('spelar in, skickar, synkar', 'records, submits, synchronizes'),
    },
    vulkan: {
      note: L(
        'I Vulkan spelar du in i en VkCommandBuffer från en VkCommandPool, och skickar den med vkQueueSubmit2. Semaforer ordnar GPU-arbete (acquire → render → present), en fence säger till CPU:n när en frame är klar.',
        'In Vulkan you record into a VkCommandBuffer from a VkCommandPool and submit it with vkQueueSubmit2. Semaphores order GPU work (acquire → render → present), a fence tells the CPU when a frame is done.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `// once: VkCommandPool + vkAllocateCommandBuffers(device, &ai, &cmd[f]) for f < ${FIF}
vkWaitForFences(device, 1, &inFlight[f], VK_TRUE, UINT64_MAX);
vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imageAvailable[f], VK_NULL_HANDLE, &img);
vkResetFences(device, 1, &inFlight[f]);
vkResetCommandPool(device, pool[f], 0);
vkBeginCommandBuffer(cmd, &begin);   // ONE_TIME_SUBMIT
vkCmdPipelineBarrier2(cmd, &toColorAttachment);   // UNDEFINED → COLOR_ATTACHMENT_OPTIMAL
vkCmdBeginRendering(cmd, &renderingInfo);         // ${VW}×${VH}, clear color + depth
vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
vkCmdSetViewport(cmd, 0, 1, &viewport);  vkCmdSetScissor(cmd, 0, 1, &scissor);
vkCmdBindVertexBuffers(cmd, 0, 1, &vertexBuffer, &offset0);
vkCmdBindIndexBuffer(cmd, indexBuffer, 0, ${u16 ? 'VK_INDEX_TYPE_UINT16' : 'VK_INDEX_TYPE_UINT32'});
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &set[f], 0, nullptr);
vkCmdDrawIndexed(cmd, ${idx}, 1, 0, 0, 0);
vkCmdEndRendering(cmd);
vkCmdPipelineBarrier2(cmd, &toPresent);           // → PRESENT_SRC_KHR
vkEndCommandBuffer(cmd);
VkSubmitInfo2 submit{ VK_STRUCTURE_TYPE_SUBMIT_INFO_2 };   // wait imageAvailable,
vkQueueSubmit2(queue, 1, &submit, inFlight[f]);           // signal renderFinished
vkQueuePresentKHR(queue, &presentInfo);
f = (f + 1) % ${FIF};`,
          highlight: [[14], [2, 3, 4, 7, 16], [1, 5, 6, 17, 18, 19, 20], [2, 4, 19, 21]],
        },
      ],
      terms: [
        { term: 'VkCommandBuffer', desc: L('Inspelad lista med GPU-kommandon.', 'A recorded list of GPU commands.') },
        { term: 'VkSemaphore', desc: L('GPU↔GPU-synk mellan köoperationer.', 'GPU↔GPU sync between queue operations.') },
        { term: 'VkFence', desc: L('GPU→CPU-synk: "frame f är klar".', 'GPU→CPU sync: "frame f is done".') },
        { term: 'vkCmdPipelineBarrier2', desc: L('Synchronization2: minnes- och layoutövergång.', 'Synchronization2: memory and layout transition.') },
      ],
      you: L('spelar in, skickar, synkar', 'record, submit, synchronize'),
      driver: L('översätter till GPU-paket', 'translates into GPU packets'),
    },
    d3d12: {
      note: L(
        'I D3D12 spelar du in i en ID3D12GraphicsCommandList med minne från en ID3D12CommandAllocator, stänger den och kör den med ExecuteCommandLists. En ID3D12Fence med stigande värden säger när en frame är klar.',
        'In D3D12 you record into an ID3D12GraphicsCommandList backed by an ID3D12CommandAllocator, close it and run it with ExecuteCommandLists. An ID3D12Fence with increasing values tells when a frame is done.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `if (fence->GetCompletedValue() < frameFence[f]) {      // GPU done with slot f?
    fence->SetEventOnCompletion(frameFence[f], ev);  WaitForSingleObject(ev, INFINITE); }
allocator[f]->Reset();
cmdList->Reset(allocator[f].Get(), nullptr);
cmdList->SetGraphicsRootSignature(rootSig.Get());
cmdList->SetPipelineState(pso.Get());
cmdList->SetGraphicsRootConstantBufferView(0, cbVA + f * 256);
cmdList->RSSetViewports(1, &viewport);  cmdList->RSSetScissorRects(1, &scissor);
cmdList->ResourceBarrier(1, &toRenderTarget);  // PRESENT → RENDER_TARGET
cmdList->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
cmdList->ClearRenderTargetView(rtv, clearColor, 0, nullptr);
cmdList->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
cmdList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
cmdList->IASetVertexBuffers(0, 1, &vbv);       // ${lay.vertexBytes} B, stride ${lay.stride}
cmdList->IASetIndexBuffer(&ibv);               // ${lay.indexBytes} B, ${u16 ? 'R16_UINT' : 'R32_UINT'}
cmdList->DrawIndexedInstanced(${idx}, 1, 0, 0, 0);
cmdList->ResourceBarrier(1, &toPresent);       // RENDER_TARGET → PRESENT
cmdList->Close();
ID3D12CommandList* lists[] = { cmdList.Get() };
queue->ExecuteCommandLists(1, lists);
swapChain->Present(1, 0);
queue->Signal(fence.Get(), ++fenceValue);  frameFence[f] = fenceValue;
f = swapChain->GetCurrentBackBufferIndex();`,
          highlight: [[16], [1, 2, 3, 9, 17, 22], [3, 4, 18, 19, 20, 21], [1, 2, 22, 23]],
        },
      ],
      terms: [
        { term: 'ID3D12CommandAllocator', desc: L('Minnet kommandona spelas in i – får bara återställas när GPU:n är klar.', 'The memory commands are recorded into – may only be reset when the GPU is done.') },
        { term: 'ID3D12GraphicsCommandList', desc: L('Inspelningsgränssnittet. Close() innan körning.', 'The recording interface. Close() before execution.') },
        { term: 'ID3D12Fence', desc: L('64-bitars räknare som GPU:n sätter med Signal.', '64-bit counter the GPU sets with Signal.') },
        { term: 'ResourceBarrier', desc: L('Övergång mellan resurstillstånd.', 'Transition between resource states.') },
      ],
      you: L('spelar in, skickar, synkar', 'record, submit, synchronize'),
      driver: L('översätter till GPU-paket', 'translates into GPU packets'),
    },
  };
}

export default standardSlide({
  id: 'commands',
  group: 'api',
  short: L('Kommandon', 'Commands'),
  title: L('Kommandon & submit', 'Commands & submit'),
  lead: L(
    'Nu är allt förberett. Själva ritandet är en lista kommandon som spelas in på CPU:n, skickas till GPU:ns kö och körs – medan CPU:n redan förbereder nästa bild.',
    'Everything is prepared. The drawing itself is a list of commands recorded on the CPU, sent to the GPU’s queue and executed – while the CPU is already preparing the next frame.',
  ),
  bullets: [
    L('En frame för den här modellen är ett <b>draw-anrop</b> med alla index – plus state, bindningar och synk runt omkring.', 'One frame for this model is a single <b>draw call</b> with all the indices – plus state, bindings and sync around it.'),
    L('<b>OpenGL</b> döljer kommandobufferten: drivrutinen spelar in bakom dina <code>glDraw*</code>-anrop, skickar implicit och synkar åt dig.', '<b>OpenGL</b> hides the command buffer: the driver records behind your <code>glDraw*</code> calls, submits implicitly and synchronizes for you.'),
    L('<b>Vulkan</b> och <b>D3D12</b> är explicita: spela in (<code>vkBeginCommandBuffer</code> / <code>Reset</code>), stäng och skicka (<code>vkQueueSubmit2</code> / <code>ExecuteCommandLists</code>).', '<b>Vulkan</b> and <b>D3D12</b> are explicit: record (<code>vkBeginCommandBuffer</code> / <code>Reset</code>), close and submit (<code>vkQueueSubmit2</code> / <code>ExecuteCommandLists</code>).'),
    L(`CPU och GPU arbetar parallellt med ${FIF} <b>frames i flykten</b>; <b>fences</b> hindrar CPU:n från att skriva över det GPU:n fortfarande läser.`, `CPU and GPU work in parallel with ${FIF} <b>frames in flight</b>; <b>fences</b> stop the CPU from overwriting what the GPU is still reading.`),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
