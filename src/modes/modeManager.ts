export type ModeId = 'live' | 'terras' | 'kas' | 'pv';

export interface ModeDef {
  id: ModeId;
  label: string;
  icon: string;
  /** Roep aan wanneer deze modus actief wordt. */
  activate(controlsHost: HTMLElement): void;
  /** Roep aan wanneer overgeschakeld wordt naar een andere modus. */
  deactivate(): void;
}

export interface ModeManager {
  setActive(id: ModeId): void;
  current(): ModeId;
}

export function buildModeManager(
  tabsHost: HTMLElement,
  controlsHost: HTMLElement,
  modes: ModeDef[],
  initial: ModeId = 'live',
): ModeManager {
  tabsHost.innerHTML = '';
  let active: ModeId = initial;
  const buttons = new Map<ModeId, HTMLButtonElement>();

  for (const mode of modes) {
    const btn = document.createElement('button');
    btn.textContent = `${mode.icon} ${mode.label}`;
    btn.dataset.modeId = mode.id;
    btn.addEventListener('click', () => setActive(mode.id));
    tabsHost.appendChild(btn);
    buttons.set(mode.id, btn);
  }

  function setActive(id: ModeId) {
    if (id === active) return;
    const oldMode = modes.find((m) => m.id === active);
    oldMode?.deactivate();
    active = id;
    for (const [mid, b] of buttons) b.classList.toggle('active', mid === id);
    controlsHost.innerHTML = '';
    const newMode = modes.find((m) => m.id === id);
    newMode?.activate(controlsHost);
  }

  // Initial activation
  for (const [mid, b] of buttons) b.classList.toggle('active', mid === active);
  modes.find((m) => m.id === active)?.activate(controlsHost);

  return {
    setActive,
    current: () => active,
  };
}
