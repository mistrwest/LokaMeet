from pathlib import Path
import io
import struct

from PIL import Image, ImageDraw, ImageFont

NAVY = (16, 24, 40, 255)
MINT = (176, 242, 210, 255)
FONT = r"C:\Windows\Fonts\arialbd.ttf"


# 16×16 pixel LM (1 = mint). Corners left empty for round look when scaled.
TINY_LM = [
    "................",
    "................",
    "..###....#....#.",
    "..###....##..##.",
    "..###....##..##.",
    "..###....#.##.#.",
    "..###....#.##.#.",
    "..###....#.#..#.",
    "..###....#....#.",
    "..###....#....#.",
    "..###....#....#.",
    "..##########..#.",
    "..##########..#.",
    "................",
    "................",
    "................",
]


def draw_tiny(size: int) -> Image.Image:
    base = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    px = base.load()
    for y, row in enumerate(TINY_LM):
        for x, ch in enumerate(row):
            if ch == "#":
                px[x, y] = MINT
            elif 1 <= x <= 14 and 1 <= y <= 14:
                px[x, y] = NAVY
    # round corners: clear the four corner pixels
    for x, y in ((0, 0), (0, 1), (1, 0), (15, 0), (14, 0), (15, 1), (0, 15), (0, 14), (1, 15), (15, 15), (14, 15), (15, 14)):
        px[x, y] = (0, 0, 0, 0)
    if size == 16:
        return base
    return base.resize((size, size), Image.Resampling.NEAREST)


def draw_icon(size: int) -> Image.Image:
    if size <= 20:
        return draw_tiny(size)

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rad = max(2, int(size * 0.22))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=rad, fill=NAVY)

    if size <= 16:
        fs = int(size * 0.62)
        gap = max(1, int(size * 0.04))
    elif size <= 32:
        fs = int(size * 0.50)
        gap = max(2, int(size * 0.08))
    else:
        fs = int(size * 0.46)
        gap = int(size * 0.07)

    font = ImageFont.truetype(FONT, fs)
    stroke = 1 if size <= 32 else max(0, int(size * 0.012))

    lb = d.textbbox((0, 0), "L", font=font, stroke_width=stroke)
    mb = d.textbbox((0, 0), "M", font=font, stroke_width=stroke)
    lw, lh = lb[2] - lb[0], lb[3] - lb[1]
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]
    total = lw + gap + mw
    x = (size - total) / 2 - lb[0]
    y = (size - max(lh, mh)) / 2 - min(lb[1], mb[1]) - size * 0.02

    kw = dict(font=font, fill=MINT, stroke_width=stroke, stroke_fill=MINT)
    d.text((x, y), "L", **kw)
    d.text((x + lw + gap, y), "M", **kw)
    return img


def save_ico(images: list[Image.Image], path: Path) -> None:
    count = len(images)
    payloads: list[bytes] = []
    entries: list[tuple[int, int, int]] = []
    for im in images:
        bio = io.BytesIO()
        im.save(bio, format="PNG")
        data = bio.getvalue()
        w, h = im.size
        payloads.append(data)
        entries.append((0 if w >= 256 else w, 0 if h >= 256 else h, len(data)))
    offset = 6 + 16 * count
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, count))
    cur = offset
    for w, h, nbytes in entries:
        out.write(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, nbytes, cur))
        cur += nbytes
    for data in payloads:
        out.write(data)
    path.write_bytes(out.getvalue())


def main() -> None:
    root = Path(__file__).resolve().parents[1] / "build"
    png = draw_icon(1024)
    png.save(root / "icon.png", "PNG")
    (root / "icon-variants").mkdir(exist_ok=True)
    png.save(root / "icon-variants" / "simple-readable.png", "PNG")

    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    imgs = [draw_icon(s) for s in sizes]
    save_ico(imgs, root / "icon.ico")

    draw_icon(16).resize((128, 128), Image.Resampling.NEAREST).save(root / "icon-variants" / "preview-16.png")
    draw_icon(32).resize((128, 128), Image.Resampling.NEAREST).save(root / "icon-variants" / "preview-32.png")
    print("png", (root / "icon.png").stat().st_size, "ico", (root / "icon.ico").stat().st_size)


if __name__ == "__main__":
    main()
