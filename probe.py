import subprocess, json, os
os.makedirs('out', exist_ok=True)
js = open('w.mjs').read().replace('export default', 'const W =') + """
const t0 = Date.now();
const r = await W.fetch(new Request('https://x/q?c=2330,6863,00878,3017&i=1&b=1', {headers: {Origin: 'https://k6107055.github.io'}}));
const j = await r.json();
console.log(JSON.stringify({ms: Date.now() - t0, j}).slice(0, 4000));
"""
open('t.mjs', 'w').write(js)
p = subprocess.run(['node', 't.mjs'], capture_output=True, text=True, timeout=120)
open('out/w.txt', 'w').write(p.stdout + '\nERR:' + p.stderr)
