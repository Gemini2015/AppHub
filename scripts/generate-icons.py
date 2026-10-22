#!/usr/bin/env python3
"""生成 AppHub 应用图标（PNG / ICO / ICNS）。

用法：
    python scripts/generate-icons.py

产物（提交到仓库，electron-builder 打包时使用）：
    apps/desktop/build/icon.png   1024x1024，Linux / 通用
    apps/desktop/build/icon.ico   Windows（多尺寸）
    apps/desktop/build/icon.icns  macOS

图形：蓝紫渐变圆角方块 + 白色 "hub" 节点网络符号（与 UI 侧边栏 Logo 一致）。
仅依赖 Pillow + numpy。
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "apps" / "desktop" / "build"
SIZE = 1024


def make_background() -> Image.Image:
    top = np.array([79, 125, 255], dtype=np.float32)
    bottom = np.array([139, 92, 246], dtype=np.float32)
    t = np.linspace(0.0, 1.0, SIZE, dtype=np.float32)[:, None, None]
    gradient = (top[None, None, :] * (1.0 - t) + bottom[None, None, :] * t).astype(np.uint8)
    gradient = np.repeat(gradient, SIZE, axis=1)
    return Image.fromarray(gradient, "RGB").convert("RGBA")


def rounded_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_glyph(canvas: Image.Image) -> None:
    """绘制白色 hub 符号：中心节点 + 四个卫星节点 + 连接线。"""
    size = canvas.size[0]
    center = size / 2
    draw = ImageDraw.Draw(canvas)
    white = (255, 255, 255, 255)

    orbit = size * 0.265
    center_radius = size * 0.092
    node_radius = size * 0.060
    line_width = int(size * 0.044)

    nodes = []
    for index in range(4):
        angle = np.deg2rad(45 + index * 90)
        x = center + orbit * np.cos(angle)
        y = center + orbit * np.sin(angle)
        nodes.append((x, y))

    # 连接线（先画线，再画节点，保证节点边缘干净）
    for x, y in nodes:
        draw.line([(center, center), (x, y)], fill=white, width=line_width)
        # 线端圆角
        for cx, cy, r in ((center, center, line_width / 2), (x, y, line_width / 2)):
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)

    # 卫星节点
    for x, y in nodes:
        draw.ellipse([x - node_radius, y - node_radius, x + node_radius, y + node_radius], fill=white)

    # 中心节点（略大，带内圈装饰）
    draw.ellipse(
        [center - center_radius, center - center_radius, center + center_radius, center + center_radius],
        fill=white,
    )
    inner = center_radius * 0.52
    draw.ellipse([center - inner, center - inner, center + inner, center + inner], fill=(79, 125, 255, 255))


def build_master() -> Image.Image:
    background = make_background()
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(background, (0, 0), rounded_mask(SIZE))
    draw_glyph(icon)
    return icon


def save_png(icon: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon.save(path, format="PNG", optimize=True)


def save_ico(icon: Image.Image, path: Path) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    base = icon.resize((256, 256), Image.Resampling.LANCZOS)
    base.save(path, format="ICO", sizes=[(s, s) for s in sizes])


def save_icns(icon: Image.Image, path: Path) -> None:
    """构造 PNG 载荷的 ICNS（electron-builder / macOS 10.7+ 支持）。"""
    chunk_types = {
        b"icp4": 16,
        b"icp5": 32,
        b"icp6": 64,
        b"ic07": 128,
        b"ic08": 256,
        b"ic09": 512,
        b"ic10": 1024,
    }
    chunks: list[bytes] = []
    for chunk_type, pixels in chunk_types.items():
        buffer = io.BytesIO()
        resized = icon.resize((pixels, pixels), Image.Resampling.LANCZOS)
        resized.save(buffer, format="PNG", optimize=True)
        payload = buffer.getvalue()
        chunks.append(chunk_type + struct.pack(">I", len(payload) + 8) + payload)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = build_master()
    save_png(master, OUT_DIR / "icon.png")
    save_ico(master, OUT_DIR / "icon.ico")
    save_icns(master, OUT_DIR / "icon.icns")
    print("图标已生成：")
    for name in ("icon.png", "icon.ico", "icon.icns"):
        target = OUT_DIR / name
        print(f"  - {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
