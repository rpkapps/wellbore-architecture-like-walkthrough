#!/usr/bin/env python3
"""
Download the CC0 PBR photo textures used by the "Realistic textures" feature
and pack them for the web (512 px JPEG per map).

Sources (all CC0 1.0 — public domain, no attribution required; credited anyway):
  * Poly Haven  https://polyhaven.com   (rock faces, seabed sand, steel, cement)
  * ambientCG   https://ambientcg.com   (supported: set a layer's source to
                                        'ambientcg' with an asset id, e.g. Metal012)

Per layer three images are written to public/textures/:
  <layer>_albedo.jpg   base colour (sRGB)
  <layer>_normal.jpg   tangent-space normal, OpenGL (+Y) convention
  <layer>_arm.jpg      R = ambient occlusion, G = roughness, B = metalness

Usage: python3 scripts/fetch_textures.py      (needs Pillow and network access)
"""
import io, json, os, urllib.request, zipfile
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures')
SIZE = 512

# layer order must match src/scene/textures.ts (LAYERS)
LAYERS = [
    ('seabed', 'polyhaven', 'damp_sand', 'Seabed sand at the Nordland mudline'),
    ('clay', 'polyhaven', 'excavated_soil_wall', 'Claystone (Nordland, Hordaland)'),
    ('sand', 'polyhaven', 'rock_06', 'Sandstone (Utsira, Hugin)'),
    ('chalk', 'polyhaven', 'marble_cliff_03', 'Chalk (Ekofisk, Hod) — pale stratified cliff'),
    ('marl', 'polyhaven', 'marble_cliff_02', 'Marl — brown stratified sedimentary rock'),
    ('blackshale', 'polyhaven', 'dark_rock_02', 'Organic shale (Draupne) — dark stratified rock'),
    ('siltshale', 'polyhaven', 'dark_rock', 'Silty shale (Ty, Heather)'),
    ('heterolithic', 'polyhaven', 'cliff_side', 'Heterolithic delta plain (Sleipner) — eroded sediment'),
    ('redbed', 'polyhaven', 'rock_boulder_cracked', 'Red beds (Skagerrak, Smith Bank)'),
    ('steel', 'polyhaven', 'rusty_metal_sheet', 'Casing steel (grey steel with light rust staining)'),
    ('cement', 'polyhaven', 'concrete_floor_worn_001', 'Casing cement'),
]


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'BoreWalk texture fetcher'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def img(data, mode='RGB'):
    return Image.open(io.BytesIO(data)).convert(mode).resize((SIZE, SIZE), Image.LANCZOS)


def polyhaven(asset):
    files = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))
    u = lambda k: files[k]['1k']['jpg']['url']
    alb = img(get(u('Diffuse')))
    nrm = img(get(u('nor_gl')))
    arm = img(get(u('arm')))  # AO, rough, metal
    return alb, nrm, arm, f'https://polyhaven.com/a/{asset}'


def ambientcg(asset):
    z = zipfile.ZipFile(io.BytesIO(get(f'https://ambientcg.com/get?file={asset}_1K-JPG.zip')))
    names = z.namelist()
    pick = lambda key: next((n for n in names if key in n and n.endswith('.jpg')), None)
    alb = img(z.read(pick('_Color')))
    nrm = img(z.read(pick('_NormalGL')))
    rough = img(z.read(pick('_Roughness')), 'L')
    ao_n = pick('_AmbientOcclusion')
    ao = img(z.read(ao_n), 'L') if ao_n else Image.new('L', (SIZE, SIZE), 255)
    met_n = pick('_Metalness')
    met = img(z.read(met_n), 'L') if met_n else Image.new('L', (SIZE, SIZE), 0)
    arm = Image.merge('RGB', (ao, rough, met))
    return alb, nrm, arm, f'https://ambientcg.com/view?id={asset}'


def main():
    os.makedirs(OUT, exist_ok=True)
    credits = []
    only = set(os.environ.get('ONLY', '').split(',')) - {''}
    for name, src, asset, desc in LAYERS:
        if only and name not in only:
            credits.append((name, desc, 'Poly Haven' if src == 'polyhaven' else 'ambientCG', asset, f'https://polyhaven.com/a/{asset}' if src == 'polyhaven' else f'https://ambientcg.com/view?id={asset}'))
            continue
        alb, nrm, arm, url = (polyhaven if src == 'polyhaven' else ambientcg)(asset)
        alb.save(os.path.join(OUT, f'{name}_albedo.jpg'), quality=86, optimize=True)
        nrm.save(os.path.join(OUT, f'{name}_normal.jpg'), quality=90, optimize=True)
        arm.save(os.path.join(OUT, f'{name}_arm.jpg'), quality=88, optimize=True)
        credits.append((name, desc, 'Poly Haven' if src == 'polyhaven' else 'ambientCG', asset, url))
        print('ok', name, asset)
    with open(os.path.join(OUT, 'CREDITS.md'), 'w') as f:
        used = sorted({c[2] for c in credits})
        links = {'Poly Haven': '[Poly Haven](https://polyhaven.com)', 'ambientCG': '[ambientCG](https://ambientcg.com)'}
        f.write(f"# Texture credits\n\nAll textures are **CC0 1.0** (public domain) from {' and '.join(links[u] for u in used)}; resized to 512 px by `scripts/fetch_textures.py`.\n\n")
        f.write('| Layer | Used for | Source | Asset |\n| --- | --- | --- | --- |\n')
        for name, desc, s, asset, url in credits:
            f.write(f'| `{name}` | {desc} | {s} | [{asset}]({url}) |\n')


if __name__ == '__main__':
    main()
