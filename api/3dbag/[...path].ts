/**
 * Vercel Edge Function: proxy naar api.3dbag.nl.
 *
 * 3D BAG (TU Delft) heeft geen CORS-headers, dus de browser kan er niet direct
 * vanaf onze gedeployde site fetchen. Deze edge-functie tunnelt de request en
 * voegt CORS-headers toe zodat de SPA in productie wel werkt.
 *
 * Voor lokale dev wordt /api/3dbag via Vite dev-proxy afgehandeld.
 */

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // /api/3dbag/collections/pand/items?bbox=...  →  https://api.3dbag.nl/collections/pand/items?bbox=...
  const subPath = url.pathname.replace(/^\/api\/3dbag\/?/, '/');
  const target = `https://api.3dbag.nl${subPath}${url.search}`;

  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      Accept: req.headers.get('Accept') || '*/*',
    },
    redirect: 'follow',
  });

  const headers = new Headers();
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, OPTIONS');
  headers.set(
    'content-type',
    upstream.headers.get('content-type') || 'application/octet-stream',
  );
  // 3D BAG-data verandert nauwelijks; cache lang aan de edge
  headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
