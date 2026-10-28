import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h, s } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { renderMesh } from '../pipeline/raster';
import { PixelCanvas } from '../views/PixelCanvas';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/present.css';

const REFRESH_MS = 1000 / 60;
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function encodeSrgb(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(toSrgb(i / 255) * 255);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = lut[rgba[i]];
    out[i + 1] = lut[rgba[i + 1]];
    out[i + 2] = lut[rgba[i + 2]];
    out[i + 3] = 255;
  }
  return out;
}

/** Per-API swapchain facts shown in the data view. */
const SWAP: Record<ApiId, { count: number; format: string; srgb: string; modes: [string, string, string] }> = {
  opengl: {
    count: 2,
    format: 'GL_SRGB8_ALPHA8',
    srgb: 'glEnable(GL_FRAMEBUFFER_SRGB)',
    modes: ['SwapInterval(1)', 'SwapInterval(-1) *', 'SwapInterval(0)'],
  },
  vulkan: {
    count: 3,
    format: 'VK_FORMAT_B8G8R8A8_SRGB',
    srgb: 'VK_COLOR_SPACE_SRGB_NONLINEAR_KHR',
    modes: ['PRESENT_MODE_FIFO_KHR', 'PRESENT_MODE_MAILBOX_KHR', 'PRESENT_MODE_IMMEDIATE_KHR'],
  },
  d3d12: {
    count: 2,
    format: 'DXGI_FORMAT_R8G8B8A8_UNORM',
    srgb: 'RTV: R8G8B8A8_UNORM_SRGB',
    modes: ['Present(1, 0)', 'Present(0, 0)', 'Present(0, ALLOW_TEARING)'],
  },
};

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const sw = SWAP[api];
  const IW = 320;
  const IH = 200;
  const final = ctx.derived.render(api, IW, IH);
  const srgb = encodeSrgb(final.color);
  // Three consecutive "frames" (the model keeps turning) for the swap and present-mode views.
  const FW = 160;
  const FH = 100;
  const frames = [0, 1, 2].map((k) => encodeSrgb(ctx.derived.render(api, FW, FH, { rotY: SHOWCASE_ROT_Y + k * 0.45 }).color));

  const screen = h('div.pr-screen');
  const scan = h('div.pr-scan');
  const monitor = h('div.pr-monitor', {}, [screen, scan, h('div.pr-brand', { text: '60 Hz' })]);
  const stand = h('div.pr-stand');
  const monitorWrap = h('div.pr-monwrap', {}, [monitor, stand]);
  const timeline = h('div.pr-timeline');
  const modes = h('div.pr-modes');
  const main = h('div.pr-main', {}, [monitorWrap, timeline, modes]);
  const side = h('div.pr-side');
  const root = h('div.pr-root', {}, [main, side]);
  host.append(root);
  const pc = new PixelCanvas(screen, IW, IH, 0);
  let step = 0;
  let wipe = 0.5;
  let raf = 0;
  let timer = 0;
  let front = 0;
  let measured: number | null = null;

  const blit = (img: Uint8ClampedArray, w: number, hh: number) => {
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = hh;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), w, hh), 0, 0);
    pc.ctx.save();
    pc.ctx.imageSmoothingEnabled = false;
    pc.ctx.drawImage(tmp, pc.ox, pc.oy, pc.cols * pc.cell, pc.rows * pc.cell);
    pc.ctx.restore();
  };
  const draw = () => {
    pc.clear();
    if (step === 0) {
      blit(final.color, IW, IH);
      const cut = Math.round(wipe * IW);
      const [x] = pc.px(cut, 0);
      pc.ctx.save();
      pc.ctx.beginPath();
      pc.ctx.rect(x, pc.oy, pc.width - x, IH * pc.cell);
      pc.ctx.clip();
      blit(srgb, IW, IH);
      pc.ctx.restore();
      pc.ctx.save();
      pc.ctx.fillStyle = '#fff';
      pc.ctx.shadowColor = '#38e1ff';
      pc.ctx.shadowBlur = 14;
      pc.ctx.fillRect(x - 1, pc.oy, 2, IH * pc.cell);
      pc.ctx.restore();
      pc.text(t(L('linjärt', 'linear')), cut - 4, 8, '#ffb547', 11, 'right');
      pc.text('sRGB', cut + 4, 8, '#38e1ff', 11, 'left');
    } else {
      blit(frames[front], FW, FH);
    }
  };
  pc.onResize(draw);

  // Linear → sRGB numbers for one mid-tone pixel on the model.
  let probe = (IH >> 1) * IW + (IW >> 1);
  for (let best = Infinity, p = 0; p < IW * IH; p++) {
    if (final.depth[p] >= 1) continue;
    const d = Math.abs(final.color[p * 4] / 255 - 0.42) + Math.abs(final.color[p * 4 + 2] / 255 - 0.1);
    if (d < best) {
      best = d;
      probe = p;
    }
  }
  const lin = [0, 1, 2].map((i) => final.color[probe * 4 + i]);

  const thumbs = () =>
    Array.from({ length: sw.count }, (_, i) => {
      const role = i === front ? 'front' : i === (front + 1) % sw.count ? 'back' : 'queued';
      return `<div class="pr-thumb ${role}"><canvas data-i="${i}" width="${FW}" height="${FH}"></canvas><span>${api === 'opengl' ? (i === front ? 'FRONT' : 'BACK') : `#${i}`} · ${role === 'front' ? t(L('visas', 'on screen')) : role === 'back' ? t(L('ritas i', 'being drawn')) : t(L('ledig', 'free'))}</span></div>`;
    }).join('');
  const paintThumbs = () =>
    side.querySelectorAll<HTMLCanvasElement>('.pr-thumb canvas').forEach((c) => {
      const i = Number(c.dataset.i);
      const img = frames[i % frames.length];
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), FW, FH), 0, 0);
    });

  const row = (k: string, v: string, cls = '') => `<div class="pr-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const mb = (bytes: number) => (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`);
  const updateSide = () => {
    if (step === 0) {
      side.innerHTML = `<h4>${t(L('Färdig back buffer', 'Finished back buffer'))}</h4>
        ${row(t(L('upplösning', 'resolution')), `${IW}×${IH}`)}
        ${row(t(L('storlek (RGBA8)', 'size (RGBA8)')), mb(IW * IH * 4))}
        ${row('@ 1920×1080', mb(1920 * 1080 * 4))}
        ${row(t(L('format', 'format')), sw.format.replace('VK_FORMAT_', '').replace('DXGI_FORMAT_', '').replace('GL_', ''), 'glow-cyan')}
        <div class="pr-srgb">${['R', 'G', 'B'].map((c, i) => `<div><span>${c}</span>${(lin[i] / 255).toFixed(3)} → <b>${toSrgb(lin[i] / 255).toFixed(3)}</b></div>`).join('')}</div>
        <p class="pr-note">${t(L('Shadern räknar i <b>linjärt</b> ljus. Skärmen förväntar sig <b>sRGB</b>-kodade värden (≈ gamma 2.2). Ett sRGB-format kodar automatiskt vid skrivning. Utan det blir bilden för mörk (vänster).', 'The shader computes in <b>linear</b> light. The display expects <b>sRGB</b>-encoded values (≈ gamma 2.2). An sRGB format encodes automatically on write. Without it the image is too dark (left).'))}</p>
        <p class="pr-note">${sw.srgb}</p>`;
    } else if (step === 1) {
      side.innerHTML = `<h4>${t(L('Swapchain', 'Swapchain'))} · ${sw.count} ${t(L('bilder', 'images'))}</h4>
        <div class="pr-thumbs">${thumbs()}</div>
        <p class="pr-note">${t(
          api === 'opengl'
            ? L('Standard-framebuffern är dubbelbuffrad: du ritar i BACK medan FRONT visas. SwapBuffers byter roller.', 'The default framebuffer is double-buffered: you draw into BACK while FRONT is shown. SwapBuffers swaps the roles.')
            : api === 'vulkan'
              ? L('vkAcquireNextImageKHR ger index till nästa lediga bild; vkQueuePresentKHR lämnar tillbaka den för visning.', 'vkAcquireNextImageKHR hands out the index of the next free image; vkQueuePresentKHR gives it back for display.')
              : L('GetCurrentBackBufferIndex() säger vilken buffert du ska rita i; Present() vänder (flip) till nästa.', 'GetCurrentBackBufferIndex() says which buffer to draw into; Present() flips to the next one.'),
        )}</p>`;
      paintThumbs();
    } else if (step === 2) {
      const n = measured === null ? null : Math.max(1, Math.ceil(measured / REFRESH_MS));
      side.innerHTML = `<h4>${t(L('Tajming med vsync', 'Timing with vsync'))}</h4>
        ${row(t(L('uppdatering', 'refresh')), `60 Hz = ${REFRESH_MS.toFixed(2)} ms`, 'glow-amber')}
        ${row(t(L('denna frame i JS (CPU)', 'this frame in JS (CPU)')), measured === null ? '…' : `${measured.toFixed(1)} ms`, 'glow-cyan')}
        ${n === null ? '' : row(t(L('vsync-intervall per frame', 'vsync intervals per frame')), String(n))}
        ${n === null ? '' : row(t(L('bildfrekvens', 'frame rate')), `${(60 / n).toFixed(n === 1 ? 0 : 1)} fps`, n === 1 ? 'c-idx' : 'pr-neg')}
        <p class="pr-note">${t(L('Med vsync (FIFO) visas en ny bild bara vid vertical blank. Missar en frame sin deadline visas den förra en gång till – bildfrekvensen hoppar till 30, 20 … fps. En GPU ritar den här bilden på en bråkdel av en millisekund.', 'With vsync (FIFO) a new image is shown only at vertical blank. If a frame misses its deadline the previous one is shown again – the frame rate drops to 30, 20 … fps. A GPU draws this image in a fraction of a millisecond.'))}</p>`;
    } else {
      side.innerHTML = `<h4>${t(L('Presentationslägen', 'Present modes'))}</h4>
        ${[
          [L('vänta på vblank, kö', 'wait for vblank, queue'), 'FIFO', 'c-idx'],
          [L('vblank, nyaste vinner', 'vblank, newest wins'), 'MAILBOX', 'glow-cyan'],
          [L('direkt – kan riva', 'immediately – may tear'), 'IMMEDIATE', 'pr-neg'],
        ]
          .map(([d, n, c], i) => `<div class="pr-mode"><b class="${c}">${n}</b><code>${sw.modes[i]}</code><span>${t(d as L)}</span></div>`)
          .join('')}
        <p class="pr-note">${t(
          api === 'opengl'
            ? L('* Negativt intervall = <i>adaptive vsync</i> (EXT_swap_control_tear) – riva bara när en frame är sen. OpenGL har inget riktigt MAILBOX.', '* A negative interval = <i>adaptive vsync</i> (EXT_swap_control_tear) – tear only when a frame is late. OpenGL has no true MAILBOX.')
            : api === 'vulkan'
              ? L('FIFO är det enda läge som alltid finns. Kolla vkGetPhysicalDeviceSurfacePresentModesKHR för resten.', 'FIFO is the only mode guaranteed to exist. Check vkGetPhysicalDeviceSurfacePresentModesKHR for the rest.')
              : L('Tearing kräver DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING på swapchainen och stöd enligt CheckFeatureSupport.', 'Tearing needs DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING on the swapchain and support per CheckFeatureSupport.'),
        )}</p>`;
    }
  };

  // Timeline (step 2): double-buffered FIFO, frames start when the previous one is flipped on.
  const buildTimeline = () => {
    const X = measured ?? 0;
    const per = Math.max(1, Math.ceil(X / REFRESH_MS));
    const intervals = Math.min(36, Math.max(6, per * 3));
    const total = intervals * REFRESH_MS;
    const VW = 620;
    const VH = 250;
    const m = { l: 92, r: 26, t: 26, b: 30 };
    const T = (ms: number) => m.l + (ms / total) * (VW - m.l - m.r);
    const rows = [
      { y: 60, name: t(L('Rendering', 'Rendering')) },
      { y: 120, name: 'Present' },
      { y: 180, name: t(L('Skärmen', 'Display')) },
    ];
    const els: SVGElement[] = [];
    rows.forEach((r) => els.push(s('text', { x: 10, y: r.y + 5, class: 'pr-tl-name' }, [r.name])));
    for (let i = 0; i <= intervals; i++) {
      const x = T(i * REFRESH_MS);
      els.push(s('line', { x1: x, x2: x, y1: m.t, y2: VH - m.b, class: 'pr-vsync' }));
      if (intervals <= 12 || i % Math.ceil(intervals / 12) === 0) els.push(s('text', { x, y: VH - 10, 'text-anchor': 'middle', class: 'pr-tl-tick' }, [`${(i * REFRESH_MS).toFixed(i ? 1 : 0)}`]));
    }
    els.push(s('text', { x: T(0) + 2, y: 16, class: 'pr-tl-tick' }, ['vsync ↓ ms']));
    const hues = ['#38e1ff', '#ff3fd2', '#ffb547', '#5cf08f', '#9b7bff'];
    let start = 0;
    let k = 0;
    let lastShown = -1;
    while (start < total && k < 40) {
      const end = start + Math.max(X, 0.4);
      const v = Math.max(Math.ceil(end / REFRESH_MS - 1e-9), lastShown + 1) * REFRESH_MS;
      const col = hues[k % hues.length];
      els.push(s('rect', { x: T(start), y: rows[0].y - 13, width: Math.max(2, T(end) - T(start)), height: 26, rx: 5, fill: col, class: 'pr-block' }));
      if (T(end) - T(start) > 26) els.push(s('text', { x: (T(start) + T(Math.min(end, total))) / 2, y: rows[0].y + 4, 'text-anchor': 'middle', class: 'pr-tl-lbl' }, [`#${k}`]));
      if (v < total) {
        els.push(s('line', { x1: T(Math.min(end, total)), y1: rows[0].y + 13, x2: T(v), y2: rows[1].y - 4, class: 'pr-arrow', stroke: col }));
        els.push(s('circle', { cx: T(v), cy: rows[1].y, r: 5, fill: col, class: 'pr-dot' }));
        const nextV = Math.max(v + REFRESH_MS, (Math.ceil((v + Math.max(X, 0.4)) / REFRESH_MS - 1e-9)) * REFRESH_MS);
        els.push(s('rect', { x: T(v), y: rows[2].y - 13, width: Math.max(2, T(Math.min(nextV, total)) - T(v)), height: 26, fill: col, opacity: 0.35, class: 'pr-block' }));
        els.push(s('text', { x: T(v) + 6, y: rows[2].y + 4, class: 'pr-tl-lbl' }, [`#${k}`]));
      }
      lastShown = Math.round(v / REFRESH_MS);
      start = v; // double buffering: the next frame can start once this one is flipped on
      k++;
    }
    const glow = s('line', { x1: T(0), x2: T(0), y1: m.t - 6, y2: VH - m.b, class: 'pr-playhead glow' });
    const playhead = s('line', { x1: T(0), x2: T(0), y1: m.t - 6, y2: VH - m.b, class: 'pr-playhead' });
    els.push(glow, playhead);
    const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'pr-tl-svg', preserveAspectRatio: 'xMidYMid meet' }, els);
    timeline.replaceChildren(svg);
    const t0 = performance.now();
    const tick = () => {
      const p = ((performance.now() - t0) / (total * 12)) % 1; // 12× slow motion
      const x = T(p * total);
      for (const l of [glow, playhead]) {
        l.setAttribute('x1', String(x));
        l.setAttribute('x2', String(x));
      }
      raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };

  // Present modes (step 3): FIFO and MAILBOX show whole frames; IMMEDIATE flips mid-scan and tears.
  const buildModes = () => {
    const names = ['FIFO', 'MAILBOX', 'IMMEDIATE'];
    modes.replaceChildren(
      ...names.map((n, i) => {
        const c = h('canvas', { attrs: { width: FW, height: FH } });
        let img: Uint8ClampedArray;
        if (i < 2) img = frames[i === 0 ? 1 : 2];
        else {
          img = new Uint8ClampedArray(frames[1]);
          const tear = Math.round(FH * 0.46);
          img.set(frames[2].subarray(0, tear * FW * 4), 0);
        }
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), FW, FH), 0, 0);
        return h(`div.pr-mini${i === 2 ? '.tear' : ''}`, {}, [h('div.pr-mini-screen', {}, [c, i === 2 ? h('div.pr-tearline') : null]), h('b', { text: n }), h('code', { text: sw.modes[i] })]);
      }),
    );
  };

  const setView = () => {
    monitorWrap.style.display = step <= 1 ? '' : 'none';
    timeline.style.display = step === 2 ? '' : 'none';
    modes.style.display = step === 3 ? '' : 'none';
    scan.classList.toggle('on', step === 1);
  };

  return {
    show(st, animate) {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      step = st;
      front = 0;
      setView();
      if (st === 0) {
        wipe = 0.5;
        if (animate) {
          const t0 = performance.now();
          const tick = () => {
            const p = Math.min(1, (performance.now() - t0) / (dur(1.6) * 1000));
            wipe = 1 - 0.5 * (1 - Math.pow(1 - p, 3));
            draw();
            if (p < 1) raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        }
      }
      if (st === 1) {
        // A slowed-down refresh: the scanline sweeps the screen, and at every vblank the buffers swap.
        const t0 = performance.now();
        const PERIOD = 1800;
        let last = 0;
        const tick = () => {
          const el = performance.now() - t0;
          const n = Math.floor(el / PERIOD);
          scan.style.top = `${((el % PERIOD) / PERIOD) * 100}%`;
          if (n !== last) {
            last = n;
            front = n % sw.count;
            draw();
            updateSide();
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
      if (st === 2) {
        buildTimeline();
        if (measured === null) {
          timer = window.setTimeout(() => {
            const t0 = performance.now();
            renderMesh(ctx.state.mesh, api, IW, IH, { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X });
            measured = performance.now() - t0;
            if (step === 2) {
              buildTimeline();
              updateSide();
            }
          }, 60);
        }
      }
      if (st === 3) buildModes();
      draw();
      updateSide();
      if (animate) {
        side.animate([{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.4) * 1000, easing: 'ease-out' });
        if (st === 3) modes.querySelectorAll('.pr-mini').forEach((m, i) => m.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.45) * 1000, delay: i * 90, fill: 'backwards' }));
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      pc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: frames flowing from back buffer to screen                  */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const canvas = h('canvas.v-fill');
  const caption = h('div.pr-caption');
  host.append(canvas, caption);
  const g = canvas.getContext('2d')!;
  let W = 0;
  let H = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  let step = 0;
  let t0 = performance.now();
  let raf = 0;
  const REF = 1.6; // seconds per (slowed-down) refresh

  /** A procedural "frame": gradient sky, a moving bar and a ball, numbered. */
  const frameArt = (x: number, y: number, w: number, hh: number, k: number, reveal = 1) => {
    g.save();
    g.beginPath();
    g.rect(x, y, w, hh * reveal);
    g.clip();
    const hue = (200 + k * 47) % 360;
    const grad = g.createLinearGradient(x, y, x + w, y + hh);
    grad.addColorStop(0, `hsl(${hue},70%,22%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360},70%,12%)`);
    g.fillStyle = grad;
    g.fillRect(x, y, w, hh);
    const bx = x + w * (0.12 + ((k * 0.19) % 0.76));
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(bx, y, w * 0.06, hh);
    g.fillStyle = `hsl(${(hue + 180) % 360},90%,62%)`;
    g.shadowColor = g.fillStyle;
    g.shadowBlur = 16;
    g.beginPath();
    g.arc(x + w * (0.25 + ((k * 0.31) % 0.5)), y + hh * 0.55, hh * 0.16, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.font = `700 ${Math.round(hh * 0.13)}px "JetBrains Mono", monospace`;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillText(`#${k}`, x + 8, y + hh * 0.17);
    g.restore();
  };
  const monitor = (x: number, y: number, w: number, hh: number, label?: string) => {
    g.save();
    g.fillStyle = '#0b0e1f';
    g.strokeStyle = 'rgba(140,160,255,0.45)';
    g.lineWidth = 2;
    g.shadowColor = 'rgba(56,225,255,0.35)';
    g.shadowBlur = 24;
    g.beginPath();
    g.roundRect(x - 10, y - 10, w + 20, hh + 20, 12);
    g.fill();
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(140,160,255,0.35)';
    g.fillRect(x + w / 2 - 6, y + hh + 10, 12, 14);
    g.fillRect(x + w / 2 - 40, y + hh + 24, 80, 4);
    if (label) {
      g.font = '700 12px Inter, sans-serif';
      g.fillStyle = '#e8ebff';
      g.textAlign = 'center';
      g.fillText(label, x + w / 2, y - 18);
    }
    g.restore();
  };
  const scanline = (x: number, y: number, w: number, hh: number, p: number) => {
    const sy = y + p * hh;
    const grad = g.createLinearGradient(0, sy - 26, 0, sy);
    grad.addColorStop(0, 'rgba(56,225,255,0)');
    grad.addColorStop(1, 'rgba(56,225,255,0.35)');
    g.fillStyle = grad;
    g.fillRect(x, sy - 26, w, 26);
    g.fillStyle = '#bff6ff';
    g.shadowColor = '#38e1ff';
    g.shadowBlur = 12;
    g.fillRect(x, sy - 1, w, 2);
    g.shadowBlur = 0;
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const tt = (now - t0) / 1000;
    g.clearRect(0, 0, W, H);
    if (W < 120 || H < 140) return;
    const avail = H - 60;
    const refreshes = Math.floor(tt / REF);
    const scanP = (tt % REF) / REF;

    if (step <= 1) {
      const mw = Math.min(W * 0.5, avail * 1.25);
      const mh = mw / 1.6;
      const mx = step === 0 ? (W - mw) / 2 : W - mw - 30;
      const my = (avail - mh) / 2 + 10;
      monitor(mx, my, mw, mh, step === 0 ? undefined : t(L('skärm (front buffer)', 'display (front buffer)')));
      const shown = step === 0 ? 1 : refreshes + 1;
      frameArt(mx, my, mw, mh, shown);
      scanline(mx, my, mw, mh, scanP);
      if (step === 0) {
        g.save();
        g.font = '600 12px "JetBrains Mono", monospace';
        g.fillStyle = '#9aa3c7';
        g.textAlign = 'center';
        g.fillText(t(L(`uppdatering ${refreshes + 1} · samma bild ritas om rad för rad`, `refresh ${refreshes + 1} · the same image is scanned out line by line`)), W / 2, my + mh + 50);
        g.restore();
      }
      if (step === 1) {
        // The back buffer being drawn, then flipped forward at vblank.
        const bw = mw * 0.55;
        const bh = bw / 1.6;
        const bx = 40;
        const by = my + (mh - bh) / 2;
        const k = refreshes + 2;
        const flip = scanP > 0.9 ? (scanP - 0.9) / 0.1 : 0;
        g.save();
        g.strokeStyle = 'rgba(255,181,71,0.8)';
        g.setLineDash([5, 5]);
        g.strokeRect(bx - 4, by - 4, bw + 8, bh + 8);
        g.restore();
        g.font = '700 12px Inter, sans-serif';
        g.fillStyle = '#ffb547';
        g.fillText(t(L('back buffer – GPU:n ritar', 'back buffer – the GPU draws')), bx, by - 14);
        const reveal = Math.min(1, scanP / 0.7);
        frameArt(bx, by, bw, bh, k, reveal);
        if (reveal < 1) {
          g.fillStyle = 'rgba(255,181,71,0.9)';
          g.fillRect(bx, by + bh * reveal - 1, bw, 2);
        }
        if (flip > 0) {
          const e = flip * flip;
          const fx = bx + (mx - bx) * e;
          const fy = by + (my - by) * e;
          g.globalAlpha = 0.8;
          frameArt(fx, fy, bw + (mw - bw) * e, bh + (mh - bh) * e, k);
          g.globalAlpha = 1;
        }
        // Arrow.
        g.save();
        g.strokeStyle = `rgba(56,225,255,${0.3 + 0.7 * flip})`;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(bx + bw + 12, by + bh / 2);
        g.lineTo(mx - 20, by + bh / 2);
        g.stroke();
        g.fillStyle = g.strokeStyle;
        g.beginPath();
        g.moveTo(mx - 14, by + bh / 2);
        g.lineTo(mx - 24, by + bh / 2 - 6);
        g.lineTo(mx - 24, by + bh / 2 + 6);
        g.fill();
        g.font = '700 11px "JetBrains Mono", monospace';
        g.textAlign = 'center';
        g.fillText('swap @ vblank', (bx + bw + mx) / 2, by + bh / 2 - 10);
        g.restore();
      }
    } else if (step === 2) {
      // A vsync strip: frame times vary; a late frame repeats the previous image (stutter).
      const x0 = 30;
      const x1 = W - 30;
      const n = 8;
      const cw = (x1 - x0) / n;
      const y = avail * 0.25;
      const work = [0.55, 0.7, 0.6, 1.45, 0.5, 0.65, 0.8, 0.55];
      // When each frame becomes visible.
      const shownAt: number[] = [];
      let start = 0;
      work.forEach((w, i) => {
        const end = start + w;
        const v = Math.max(Math.ceil(end - 1e-9), (shownAt[i - 1] ?? 0) + 1);
        shownAt.push(v);
        start = v;
      });
      const cycle = n * REF;
      const ph = (tt % cycle) / REF;
      g.save();
      g.font = '600 11px Inter, sans-serif';
      g.fillStyle = '#9aa3c7';
      g.fillText(t(L('GPU-arbete', 'GPU work')), x0, y - 22);
      g.fillText(t(L('på skärmen', 'on screen')), x0, y + 76);
      for (let i = 0; i <= n; i++) {
        g.strokeStyle = 'rgba(255,181,71,0.5)';
        g.beginPath();
        g.moveTo(x0 + i * cw, y - 12);
        g.lineTo(x0 + i * cw, y + 120);
        g.stroke();
        g.fillStyle = '#ffb547';
        g.font = '600 10px "JetBrains Mono", monospace';
        if (i < n) g.fillText(`vsync ${(i * 16.67).toFixed(1)} ms`, x0 + i * cw + 3, y + 134);
      }
      let s0 = 0;
      work.forEach((w, i) => {
        const hue = (200 + i * 47) % 360;
        if (s0 >= n) return;
        const late = w > 1;
        g.fillStyle = `hsla(${hue},80%,60%,${ph >= s0 ? 0.9 : 0.25})`;
        g.fillRect(x0 + s0 * cw + 2, y, Math.min(w, n - s0) * cw - 4, 24);
        g.fillStyle = '#05060d';
        g.font = '700 11px "JetBrains Mono", monospace';
        g.fillText(`#${i}${late ? ' late!' : ''}`, x0 + s0 * cw + 8, y + 16);
        s0 = shownAt[i];
      });
      // Display row.
      for (let slot = 0; slot < n; slot++) {
        let k = -1;
        shownAt.forEach((v, i) => {
          if (v <= slot) k = i;
        });
        const fx = x0 + slot * cw + 3;
        if (k >= 0) frameArt(fx, y + 44, cw - 6, Math.min(56, (cw - 6) / 1.6), k);
        if (k >= 0 && slot > 0 && shownAt[k] < slot) {
          g.fillStyle = '#ff5a6e';
          g.font = '700 11px Inter, sans-serif';
          g.fillText(t(L('igen!', 'again!')), fx + 4, y + 44 + Math.min(56, (cw - 6) / 1.6) + 14);
        }
      }
      g.fillStyle = '#fff';
      g.shadowColor = '#fff';
      g.shadowBlur = 10;
      g.fillRect(x0 + ph * cw - 1, y - 14, 2, 136);
      g.restore();
    } else {
      // Tearing: IMMEDIATE swaps mid-scan; FIFO waits for vblank.
      const mw = Math.min((W - 120) / 2, avail * 1.2);
      const mh = mw / 1.6;
      const my = (avail - mh) / 2 + 18;
      const xs = [W / 2 - mw - 30, W / 2 + 30];
      const k = refreshes + 1;
      const presentAt = 0.45;
      xs.forEach((mx, i) => {
        monitor(mx, my, mw, mh, i === 0 ? 'FIFO (vsync)' : 'IMMEDIATE');
        if (i === 0) frameArt(mx, my, mw, mh, k);
        else {
          // Lines above the scan position at present time show the new frame.
          frameArt(mx, my, mw, mh, k);
          if (scanP > presentAt) {
            g.save();
            g.beginPath();
            g.rect(mx, my, mw, mh * presentAt);
            g.clip();
            frameArt(mx, my, mw, mh, k + 1);
            g.restore();
            g.strokeStyle = '#ff5a6e';
            g.shadowColor = '#ff5a6e';
            g.shadowBlur = 10;
            g.lineWidth = 2;
            g.setLineDash([6, 4]);
            g.beginPath();
            g.moveTo(mx - 6, my + mh * presentAt);
            g.lineTo(mx + mw + 6, my + mh * presentAt);
            g.stroke();
            g.setLineDash([]);
            g.shadowBlur = 0;
            g.font = '700 11px Inter, sans-serif';
            g.fillStyle = '#ff5a6e';
            g.fillText('tear', mx + mw + 10, my + mh * presentAt + 4);
          }
        }
        scanline(mx, my, mw, mh, scanP);
      });
    }
  };
  raf = requestAnimationFrame(frame);

  const captions = [
    L('Skärmen ritar om bilden uppifrån och ned, rad för rad, 60 gånger per sekund (här i slow motion).', 'The display redraws the image top to bottom, line by line, 60 times per second (here in slow motion).'),
    L('GPU:n ritar nästa bild i en <b>back buffer</b> medan skärmen visar <b>front buffern</b>. Vid vblank byter de plats.', 'The GPU draws the next image into a <b>back buffer</b> while the display shows the <b>front buffer</b>. At vblank they swap.'),
    L('Med vsync måste varje bild vara klar till nästa vsync. En sen bild gör att den förra visas igen – <b>stutter</b>.', 'With vsync every image must be ready by the next vsync. A late image means the previous one is shown again – <b>stutter</b>.'),
    L('Utan vsync byts bilden mitt i uppritningen: övre delen visar nästa bild – en <b>tearing</b>-linje.', 'Without vsync the image is swapped mid-scan: the top part shows the next image – a <b>tearing</b> line.'),
  ];
  return {
    show(st, animate) {
      step = st;
      t0 = performance.now();
      caption.innerHTML = t(captions[st]);
      if (animate) caption.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.4) * 1000, easing: 'ease-out' });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const gl = `// The default framebuffer is created with the window (WGL/GLX/EGL)
glfwWindowHint(GLFW_DOUBLEBUFFER, GLFW_TRUE);
glfwWindowHint(GLFW_SRGB_CAPABLE, GLFW_TRUE);
glfwSwapInterval(1);                // 1 = vsync, 0 = off, -1 = adaptive

while (!glfwWindowShouldClose(window)) {
    glEnable(GL_FRAMEBUFFER_SRGB);  // encode linear → sRGB on write
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    drawScene();                    // into the back buffer
    glfwSwapBuffers(window);        // SwapBuffers(hdc) / glXSwapBuffers
    glfwPollEvents();
}`;
  const vk = `VkSwapchainCreateInfoKHR sc{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
sc.surface          = surface;
sc.minImageCount    = caps.minImageCount + 1;         // e.g. 3
sc.imageFormat      = VK_FORMAT_B8G8R8A8_SRGB;
sc.imageColorSpace  = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
sc.imageUsage       = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
sc.presentMode      = VK_PRESENT_MODE_FIFO_KHR;       // vsync; MAILBOX, IMMEDIATE
vkCreateSwapchainKHR(device, &sc, nullptr, &swapchain);

vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, acquired, VK_NULL_HANDLE, &idx);
// ... render into images[idx], then barrier (synchronization2):
//     COLOR_ATTACHMENT_OPTIMAL → VK_IMAGE_LAYOUT_PRESENT_SRC_KHR
VkPresentInfoKHR pi{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
pi.waitSemaphoreCount = 1;  pi.pWaitSemaphores = &renderDone;
pi.swapchainCount     = 1;  pi.pSwapchains = &swapchain;  pi.pImageIndices = &idx;
vkQueuePresentKHR(queue, &pi);`;
  const dx = `DXGI_SWAP_CHAIN_DESC1 sd{};
sd.Width = w;  sd.Height = h;
sd.Format      = DXGI_FORMAT_R8G8B8A8_UNORM;   // RTV uses ..._UNORM_SRGB
sd.SampleDesc  = { 1, 0 };
sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
sd.BufferCount = 2;
sd.SwapEffect  = DXGI_SWAP_EFFECT_FLIP_DISCARD;
sd.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
factory->CreateSwapChainForHwnd(queue, hwnd, &sd, nullptr, nullptr, &sc1);
sc1.As(&swapChain);                            // IDXGISwapChain4
HANDLE waitable = swapChain->GetFrameLatencyWaitableObject();

WaitForSingleObjectEx(waitable, 1000, TRUE);   // limit queued frames
UINT i = swapChain->GetCurrentBackBufferIndex();
// ... render into backBuffers[i] (barrier RENDER_TARGET → PRESENT)
swapChain->Present(1, 0);                      // sync interval 1 = vsync`;
  return {
    opengl: {
      note: L(
        'OpenGL har ingen egen swapchain: standard-framebuffern och dess back buffer skapas av fönstersystemet (WGL, GLX, EGL – här via GLFW). Du byter med SwapBuffers.',
        'OpenGL has no swapchain object of its own: the default framebuffer and its back buffer are created by the window system (WGL, GLX, EGL – here via GLFW). You swap with SwapBuffers.',
      ),
      code: [{ lang: 'cpp', src: gl, highlight: [[3, 7], [2, 8, 9, 10], [4, 10], [4]] }],
      terms: [
        { term: 'front / back buffer', desc: L('Front visas på skärmen, back är den du ritar i.', 'Front is shown on screen, back is the one you draw into.') },
        { term: 'swap interval', desc: L('Antal vblanks att vänta per swap: 1 = vsync, 0 = direkt (tearing).', 'Number of vblanks to wait per swap: 1 = vsync, 0 = immediately (tearing).') },
        { term: 'GL_FRAMEBUFFER_SRGB', desc: L('Linjär → sRGB-kodning vid skrivning, om framebuffern är sRGB-kapabel.', 'Linear → sRGB encoding on write, if the framebuffer is sRGB-capable.') },
      ],
      you: L('anropar SwapBuffers', 'call SwapBuffers'),
      driver: L('fönstersystemet visar bilden', 'the window system shows the image'),
    },
    vulkan: {
      note: L(
        'I Vulkan är swapchainen ett eget objekt (VK_KHR_swapchain). Du hämtar en bild, ritar, byter layout till PRESENT_SRC_KHR och lämnar den till presentationsmotorn – synkat med semaforer.',
        'In Vulkan the swapchain is an explicit object (VK_KHR_swapchain). You acquire an image, render, transition it to PRESENT_SRC_KHR and hand it to the presentation engine – synchronized with semaphores.',
      ),
      code: [{ lang: 'cpp', src: vk, highlight: [[4, 5], [3, 10, 11, 12, 13, 14, 15, 16], [7, 16], [7]] }],
      terms: [
        { term: 'VkSwapchainKHR', desc: L('En kö av bilder som delas med skärmens presentationsmotor.', 'A queue of images shared with the display\'s presentation engine.') },
        { term: 'PRESENT_SRC_KHR', desc: L('Bildlayout som krävs innan en bild får presenteras.', 'Image layout required before an image may be presented.') },
        { term: 'FIFO / MAILBOX / IMMEDIATE', desc: L('Vsync med kö / vsync där nyaste ersätter köad bild / ingen väntan (tearing).', 'Vsync with a queue / vsync where the newest replaces the queued image / no wait (tearing).') },
        { term: 'semaphore', desc: L('GPU-signal: acquire → rendering → present, utan att CPU:n väntar.', 'GPU signal: acquire → rendering → present, without the CPU waiting.') },
      ],
      you: L('acquire, barriär, present, synk', 'acquire, barrier, present, sync'),
      driver: L('presentationsmotorn visar bilden', 'the presentation engine shows the image'),
    },
    d3d12: {
      note: L(
        'I D3D12 sköter DXGI presentationen. Flip-modellen (FLIP_DISCARD) byter buffertar utan kopiering; du ritar i GetCurrentBackBufferIndex() och anropar Present.',
        'In D3D12, DXGI handles presentation. The flip model (FLIP_DISCARD) swaps buffers without copying; you draw into GetCurrentBackBufferIndex() and call Present.',
      ),
      code: [{ lang: 'cpp', src: dx, highlight: [[3], [6, 7, 9, 10, 14, 15, 16], [8, 11, 13, 16], [16]] }],
      terms: [
        { term: 'IDXGISwapChain4', desc: L('Swapchain-gränssnittet; ger HDR-metadata, färgrymd m.m.', 'The swapchain interface; adds HDR metadata, color space etc.') },
        { term: 'FLIP_DISCARD', desc: L('Flip-modell: bufferten byts ut, innehållet efter Present är odefinierat.', 'Flip model: the buffer is flipped, its contents after Present are undefined.') },
        { term: 'Present(1, 0)', desc: L('SyncInterval 1 = vänta en vblank (vsync). 0 + ALLOW_TEARING = direkt.', 'SyncInterval 1 = wait one vblank (vsync). 0 + ALLOW_TEARING = immediately.') },
        { term: 'frame latency waitable', desc: L('Ett event som signaleras när en ny frame får börja – minskar input lag.', 'An event signaled when a new frame may start – reduces input lag.') },
      ],
      you: L('Present + väntan på latens', 'Present + latency wait'),
      driver: L('DXGI/DWM visar bilden', 'DXGI/DWM shows the image'),
    },
  };
}

export default standardSlide({
  id: 'present',
  group: 'gpu-fixed',
  short: L('Present', 'Present'),
  title: L('Present – bilden når skärmen', 'Present – the image reaches the screen'),
  lead: L(
    'Den färdiga bilden ligger i en <b>back buffer</b>. Present lämnar över den till skärmen, i takt med skärmens uppdatering.',
    'The finished image sits in a <b>back buffer</b>. Present hands it over to the display, in step with the display\'s refresh.',
  ),
  bullets: [
    L(
      'Bilden är klar. Shaders räknar i <b>linjärt</b> ljus, men skärmen vill ha <b>sRGB</b>: ett sRGB-format kodar om värdena när de skrivs.',
      'The image is done. Shaders compute in <b>linear</b> light, but the display wants <b>sRGB</b>: an sRGB format re-encodes the values as they are written.',
    ),
    L(
      '<b>Dubbel- eller trippelbuffring</b>: GPU:n ritar i back buffern medan skärmen visar front buffern. Vid present byter de roller.',
      '<b>Double or triple buffering</b>: the GPU draws into the back buffer while the display shows the front buffer. At present they swap roles.',
    ),
    L(
      'Skärmen uppdateras t.ex. <b>60 Hz = 16,67 ms</b>. Med <b>vsync</b> byts bilden bara vid vertical blank; en sen frame visas en uppdatering senare.',
      'The display refreshes at e.g. <b>60 Hz = 16.67 ms</b>. With <b>vsync</b> the image only changes at vertical blank; a late frame is shown one refresh later.',
    ),
    L(
      '<b>Presentationslägen</b>: FIFO (vsync), MAILBOX (låg latens utan tearing) och IMMEDIATE (ingen väntan – kan ge <b>tearing</b>).',
      '<b>Present modes</b>: FIFO (vsync), MAILBOX (low latency without tearing) and IMMEDIATE (no wait – may cause <b>tearing</b>).',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
