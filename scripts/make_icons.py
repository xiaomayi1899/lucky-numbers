#!/usr/bin/env python3
"""生成 PWA 图标（纯 Pillow 绘制，无版权素材）。"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SCALE = 4


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = color
    return img


def draw_icon(size: int, padding_ratio: float) -> Image.Image:
    s = size * SCALE
    base = vertical_gradient(s, (17, 24, 46), (8, 11, 22)).convert("RGBA")

    # 背景光晕
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        (s * 0.04, s * 0.02, s * 0.96, s * 0.9),
        fill=(76, 110, 255, 46),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.14))
    base = Image.alpha_composite(base, glow)

    # 环形暗纹
    ring = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse(
        (s * 0.12, s * 0.12, s * 0.88, s * 0.88),
        outline=(255, 255, 255, 18),
        width=max(2, int(s * 0.006)),
    )
    rd.ellipse(
        (s * 0.21, s * 0.21, s * 0.79, s * 0.79),
        outline=(255, 255, 255, 10),
        width=max(2, int(s * 0.004)),
    )
    base = Image.alpha_composite(base, ring)

    colors = [
        ((255, 92, 82), (255, 154, 111)),    # 红
        ((255, 160, 61), (255, 205, 112)),   # 橙
        ((47, 212, 194), (98, 236, 212)),    # 青
        ((148, 128, 255), (188, 172, 255)),  # 紫
        ((255, 105, 180), (255, 158, 205)),  # 粉
    ]
    # 五球围成一圈，整体居中
    content = s * (1 - 2 * padding_ratio)
    origin = (s - content) / 2
    cx = cy = s / 2
    orbit = content * 0.255
    ball_r = content * 0.155

    balls: list[tuple[float, float, int, tuple[int, int, int], tuple[int, int, int]]] = []
    for i, (c0, c1) in enumerate(colors):
        angle = -math.pi / 2 + i * (2 * math.pi / 5)
        x = cx + math.cos(angle) * orbit
        y = cy + math.sin(angle) * orbit
        balls.append((x, y, ball_r, c0, c1))

    # 球体投影
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for x, y, r, _, _ in balls:
        sd.ellipse(
            (x - r * 1.06, y - r * 0.92, x + r * 1.06, y + r * 1.18),
            fill=(0, 0, 0, 90),
        )
    shadow = shadow.filter(ImageFilter.GaussianBlur(r * 0.20))
    base = Image.alpha_composite(base, shadow)

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x, y, r, c0, c1 in balls:
        d.ellipse((x - r, y - r, x + r, y + r), fill=(*c0, 255))
        # 上半部柔和亮面（实色，避免半透明叠加发灰）
        top = tuple(round(c0[i] * 0.45 + c1[i] * 0.55) for i in range(3))
        d.ellipse((x - r * 0.78, y - r * 0.82, x + r * 0.78, y + r * 0.34), fill=(*top, 255))
        # 高光
        d.ellipse(
            (x - r * 0.50, y - r * 0.62, x - r * 0.08, y - r * 0.26),
            fill=(255, 255, 255, 220),
        )
        d.ellipse((x - r, y - r, x + r, y + r), outline=(255, 255, 255, 70), width=max(2, int(s * 0.004)))

    base = Image.alpha_composite(base, layer)

    # 中心小星点
    star = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    std = ImageDraw.Draw(star)
    sr = content * 0.045
    std.ellipse((cx - sr, cy - sr, cx + sr, cy + sr), fill=(255, 255, 255, 230))
    star = star.filter(ImageFilter.GaussianBlur(s * 0.004))
    base = Image.alpha_composite(base, star)

    return base.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in (32, 180, 192, 512, 1024):
        draw_icon(size, 0.10).save(ICON_DIR / f"icon-{size}.png", optimize=True)
    # maskable 图标留出安全边距
    draw_icon(512, 0.20).save(ICON_DIR / "maskable-512.png", optimize=True)
    # iOS 启动图用的同款大图
    draw_icon(1024, 0.10).save(ICON_DIR / "apple-touch-icon.png", optimize=True)
    print("icons written to", ICON_DIR)


if __name__ == "__main__":
    main()
