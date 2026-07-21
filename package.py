"""打包 Audio无限+ 扩展为 zip，排除测试与开发文件。"""
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), 'Audio无限+_1.0.0.zip')

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


def main():
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            # 过滤掉被排除的目录，避免进入
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT)
                if not should_include(rel):
                    continue
                zf.write(full, rel)
                print('added', rel)
    print('packed ->', OUT)


if __name__ == '__main__':
    main()
