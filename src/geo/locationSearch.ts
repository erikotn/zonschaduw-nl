import type { ZonLocation } from '../config';

export interface AddressSuggestion {
  id: string;
  weergavenaam: string;
  type: 'adres' | 'postcode' | 'weg' | 'woonplaats';
}

/**
 * PDOK Locatieserver suggest: typeahead voor Nederlandse adressen.
 * Filtert op type=adres voor concrete adressen (geen postcodes/wegen).
 */
export async function suggestAddress(query: string): Promise<AddressSuggestion[]> {
  if (query.length < 3) return [];
  const params = new URLSearchParams({
    q: query,
    fq: 'type:adres',
    rows: '8',
  });
  const r = await fetch(`/api/pdok-loc/suggest?${params}`);
  if (!r.ok) throw new Error(`PDOK suggest ${r.status}`);
  const data = await r.json();
  const docs = data?.response?.docs ?? [];
  return docs.map((d: any) => ({
    id: d.id,
    weergavenaam: d.weergavenaam,
    type: d.type,
  }));
}

/** PDOK lookup: geeft volledige info incl. RD- en WGS-coördinaten. */
export async function lookupAddress(id: string): Promise<ZonLocation | null> {
  const params = new URLSearchParams({ id, fl: '*' });
  const r = await fetch(`/api/pdok-loc/lookup?${params}`);
  if (!r.ok) throw new Error(`PDOK lookup ${r.status}`);
  const data = await r.json();
  const doc = data?.response?.docs?.[0];
  if (!doc) return null;

  // centroide_ll: "POINT(lon lat)"
  // centroide_rd: "POINT(x y)"
  const ll = parsePoint(doc.centroide_ll);
  const rd = parsePoint(doc.centroide_rd);
  if (!ll || !rd) return null;

  return {
    address: doc.weergavenaam ?? 'Onbekend adres',
    bagAdresseerbaarobjectId: doc.adresseerbaarobject_id ?? doc.nummeraanduiding_id ?? null,
    wgs84: { lat: ll.y, lon: ll.x },
    rd: { x: rd.x, y: rd.y },
  };
}

function parsePoint(s: string | undefined): { x: number; y: number } | null {
  if (!s) return null;
  const m = s.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}
