import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { PANEL_W, wrapText, type PanelInfo } from './panelLayout';

export const GROUP_COLOR: Record<string, string> = {
  cpu: '#38e1ff',
  api: '#9b7bff',
  'gpu-prog': '#ff3fd2',
  'gpu-fixed': '#ffb547',
};
export const API_COLOR: Record<string, string> = { opengl: '#5aa9e6', vulkan: '#ff4d64', d3d12: '#6cd04a' };
const API_NAME: Record<string, string> = { opengl: 'OpenGL', vulkan: 'Vulkan', d3d12: 'DirectX 12' };

/** A stage the user is pointing at in the stage strip ("jump to …" preview). */
export interface StagePreview {
  index: number;
  short: string;
  group: string;
}

/**
 * The console's info screen: stage group and number, title, the current bullet, up to three key
 * numbers and the step dots, drawn onto a canvas texture.
 */
export class XRPanel {
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private ctx2d: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private last: PanelInfo | null = null;
  private preview: StagePreview | null = null;
  readonly W = PANEL_W;
  readonly H: number;

  constructor(
    readonly width = 0.36,
    readonly height = 0.23,
  ) {
    this.H = Math.round((PANEL_W * height) / width);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx2d = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthWrite: false }));
    this.mesh.renderOrder = 20;
  }

  setPreview(p: StagePreview | null): void {
    if (p?.index === this.preview?.index) return;
    this.preview = p;
    if (this.last) this.draw(this.last);
  }

  draw(info: PanelInfo): void {
    this.last = info;
    const g = this.ctx2d;
    const W = this.W;
    const H = this.H;
    const sv = info.lang === 'sv';
    const pad = 40;
    g.clearRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    // Glass card.
    const gc = GROUP_COLOR[info.group] ?? '#38e1ff';
    g.fillStyle = 'rgba(9,12,30,0.9)';
    g.strokeStyle = 'rgba(140,160,255,0.45)';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, 30);
    g.fill();
    g.stroke();
    // Group accent along the top.
    g.fillStyle = gc;
    g.globalAlpha = 0.9;
    g.fillRect(30, 6, W - 60, 5);
    g.globalAlpha = 1;

    // Header: group · step n/total, and API / mode chips on the right.
    g.font = '700 26px Inter, system-ui, sans-serif';
    g.fillStyle = gc;
    const groupName = info.group.toUpperCase().replace('-', ' · ');
    g.fillText(`${groupName}   ${sv ? 'STEG' : 'STAGE'} ${info.index + 1}/${info.total}`, pad, 58);
    const chips = [
      { text: API_NAME[info.api] ?? info.api, col: API_COLOR[info.api] ?? '#38e1ff' },
      { text: info.mode === 'data' ? (sv ? 'Verklig data' : 'Real data') : sv ? 'Koncept' : 'Concept', col: '#9aa3c7' },
    ];
    g.font = '700 24px Inter, system-ui, sans-serif';
    let cx = W - pad;
    for (const c of chips.reverse()) {
      const w = g.measureText(c.text).width + 28;
      cx -= w;
      g.beginPath();
      g.roundRect(cx, 32, w, 36, 18);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fill();
      g.strokeStyle = c.col;
      g.lineWidth = 2.5;
      g.stroke();
      g.fillStyle = '#eef0ff';
      g.fillText(c.text, cx + 14, 58);
      cx -= 10;
    }

    // Title.
    g.font = '800 50px Inter, system-ui, sans-serif';
    g.fillStyle = '#ffffff';
    const titleLines = wrapText(info.title, W - pad * 2, (s) => g.measureText(s).width, 2);
    titleLines.forEach((l, i) => g.fillText(l, pad, 124 + i * 56));
    let y = 124 + (titleLines.length - 1) * 56 + 52;

    // Current bullet.
    const factsH = info.facts.length ? 58 : 0;
    const bottom = H - 70 - factsH;
    g.font = '400 32px Inter, system-ui, sans-serif';
    g.fillStyle = '#e4e8ff';
    const maxLines = Math.max(1, Math.floor((bottom - y + 10) / 42));
    const bulletLines = wrapText(info.bullet, W - pad * 2, (s) => g.measureText(s).width, maxLines);
    bulletLines.forEach((l, i) => g.fillText(l, pad, y + i * 42));

    // Key numbers as chips.
    if (info.facts.length) {
      g.font = '600 25px "JetBrains Mono", ui-monospace, monospace';
      let fx = pad;
      const fy = H - 70 - 50;
      for (const f of info.facts.slice(0, 3)) {
        let text = f;
        while (g.measureText(text).width > (W - pad * 2) / 3 - 34 && text.length > 3) text = text.slice(0, -2) + '…';
        const w = g.measureText(text).width + 26;
        g.beginPath();
        g.roundRect(fx, fy, w, 40, 10);
        g.fillStyle = 'rgba(56,225,255,0.1)';
        g.fill();
        g.strokeStyle = 'rgba(56,225,255,0.45)';
        g.lineWidth = 2;
        g.stroke();
        g.fillStyle = '#7deeff';
        g.fillText(text, fx + 13, fy + 29);
        fx += w + 12;
      }
    }

    // Step dots, bottom left.
    const dotsY = H - 38;
    for (let i = 0; i < info.steps; i++) {
      g.beginPath();
      g.arc(pad + 10 + i * 30, dotsY, i === info.step ? 10 : 8, 0, Math.PI * 2);
      g.fillStyle = i <= info.step ? gc : 'rgba(255,255,255,0.18)';
      g.fill();
    }
    // "Jump to" preview (pointing at the stage strip) or a hint, bottom right.
    g.textAlign = 'right';
    const pv = this.preview;
    if (pv) {
      g.font = '700 28px Inter, system-ui, sans-serif';
      g.fillStyle = GROUP_COLOR[pv.group] ?? '#38e1ff';
      g.fillText(`${sv ? 'Hoppa till' : 'Jump to'} ${pv.index + 1} · ${pv.short}  ›`, W - pad, dotsY + 10);
    } else {
      g.font = '500 24px Inter, system-ui, sans-serif';
      g.fillStyle = 'rgba(190,200,240,0.6)';
      g.fillText(sv ? `Steg ${info.step + 1} av ${info.steps}` : `Step ${info.step + 1} of ${info.steps}`, W - pad, dotsY + 9);
    }
    g.textAlign = 'left';
    this.texture.needsUpdate = true;
  }
}
