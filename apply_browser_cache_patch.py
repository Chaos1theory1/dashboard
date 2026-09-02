#!/usr/bin/env python3
from pathlib import Path
import sys

MARK = '<script src="js/mtd-api-cache.js"></script>'
AUTH = '<script src="js/admin-auth.js"></script>'

def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    public = root / 'public'
    if not public.exists():
        raise SystemExit(f'public folder not found: {public}')

    source = Path(__file__).resolve().parent / 'public' / 'js' / 'mtd-api-cache.js'
    target = public / 'js' / 'mtd-api-cache.js'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source.read_text(encoding='utf-8'), encoding='utf-8')
    print(f'[saved] {target}')

    changed = 0
    already = 0
    missing = []

    for html in sorted(public.glob('*.html')):
        text = html.read_text(encoding='utf-8')
        if MARK in text:
            already += 1
            continue
        if AUTH not in text:
            continue
        backup = html.with_name(html.name + '.cache-backup')
        if not backup.exists():
            backup.write_text(text, encoding='utf-8')
        text = text.replace(AUTH, MARK + '\n' + AUTH, 1)
        html.write_text(text, encoding='utf-8')
        changed += 1
        print(f'[patched] {html.name}')

    print()
    print(f'Done. Patched {changed} HTML files; {already} already had the cache script.')
    print('The cache script is inserted immediately BEFORE admin-auth.js.')
    print('GET cache TTLs: session=60s, dashboard summary=30s, dashboard today=30s.')
    print('Any successful API mutation clears the dashboard cache.')

if __name__ == '__main__':
    main()
