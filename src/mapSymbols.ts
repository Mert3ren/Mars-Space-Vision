import type { LocalPoint } from './mission';

export type MissionPin = { id: string; label: string; point: LocalPoint; status: 'active' | 'complete' | 'pending' };
export type SymbolKind = 'base' | 'station' | 'camera' | 'astronaut' | 'shelter' | 'stop' | 'science';

const glyph: Record<SymbolKind, string> = {
  base: '<path d="m3 11 9-7 9 7M5 10v10h14V10M10 20v-6h4v6"/>',
  station: '<path d="M12 12v7M8 20h8M8 5a6 6 0 0 0 0 7m8-7a6 6 0 0 1 0 7M5 3a9 9 0 0 0 0 12m14-12a9 9 0 0 1 0 12"/><circle cx="12" cy="9" r="1"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3"/><path d="m8 7 1.5-3h5L16 7"/>',
  astronaut: '<rect x="5" y="3" width="14" height="17" rx="6"/><rect x="7.5" y="6" width="9" height="7" rx="2"/><path d="M9.5 16h5"/>',
  shelter: '<path d="m12 3 8 4v5c0 4-4 7-8 9-4-2-8-5-8-9V7z"/>',
  stop: '<path d="m5 12 5 5L20 7"/>',
  science: '<path d="M9 4h6m-5 0v6l-5 8a1 1 0 0 0 1 2h12a1 1 0 0 0 1-2l-5-8V4M8 15h8"/>',
};

export function symbolGlyph(kind: SymbolKind) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph[kind]}</svg>`;
}

export function createMapSymbol(kind: SymbolKind, number?: string, state = '') {
  const badge = document.createElement('span');
  badge.className = `map-symbol map-symbol--${kind}`;
  badge.dataset.state = state;
  if (kind === 'stop' && state !== 'complete') {
    badge.textContent = number ?? '';
  } else {
    badge.innerHTML = symbolGlyph(kind);
    if (number) {
      const counter = document.createElement('b');
      counter.textContent = number;
      badge.append(counter);
    }
  }
  return badge;
}
