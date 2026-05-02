import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    proxy: {
      // 3D BAG API — geen CORS, dus via dev-proxy
      '/api/3dbag': {
        target: 'https://api.3dbag.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/3dbag/, ''),
        secure: true,
      },
      // PDOK Luchtfoto-WMS
      '/api/pdok-luchtfoto': {
        target: 'https://service.pdok.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pdok-luchtfoto/, '/hwh/luchtfotorgb/wms/v1_0'),
        secure: true,
      },
      // PDOK Kadastrale Kaart (OGC API Features)
      '/api/pdok-kadaster': {
        target: 'https://api.pdok.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pdok-kadaster/, '/kadaster/brk-kadastrale-kaart/ogc/v1'),
        secure: true,
      },
      // PDOK Locatieserver (adres-suggest + lookup)
      '/api/pdok-loc': {
        target: 'https://api.pdok.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pdok-loc/, '/bzk/locatieserver/search/v3_1'),
        secure: true,
      },
      // PDOK BRT-achtergrondkaart (WMTS tiles, 1:1 aligned met BAG)
      '/api/pdok-brt': {
        target: 'https://service.pdok.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pdok-brt/, '/brt/achtergrondkaart/wmts/v2_0'),
        secure: true,
      },
      // PDOK Kadastrale Kaart als WMS (voor kadasterlijnen-overlay)
      '/api/pdok-kadaster-wms': {
        target: 'https://service.pdok.nl',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/pdok-kadaster-wms/, '/kadaster/kadastralekaart/wms/v5_0'),
        secure: true,
      },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
