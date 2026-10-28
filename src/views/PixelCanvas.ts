/**
 * A 2D canvas that shows a coarse "framebuffer" of `cols × rows` big pixels, scaled to fit its
 * host. Used for rasterization, depth buffer, blending and present slides.
 * All drawing helpers take coordinates in pixel (cell) units, origin top-left.
 */
export class PixelCanvas {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  cell = 8;
  ox = 0;
  oy = 0;
  private ro: ResizeObserver;
  private resizeCbs: (() => void)[] = [];

  constructor(private host: HTMLElement, public cols: number, public rows: number, private padding = 18) {
    this.canvas.className = 'pixel-canvas';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  onResize(cb: () => void): void {
    this.resizeCbs.push(cb);
  }

  get width(): number {
    return this.canvas.width / this.dpr;
  }
  get height(): number {
    return this.canvas.height / this.dpr;
  }
  private get dpr(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const dpr = this.dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cell = Math.max(1, Math.min((w - this.padding * 2) / this.cols, (h - this.padding * 2) / this.rows));
    this.ox = (w - this.cell * this.cols) / 2;
    this.oy = (h - this.cell * this.rows) / 2;
    this.resizeCbs.forEach((cb) => cb());
  }

  /** Cell units → CSS pixels. */
  px(x: number, y: number): [number, number] {
    return [this.ox + x * this.cell, this.oy + y * this.cell];
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Frame + faint grid lines. */
  grid(alpha = 0.12, background = 'rgba(4,6,16,0.85)'): void {
    const { ctx, cell, ox, oy, cols, rows } = this;
    ctx.fillStyle = background;
    ctx.fillRect(ox, oy, cols * cell, rows * cell);
    if (cell >= 4) {
      ctx.strokeStyle = `rgba(140,160,255,${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= cols; x++) {
        ctx.moveTo(Math.round(ox + x * cell) + 0.5, oy);
        ctx.lineTo(Math.round(ox + x * cell) + 0.5, oy + rows * cell);
      }
      for (let y = 0; y <= rows; y++) {
        ctx.moveTo(ox, Math.round(oy + y * cell) + 0.5);
        ctx.lineTo(ox + cols * cell, Math.round(oy + y * cell) + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(140,160,255,0.35)';
    ctx.strokeRect(ox + 0.5, oy + 0.5, cols * cell, rows * cell);
  }

  fillCell(x: number, y: number, color: string, inset = 0): void {
    const [px, py] = this.px(x, y);
    this.ctx.fillStyle = color;
    const i = inset * this.cell;
    this.ctx.fillRect(px + i, py + i, this.cell - i * 2, this.cell - i * 2);
  }

  /** Draw an RGBA image of exactly cols × rows, upscaled with hard pixel edges. */
  image(rgba: Uint8ClampedArray, alpha = 1): void {
    const tmp = document.createElement('canvas');
    tmp.width = this.cols;
    tmp.height = this.rows;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), this.cols, this.rows), 0, 0);
    this.ctx.save();
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(tmp, this.ox, this.oy, this.cols * this.cell, this.rows * this.cell);
    this.ctx.restore();
  }

  triangle(pts: [number, number][], stroke: string, fill?: string, lineWidth = 2, glow = 12): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [px, py] = this.px(x, y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.shadowColor = stroke;
    ctx.shadowBlur = glow;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.restore();
  }

  dot(x: number, y: number, color: string, r = 4): void {
    const [px, py] = this.px(x, y);
    const { ctx } = this;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  text(str: string, x: number, y: number, color = '#e8ebff', size = 12, align: CanvasTextAlign = 'left'): void {
    const [px, py] = this.px(x, y);
    const { ctx } = this;
    ctx.save();
    ctx.font = `600 ${size}px "JetBrains Mono", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(5,6,13,0.8)';
    const w = ctx.measureText(str).width;
    const bx = align === 'center' ? px - w / 2 : align === 'right' ? px - w : px;
    ctx.fillRect(bx - 4, py - size * 0.75, w + 8, size * 1.5);
    ctx.fillStyle = color;
    ctx.fillText(str, px, py);
    ctx.restore();
  }

  destroy(): void {
    this.ro.disconnect();
    this.canvas.remove();
  }
}

/** Map a 0..1 value to a cold→hot heat-map color (for depth / overdraw). */
export function heat(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v));
  const stops: [number, [number, number, number]][] = [
    [0, [255, 250, 220]],
    [0.25, [255, 181, 71]],
    [0.5, [255, 63, 210]],
    [0.75, [110, 70, 255]],
    [1, [10, 14, 40]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const k = (t - a) / (b - a);
      return [0, 1, 2].map((c) => Math.round(ca[c] + (cb[c] - ca[c]) * k)) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

/** Run `frame(progress 0..1)` over `seconds`; returns a cancel function. */
export function animateProgress(seconds: number, frame: (p: number) => void, done?: () => void): () => void {
  let raf = 0;
  const start = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / (seconds * 1000));
    frame(p);
    if (p < 1) raf = requestAnimationFrame(tick);
    else done?.();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
