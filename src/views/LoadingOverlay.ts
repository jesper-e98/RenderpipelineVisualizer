import gsap from 'gsap';
import { dur, h } from '../core/dom';
import { L, tr, type Text } from '../core/i18n';
import type { Lang } from '../core/state';
import type { LoadStage } from '../model/normalize';

const STAGES: { id: LoadStage; label: Text }[] = [
  { id: 'read', label: L('Läser filen', 'Reading the file') },
  { id: 'parse', label: L('Tolkar formatet', 'Parsing the format') },
  { id: 'weld', label: L('Svetsar ihop vertices', 'Welding vertices') },
  { id: 'normals', label: L('Räknar normaler', 'Computing normals') },
  { id: 'normalize', label: L('Normaliserar', 'Normalizing') },
  { id: 'prepare', label: L('Förbereder vyer i bakgrunden', 'Preparing views in the background') },
];

/**
 * A glass progress card for model loading. Everything heavy runs in workers, so the page behind it
 * keeps animating; the card only appears if the job takes longer than a blink.
 */
export class LoadingOverlay {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private rows = new Map<LoadStage, HTMLElement>();
  private bar: HTMLElement;
  private detail: HTMLElement;
  private showTimer = 0;
  private visible = false;

  constructor(private lang: () => Lang) {
    this.title = h('div.lo-title');
    this.bar = h('div.lo-bar-fill');
    this.detail = h('div.lo-detail');
    const list = h('ol.lo-steps', {}, STAGES.map((s) => {
      const row = h('li.lo-step', { dataset: { id: s.id } }, [h('span.lo-dot'), h('span.lo-label')]);
      this.rows.set(s.id, row);
      return row;
    }));
    this.el = h('div.loading-overlay', { attrs: { role: 'status', 'aria-live': 'polite' } }, [
      h('div.lo-card.glass', {}, [h('div.lo-spinner'), this.title, list, h('div.lo-bar', {}, [this.bar]), this.detail]),
    ]);
  }

  start(name: string, fromFile: boolean): void {
    const t = (x: Text) => tr(x, this.lang());
    this.title.textContent = `${t(L('Laddar', 'Loading'))} ${name}`;
    for (const s of STAGES) {
      const row = this.rows.get(s.id)!;
      row.querySelector('.lo-label')!.textContent = t(s.label);
      row.className = 'lo-step';
      row.style.display = !fromFile && s.id !== 'prepare' ? 'none' : '';
    }
    this.detail.textContent = '';
    this.bar.style.width = '0%';
    clearTimeout(this.showTimer);
    // Small models finish before this fires, so there's no flash.
    this.showTimer = window.setTimeout(() => this.reveal(), 160);
  }

  private reveal(): void {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.add('on');
    gsap.fromTo(this.el.firstElementChild, { y: 16, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1, duration: dur(0.35), ease: 'power3.out' });
  }

  stage(id: LoadStage): void {
    let passed = true;
    for (const s of STAGES) {
      const row = this.rows.get(s.id)!;
      if (s.id === id) {
        passed = false;
        row.className = 'lo-step active';
      } else row.className = passed ? 'lo-step done' : 'lo-step';
    }
    const i = STAGES.findIndex((s) => s.id === id);
    this.bar.style.width = `${Math.round((i / STAGES.length) * 100)}%`;
  }

  prepareProgress(done: number, total: number): void {
    this.stage('prepare');
    const base = ((STAGES.length - 1) / STAGES.length) * 100;
    this.bar.style.width = `${base + (total ? (done / total) * (100 - base) : 0)}%`;
    this.detail.textContent = total ? `${done} / ${total}` : '';
  }

  finish(): void {
    clearTimeout(this.showTimer);
    if (!this.visible) return;
    this.bar.style.width = '100%';
    this.rows.forEach((r) => r.className = r.style.display === 'none' ? r.className : 'lo-step done');
    gsap.to(this.el.firstElementChild, {
      opacity: 0,
      y: -10,
      duration: dur(0.3),
      delay: dur(0.15),
      onComplete: () => {
        this.el.classList.remove('on');
        this.visible = false;
      },
    });
  }
}
