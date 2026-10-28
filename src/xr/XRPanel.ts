import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { PANEL_H, PANEL_W, panelRegions, wrapText, type PanelAction, type PanelInfo, type Region } from './panelLayout';

const GROUP_COLOR: Record<string, string> = {
  cpu: '#38e1ff',
  api: '#9b7bff',
  'gpu-prog': '#ff3fd2',
  'gpu-fixed': '#ffb547',
};
const API_COLOR = { opengl: '#5aa9e6', vulkan: '#ff4d64', d3d12: '#6cd04a' };

/** A floating text panel for XR, drawn onto a canvas texture. ~0.8 m wide. */
export class XRPanel {
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private ctx2d: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  regions: Region[] = [];
  hover: PanelAction | null = null;
  private last: PanelInfo | null = null;

  constructor(width = 0.8) {
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;
    this.ctx2d = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(width, (width * PANEL_H) / PANEL_W),
      new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide }),
    );
    this.mesh.renderOrder = 20;
  }

  setHover(a: PanelAction | null): void {
    if (a === this.hover) return;
    this.hover = a;
    if (this.last) this.draw(this.last);
  }

  draw(info: PanelInfo): void {
    this.last = info;
    const g = this.ctx2d;
    const W = PANEL_W;
    const H = PANEL_H;
    g.clearRect(0, 0, W, H);
    // Glass card.
    g.fillStyle = 'rgba(10,13,30,0.88)';
    g.strokeStyle = 'rgba(140,160,255,0.45)';
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, 34);
    g.fill();
    g.stroke();

    const gc = GROUP_COLOR[info.group] ?? '#38e1ff';
    g.font = '700 24px Inter, system-ui, sans-serif';
    g.fillStyle = gc;
    g.fillText(info.group.toUpperCase().replace('-', ' · '), 44, 62);
    g.textAlign = 'right';
    g.fillStyle = '#9aa3c7';
    g.fillText(`${info.index + 1} / ${info.total}`, W - 44, 62);
    g.textAlign = 'left';

    g.font = '800 48px Inter, system-ui, sans-serif';
    g.fillStyle = '#ffffff';
    const titleLines = wrapText(info.title, W - 88, (s) => g.measureText(s).width, 2);
    titleLines.forEach((l, i) => g.fillText(l, 44, 124 + i * 56));
    let y = 124 + titleLines.length * 56 + 6;

    g.font = '400 30px Inter, system-ui, sans-serif';
    g.fillStyle = '#e8ebff';
    const bulletLines = wrapText(info.bullet, W - 88, (s) => g.measureText(s).width, info.facts.length ? 4 : 6);
    bulletLines.forEach((l, i) => g.fillText(l, 44, y + i * 40));
    y += bulletLines.length * 40 + 14;

    if (info.facts.length) {
      g.font = '600 26px "JetBrains Mono", monospace';
      g.fillStyle = '#38e1ff';
      info.facts.slice(0, 3).forEach((f, i) => g.fillText(f, 44, y + i * 34));
    }

    // Step dots.
    const dotsY = H - 132;
    for (let i = 0; i < info.steps; i++) {
      g.beginPath();
      g.arc(52 + i * 28, dotsY, 8, 0, Math.PI * 2);
      g.fillStyle = i <= info.step ? gc : 'rgba(255,255,255,0.18)';
      g.fill();
    }

    this.regions = panelRegions(info);
    for (const r of this.regions) {
      const isApi = r.action.startsWith('api:');
      const active = isApi && r.action === `api:${info.api}`;
      const col = isApi ? API_COLOR[r.action.slice(4) as keyof typeof API_COLOR] : '#9b7bff';
      g.beginPath();
      g.roundRect(r.x, r.y, r.w, r.h, 18);
      g.fillStyle = active ? col : this.hover === r.action ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      g.fill();
      g.strokeStyle = active || this.hover === r.action ? col : 'rgba(140,160,255,0.4)';
      g.lineWidth = 3;
      g.stroke();
      g.font = r.label.length <= 1 ? '700 46px Inter, sans-serif' : '700 26px Inter, sans-serif';
      g.fillStyle = active ? '#05060d' : '#e8ebff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2 + 1);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    }
    this.texture.needsUpdate = true;
  }
}
