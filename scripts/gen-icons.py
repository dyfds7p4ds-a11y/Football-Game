# Generates the PWA icons (retro football on a field). Run: python3 scripts/gen-icons.py
from PIL import Image, ImageDraw

def icon(size, path, pad=0.0):
    s = 64  # draw at low res, upscale with nearest-neighbour for a pixel-art look
    im = Image.new('RGB', (s, s), '#101418')
    d = ImageDraw.Draw(im)
    p = int(s * pad)
    d.rectangle([p, p, s - 1 - p, s - 1 - p], fill='#3f8a2e')
    for y in range(p + 6, s - p, 10):
        d.line([p, y, s - 1 - p, y], fill='#f4f1de')
    d.ellipse([14, 22, 50, 42], fill='#7a3e1d', outline='#101418')
    d.line([24, 32, 40, 32], fill='#f4f1de')
    for x in range(26, 40, 3):
        d.line([x, 30, x, 34], fill='#f4f1de')
    d.rectangle([p, s - 12 - p, s - 1 - p, s - 1 - p], fill='#c8102e')
    d.text((p + 5, s - 11 - p), 'QB', fill='#ffd23f')
    im.resize((size, size), Image.NEAREST).save(path)

icon(192, 'public/icons/icon-192.png')
icon(512, 'public/icons/icon-512.png', pad=0.08)
icon(180, 'public/icons/apple-touch-icon.png')
print('icons written')
