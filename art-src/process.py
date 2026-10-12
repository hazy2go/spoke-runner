"""Turn the Codex renders into game-ready assets: trim transparent padding, resize, compress."""
from PIL import Image
import os, sys
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(SRC, '..', 'public', 'art')
os.makedirs(OUT, exist_ok=True)
SIZES = {'ship': 256, 'hub': 720, 'asteroid_a': 220, 'asteroid_b': 220, 'crate': 128, 'fuel_pod': 160,
         'mev_bot': 200, 'leviathan': 560, 'freighter': 320, 'planet_ice': 400, 'planet_gas': 400, 'planet_lava': 400, 'planet_ocean': 400, 'planet_desert': 400, 'planet_violet': 400}
for name, size in SIZES.items():
    p = os.path.join(SRC, name + '.png')
    if not os.path.exists(p): print('missing', name); continue
    im = Image.open(p).convert('RGBA')
    bbox = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    im = im.crop(bbox)
    w, h = im.size; side = max(w, h)
    sq = Image.new('RGBA', (side, side)); sq.paste(im, ((side - w) // 2, (side - h) // 2))
    sq.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name + '.png'), optimize=True)
    print(name, 'ok')
for name, w in (('bg_nebula', 1920), ('title_art', 1920)):
    im = Image.open(os.path.join(SRC, name + '.png')).convert('RGB')
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '.jpg'), quality=84, optimize=True, progressive=True)
    print(name, 'ok')
ta = Image.open(os.path.join(SRC, 'title_art.png')).convert('RGB')
ta.resize((1200, 800)).crop((0, 85, 1200, 715)).save(os.path.join(OUT, 'og.jpg'), quality=82)
Image.open(os.path.join(OUT, 'ship.png')).resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))

# per-network planets
import json
PD = os.path.join(SRC, 'planets'); PO = os.path.join(OUT, 'planets'); os.makedirs(PO, exist_ok=True)
done = []
for f in sorted(os.listdir(PD)) if os.path.isdir(PD) else []:
    if not f.endswith('.png'): continue
    im = Image.open(os.path.join(PD, f)).convert('RGBA')
    bbox = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    im = im.crop(bbox); w, h = im.size; side = max(w, h)
    sq = Image.new('RGBA', (side, side)); sq.paste(im, ((side - w) // 2, (side - h) // 2))
    sq.resize((420, 420), Image.LANCZOS).save(os.path.join(PO, f), optimize=True)
    done.append(f[:-4])
open(os.path.join(SRC, '..', 'src', 'planets.json'), 'w').write(json.dumps(done))
print('planets', len(done))
