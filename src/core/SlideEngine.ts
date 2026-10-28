import gsap from 'gsap';
import { dur } from './dom';
import { tr } from './i18n';
import type { Store } from './state';
import type { Derived } from './derived';
import type { ThreeStage } from '../views/ThreeStage';
import type { SlideContext, SlideDef, SlideInstance } from '../slides/types';

type ChangeListener = (index: number, step: number) => void;

/**
 * Owns navigation: which slide and sub-step is showing, URL hash sync (#/slide-id/step),
 * transitions between slides, and rebuilding the current slide when app state changes.
 */
export class SlideEngine {
  index = 0;
  step = 0;
  private instance: SlideInstance | null = null;
  private listeners = new Set<ChangeListener>();
  private busy: gsap.core.Timeline | null = null;

  constructor(
    private root: HTMLElement,
    readonly slides: SlideDef[],
    private store: Store,
    private stage: ThreeStage,
    private getDerived: () => Derived,
  ) {
    store.on(() => this.rebuild());
    window.addEventListener('hashchange', () => this.fromHash());
  }

  start(): void {
    if (!this.fromHash()) this.mount(0, 0, 0);
  }

  onChange(fn: ChangeListener): void {
    this.listeners.add(fn);
  }

  private context(): SlideContext {
    const state = this.store.state;
    return { state, t: (x) => tr(x, state.lang), stage: this.stage, derived: this.getDerived(), set: (p) => this.store.set(p) };
  }

  next(): void {
    const def = this.slides[this.index];
    if (this.step < def.steps - 1) this.setStep(this.step + 1, true);
    else if (this.index < this.slides.length - 1) this.go(this.index + 1, 0);
  }

  prev(): void {
    if (this.step > 0) this.setStep(this.step - 1, true);
    else if (this.index > 0) this.go(this.index - 1, this.slides[this.index - 1].steps - 1);
  }

  go(index: number, step = 0): void {
    index = Math.max(0, Math.min(this.slides.length - 1, index));
    step = Math.max(0, Math.min(this.slides[index].steps - 1, step));
    if (index === this.index && this.instance) return this.setStep(step, true);
    this.mount(index, step, index > this.index ? 1 : -1);
  }

  private setStep(step: number, animate: boolean): void {
    this.step = step;
    this.instance?.show(step, animate);
    this.emit();
  }

  private mount(index: number, step: number, dir: number): void {
    this.busy?.progress(1); // finish any running transition first
    const old = this.instance;
    const def = this.slides[index];
    const inst = def.create(this.context());
    this.index = index;
    this.step = step;
    this.instance = inst;
    this.root.append(inst.el);
    inst.show(step, false);
    this.emit();

    const offset = 70 * dir;
    const tl = gsap.timeline({ onComplete: () => (this.busy = null) });
    if (old) {
      old.el.classList.add('leaving');
      tl.to(old.el, { x: -offset, opacity: 0, filter: 'blur(8px)', duration: dur(0.45), ease: 'power2.in' }, 0);
      tl.call(() => {
        old.destroy();
        old.el.remove();
      });
    }
    tl.fromTo(
      inst.el,
      { x: offset, opacity: 0, filter: 'blur(8px)' },
      { x: 0, opacity: 1, filter: 'blur(0px)', duration: dur(0.6), ease: 'power3.out', clearProps: 'filter,transform' },
      old ? 0.15 : 0,
    );
    this.busy = tl;
  }

  /** App state changed (model, API, mode, language): rebuild the slide in place. */
  private rebuild(): void {
    if (!this.instance) return;
    this.busy?.progress(1);
    const old = this.instance;
    const inst = this.slides[this.index].create(this.context());
    this.instance = inst;
    old.destroy();
    old.el.replaceWith(inst.el);
    inst.show(this.step, false);
    gsap.fromTo(inst.el.querySelectorAll('.right > *, .story'), { opacity: 0.25 }, { opacity: 1, duration: dur(0.35), stagger: 0.05 });
    this.emit();
  }

  private emit(): void {
    const id = this.slides[this.index].id;
    const hash = `#/${id}/${this.step + 1}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    this.listeners.forEach((fn) => fn(this.index, this.step));
  }

  private fromHash(): boolean {
    const m = /^#\/([\w-]+)(?:\/(\d+))?/.exec(location.hash);
    if (!m) return false;
    const index = this.slides.findIndex((s) => s.id === m[1]);
    if (index < 0) return false;
    const step = m[2] ? parseInt(m[2], 10) - 1 : 0;
    if (index === this.index && this.instance && step === this.step) return true;
    if (this.instance) this.go(index, step);
    else this.mount(index, Math.max(0, Math.min(this.slides[index].steps - 1, step)), 0);
    return true;
  }
}
