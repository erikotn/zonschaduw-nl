export interface ToggleSpec {
  key: string;
  label: string;
  initial: boolean;
  onChange: (value: boolean) => void;
}

export function buildOverlayToggles(host: HTMLElement, toggles: ToggleSpec[]): void {
  host.innerHTML = '';
  for (const t of toggles) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.initial;
    cb.addEventListener('change', () => t.onChange(cb.checked));
    lab.append(cb, document.createTextNode(' ' + t.label));
    host.appendChild(lab);
  }
}
