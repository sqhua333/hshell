#!/usr/bin/env python3
"""Generate HShell application icons into build/.

Design: a dark rounded square with a soft vertical gradient and a green
terminal prompt (chevron + underscore). Drawn with primitives so it stays
crisp from 16px up; no external font required.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'build'
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 1024
TOP = (14, 23, 38)
BOTTOM = (22, 58, 96)
ACCENT = (126, 231, 135)
CURSOR = (125, 196, 255)


def gradient(size: int) -> Image.Image:
    image = Image.new('RGB', (size, size))
    pixels = image.load()
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
        for x in range(size):
            pixels[x, y] = color
    return image


def render(size: int) -> Image.Image:
    scale = size / SIZE
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (round(36 * scale), round(36 * scale), round(988 * scale), round(988 * scale)),
        radius=round(210 * scale),
        fill=255,
    )

    body = gradient(size).convert('RGBA')
    canvas.paste(body, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)

    # Subtle inner rim.
    rim = round(4 * scale)
    draw.rounded_rectangle(
        (round(36 * scale), round(36 * scale), round(988 * scale), round(988 * scale)),
        radius=round(210 * scale),
        outline=(255, 255, 255, 38),
        width=max(1, rim),
    )

    width = round(74 * scale)
    joint = 'curve' if scale > 0.1 else None

    # Chevron ">".
    draw.line(
        [(round(320 * scale), round(322 * scale)), (round(520 * scale), round(512 * scale))],
        fill=ACCENT,
        width=width,
        joint=joint,
    )
    draw.line(
        [(round(520 * scale), round(512 * scale)), (round(320 * scale), round(702 * scale))],
        fill=ACCENT,
        width=width,
        joint=joint,
    )

    # Underscore cursor "_".
    draw.line(
        [(round(582 * scale), round(676 * scale)), (round(736 * scale), round(676 * scale))],
        fill=CURSOR,
        width=width,
        joint=joint,
    )

    # Round the line ends by stamping circles (PIL lines are butt-capped).
    radius = width // 2
    for x, y, color in (
        (320, 322, ACCENT),
        (520, 512, ACCENT),
        (320, 702, ACCENT),
        (582, 676, CURSOR),
        (736, 676, CURSOR),
    ):
        cx, cy = round(x * scale), round(y * scale)
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color)

    return canvas


master = render(SIZE)
master.save(OUT / 'icon.png')

# electron-builder picks the right size for .deb / AppImage from an icon dir.
ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
icons = OUT / 'icons'
icons.mkdir(exist_ok=True)
for size in ICON_SIZES:
    render(size).save(icons / f'{size}x{size}.png')

ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
master.save(OUT / 'icon.ico', sizes=ico_sizes)

try:
    icns_sizes = [16, 32, 64, 128, 256, 512, 1024]
    master.save(OUT / 'icon.icns', sizes=[(s, s) for s in icns_sizes])
except Exception as error:  # pragma: no cover - platform dependent
    print(f'icns skipped: {error}')

print('wrote', ', '.join(sorted(p.name for p in OUT.iterdir())))
