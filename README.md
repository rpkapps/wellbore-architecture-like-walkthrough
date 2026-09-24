# Volve Wellbore Digital Twin

A web-based 3D wellbore visualization that works like an architectural walkthrough, built on real public oil and gas data from Equinor's **Volve** field (North Sea, block 15/9). You can travel from the drill floor through the water column, the cased vertical hole, the build section and the near-horizontal lateral of well **15/9-F-11 B**. Along the way you see the borehole geometry from the caliper log, the inferred casing strings, formation tops, bedding, fractures and the Hugin oil reservoir. You can also fly freely around a structural geomodel built from 34 wellbores.

| Field overview | Landing in the reservoir (measured resistivity) |
| --- | --- |
| ![overview](docs/screenshots/hero_overview.png) | ![resistivity](docs/screenshots/hero_resistivity.png) |
| **Interpreted hydrocarbons (calculated)** | **Inside the borehole** |
| ![hydrocarbons](docs/screenshots/hero_hydrocarbon.png) | ![inside](docs/screenshots/hero_inside.png) |

> The screenshots were rendered with a software GPU in headless Chromium (`?q=low`: no MSAA and no bloom). On a real GPU the app renders with MSAA, bloom and adaptive resolution.

## Quick start

Requires Node 22+ and pnpm (the version is pinned in `package.json` via `packageManager`; `corepack enable` picks it up).

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # unit tests against the real Volve files
pnpm build         # static site in dist/ (deploy anywhere, relative paths)
```

The app needs no backend. All data is served as static files from `public/data/volve/`, and anything you upload is parsed in the browser and never leaves it. Add `?q=low` to the URL on very weak GPUs.

## What is preloaded (real data, not simulated)

| Data | Wellbores | Provenance |
| --- | --- | --- |
| Composite LAS logs: GR, deep, medium and shallow resistivity (RT, RACELM/HM, RPCEHM/LM), RHOB, NPHI, PEF, DRHO, CALI, BS, ROP; **DT and DTS** on F-11 A | F-11 B, F-11 A, F-1 C | Measured |
| Equinor CPI petrophysical output (SW, PHIF, VSH, KLOGH, flags) | F-11 A, F-1 C | Operator interpretation |
| Formation picks with MD, TVD, easting and northing (408 picks) | 34 wellbores | Operator interpretation |
| Definitive directional survey (323 stations) | F-11 A | Measured |
| MD/INC/AZI survey | F-12 | Measured (see limitations) |
| Daily production: oil, gas, water, water injection, downhole P and T, WHP, choke | F-11, F-12, F-1 C | Measured (reported) |
| Monthly production | all Volve producers and injectors | Measured (reported) |

Sources (Equinor Volve Data Village release, taken from public GitHub mirrors) are listed in `public/data/volve/manifest.json` and in the in-app **Data** dialog. `scripts/prepare_volve_data.py` documents every step. It only drops empty or duplicate LAS columns (data rows are copied verbatim), converts the production workbook to CSV and builds the trajectories marked *reconstructed*.

Data licence: Equinor Open Data Licence (https://www.equinor.com/energy/volve-data-sharing).

## Measured vs calculated: every value is labelled

Each value in the UI (log tracks, inspector, legend, narrative) carries a provenance chip:

- **Measured**: acquired by logging tools, survey tools or gauges.
- **Operator interp.**: formation picks and Equinor CPI.
- **Calculated**: computed live in the app from measured inputs and parameters you can edit.
- **Reconstructed**: geometry derived from other data (trajectories through pick coordinates, casing from bit size).
- **Schematic**: illustrative only (natural fractures, cement placement, the platform model).

### Resistivity view (measured)
The borehole wall is coloured by the shallow resistivity reading. Concentric translucent shells grade outward to the deep reading (RT), so invasion shows up as a colour change with radius. The colour scale is logarithmic from 0.2 to 2000 Ω·m. You can choose a petrophysical blue→red ramp, Turbo, Viridis or Inferno. The same scale is drawn as a strip in the resistivity log track.

### Hydrocarbon view (calculated)
- `Vsh` comes from the gamma-ray index (linear or Larionov).
- `φ` is density porosity `(ρma − ρb)/(ρma − ρfl)`, optionally combined with neutron porosity and shale-corrected.
- `Sw` uses Archie (default) or modified Simandoux. `So = 1 − Sw`.
- Net pay uses Vsh, φ and Sw cut-offs.

Defaults are calibrated to the operator's own interpretation:

| Check (F-11 A / F-1 C) | r | bias |
| --- | --- | --- |
| Calculated Sw vs Equinor CPI SW | 0.980 / 0.981 | +0.9 / +1.4 pu |
| Calculated φ vs Equinor CPI PHIF | 0.986 / 0.979 | +1.0 / +0.9 pu |

(`Rw = 0.025 Ω·m` at 106 °C, the median downhole gauge temperature of Volve producers; a = 1, m = n = 2; ρma = 2.65 g/cm³.)

Oil-bearing pore space is drawn as a volume around the borehole: a soft pore network whose pore fraction follows φ, where each pore is filled with oil (amber) or brine (blue) in proportion to So. The borehole wall takes an oil stain like slabbed core. The volume is drawn only where density and resistivity logs exist. The Interpretation drawer shows zone summaries (N/G, net pay, φ, Sw, HC column), validates against the CPI live, and exports the calculated curves as CSV.

## Features

- **Guided walkthrough** with data-driven chapters (rig floor → seabed → Utsira aquifer → casing shoes → sidetrack → chalk → Draupne source rock → landing → best pay → reservoir exit and re-entry → TD). Three views: *Inside* (tunnel camera in the hole), *Chase* (cutaway section) and *Orbit*. Includes play, scrub, speed control and an auto tour.
- **Free exploration**: fly with WASD/QE, drag to look, Shift to boost, wheel to set speed. Orbit mode is also available. Double-click focuses on a point. You can go above, below and sideways from the well. Inside the rock, a proximity bubble dissolves nearby geology into a contour grid so it doesn't block the view.
- **Geomodel**: 12 horizons interpolated from multi-well picks (planar trend + inverse-distance residuals, forced into stratigraphic order), built as capped solids. A BIM-style **section box** lets you strip overburden to a TVDSS and move each face. You can show, hide, fade and **isolate** any formation, and use presets such as *Reservoir focus* and *Isolate pay*. The procedural PBR lithologies (sandstone, claystone, chalk with stylolites and flint, marl couplets, organic shale, coal-streaked delta plain, red beds) follow conformable bedding.
- **Wellbore**: tube radius from the caliper log (bit size as fallback), with adjustable radial exaggeration. Casing strings and cement are inferred from the bit-size log and drawn as steel with couplings. The view also shows formation-top rings, casing shoes, the sidetrack point, depth ticks with MD/TVD, fractures (schematic) and pay brackets.
- **Log tracks synced with 3D**: GR/caliper, resistivity with the matching colour strip, density–neutron with crossover shading, sonic, calculated Vsh/φ, and Sw with So fill plus the CPI Sw overlay. Hovering highlights the depth in 3D, clicking travels there, the wheel scrolls and Ctrl+wheel zooms.
- **Inspector**: click the borehole, casing, a formation, a fracture, a top, a pay interval, another well or the platform to see its data with provenance.
- **Production**: monthly rates, cumulative oil, water cut, GOR and downhole gauges.
- **Uploads** (drag and drop anywhere): LAS 1.2/2.0 (wrapped or not, feet converted to metres, vendor mnemonics resolved through aliases), CSV logs, formation tops (including headerless `NAME,MD`), surveys as MD/INC/AZI (minimum curvature) or MD/TVD/NS/EW, and daily or monthly production. You can **supplement** the active well (curves are resampled onto its depth grid), **replace** its data, or **create a new well**. Templates can be downloaded.

## Honest limitations

- **15/9-F-11 B has no public definitive survey.** Above the 2585 m MD sidetrack point the app uses the definitive survey of its parent bore, F-11 A. The GR logs are identical down to ~2490 m and the bit-size log shows the sidetrack at 2585 m. Below that point the path is a smooth curve through the 33 official formation-pick coordinates (MD, TVD, E, N) of F-11 B, and it passes exactly through each pick. F-1 C and the context wells are reconstructed the same way. All of these are labelled *reconstructed*.
- The public F-12 MD/INC/AZI file differs from the official pick coordinates by up to ~29 m (probably a datum or version difference), so F-12 is shown only for context.
- F-11 B has no sonic log. DT and DTS are shown for F-11 A.
- Natural fractures are **schematic**: the package contains no image log.
- Cement tops and the jack-up geometry are schematic. Casing sizes are inferred from standard hole/casing pairs.
- Volve production is reported at well level: F-11 volumes are listed under NPD wellbore 15/9-F-11.
- Regional surfaces are interpretive between wells. Along the well, zonation comes from that well's own picks.

## Coordinates

ED50 / UTM 31N. The local origin is E 435050.03, N 6478563.55, derived from the F-11 A survey tie-in against its seabed pick. Scene axes: x = east, y = elevation (MSL = 0), z = −north. MD and TVD are measured from the drill floor at +54.9 m. TVDSS is below MSL. Only the near-well radial geometry is exaggerated.

## Project structure

```
scripts/prepare_volve_data.py   provenance-preserving data preparation
public/data/volve/              preloaded dataset + manifest.json
src/data/                       LAS/CSV parsers, minimum curvature, petrophysics, horizons, stratigraphy
src/scene/                      three.js engine, geomodel, wellbore assembly, shaders, camera rig
src/ui/                         glass UI: panels, log tracks, inspector, drawers, data manager, tour
tests/                          unit tests against the real Volve files
```
