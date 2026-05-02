/**
 * Universele PDOK-proxy als Vercel Edge Function.
 *
 * In productie hebben we niet alle PDOK-services direct beschikbaar:
 *  - api.3dbag.nl heeft geen CORS-headers (gebouwen) → moet via deze proxy
 *  - Andere services (BRT, Locatieserver, Kadaster) hebben wel CORS, maar we
 *    routeren ze ook hierdoor zodat dev-paths en prod-paths identiek zijn.
 *
 * Lokaal worden dezelfde paths door de Vite dev-proxy afgehandeld
 * (zie vite.config.ts), zodat de client-code 100% hetzelfde is in dev en prod.
 */

export const config = {
  runtime: 'edge',
};

interface Route {
  prefix: string;
  host: string;
}

const ROUTES: Route[] = [
  { prefix: '/api/3dbag/', host: 'https://api.3dbag.nl/' },
  { prefix: '/api/pdok-brt/', host: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/' },
  { prefix: '/api/pdok-loc/', host: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/' },
  {
    prefix: '/api/pdok-kadaster-wms',
    host: 'https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0',
  },
  {
    prefix: '/api/pdok-kadaster/',
    host: 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/',
  },
  {
    prefix: '/api/pdok-luchtfoto',
    host: 'https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0',
  },
];

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Vind de eerste route die past (langste prefix wint impliciet door volgorde)
  const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (!route) {
    return new Response(`No proxy for ${url.pathname}`, { status: 404 });
  }

  const target = route.host + url.pathname.slice(route.prefix.length) + url.search;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        Accept: req.headers.get('Accept') || '*/*',
      },
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const headers = new Headers();
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, OPTIONS');
  headers.set(
    'content-type',
    upstream.headers.get('content-type') || 'application/octet-stream',
  );
  // Caching: PDOK-data verandert nauwelijks
  headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
