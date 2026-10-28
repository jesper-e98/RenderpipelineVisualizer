import './styles/main.css';
import 'highlight.js/styles/github-dark.css';
import gsap from 'gsap';
import { h } from './core/dom';
import { tr, UI } from './core/i18n';
import { Derived } from './core/derived';
import { SlideEngine } from './core/SlideEngine';
import { API_LIST, loadPref, Store, type ApiId, type Lang, type Mode } from './core/state';
import { BUILTINS, builtinMesh, type BuiltinId } from './model/builtins';
import { ACCEPTED_EXTENSIONS, loadModelFile } from './model/loadModel';
import { SLIDES } from './slides';
import { GROUP_LABEL } from './slides/standard';
import { ThreeStage } from './views/ThreeStage';

const app = document.getElementById('app')!;

const store = new Store({
  mesh: builtinMesh('teapot'),
  api: loadPref<ApiId>('api', ['opengl', 'vulkan', 'd3d12'], 'opengl'),
  mode: loadPref<Mode>('mode', ['data', 'concept'], 'data'),
  lang: loadPref<Lang>('lang', ['sv', 'en'], 'sv'),
});
let derived = new Derived(store.state.mesh);
store.on((s, changed) => {
  if (changed.includes('mesh')) derived = new Derived(s.mesh);
});
const t = (x: Parameters<typeof tr>[0]) => tr(x, store.state.lang);

// ---------- Layout ----------
const fileInput = h('input', { attrs: { type: 'file', accept: ACCEPTED_EXTENSIONS.join(','), hidden: true } });
const modelSelect = h('select.model-select', { attrs: { 'aria-label': 'Model' } });
const loadBtn = h('button.btn.load', { on: { click: () => fileInput.click() } });
const apiSeg = h('div.seg.api-seg', { attrs: { role: 'radiogroup', 'aria-label': 'API' } });
const modeSeg = h('div.seg.mode-seg', { attrs: { role: 'radiogroup' } });
const langSeg = h('div.seg.lang-seg', { attrs: { role: 'radiogroup' } });
const meshInfo = h('div.mesh-info');

const topbar = h('header.topbar.glass', {}, [
  h('div.brand', {}, [h('span.logo'), h('span', { html: 'Render<b>Pipeline</b><i>//</i>Viz' })]),
  h('div.model-picker', {}, [modelSelect, loadBtn, fileInput, meshInfo]),
  h('div.controls', {}, [apiSeg, modeSeg, langSeg]),
]);

const stageEl = h('main.slides');
const minimap = h('nav.minimap', { attrs: { 'aria-label': 'Pipeline' } });
const prevBtn = h('button.nav-btn.prev', { html: '&#8592;' });
const nextBtn = h('button.nav-btn.next', { html: '&#8594;' });
const stepDots = h('div.step-dots');
const counter = h('div.counter');
const keysHint = h('div.keys-hint');
const progress = h('div.progress', {}, [h('div.progress-fill')]);

const bottombar = h('footer.bottombar.glass', {}, [
  progress,
  h('div.bottom-row', {}, [prevBtn, h('div.mid', {}, [minimap, h('div.sub-row', {}, [counter, stepDots, keysHint])]), nextBtn]),
]);
const dropOverlay = h('div.drop-overlay', {}, [h('div.drop-box', {}, [h('div.drop-icon'), h('p.drop-text')])]);
const toast = h('div.toast');
const bgGlow = h('div.bg-glow', {}, [h('div.orb.o1'), h('div.orb.o2'), h('div.orb.o3'), h('div.grid-floor')]);

app.append(bgGlow, topbar, stageEl, bottombar, dropOverlay, toast);

// ---------- Engine ----------
const stage = new ThreeStage();
const engine = new SlideEngine(stageEl, SLIDES, store, stage, () => derived);

function segmented<T extends string>(host: HTMLElement, items: { id: T; label: string; cls?: string }[], current: T, onPick: (id: T) => void) {
  host.replaceChildren(
    ...items.map((it) =>
      h(`button.seg-btn${it.cls ? '.' + it.cls : ''}`, {
        text: it.label,
        attrs: { role: 'radio', 'aria-checked': String(it.id === current) },
        dataset: { id: it.id },
        on: { click: () => onPick(it.id) },
      }),
    ),
    h('span.seg-pill'),
  );
  requestAnimationFrame(() => movePill(host));
}

function movePill(host: HTMLElement) {
  const active = host.querySelector<HTMLElement>('[aria-checked="true"]');
  const pill = host.querySelector<HTMLElement>('.seg-pill');
  if (!active || !pill) return;
  gsap.to(pill, { x: active.offsetLeft, width: active.offsetWidth, duration: 0.35, ease: 'power3.out' });
  pill.dataset.id = active.dataset.id;
}

function renderChrome() {
  const s = store.state;
  document.documentElement.lang = s.lang;
  document.body.dataset.api = s.api;
  document.body.dataset.mode = s.mode;
  segmented(apiSeg, API_LIST.map((a) => ({ id: a.id, label: a.label, cls: a.id })), s.api, (api) => store.set({ api }));
  segmented(modeSeg, [
    { id: 'data' as Mode, label: t(UI.modeData) },
    { id: 'concept' as Mode, label: t(UI.modeConcept) },
  ], s.mode, (mode) => store.set({ mode }));
  segmented(langSeg, [
    { id: 'sv' as Lang, label: 'SV' },
    { id: 'en' as Lang, label: 'EN' },
  ], s.lang, (lang) => store.set({ lang }));

  const builtinId = s.mesh.format === 'builtin' ? s.mesh.name : '__file';
  modelSelect.replaceChildren(
    h('optgroup', { attrs: { label: t(UI.builtin) } }, BUILTINS.map((b) => h('option', { text: t(b.label), attrs: { value: b.id } }))),
    ...(s.mesh.format !== 'builtin' ? [h('option', { text: `📄 ${s.mesh.name}.${s.mesh.format.toLowerCase()}`, attrs: { value: '__file' } })] : []),
  );
  modelSelect.value = builtinId;
  loadBtn.textContent = t(UI.loadFile);
  meshInfo.innerHTML = `<span>${s.mesh.vertexCount.toLocaleString()} <small>${t(UI.vertices)}</small></span><span>${s.mesh.triangleCount.toLocaleString()} <small>${t(UI.triangles)}</small></span>`;
  dropOverlay.querySelector('.drop-text')!.textContent = t(UI.dropHint);
  prevBtn.title = t(UI.prev);
  nextBtn.title = t(UI.next);
  keysHint.textContent = t(UI.keysHint);
  renderMinimap();
}

function renderMinimap() {
  const groups: { group: string; items: { i: number }[] }[] = [];
  SLIDES.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && last.group === s.group) last.items.push({ i });
    else groups.push({ group: s.group, items: [{ i }] });
  });
  minimap.replaceChildren(
    ...groups.map((g) =>
      h('div.mm-group', { dataset: { group: g.group }, attrs: { title: t(UI[GROUP_LABEL[g.group as keyof typeof GROUP_LABEL]]) } },
        g.items.map(({ i }) =>
          h('button.mm-chip', {
            dataset: { i: String(i) },
            attrs: { title: t(SLIDES[i].title) },
            on: { click: () => engine.go(i, 0) },
          }, [h('span.mm-num', { text: String(i) }), h('span.mm-label', { text: t(SLIDES[i].short) })]),
        ),
      ),
    ),
  );
  updateNav(engine.index, engine.step);
}

function updateNav(index: number, step: number) {
  minimap.querySelectorAll<HTMLElement>('.mm-chip').forEach((c) => {
    const i = Number(c.dataset.i);
    c.classList.toggle('active', i === index);
    c.classList.toggle('done', i < index);
  });
  minimap.querySelector('.mm-chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  const def = SLIDES[index];
  stepDots.replaceChildren(
    ...Array.from({ length: def.steps }, (_, k) =>
      h('button.dot', { attrs: { 'aria-label': `${t(UI.step)} ${k + 1}` }, on: { click: () => engine.go(index, k) } }),
    ),
  );
  stepDots.querySelectorAll('.dot').forEach((d, k) => d.classList.toggle('on', k <= step));
  counter.textContent = `${index + 1} / ${SLIDES.length}`;
  const total = SLIDES.reduce((a, s) => a + s.steps, 0);
  const done = SLIDES.slice(0, index).reduce((a, s) => a + s.steps, 0) + step + 1;
  gsap.to(progress.firstElementChild, { width: `${(done / total) * 100}%`, duration: 0.4, ease: 'power2.out' });
  prevBtn.disabled = index === 0 && step === 0;
  nextBtn.disabled = index === SLIDES.length - 1 && step === def.steps - 1;
}

engine.onChange(updateNav);
store.on(renderChrome);

// ---------- Input ----------
prevBtn.addEventListener('click', () => engine.prev());
nextBtn.addEventListener('click', () => engine.next());

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') engine.next();
  else if (k === 'ArrowLeft' || k === 'PageUp') engine.prev();
  else if (k === 'Home') engine.go(0, 0);
  else if (k === 'End') engine.go(SLIDES.length - 1, 0);
  else if (k === 'm' || k === 'M') store.set({ mode: store.state.mode === 'data' ? 'concept' : 'data' });
  else if (k === '1' || k === '2' || k === '3') store.set({ api: API_LIST[Number(k) - 1].id });
  else return;
  e.preventDefault();
});

let touchX: number | null = null;
stageEl.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
stageEl.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if ((e.target as HTMLElement).closest('canvas, .three-labels, pre, .scroll-x')) return;
  if (dx < -60) engine.next();
  else if (dx > 60) engine.prev();
});

modelSelect.addEventListener('change', () => {
  const v = modelSelect.value;
  if (v !== '__file') store.set({ mesh: builtinMesh(v as BuiltinId) });
});

function showToast(msg: string, kind: 'ok' | 'err' = 'ok') {
  toast.textContent = msg;
  toast.dataset.kind = kind;
  gsap.fromTo(toast, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3 });
  gsap.to(toast, { opacity: 0, y: 20, duration: 0.4, delay: kind === 'err' ? 5 : 2.2 });
}

async function loadFile(file: File) {
  showToast(t(UI.loading));
  try {
    const mesh = await loadModelFile(file);
    store.set({ mesh });
    showToast(`${file.name} · ${mesh.vertexCount.toLocaleString()} ${t(UI.vertices)} · ${mesh.triangleCount.toLocaleString()} ${t(UI.triangles)}`);
  } catch (err) {
    console.error(err);
    showToast(`${t(UI.loadError)}: ${(err as Error).message}`, 'err');
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) dropOverlay.classList.add('on');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.remove('on');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('on');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// Allow slides to ask for the file picker (the intro slide has a drop zone).
window.addEventListener('rpv:pick-file', () => fileInput.click());
window.addEventListener('rpv:load-file', (e) => loadFile((e as CustomEvent<File>).detail));
window.addEventListener('rpv:go', (e) => engine.go((e as CustomEvent<number>).detail, 0));

// Debug/testing hook.
(window as unknown as { rpv: unknown }).rpv = { store, engine, get derived() { return derived; } };

renderChrome();
engine.start();
