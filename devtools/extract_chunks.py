#!/usr/bin/env python3
"""从 admin chunk source maps 提取源码。"""
import json, os, re, glob

CHUNK_DIR = "maps/admin-chunks"
OUTDIR = "admin"
BASE = os.path.dirname(os.path.abspath(__file__))

def norm_path(s):
    return re.sub(r'^(\.\./)+', '', s)

total = 0
for mappath in sorted(glob.glob(os.path.join(BASE, CHUNK_DIR, "*.js.map"))):
    try:
        m = json.load(open(mappath))
    except Exception as e:
        print(f"[skip invalid] {os.path.basename(mappath)}: {e}")
        continue
    for src, content in zip(m.get('sources',[]), m.get('sourcesContent',[])):
        if content is None or 'node_modules' in src:
            continue
        relpath = norm_path(src).lstrip('/')
        target = os.path.join(BASE, OUTDIR, relpath)
        t_abs = os.path.abspath(target)
        if not t_abs.startswith(os.path.abspath(os.path.join(BASE, OUTDIR))):
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8') as f:
            f.write(content)
        total += 1
print(f"extracted {total} admin chunk sources")
