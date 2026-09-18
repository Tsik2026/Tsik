import type { Prefs } from '../types';

const KEY = 'komfin:prefs';
const THEMES = ['light', 'dim', 'warm'] as const;
const ZOOMS = [90, 100, 110];

const DEFAULTS: Prefs = { theme: 'dim', zoom: 100, welcome: true };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      theme: (THEMES as readonly string[]).includes(raw.theme) ? raw.theme : DEFAULTS.theme,
      zoom: ZOOMS.includes(Number(raw.zoom)) ? Number(raw.zoom) as Prefs['zoom'] : DEFAULTS.zoom,
      welcome: typeof raw.welcome === 'boolean' ? raw.welcome : DEFAULTS.welcome,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function applyPrefs(p: Prefs): void {
  const el = document.documentElement;
  el.dataset.theme = p.theme;
  el.style.zoom = p.zoom === 100 ? '' : String(p.zoom / 100);
}

export function savePrefs(p: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(p));
  applyPrefs(p);
  window.dispatchEvent(new CustomEvent('komfin:prefs', { detail: p }));
}
