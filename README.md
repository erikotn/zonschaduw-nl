# Zon

3D zon- en schaduwsimulatie voor elk Nederlands adres. Bouw op open PDOK-data (3D BAG, Locatieserver, Kadaster, BRT) om voor je eigen huis te zien:

- waar valt schaduw, op welk moment van het jaar
- de beste plek voor een terras (op zit-hoogte gemeten)
- de beste plek voor een kas (jaar/winter zonuren op grondniveau)
- welke dakvlakken kansrijk zijn voor zonnepanelen, met kWh/jaar-schatting

## Demo

| | |
|---|---|
| **Live schaduw** | Tijd- en datum-slider; schaduw beweegt direct mee. |
| **Terras** | Heatmap "totale zonuren" of "tot hoe laat zon" binnen 16:00–22:00, beste plek aangewezen met goudgele pin. |
| **Kas** | Heatmap voor hele jaar / winter / groeiseizoen, met klikbare maandgrafiek. |
| **Zonnepanelen** | Per dakvlak (PVGIS-baseline + multi-sample raycast schaduw); rode/groene kleuring; klik voor kWh/jaar + terugverdientijd. Markeer ongeschikte vlakken (riet) of teken paneelzone op een dakvlak. |
| **Adres-zoeker** | Topbar autocomplete via PDOK Locatieserver — werkt voor elk Nederlands adres. |

## Lokaal draaien

```bash
npm install
npm run dev
```

Open http://localhost:5173.

```bash
npm test          # vitest unit tests (coord transforms)
npm run build     # tsc + vite build → dist/
```

## Datasources

Alle data is open en wordt rechtstreeks via PDOK gefetcht (Vite dev-proxy om CORS te omzeilen).

| Data | Service | Gebruik |
|---|---|---|
| 3D BAG (LOD2.2) | api.3dbag.nl | Gebouwgeometrie + dakvlak-semantiek |
| Locatieserver | api.pdok.nl/bzk/locatieserver | Adres-suggest + lookup |
| BRT-A WMTS | service.pdok.nl/brt/achtergrondkaart | Topografische kaart (pastel/grijs) |
| Kadastrale Kaart WMS | service.pdok.nl/kadaster/kadastralekaart | Perceelgrenzen overlay |
| Kadastrale Kaart OGC API | api.pdok.nl/kadaster/brk-kadastrale-kaart | Perceel-polygonen (bestaand maar niet meer in UI) |

Voor productie-deployment is een eigen proxy nodig (Cloudflare Worker, edge-function of vergelijkbaar) want de PDOK-services zetten geen CORS-headers.

## Tech stack

- **Vite + TypeScript** — build/dev
- **three.js (r178)** — 3D scene, shadow-mapping
- **three-mesh-bvh** — BVH-versnelde raycast (~50× sneller; nodig voor multi-sample PV)
- **SunCalc** — zonpositie via WGS-coördinaat
- **proj4** — RD New (EPSG:28992) ↔ WGS84
- **earcut** — polygon-triangulatie voor BAG-faces
- **Chart.js** — uurcurve + maandgrafiek

## Architectuur

```
src/
├── main.ts                    # bootstrap, mode-router, click/mousemove handlers
├── config.ts                  # locatie-state (mutable HOUSE via localStorage)
├── geo/                       # PDOK + coord-transforms
│   ├── coords.ts              # RD ↔ WGS ↔ scene-local
│   ├── bag.ts                 # 3D BAG fetch + CityJSON-parser (incl. earcut)
│   ├── aerial.ts              # WMTS tile-stitcher + kadaster-overlay
│   ├── parcel.ts              # Kadaster OGC API (bestaand maar uitgeschakeld)
│   └── locationSearch.ts      # PDOK Locatieserver suggest+lookup
├── scene/                     # three.js scene-objecten
│   ├── sceneRoot.ts           # renderer, camera, controls, render-loop
│   ├── buildings.ts           # walls + roofs meshes
│   ├── ground.ts              # grondvlak met topo-textuur
│   ├── eyeHeightLayer.ts      # heatmap-overlay vlak
│   ├── lighting.ts            # zon (DirectionalLight) via SunCalc
│   ├── sky.ts                 # three.js Sky
│   ├── polygonDrawer.ts       # tuin-polygon-tekenaar (op grond)
│   ├── roofZoneDrawer.ts      # paneel-zone-tekenaar (op dakvlak)
│   ├── roofPlane.ts           # 3D-vlak helpers (frame, project, area)
│   ├── roofColoring.ts        # vertex-colors voor PV-resultaten
│   ├── parcelOutline.ts       # perceel-outlines (bestaand maar uitgeschakeld)
│   └── bestSpotPin.ts         # goudgele pin voor terras/kas-best-spot
├── sun/
│   └── sunPosition.ts         # SunCalc-wrapper → Vector3 zonrichting
├── exposure/                  # heatmap + PV-berekening
│   ├── accumulator.ts         # GPU multi-pass shadow-accumulator
│   ├── timeWindows.ts         # sample-generators per modus
│   ├── colormap.ts            # viridis-LUT
│   ├── findBestSpot.ts        # scan heatmap binnen polygon
│   ├── raycastSun.ts          # uurcurve / maandgrafiek per punt
│   └── pvCalc.ts              # PVGIS-baseline + multi-sample BVH-raycast
├── modes/
│   └── modeManager.ts         # tab-router (Live / Terras / Kas / PV)
└── ui/                        # vanilla DOM UI
    ├── timeStrip.ts           # tijd/datum slider + speed dropdown
    ├── overlayToggles.ts      # checkbox-toggles
    ├── locationPicker.ts      # adres-zoeker
    ├── chartUurcurve.ts       # Chart.js per uur
    └── chartMaandgrafiek.ts   # Chart.js per maand
```

## Beperkingen

- Alleen direct zonlicht; diffuus benaderd als 50% baseline.
- Geen bewolking, geen blad-cyclus van bomen.
- Vlak terrein (gemiddelde maaiveldhoogte uit BAG GroundSurface).
- PV-berekening gebruikt PVGIS-baseline voor 53°N geinterpoleerd; voor exacte cijfers blijft een offerte + [Zonatlas](https://www.zonatlas.nl) leidend.
- Rieten kap of andere materialen worden niet gedetecteerd; gebruiker markeert per dakvlak of er panelen mogelijk zijn (of tekent een zone op het pannen-deel).

## Credits

- **3D BAG** — [TU Delft 3D Geoinformation Group / 3DGI](https://3dbag.nl)
- **PDOK** — [Kadaster, Geonovum](https://pdok.nl)
- Inspiratie: [Shadowmap](https://shadowmap.org) (closed-source maar beste-in-klasse)

## Licentie

MIT (zie `LICENSE`).
