import gsap from 'gsap';
import { dur, s } from '../core/dom';

export interface FlowNode {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  sub?: string;
  /** CSS color for the node border/glow. */
  color?: string;
  /** First step at which the node is visible (default 0). */
  step?: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  step?: number;
  /** Animated dashes + travelling packets. */
  live?: boolean;
  /** Bend direction: 'h' (left→right, default) or 'v' (top→bottom). */
  dir?: 'h' | 'v';
}

/**
 * An SVG node/edge diagram whose parts appear step by step, with glowing "data packets"
 * travelling along live edges. Coordinates are in viewBox units.
 */
export function flowDiagram(
  host: HTMLElement,
  nodes: FlowNode[],
  edges: FlowEdge[],
  viewBox: [number, number],
): { svg: SVGSVGElement; show: (step: number, animate: boolean) => void; node: (id: string) => SVGGElement | undefined } {
  const svg = s('svg', { class: 'flow', viewBox: `0 0 ${viewBox[0]} ${viewBox[1]}`, preserveAspectRatio: 'xMidYMid meet' });
  const defs = s('defs', {}, [
    s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, [
      s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'rgba(160,175,255,0.7)' }),
    ]),
  ]);
  svg.append(defs);
  const byId = new Map(nodes.map((n) => [n.id, { ...n, w: n.w ?? 150, h: n.h ?? 52 }]));
  const edgeEls: { el: SVGGElement; step: number }[] = [];
  const nodeEls: { el: SVGGElement; step: number }[] = [];
  const nodeMap = new Map<string, SVGGElement>();

  edges.forEach((e, i) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    let d: string;
    if ((e.dir ?? 'h') === 'h') {
      const x1 = a.x + a.w / 2;
      const y1 = a.y;
      const x2 = b.x - b.w / 2;
      const y2 = b.y;
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`;
    } else {
      const x1 = a.x;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y - b.h / 2;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`;
    }
    const id = `flow-e-${i}-${Math.random().toString(36).slice(2, 7)}`;
    const path = s('path', { d, id, class: `edge${e.live ? ' live' : ''}`, 'marker-end': 'url(#arrow)' });
    const g = s('g', { class: 'edge-g' }, [path]);
    if (e.label) {
      const lx = (a.x + b.x) / 2;
      const ly = (a.y + b.y) / 2 - 8;
      g.append(s('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'edge-label', fill: '#9aa3c7', 'font-size': 11, 'font-family': 'JetBrains Mono, monospace' }, [e.label]));
    }
    if (e.live) {
      for (let k = 0; k < 3; k++) {
        const c = s('circle', { r: 3.2, fill: 'currentColor', class: 'packet' });
        c.style.color = 'var(--api)';
        c.style.filter = 'drop-shadow(0 0 4px var(--api))';
        const anim = s('animateMotion', { dur: '1.8s', repeatCount: 'indefinite', begin: `${k * 0.6}s` });
        anim.append(s('mpath', { href: `#${id}` }));
        c.append(anim);
        g.append(c);
      }
    }
    svg.append(g);
    edgeEls.push({ el: g, step: e.step ?? 0 });
  });

  for (const n of byId.values()) {
    const color = n.color ?? 'var(--line-strong)';
    const rect = s('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 10 });
    rect.style.stroke = color;
    rect.style.filter = n.color ? `drop-shadow(0 0 6px ${n.color})` : '';
    const g = s('g', { class: 'node' }, [
      rect,
      s('text', { x: n.x, y: n.sub ? n.y - 4 : n.y + 4, 'text-anchor': 'middle' }, [n.label]),
    ]);
    if (n.sub) g.append(s('text', { x: n.x, y: n.y + 13, 'text-anchor': 'middle', class: 'sub' }, [n.sub]));
    svg.append(g);
    nodeEls.push({ el: g, step: n.step ?? 0 });
    nodeMap.set(n.id, g);
  }
  host.append(svg);

  return {
    svg,
    node: (id) => nodeMap.get(id),
    show(step, animate) {
      for (const { el, step: st } of [...nodeEls, ...edgeEls]) {
        const vis = st <= step;
        const was = el.dataset.vis === '1';
        el.dataset.vis = vis ? '1' : '0';
        if (animate && vis && !was) {
          gsap.fromTo(el, { opacity: 0, scale: 0.85, transformOrigin: 'center' }, { opacity: 1, scale: 1, duration: dur(0.5), ease: 'back.out(1.6)' });
        } else {
          gsap.set(el, { opacity: vis ? 1 : 0, scale: 1 });
        }
      }
    },
  };
}
