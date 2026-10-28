import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import glsl from 'highlight.js/lib/languages/glsl';
import { h } from '../core/dom';
import { UI } from '../core/i18n';
import { API_LIST, type ApiId } from '../core/state';
import type { ApiPanelSpec, SlideContext } from '../slides/types';

hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('glsl', glsl);

function highlightLine(line: string, lang: string): string {
  // HLSL reads well with the C++ grammar. Lines are highlighted one by one so each can be dimmed.
  const language = lang === 'glsl' ? 'glsl' : 'cpp';
  return hljs.highlight(line || ' ', { language, ignoreIllegals: true }).value;
}

export function apiLabel(api: ApiId): string {
  const a = API_LIST.find((x) => x.id === api)!;
  return `${a.label} ${a.version}`;
}

/** Code + terminology for the active API, with per-step line highlighting. */
export function apiPanel(spec: ApiPanelSpec, ctx: SlideContext): { el: HTMLElement; show: (step: number) => void } {
  const { t } = ctx;
  const api = ctx.state.api;
  const tabs: { label: string; body: HTMLElement; lines?: HTMLElement[]; highlight?: number[][] }[] = [];

  for (const snip of spec.code) {
    const lines = snip.src.replace(/^\n+|\s+$/g, '').split('\n');
    const lineEls = lines.map((l, i) =>
      h('div.code-line', {}, [h('span.ln', { text: String(i + 1) }), h('span.lc', { html: highlightLine(l, snip.lang) })]),
    );
    const langTag = { cpp: 'C++', glsl: 'GLSL', hlsl: 'HLSL' }[snip.lang];
    tabs.push({
      label: snip.title ? t(snip.title) : langTag,
      body: h('pre.code.hljs', { attrs: { 'data-lang': langTag } }, lineEls),
      lines: lineEls,
      highlight: snip.highlight,
    });
  }
  if (spec.terms?.length) {
    tabs.push({
      label: t(UI.terms),
      body: h(
        'dl.terms',
        {},
        spec.terms.flatMap((x) => [h('dt', { text: x.term }), h('dd', { text: t(x.desc) })]),
      ),
    });
  }

  const tabBar = h('div.api-tabs');
  const bodyHost = h('div.api-body');
  let active = 0;
  const select = (i: number) => {
    active = i;
    tabBar.querySelectorAll('button').forEach((b, k) => b.classList.toggle('active', k === i));
    bodyHost.replaceChildren(tabs[i].body);
  };
  tabs.forEach((tab, i) => tabBar.append(h('button', { text: tab.label, on: { click: () => select(i) } })));

  const chips = h('div.who', {}, [
    spec.you ? h('span.chip.you', {}, [h('b', { text: t(UI.youWrite) }), ' ', t(spec.you)]) : null,
    spec.driver ? h('span.chip.driver', {}, [h('b', { text: t(UI.driverDoes) }), ' ', t(spec.driver)]) : null,
  ]);

  const toggle = h('button.api-toggle', { attrs: { 'aria-expanded': 'true' } });
  const el = h('div.api-panel.glass', { dataset: { api } }, [
    h('div.api-head', {}, [h('span.api-badge', { text: apiLabel(api) }), h('p.api-note', { text: t(spec.note) }), toggle]),
    chips,
    tabBar,
    bodyHost,
  ]);
  if (tabs.length) select(0);

  // Collapsing the panel gives the visual more room; the choice is remembered across slides.
  const setCollapsed = (c: boolean) => {
    el.classList.toggle('collapsed', c);
    toggle.setAttribute('aria-expanded', String(!c));
    toggle.textContent = c ? `▴ ${t(UI.code)}` : `▾ ${t(UI.hideCode)}`;
  };
  setCollapsed(readCollapsed());
  toggle.addEventListener('click', () => {
    const c = !el.classList.contains('collapsed');
    setCollapsed(c);
    try {
      localStorage.setItem('rpv.panelCollapsed', c ? '1' : '0');
    } catch {
      /* optional preference */
    }
  });

  return {
    el,
    show(step: number) {
      for (const tab of tabs) {
        if (!tab.lines) continue;
        const marks = tab.highlight?.[Math.min(step, (tab.highlight?.length ?? 1) - 1)] ?? [];
        tab.body.classList.toggle('has-marks', marks.length > 0);
        tab.lines.forEach((l, i) => l.classList.toggle('mark', marks.includes(i + 1)));
      }
      // Scroll the first highlighted line into view in the active code tab.
      const first = tabs[active]?.lines?.find((l) => l.classList.contains('mark'));
      if (first) {
        const pre = tabs[active].body;
        const top = first.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop;
        pre.scrollTo({ top: Math.max(0, top - pre.clientHeight / 3), behavior: 'smooth' });
      }
    },
  };
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('rpv.panelCollapsed') === '1';
  } catch {
    return false;
  }
}
