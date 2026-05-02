import { suggestAddress, lookupAddress } from '../geo/locationSearch';
import { setLocation, HOUSE, resetToDefaultLocation } from '../config';

/**
 * Search-box met dropdown voor Nederlandse adressen.
 * Gebruikt PDOK Locatieserver suggest+lookup.
 * Bij selectie: setLocation() → page reload met nieuw adres.
 */
export function buildLocationPicker(host: HTMLElement): void {
  host.innerHTML = `
    <div class="loc-picker">
      <input type="text" id="loc-input" placeholder="🔍 Zoek adres in Nederland…" autocomplete="off" />
      <div id="loc-current" title="Huidig adres">${HOUSE.address}</div>
      <ul id="loc-suggestions" hidden></ul>
    </div>
  `;
  const input = host.querySelector<HTMLInputElement>('#loc-input')!;
  const list = host.querySelector<HTMLUListElement>('#loc-suggestions')!;

  let debounceTimer: number | null = null;
  let inflight = 0;

  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 3) {
      list.hidden = true;
      list.innerHTML = '';
      return;
    }
    debounceTimer = window.setTimeout(async () => {
      const myId = ++inflight;
      try {
        const suggestions = await suggestAddress(q);
        if (myId !== inflight) return; // outdated
        if (suggestions.length === 0) {
          list.hidden = true;
          return;
        }
        list.innerHTML = suggestions
          .map(
            (s) =>
              `<li data-id="${s.id}" tabindex="0">${escapeHtml(s.weergavenaam)}</li>`,
          )
          .join('');
        list.hidden = false;
      } catch (err) {
        console.error(err);
        list.hidden = true;
      }
    }, 200);
  });

  input.addEventListener('blur', () => {
    // Geef even tijd voor click op suggestion
    setTimeout(() => {
      list.hidden = true;
    }, 150);
  });
  input.addEventListener('focus', () => {
    if (list.children.length > 0) list.hidden = false;
  });

  list.addEventListener('click', async (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (!li) return;
    const id = li.getAttribute('data-id');
    if (!id) return;
    list.hidden = true;
    input.value = li.textContent ?? '';
    input.disabled = true;
    try {
      const loc = await lookupAddress(id);
      if (!loc) throw new Error('Geen geldige coördinaten');
      // setLocation triggert page reload met nieuwe locatie
      setLocation(loc);
    } catch (err) {
      console.error(err);
      input.disabled = false;
      alert(`Adres ophalen mislukt: ${err instanceof Error ? err.message : err}`);
    }
  });

  // Reset-knop (dubbelklik op huidig adres → terug naar default)
  const cur = host.querySelector<HTMLDivElement>('#loc-current')!;
  cur.addEventListener('dblclick', () => {
    if (confirm('Terug naar standaard-adres (Kloosterstraat 9, Eext)?')) {
      resetToDefaultLocation();
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]!,
  );
}
