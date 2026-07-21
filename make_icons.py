"""为扩展图标增加紫色渐变背景并生成匹配蒙版。

逻辑：
1. 优先读取用户源图 C:/Users/Xlinjian/Desktop/6a5e08e1c4b8e5cac2573700_1_0.png；
2. 若源图存在，则生成彩色图标 icon16/32/48/128.png；
3. 无论源图是否存在，都从 icon128.png 生成白色前景蒙版 icon-mask.png，
   用于页面左上角图标，使其与插件图标图案完全一致，同时可通过 CSS 变量变色。
"""
import os
from PIL import Image

SRC = os.path.join(os.path.expanduser('~'), 'Desktop', '6a5e08e1c4b8e5cac2573700_1_0.png')
SIZES = (16, 32, 48, 128)
START = '#6C5CE7'
LIGHTEN_RATIO = 0.35
MASK_SIZE = 96


def hex_to_rgb(hex_color):
    h = hex_color.lstrip('#')
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def lighten(hex_color, ratio=LIGHTEN_RATIO):
    r, g, b = hex_to_rgb(hex_color)

    def mix(c):
        return int(c * (1 - ratio) + 255 * ratio)

    return mix(r), mix(g), mix(b)


def detect_bg_color(img, sample_size=8):
    """从四角采样估算背景色。"""
    w, h = img.size
    offset = max(1, sample_size)
    samples = [
        img.crop((offset, offset, offset * 2, offset * 2)),
        img.crop((w - offset * 2, offset, w - offset, offset * 2)),
        img.crop((offset, h - offset * 2, offset * 2, h - offset)),
        img.crop((w - offset * 2, h - offset * 2, w - offset, h - offset)),
    ]
    totals = [0, 0, 0]
    count = 0
    for s in samples:
        w, h = s.size
        for y in range(h):
            for x in range(w):
                p = s.getpixel((x, y))
                totals[0] += p[0]
                totals[1] += p[1]
                totals[2] += p[2]
                count += 1
    return tuple(int(t / count) for t in totals)


def make_gradient_icon(src_path, out_dir, start, end):
    img = Image.open(src_path).convert('RGBA')
    w, h = img.size
    bg = detect_bg_color(img)

    # 在原始尺寸上处理，避免小图抗锯齿被梯度误判
    processed = Image.new('RGBA', (w, h))
    for y in range(h):
        for x in range(w):
            r, g, b, a = img.getpixel((x, y))
            # 与背景色/白色距离，决定该像素属于背景（alpha=1）还是前景（alpha=0）
            d_bg = ((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) ** 0.5
            d_white = ((r - 255) ** 2 + (g - 255) ** 2 + (b - 255) ** 2) ** 0.5
            total = d_bg + d_white + 1e-6
            alpha = max(0.0, min(1.0, d_white / total))

            # 135° 对角渐变：左下角为 start，右上角为 end
            t = (x - y + h) / (w + h)
            t = max(0.0, min(1.0, t))
            gr = int(start[0] * (1 - t) + end[0] * t)
            gg = int(start[1] * (1 - t) + end[1] * t)
            gb = int(start[2] * (1 - t) + end[2] * t)

            nr = int(gr * alpha + r * (1 - alpha))
            ng = int(gg * alpha + g * (1 - alpha))
            nb = int(gb * alpha + b * (1 - alpha))
            processed.putpixel((x, y), (nr, ng, nb, a))

    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        resized = processed.resize((size, size), Image.Resampling.LANCZOS)
        out = os.path.join(out_dir, f'icon{size}.png')
        resized.save(out, 'PNG')
        print('wrote', out)


def make_mask_from_icon(src_path, out_path, size=MASK_SIZE):
    """从已带渐变背景的图标中提取白色前景，生成白色前景透明背景蒙版。"""
    img = Image.open(src_path).convert('RGBA')
    w, h = img.size
    start = hex_to_rgb(START)
    end = lighten(START)

    mask = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for y in range(h):
        for x in range(w):
            r, g, b, a = img.getpixel((x, y))
            # 当前图标背景为 135° 对角渐变
            t = (x - y + h) / (w + h)
            t = max(0.0, min(1.0, t))
            gr = int(start[0] * (1 - t) + end[0] * t)
            gg = int(start[1] * (1 - t) + end[1] * t)
            gb = int(start[2] * (1 - t) + end[2] * t)

            d_bg = ((r - gr) ** 2 + (g - gg) ** 2 + (b - gb) ** 2) ** 0.5
            d_white = ((r - 255) ** 2 + (g - 255) ** 2 + (b - 255) ** 2) ** 0.5
            total = d_bg + d_white + 1e-6
            opacity = d_bg / total  # 越接近白色，前景越不透明

            alpha = int(opacity * 255 * (a / 255))
            mask.putpixel((x, y), (255, 255, 255, alpha))

    resized = mask.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(out_path, 'PNG')
    print('wrote', out_path)


def make_icons():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
    src = SRC

    if os.path.exists(src):
        # 有源图：重新生成全套彩色图标
        make_gradient_icon(src, out_dir, hex_to_rgb(START), lighten(START))
    else:
        # 无源图：保留现有彩色图标，仅生成/更新蒙版
        src = os.path.join(out_dir, 'icon128.png')
        if not os.path.exists(src):
            raise FileNotFoundError('找不到源图标：' + SRC)

    mask_src = os.path.join(out_dir, 'icon128.png')
    make_mask_from_icon(mask_src, os.path.join(out_dir, 'icon-mask.png'), size=MASK_SIZE)


if __name__ == '__main__':
    make_icons()
