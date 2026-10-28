import gsap from 'gsap';
import { dur, h, reducedMotion } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { card, stat } from '../views/widgets';
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
/* Real data: this frame's command stream                              */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const cmds = commandStream(ctx, api);
  const lay = ctx.derived.layout;
  const mesh = ctx.state.mesh;
  const idx = mesh.indices.length;
  const count = (k: Kind[]) => cmds.filter((c) => k.includes(c.kind)).length;

  const rows = cmds.map((c, i) =>
    h(`div.cmd-row.k-${c.kind}`, {}, [
      h('span.cmd-i', { text: String(i + 1).padStart(2, '0') }),
      h('span.cmd-call', { text: c.call }),
      h('span.cmd-args', { text: c.args ? `(${c.args})` : '()' }),
      c.note ? h('span.cmd-note', { text: c.note }) : null,
    ]),
  );
  const listCard = card(
    api === 'opengl' ? t(L('Dina GL-anrop för en frame', 'Your GL calls for one frame')) : api === 'vulkan' ? t(L('Inspelat i VkCommandBuffer + submit', 'Recorded into a VkCommandBuffer + submit')) : t(L('Inspelat i ID3D12GraphicsCommandList + submit', 'Recorded into an ID3D12GraphicsCommandList + submit')),
    [h('div.v-scroll.cmd-list', {}, rows)],
    'cmd-listcard',
  );

  // Right side, one card per step.
  const legend = h('div.cmd-legend', {}, (['sync', 'rec', 'barrier', 'pass', 'state', 'bind', 'draw', 'submit'] as Kind[]).filter((k) => count([k])).map((k) => h(`span.k-${k}`, { text: `${k} ${count([k])}` })));
  const s0 = h('div.cmd-side', {}, [
    h('div.stat-row', {}, [
      stat(String(cmds.length), t(L('anrop / frame', 'calls / frame')), 'glow-cyan'),
      stat('1', t(L('draw-anrop', 'draw call')), 'glow-magenta'),
    ]),
    h('div.stat-row', {}, [
      stat(idx.toLocaleString('en-US'), `indexCount · ${mesh.triangleCount.toLocaleString('en-US')} ${t(L('trianglar', 'triangles'))}`, 'glow-amber'),
    ]),
    h('dl.kv.cmd-kv', {}, [
      h('dt', { text: 'vertex buffer' }),
      h('dd', { text: `${formatBytes(lay.vertexBytes)} · stride ${lay.stride}` }),
      h('dt', { text: 'index buffer' }),
      h('dd', { text: `${formatBytes(lay.indexBytes)} · ${lay.indexType}` }),
      h('dt', { text: 'viewport' }),
      h('dd', { text: `${VW} × ${VH}` }),
      h('dt', { text: 'clear' }),
      h('dd', { text: `(${CLEAR})` }),
    ]),
    legend,
  ]);

  const hiddenGl = [
    t(L('validerar all state (förra bilden)', 'validates all state (previous slide)')),
    t(L('kodar GPU-paket i en intern kommandobuffert', 'encodes GPU packets into an internal command buffer')),
    t(L('lägger in barriärer / layoutbyten själv', 'inserts barriers / layout changes itself')),
    t(L('väntar eller byter buffert om du skriver i en buffert GPU:n läser', 'stalls or renames if you write a buffer the GPU is reading')),
    t(L('skickar (flush) när bufferten är full, vid glFlush eller SwapBuffers', 'flushes when the buffer is full, at glFlush or at SwapBuffers')),
  ];
  const s1 =
    api === 'opengl'
      ? card(t(L('Det drivrutinen gör bakom dina anrop', 'What the driver does behind your calls')), [h('ol.cmd-hidden', {}, hiddenGl.map((x) => h('li', { text: x })))], 'cmd-side1')
      : card(t(L('Det OpenGL gömde – nu ditt ansvar', 'What OpenGL hid – now your job')), [
          h('div.stat-row', {}, [
            stat(String(count(['sync'])), t(L('synk-anrop', 'sync calls')), 'glow-amber'),
            stat(String(count(['barrier'])), t(L('barriärer', 'barriers')), 'glow-magenta'),
            stat(String(count(['rec'])), t(L('inspelning', 'recording')), 'glow-cyan'),
          ]),
          h('p.cmd-p', {
            html: t(
              api === 'vulkan'
                ? L('Fences och semaforer, bildlayouter (<code>UNDEFINED → COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR</code>) och kommandopoolens livscykel skriver du själv.', 'Fences and semaphores, image layouts (<code>UNDEFINED → COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR</code>) and the command pool’s life cycle are all written by you.')
                : L('Fence-väntan, resurstillstånd (<code>PRESENT → RENDER_TARGET → PRESENT</code>) och allokatorns livscykel skriver du själv.', 'Fence waits, resource states (<code>PRESENT → RENDER_TARGET → PRESENT</code>) and the allocator’s life cycle are all written by you.'),
            ),
          }),
        ], 'cmd-side1');

  const pk = h('div.cmd-pk', {}, cmds.filter((c) => !['sync'].includes(c.kind)).map((c) => h(`span.k-${c.kind}`, { attrs: { title: c.call } })));
  const subTxt: Record<ApiId, Text> = {
    opengl: L('Ingen explicit submit: drivrutinen skickar sin interna buffert vid <code>SwapBuffers</code> (eller när den är full). Synk sker implicit.', 'No explicit submit: the driver sends its internal buffer at <code>SwapBuffers</code> (or when it fills up). Synchronization is implicit.'),
    vulkan: L('<code>vkQueueSubmit2</code> väntar på <code>imageAvailable[f]</code>, signalerar <code>renderFinished</code> (för present) och fencen <code>inFlight[f]</code> (för CPU:n).', '<code>vkQueueSubmit2</code> waits on <code>imageAvailable[f]</code>, signals <code>renderFinished</code> (for present) and the fence <code>inFlight[f]</code> (for the CPU).'),
    d3d12: L('<code>ExecuteCommandLists</code> köar listan; <code>Signal(fence, ++value)</code> efteråt säger när GPU:n är klar så allokatorn kan återanvändas.', '<code>ExecuteCommandLists</code> queues the list; a <code>Signal(fence, ++value)</code> afterwards tells when the GPU is done so the allocator can be reused.'),
  };
  const s2 = card(t(L('Inspelning → kö → GPU', 'Recording → queue → GPU')), [
    h('div.cmd-flow', {}, [
      h('div.cmd-box', {}, [h('b', { text: api === 'opengl' ? t(L('drivrutinens buffert', "driver's buffer")) : api === 'vulkan' ? 'VkCommandBuffer' : 'CommandList' }), pk]),
      h('div.cmd-arrow', { text: api === 'opengl' ? 'SwapBuffers' : api === 'vulkan' ? 'vkQueueSubmit2' : 'ExecuteCommandLists' }),
      h('div.cmd-box.q', {}, [h('b', { text: api === 'd3d12' ? 'ID3D12CommandQueue' : api === 'vulkan' ? 'VkQueue' : 'queue' }), h('span', { text: 'GPU' })]),
    ]),
    h('p.cmd-p', { html: t(subTxt[api]) }),
    legend.cloneNode(true) as HTMLElement,
  ], 'cmd-side2');

  const tlHost = h('div.cmd-tl');
  const s3 = card(t(L(`CPU och GPU parallellt – ${FIF} frames i flykten`, `CPU and GPU in parallel – ${FIF} frames in flight`)), [tlHost, h('p.cmd-p.small', {
    text: t(api === 'opengl'
      ? L('I OpenGL sköter drivrutinen detta (ofta 2–3 frames före). Färg = frame-slot f = n mod 2.', 'In OpenGL the driver manages this (often 2–3 frames ahead). Color = frame slot f = n mod 2.')
      : L(`Fence f blockerar CPU:n innan den återanvänder slot f = n mod ${FIF} (kommandobuffert, UBO-kopia).`, `Fence f blocks the CPU before it reuses slot f = n mod ${FIF} (command buffer, UBO copy).`)),
  })], 'cmd-side3');

  const sides = [s0, s1, s2, s3];
  const right = h('div.cmd-right', {}, sides);
  const root = h('div.cmd-data', {}, [listCard, right]);
  host.append(root);

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

  const marks: ((c: Cmd) => boolean)[] = [
    (c) => c.kind === 'draw',
    (c) => (api === 'opengl' ? true : c.kind === 'sync' || c.kind === 'barrier'),
    (c) => c.kind === 'rec' || c.kind === 'submit',
    (c) => c.kind === 'sync' || c.kind === 'submit',
  ];

  return {
    show(step, animate) {
      root.dataset.step = String(step);
      sides.forEach((s, i) => s.classList.toggle('on', i === step));
      rows.forEach((r, i) => r.classList.toggle('mark', marks[step](cmds[i])));
      if (step === 3) tl.start();
      else tl.stop();
      if (!animate) return;
      gsap.fromTo(sides[step], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.4) });
      if (step === 0) gsap.fromTo(rows, { opacity: 0, x: -14 }, { opacity: 1, x: 0, stagger: 0.035, duration: dur(0.3) });
      if (step === 2) gsap.fromTo(pk.children, { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, stagger: 0.05, duration: dur(0.25) });
      const first = rows.find((r) => r.classList.contains('mark'));
      first?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    destroy() {
      tl.destroy();
      gsap.killTweensOf([...rows, ...sides, ...Array.from(pk.children)]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: packets → command buffer → queue → GPU, and two timelines   */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const apiC = API_HEX[api];
  const wrap = h('div.v-fill.cmdc-wrap');
  const caption = h('div.pack-caption.cmdc-caption');
  host.append(wrap, caption);
  let step = 0;

  const glPk = ['glUseProgram', 'glBindVertexArray', 'glBindBufferBase', 'glDrawElements', 'glDrawElements', 'SwapBuffers'];
  const vkPk = ['Barrier', 'BeginRendering', 'BindPipeline', 'BindVertexBuffers', 'DrawIndexed', 'EndRendering'];
  const dxPk = ['ResourceBarrier', 'OMSetRenderTargets', 'SetPipelineState', 'IASetVertexBuffers', 'DrawIndexedInstanced', 'Close'];
  const bufName = api === 'd3d12' ? 'ID3D12GraphicsCommandList' : api === 'vulkan' ? 'VkCommandBuffer' : 'VkCommandBuffer / CommandList';
  const submitName = api === 'd3d12' ? 'ExecuteCommandLists' : 'vkQueueSubmit2';
  const lanes: [string, string, string] = ['CPU', t(L('kö', 'queue')), 'GPU'];
  const captions = [
    L('GPU:n kör inte dina funktionsanrop direkt. Kommandon samlas i en <b>kommandobuffert</b>, som skickas till en <b>kö</b> som GPU:n betar av.', 'The GPU does not run your function calls directly. Commands are collected in a <b>command buffer</b>, which is sent to a <b>queue</b> that the GPU works through.'),
    L('OpenGL: drivrutinen spelar in i en dold buffert bakom dina <code>glDraw*</code>-anrop och skickar den när den vill – synk sker automatiskt.', 'OpenGL: the driver records into a hidden buffer behind your <code>glDraw*</code> calls and sends it when it likes – sync is automatic.'),
    L('Vulkan/D3D12: du äger bufferten. Du spelar in, stänger och skickar den själv – och kan spela in flera parallellt på olika trådar.', 'Vulkan/D3D12: you own the buffer. You record it, close it and submit it yourself – and can record several in parallel on different threads.'),
    L(`CPU:n spelar in frame N+1 medan GPU:n kör frame N. Med ${FIF} frames i flykten väntar CPU:n på en <b>fence</b> innan den återanvänder en frames resurser.`, `The CPU records frame N+1 while the GPU executes frame N. With ${FIF} frames in flight the CPU waits on a <b>fence</b> before it reuses a frame’s resources.`),
  ];

  const P = 3.4; // seconds per packet cycle
  const drawPackets = (g: CanvasRenderingContext2D, W: number, Ht: number, time: number) => {
    const gl = step === 1;
    const labels = gl ? glPk : api === 'd3d12' ? dxPk : vkPk;
    const y = Ht * 0.5;
    const srcX = 16;
    const bufX = W * 0.27;
    const bufW = W * 0.3;
    const qX = W * 0.64;
    const qW = W * 0.13;
    const gpuX = W * 0.84;
    const gpuW = W - gpuX - 14;
    const boxH = Math.min(78, Ht * 0.8);
    const tau = time % P;
    g.font = '600 10.5px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    // source
    g.fillStyle = C.cyan;
    g.fillText(gl ? t(L('din kod', 'your code')) : t(L('CPU-tråd', 'CPU thread')), srcX, y - boxH / 2 - 8);
    g.strokeStyle = 'rgba(56,225,255,0.6)';
    rrect(g, srcX, y - boxH / 2, 70, boxH, 10);
    g.stroke();
    // command buffer box
    const closed = tau > 2.0 && tau < 2.5;
    g.save();
    g.shadowColor = gl ? 'transparent' : apiC;
    g.shadowBlur = closed ? 26 : 10;
    g.strokeStyle = gl ? 'rgba(154,163,199,0.5)' : apiC;
    g.setLineDash(gl ? [5, 4] : []);
    g.fillStyle = gl ? 'rgba(154,163,199,0.08)' : `${apiC}18`;
    rrect(g, bufX, y - boxH / 2, bufW, boxH, 10);
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = gl ? C.muted : apiC;
    g.fillText(gl ? t(L('drivrutinen – dold buffert', 'driver – hidden buffer')) : bufName, bufX, y - boxH / 2 - 8);
    // queue
    g.strokeStyle = 'rgba(155,123,255,0.7)';
    rrect(g, qX, y - boxH / 2, qW, boxH, 10);
    g.stroke();
    g.fillStyle = C.violet;
    g.fillText(t(L('kö', 'queue')), qX, y - boxH / 2 - 8);
    // GPU
    const busy = tau > 2.9 || tau < 0.3;
    g.save();
    g.shadowColor = C.magenta;
    g.shadowBlur = busy ? 30 : 8;
    g.strokeStyle = C.magenta;
    g.fillStyle = busy ? 'rgba(255,63,210,0.25)' : 'rgba(255,63,210,0.08)';
    rrect(g, gpuX, y - boxH / 2, gpuW, boxH, 10);
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = C.magenta;
    g.fillText('GPU', gpuX, y - boxH / 2 - 8);
    // arrows
    g.strokeStyle = 'rgba(160,175,255,0.35)';
    g.beginPath();
    g.moveTo(srcX + 72, y);
    g.lineTo(bufX - 2, y);
    g.moveTo(bufX + bufW + 2, y);
    g.lineTo(qX - 2, y);
    g.moveTo(qX + qW + 2, y);
    g.lineTo(gpuX - 2, y);
    g.stroke();
    g.fillStyle = C.dim;
    g.font = '600 10px JetBrains Mono, ui-monospace, monospace';
    g.fillText(gl ? 'SwapBuffers' : submitName, bufX + bufW + 6, y + 12);
    // packets
    const slotW = (bufW - 16) / 6;
    const pkH = 18;
    for (let i = 0; i < 6; i++) {
      const tStart = 0.15 + i * 0.25;
      const tSlot = tStart + 0.45;
      let px: number;
      let py: number;
      let alpha = 1;
      const slotX = bufX + 8 + i * slotW;
      const slotY = y - pkH / 2 + (i % 2 ? 10 : -10);
      if (tau < tStart) continue;
      if (tau < tSlot) {
        const p = (tau - tStart) / 0.45;
        const e = p * p * (3 - 2 * p);
        px = srcX + 20 + (slotX - srcX - 20) * e;
        py = y - pkH / 2 + (slotY - (y - pkH / 2)) * e;
      } else if (tau < 2.5) {
        px = slotX;
        py = slotY;
      } else if (tau < 2.9) {
        // whole buffer travels into the queue
        const p = (tau - 2.5) / 0.4;
        px = slotX + (qX + 6 + (i % 3) * ((qW - 12) / 3) - slotX) * p;
        py = slotY + (y - pkH / 2 + (i < 3 ? -12 : 12) - slotY) * p;
      } else {
        const p = Math.min(1, (tau - 2.9) / 0.45);
        px = qX + 6 + (i % 3) * ((qW - 12) / 3) + (gpuX + gpuW / 2 - qX - 6 - (i % 3) * ((qW - 12) / 3)) * p;
        py = y - pkH / 2 + (i < 3 ? -12 : 12) * (1 - p);
        alpha = 1 - p;
      }
      const wPk = tau >= 2.5 ? (qW - 14) / 3 : slotW - 4;
      const col = labels[i].includes('Draw') ? C.magenta : labels[i].includes('arrier') ? C.amber : gl ? C.muted : apiC;
      g.globalAlpha = alpha;
      g.shadowColor = col;
      g.shadowBlur = 10;
      g.fillStyle = `${col}40`;
      g.strokeStyle = col;
      rrect(g, px, py, wPk, pkH, 4);
      g.fill();
      g.stroke();
      g.shadowBlur = 0;
      if (wPk > 34 && !gl) {
        g.fillStyle = C.text;
        g.font = '600 9px JetBrains Mono, ui-monospace, monospace';
        g.fillText(labels[i].slice(0, Math.floor(wPk / 5.6)), px + 3, py + pkH / 2);
      }
      g.globalAlpha = 1;
    }
    if (gl) {
      // the calls you make, above the hidden box
      g.font = '600 10px JetBrains Mono, ui-monospace, monospace';
      g.fillStyle = C.cyan;
      const k = Math.min(5, Math.floor(tau / 0.4));
      g.fillText(glPk[k] + '(…)', srcX, y + boxH / 2 + 14);
      g.fillStyle = 'rgba(5,6,13,0.55)';
      rrect(g, bufX + 1, y - boxH / 2 + 1, bufW - 2, boxH - 2, 10);
      g.fill();
      g.fillStyle = C.muted;
      g.font = 'italic 600 11px Inter, system-ui, sans-serif';
      g.fillText(t(L('(dold för dig)', '(hidden from you)')), bufX + bufW / 2 - 44, y);
    }
  };

  const canvasHost = h('div.cmdc-canvas');
  wrap.append(canvasHost);
  const cv = liveCanvas(canvasHost, (g, W, Ht, time) => {
    const top = 12;
    const split = step === 3 ? Ht * 0.3 : Ht * 0.62;
    g.save();
    g.globalAlpha = step === 3 ? 0.35 : 1;
    drawPackets(g, W, split - top, time);
    g.restore();
    g.globalAlpha = step === 3 ? 1 : 0.22;
    drawTimeline(g, 14, split + 6, W - 28, Ht - split - 12, 3 + time * 1.05, {
      api,
      lanes,
      cpuLabel: (k) => `${t(L('spelar in', 'record'))} F${k}`,
      gpuLabel: (k) => `${t(L('kör', 'run'))} F${k}`,
      waitLabel: t(L('väntar på fence', 'wait on fence')),
      fenceLabel: t(L('◆ fence: GPU klar med frame → CPU får återanvända dess slot', '◆ fence: GPU done with a frame → the CPU may reuse its slot')),
    });
    g.globalAlpha = 1;
  });

  return {
    show(s, animate) {
      step = s;
      caption.innerHTML = t(captions[s]);
      cv.start();
      cv.redraw();
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: dur(0.35) });
    },
    destroy() {
      cv.destroy();
      gsap.killTweensOf(caption);
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
