import { h } from '../core/dom';
import { L } from '../core/i18n';
import { standardSlide } from './standard';
import type { StageGroup } from './types';

/** Temporary slide used until the real one is written. */
export function placeholder(id: string, group: StageGroup, sv: string, en: string) {
  const visual = (host: HTMLElement) => {
    host.append(h('div.v-center', { text: 'TODO' }));
    return { show() {}, destroy() {} };
  };
  return standardSlide({ id, group, short: L(sv, en), title: L(sv, en), lead: L('', ''), bullets: [], data: visual, concept: visual });
}
