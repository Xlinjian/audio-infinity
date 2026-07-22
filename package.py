"""打包 Audio无限+ 扩展（仅 Chrome / Edge 及 Chromium 内核浏览器）。

说明：实时字幕依赖 Chrome / Edge 的 offscreen + tabCapture 能力，本包仅面向
Chrome / Edge（及 Opera、Brave、Vivaldi 等 Chromium 内核浏览器），不再单独产出 Firefox 包。
"""

import os
import json
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.dirname(ROOT)

CHROME_OUT = os.path.join(OUT_DIR, 'Audio无限+_2.3.6.zip')

EXCLUDE_DIRS = {'__pycache__', '.git', 'node_modules', '.workbuddy'}
EXCLUDE_FILES = {
    'package.py', 'make_icons.py', 'test_graph.js', 'test_pages.js',
    'README.md', '新手操作指南.md',  # 文档放在仓库根，不打包进扩展
}


def should_include(rel):
    parts = rel.replace('\\', '/').split('/')
    if any(p in EXCLUDE_DIRS for p in parts):
        return False
    if parts[-1] in EXCLUDE_FILES:
        return False
    return True


def build(out_path):
    count = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT).replace('\\', '/')
                if not should_include(rel):
                    continue
                zf.write(full, rel)
                count += 1
                print('added', rel)
    print('packed ->', out_path, '(%d files)' % count)


def main():
    build(CHROME_OUT)


if __name__ == '__main__':
    main()
