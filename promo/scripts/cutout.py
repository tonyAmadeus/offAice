"""把仓库根目录的成员立绘去白底，导出为透明 PNG 供 PV 使用。

用法：python3 -I scripts/cutout.py <仓库根目录> <输出目录>
从图像边缘做泛洪填充，只去掉与边缘连通的近白色背景，保留人物内部的白色衣物。
"""
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

SOURCES = {
    "claudia": "Claudia.webp",
    "gptia": "GPTIA.webp",
    "deepseek": "ds.webp",
    "gemini": "GEMINI.webp",
    "kimi": "KIMI.webp",
    "qwen": "QWen.webp",
    "grok": "Grok.webp",
    "glm": "GLM.jpg",
}
THRESHOLD = 34  # 与纯白的最大通道差
TARGET_HEIGHT = 1400


def cutout(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGB")
    scale = TARGET_HEIGHT / img.height
    if scale < 1:
        img = img.resize((round(img.width * scale), TARGET_HEIGHT), Image.LANCZOS)
    w, h = img.size
    px = img.load()
    bg = bytearray(w * h)

    def near_white(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        return 255 - min(r, g, b) <= THRESHOLD and max(r, g, b) - min(r, g, b) < 30

    queue = deque()
    for x in range(w):
        queue.append((x, 0))
        queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y))
        queue.append((w - 1, y))
    while queue:
        x, y = queue.popleft()
        i = y * w + x
        if bg[i] or not near_white(x, y):
            continue
        bg[i] = 1
        if x > 0:
            queue.append((x - 1, y))
        if x < w - 1:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y < h - 1:
            queue.append((x, y + 1))

    mask = Image.frombytes("L", (w, h), bytes(0 if v else 255 for v in bg))
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = img.convert("RGBA")
    out.putalpha(mask)
    out = out.crop(out.getbbox())
    out.save(dst, quality=88, method=6)
    print(f"{dst.name}: {out.size}")


def main() -> None:
    root, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for key, name in SOURCES.items():
        cutout(root / name, out_dir / f"{key}.webp")


if __name__ == "__main__":
    main()
