#!/usr/bin/env python3
"""从 source map 提取前端源码到 pigfish 目录，保留相对路径结构。"""
import json, os, re, sys

MAPS = {
    "reelax": "maps/reelax-index-C1_oPsQk.js.map",
    "admin": "maps/admin-index-BRQDoPiN.js.map",
}

BASE = os.path.dirname(os.path.abspath(__file__))

def norm_path(s):
    """规范化 source map 里的路径：去掉 ../ 前缀，返回相对包根路径。"""
    # 去掉开头的 ../ 重复段
    s = re.sub(r'^(\.\./)+', '', s)
    return s

for name, rel in MAPS.items():
    mappath = os.path.join(BASE, rel)
    m = json.load(open(mappath))
    sources = m.get('sources', [])
    contents = m.get('sourcesContent', [])
    outdir = os.path.join(BASE, name)
    os.makedirs(outdir, exist_ok=True)
    written = 0
    skipped_node_modules = 0
    for src, content in zip(sources, contents):
        if content is None:
            continue
        relpath = norm_path(src)
        # 跳过 node_modules（第三方），只还原项目源码
        if 'node_modules' in relpath:
            skipped_node_modules += 1
            continue
        # 规范化：防止路径逃逸（../ 已在上面去掉）
        relpath = relpath.lstrip('/')
        target = os.path.join(outdir, relpath)
        # 安全：确保 target 在 outdir 内
        t_abs = os.path.abspath(target)
        if not t_abs.startswith(os.path.abspath(outdir)):
            print(f"  [skip escaping] {src}")
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8') as f:
            f.write(content)
        written += 1
    print(f"=== {name}: written {written} files, skipped node_modules {skipped_node_modules} ===")
    # 也把 node_modules 里的项目私有包（packages 已在上面处理）统计
