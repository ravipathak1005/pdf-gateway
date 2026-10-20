#!/usr/bin/env python3
"""Regenerates sw.js with the list of files to precache (run after changing any app file)."""
import os, json, hashlib
root = os.path.dirname(os.path.abspath(__file__))
files = []
for d, _, fs in os.walk(root):
    if '_test' in d.split(os.sep) or '.git' in d.split(os.sep): continue
    for f in fs:
        p = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
        if p in ('sw.js','sw.template.js','build-sw.py','README.md','run-local.bat','run-local.sh') or p.endswith('.zip'): continue
        files.append(p)
files.sort()
h = hashlib.sha1()
for p in files: h.update(p.encode()); h.update(open(os.path.join(root,p),'rb').read())
ver = h.hexdigest()[:10]
tpl = open(os.path.join(root,'sw.template.js')).read()
open(os.path.join(root,'sw.js'),'w').write(tpl.replace('__VERSION__', ver).replace('__FILES__', json.dumps(['./'] + files, indent=1)))
print('sw.js written:', len(files), 'files, version', ver)
