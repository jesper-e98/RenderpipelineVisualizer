import gsap from 'gsap';
import { dur, h } from '../core/dom';
import { UI } from '../core/i18n';
import { apiPanel } from '../views/ApiPanel';
import { mountCode, unmountCode } from '../core/codeDrawer';
import type { SlideDef, StageGroup, StandardSlideSpec } from './types';

export const GROUP_LABEL: Record<StageGroup, keyof typeof UI> = {
  cpu: 'stageCpu',
  api: 'stageApi',
  'gpu-prog': 'stageGpuProg',
  'gpu-fixed': 'stageGpuFixed',
};

/**
 * The standard slide layout: story column (title, lead, bullets revealed per step) on the left,
 * the visual for the current mode on the right, and the API panel underneath it.
 */
export function standardSlide(spec: StandardSlideSpec): SlideDef {
  const steps = spec.steps ?? Math.max(1, spec.bullets.length);
  return {
    id: spec.id,
    group: spec.group,
    short: spec.short,
    title: spec.title,
    steps,
    create(ctx) {
      const { t } = ctx;
      const mode = ctx.state.mode;
      const bullets = spec.bullets.map((b, i) =>
        h('li.bullet', { dataset: { step: String(i) } }, [h('span.bullet-dot'), h('span', { html: t(b) })]),
      );
      const story = h('div.story', {}, [
        h('div.badge', { dataset: { group: spec.group } }, [t(UI[GROUP_LABEL[spec.group]])]),
        h('h2.title', { text: t(spec.title) }),
        h('p.lead', { html: t(spec.lead) }),
        h('ol.bullets', {}, bullets),
      ]);
      const visualHost = h('div.visual', { dataset: { mode } });
      const showPanel = spec.api && (spec.apiPanel ?? 'both') !== 'none' && (spec.apiPanel === undefined || spec.apiPanel === 'both' || spec.apiPanel === mode);
      const apis = typeof spec.api === 'function' ? spec.api(ctx) : spec.api;
      const panel = showPanel && apis ? apiPanel(apis[ctx.state.api], ctx) : null;
      // The API panel lives in the dock's code drawer (core/codeDrawer.ts), not in the slide.
      const right = h('div.right', {}, [visualHost]);
      const el = h('section.slide.standard.no-panel', { dataset: { id: spec.id, group: spec.group } }, [story, right]);
      if (panel) panel.el.classList.remove('collapsed');
      mountCode(panel?.el ?? null);

      const visual = spec[mode](visualHost, ctx);
      let shown = -1;

      return {
        el,
        show(step, animate) {
          bullets.forEach((b, i) => {
            const visible = i <= step;
            b.classList.toggle('current', i === step);
            const was = b.classList.contains('on');
            b.classList.toggle('on', visible);
            if (!animate || was === visible) {
              gsap.set(b, { opacity: visible ? 1 : 0.0, y: 0, x: 0 });
            } else if (visible) {
              gsap.fromTo(b, { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: dur(0.45), ease: 'power2.out' });
            } else {
              gsap.to(b, { opacity: 0, duration: dur(0.2) });
            }
          });
          visual.show(step, animate && step !== shown);
          panel?.show(step);
          shown = step;
        },
        destroy() {
          visual.destroy();
          unmountCode(panel?.el ?? null);
        },
      };
    },
  };
}

/** Helper for visuals that only need to react to steps through a single callback. */
export function simpleVisual(show: (step: number, animate: boolean) => void, destroy: () => void = () => {}) {
  return { show, destroy };
}
