# BoreWalk

BoreWalk is a web-based 3D wellbore visualization that works like an architectural walkthrough, built on real public oil and gas data from Equinor's **Volve** field (North Sea, block 15/9). You can travel from the drill floor through the water column, the cased vertical hole, the build section and the near-horizontal lateral of well **15/9-F-11 B**. Along the way you see the borehole geometry from the caliper log, the inferred casing strings, formation tops, bedding, fractures and the Hugin oil reservoir. You can also fly freely around a structural geomodel built from 34 wellbores.

| Field overview | Landing in the reservoir (measured resistivity) |
| --- | --- |
| ![overview](docs/screenshots/hero_overview.png) | ![resistivity](docs/screenshots/hero_resistivity.png) |
| **Interpreted hydrocarbons (calculated)** | **Inside the borehole** |
| ![hydrocarbons](docs/screenshots/hero_hydrocarbon.png) | ![inside](docs/screenshots/hero_inside.png) |

> The screenshots were rendered with a software GPU in headless Chromium (`?q=low`: no MSAA and no bloom). On a real GPU the app renders with MSAA, bloom and adaptive resolution.

## Running the app

### Prerequisites

- **Node.js 22 or newer**
- **pnpm 10**. The exact version is pinned in `package.json` (`packageManager`). The easiest way to get it is `corepack enable`, which ships with Node. Alternatively run `npm install -g pnpm`.
- A browser with **WebGL 2** and hardware acceleration enabled (current Chrome, Edge, Firefox or Safari).

### 1. Install

```bash
git clone https://github.com/rpkapps/wellbore-architecture-like-walkthrough.git
cd wellbore-architecture-like-walkthrough
corepack enable        # once per machine, activates the pinned pnpm
pnpm install
```

### 2. Start the development server

```bash
pnpm dev
```

Open http://localhost:5173. The app loads the preloaded Volve dataset (about 16 MB of LAS, survey, picks and production files) and then flies to the field overview. Code changes hot-reload.

To open it from another device on your network (a tablet or a meeting-room screen, for example), run `pnpm dev --host` and use the network URL it prints.

### 3. Build and serve a production version

```bash
pnpm build             # type-checks, then writes the static site to dist/
pnpm preview           # serves dist/ at http://localhost:4173
```

`dist/` is a fully static site that uses relative paths, so any static host works: GitHub Pages, Netlify, S3, nginx, or a sub-folder of an existing site. It has to be served over HTTP, because opening `dist/index.html` straight from disk (`file://`) blocks the data requests. For a quick local check without Node:

```bash
cd dist && python3 -m http.server 8080    # http://localhost:8080
```

### URL options

| Option | Effect |
| --- | --- |
| `?q=low` | Performance mode: pixel ratio 1, no MSAA, no bloom. Use it on integrated or older GPUs, remote desktops and VMs. |

Even without it, the app lowers its render resolution automatically when the frame rate drops.

### Tests and checks

```bash
pnpm test              # unit tests against the real Volve files (parsers, min-curvature, CPI calibration, zonation)
pnpm typecheck         # TypeScript only
```

### Regenerating the preloaded dataset (optional)

The prepared files are committed in `public/data/volve/`, so you only need this step to rebuild them from the upstream sources. It needs Python 3 with `numpy`, `pandas` and `openpyxl`, plus shallow clones of the public source repositories under the folder names the script expects:

```bash
pip install numpy pandas openpyxl
mkdir -p ~/volve-src && cd ~/volve-src
git clone --depth 1 https://github.com/andymcdgeo/Petrophysics-Python-Series pps
git clone --depth 1 https://github.com/yohanesnuwara/volve-machine-learning volve-machine-learning
git clone --depth 1 https://github.com/orkahub/PEG_Python peg
git clone --depth 1 https://github.com/jczettl/wellbore-trajectory-uncertainty wtu
cd -   # back to this repository
pnpm prepare-data ~/volve-src
```

### Troubleshooting

- **Blank or black viewport:** check that WebGL 2 is available (visit `chrome://gpu` or https://get.webgl.org/webgl2/) and that hardware acceleration is switched on in the browser settings.
- **Low frame rate:** add `?q=low`, collapse the side panels, or lower *Radial exaggeration* and *Halo / fluid volume intensity* in the Scene panel.
- **"Failed to load …" on the loading screen:** the site isn't being served from its root folder, or it was opened via `file://`. Serve `dist/` over HTTP as shown above.

The app has no backend. Uploaded files are parsed in the browser and never leave it.

## What is preloaded (real data, not simulated)

| Data | Wellbores | Provenance |
| --- | --- | --- |
| Composite LAS logs: GR, deep, medium and shallow resistivity (RT, RACELM/HM, RPCEHM/LM), RHOB, NPHI, PEF, DRHO, CALI, BS, ROP; **DT and DTS** on F-11 A | F-11 B, F-11 A, F-1 C, F-12 | Measured |
| More logged wellbores (*More Volve wells* feature): full suites, **DT and DTS** on F-1 A, F-1 B and F-14 | F-1 A, F-1 B, F-14, F-15 D, F-4, F-5 | Measured |
| Equinor CPI petrophysical output (SW, PHIF, VSH, KLOGH, flags) | F-11 A, F-1 C, F-12, F-1 A, F-1 B, F-15 D | Operator interpretation |
| Formation picks with MD, TVD, easting and northing (408 picks) | 34 wellbores | Operator interpretation |
| **Definitive directional surveys** (positions from the survey UTM coordinates) | all 10 detailed wells + 15 of 29 context wells | Measured |
| Daily production: oil, gas, water, water injection, downhole P and T, WHP, choke | F-11, F-12, F-1 C, F-14, F-15 D, F-4, F-5 | Measured (reported) |
| Monthly production | all Volve producers and injectors | Measured (reported) |
| Equinor's Volve reservoir simulation model (2016): 108 × 100 × 63 corner-point grid, 183,545 active cells, porosity, permeability, NTG, initial saturation, regions | field | Operator model |

Sources (Equinor Volve Data Village release, taken from public GitHub mirrors) are listed in `public/data/volve/manifest.json` and in the in-app **Data** dialog. `scripts/prepare_volve_data.py` and `scripts/add_volve_extras.py` document every step. They only drop empty or duplicate LAS columns (data rows are copied verbatim; the extra wells' 0.1 m logs are thinned to every second sample), convert the production workbook to CSV, write the definitive surveys, and build the few context trajectories still marked *reconstructed*. `scripts/prepare_sim.py` converts the Eclipse grid and INIT file into the compact `.bwsim` format.

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
- **Uploads** (drag and drop anywhere): LAS, CSV and Excel files for logs, tops, surveys and production. Details and real open datasets are under [Importing your own data](#importing-your-own-data).

## Optional features (Features panel)

Every feature below can be switched on or off in **Features** (top bar). The choice is remembered in your browser. `?features=all`, `?features=none` or a list such as `?features=geosteer,curtain` in the URL overrides it. Features marked *GPU* start off in the low-quality mode (`?q=low`).

| Feature | What it does | Provenance | Default |
| --- | --- | --- | --- |
| **Geosteering view** | Where the well is relative to the top and base of a target formation (Hugin by default) at every depth. In 3D: a status band on the hole (in zone / above / below), drop-lines to both surfaces, and the surfaces as ribbons along the path. A distance-to-boundary strip docks above the timeline. The compass HUD shows a read-out. *Tied* mode corrects the smooth regional model so it passes through every formation boundary the well actually crossed, as a geosteerer would. F-11 B: 592 m of the lateral in the Hugin (39 %), matching its picks. | Calculated | on |
| **Log curtain** | A ribbon hanging off the trajectory with GR, resistivity, So, φ, RHOB, NPHI, DT or ROP drawn as a filled, colour-coded curve. It stands vertically above laterals and turns sideways where the hole is vertical. | Measured / calculated | on |
| **Cross-section along the well** | A 2D section along the unrolled well path: formations from the picks model, trajectory, casing shoes, tops and a log. It overlays tied surfaces, the oil–water contact and uncertainty when those features are on. Vertical exaggeration is selectable; click to travel there. | Interpreted | off |
| **Oil–water contact** | Deepest oil (Sw < 0.5) and shallowest water (Sw > 0.8) in clean Hugin–Skagerrak sands of every logged well, from the live Sw calculation. Each bracket is drawn as a disc at its well, with an optional field-wide plane at the median, which you can set yourself. The wells do **not** share one contact (F-12 ≈ 2913 m, F-11 A ≈ 3025 m, F-14 ≈ 3059 m, F-5 ≈ 3148 m TVDSS), which is consistent with fault compartments and logging at different stages of depletion. The feature says so rather than forcing one plane. | Calculated | on |
| **Drilling speed (ROP) mode** | A fourth colouring mode from the LAS ROP curve, with footage-weighted mean ROP and on-bottom drilling hours per formation. | Measured | on |
| **Survey uncertainty cones** | 1σ/2σ/3σ position ellipses swept along the path from a simplified systematic MWD model (σinc 0.1°, σazi 0.5°, 1 ‰ depth), plus an allowance on trajectories reconstructed from picks. The vertical band also appears in the geosteering strip and cross-section. Not a full ISCWSA tool-code model. | Calculated | off |
| **More Volve wells** | Adds F-1 A, F-1 B, F-14, F-15 D, F-4 and F-5 with logs, CPI, definitive surveys and daily production. | Measured | on |
| **Reservoir simulation** | Equinor's Volve Eclipse model on the map. Every active cell is an instanced box coloured by initial oil saturation, porosity, permeability, NTG, region or depth. Filters for layers and values, clipping to the section box, and a field oil-rate chart. Time-lapse results (saturation and pressure per report date) are shown with a date slider when the package contains restart data. Import your own `.bwsim` in Data. | Operator model / calculated | off |
| **Shadows & ambient occlusion** | Sun shadow map, plus a screen-space AO pass written for three.js' logarithmic depth buffer (the stock SSAO/GTAO passes assume linear depth). | — | on (GPU) |
| **Inside-the-hole atmosphere** | Radial lens depth-of-field and drifting drilling-fluid particles in the Inside view. | — | on (GPU) |
| **Sea surface & seabed detail** | Multi-octave waves with Fresnel sky reflection and sun glint, and sand ripples with shell-hash patches on the seabed. | — | on (GPU) |
| **Measure tool** | Press **M**, then click two points: 3D distance, horizontal and vertical offsets, azimuth, TVDSS of both ends, and ΔMD when both points are on the well. | — | on |
| **Saved views & presentation** | Bookmark camera, view mode, property, layers and section box with a caption. **Present** plays them full-screen with captions (→ / Space next, ← back, Esc exit). *Add starter tour* builds five views for the active well. | — | on |
| **High-resolution snapshot** | 2× or 4K PNG of the current view, rendered off-screen, with the 3D labels, a title block, colour bar, north arrow and data credits drawn on top. | — | on |

## Importing your own data

Open **Data** in the top bar, or drop files anywhere on the page. Choose whether to **supplement** the active well, **replace** its data, or **create a new well**. Each file's type is detected automatically. For CSV/XLSX files with depths in feet and no unit in the header, set *Depth units* to Feet. The same guide, with templates, is built into the Data manager under *What you can import*.

| File type | Required | Real open data to try |
| --- | --- | --- |
| **Well logs (LAS 1.2/2.0)** | `~Curve` section (first curve = depth) + `~ASCII` data. Plotted curves under any vendor mnemonic: GR, RT/ILD/LLD/RDEP, RXO/MSFL/RMED, RHOB/DEN, NPHI/NEU, DT/AC, DTS, CALI, BS, PEF. Feet are converted. | [Volve LAS files (GitHub mirror)](https://github.com/andymcdgeo/Petrophysics-Python-Series/tree/master/Data/Volve) · [Equinor Volve Data Village](https://www.equinor.com/energy/volve-data-sharing) (free registration) · [Kansas Geological Survey digital logs](https://www.kgs.ku.edu/Magellan/Logs/index.html) · [NLOG (Netherlands)](https://www.nlog.nl/en) · [FORCE 2020 Norwegian wells](https://github.com/bolgebrygg/Force-2020-Machine-Learning-competition) |
| **Well logs (CSV)** | Depth column (`DEPTH`, `MD`, `DEPT`, `DEPTH_MD`) + one column per curve; optional `WELL` column for multi-well files | [VolveWells.csv](https://github.com/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/VolveWells.csv) (15/9-F-1 C, F-4, F-7) · [SEG 2016 facies_vectors.csv](https://github.com/seg/2016-ml-contest/blob/master/facies_vectors.csv) (Kansas, depth in **feet**) · [FORCE 2020 CSV](https://github.com/bolgebrygg/Force-2020-Machine-Learning-competition) |
| **Formation tops** | Name column (`FORMATION`, `PICK(S)`, `NAME`, `SURFACE`) + `MD`; optional `TVD`, `WELL`. Headerless `NAME,MD` also works. | [Volve official picks, 34 wellbores](https://github.com/yohanesnuwara/volve-machine-learning/blob/master/Volve_well_picks_modified.csv) · [NPD tops for 15/9-19 SR](https://github.com/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9_19_SR_TOPS_NPD.csv) · [Sodir FactPages wellbore lithostratigraphy](https://factpages.sodir.no/en/wellbore) (`wlbName`/`lsuName`/`lsuTopDepth` recognised) |
| **Directional survey** | `MD` + `INC`/`INCL`/`DEVI` + `AZI`/`AZIM` (minimum curvature), or `MD` + `TVD` + `NS` + `EW` | [Volve 15/9-F-11 A definitive survey](https://github.com/jczettl/wellbore-trajectory-uncertainty/blob/main/data/15_9_F_11_A.csv) · [Volve 15/9-F-12](https://github.com/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9-F-12_Survey_Data.csv) · [P11-A-02, Dutch North Sea](https://github.com/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/P11-A-02_SURV.csv) |
| **Reservoir simulation (.bwsim)** | Convert Eclipse / OPM Flow output first: `python3 scripts/prepare_sim.py --grid CASE.EGRID --init CASE.INIT --unrst CASE.UNRST --smspec CASE.SMSPEC --unsmry CASE.UNSMRY --origin-e … --origin-n … -o model.bwsim` (a GRDECL grid also works) | [Equinor Volve Data Village](https://www.equinor.com/energy/volve-data-sharing) · [Volve deck for OPM Flow](https://github.com/dabiged/Volve2OPM) · [OPM Norne benchmark](https://github.com/OPM/opm-data) |
| **Production (CSV or .xlsx)** | `DATE`/`DATEPRD` (or `YEAR` + `MONTH`) + any of `OIL`, `GAS`, `WATER`, `WATER_INJ` in Sm³ per period; optional downhole P/T, WHP, choke, hours, `WELL` | [Volve production data.xlsx](https://github.com/yohanesnuwara/volve-machine-learning/blob/master/Volve%20production%20data.xlsx) (drop the workbook in as-is) · [Sodir FactPages field production](https://factpages.sodir.no/en/field) (million/billion Sm³ columns converted) |

On GitHub file pages, use **Download raw file** to save the actual file. Good combinations to try:

- `15-9-19_SR_COMP.las` + `15_9_19_SR_TOPS_NPD.csv` with **Create new well**.
- `Volve production data.xlsx` while 15/9-F-12 is active: the matching well's daily records are picked automatically.

Multi-well files are matched to the target well by name. For example, production reported under "15/9-F-11" attaches to wellbore 15/9-F-11 B. When adding to an existing well that isn't in the file, the import fails with a clear message rather than using another well's data.

The Volve, SEG, P11-A-02 and Volve-workbook imports were tested end to end with the real files. The Sodir FactPages column mapping follows the published attribute names but could not be tested from the build environment.

## Honest limitations

- All detailed wells now use Equinor **definitive directional surveys** (from a public mirror of the Volve release). They agree with the official formation-pick coordinates within 0.6 m. 14 of the 29 context wells still have no public survey and are drawn through their pick coordinates, labelled *reconstructed*.
- F-11 B has no sonic log. DT and DTS are shown for F-11 A, F-1 A, F-1 B and F-14.
- The reservoir-simulation package holds Equinor's grid and static properties from the INIT file of their Eclipse run. The original restart (time-lapse) files are not in any reachable public mirror.
- Oil–water contacts from logs depend on the Sw model (one Rw for the field) and on when each well was logged. Treat them as evidence, not as the field contact.
- Natural fractures are **schematic**: the package contains no image log.
- Cement tops and the jack-up geometry are schematic. Casing sizes are inferred from standard hole/casing pairs.
- Volve production is reported at well level: F-11 volumes are listed under NPD wellbore 15/9-F-11.
- Regional surfaces are interpretive between wells. Along the well, zonation comes from that well's own picks.

## Coordinates

ED50 / UTM 31N. The local origin is E 435050.03, N 6478563.55, derived from the F-11 A survey tie-in against its seabed pick. Scene axes: x = east, y = elevation (MSL = 0), z = −north. MD and TVD are measured from the drill floor at +54.9 m. TVDSS is below MSL. Only the near-well radial geometry is exaggerated.

## Project structure

```
scripts/prepare_volve_data.py   provenance-preserving data preparation
scripts/add_volve_extras.py     definitive surveys, extra logged wells, daily production
scripts/prepare_sim.py          Eclipse / OPM (GRDECL|EGRID, INIT, UNRST, UNSMRY) → .bwsim
public/data/volve/              preloaded dataset + manifest.json (+ sim/volve_2016.bwsim)
src/features/                   optional features (registry, one module per feature)
src/data/                       LAS/CSV parsers, minimum curvature, petrophysics, horizons, stratigraphy
src/scene/                      three.js engine, geomodel, wellbore assembly, shaders, camera rig
src/ui/                         glass UI: panels, log tracks, inspector, drawers, data manager, tour
tests/                          unit tests against the real Volve files
```
