import re, pathlib, sys
base = pathlib.Path(sys.argv[1])
src = (base / 'final.src.md').read_text()
mirror = base / 'mirror'
def repl(m):
    p = m.group(1).strip()
    code = (mirror / p).read_text().rstrip('\n')
    return f"```ts\n{code}\n```"
out = re.sub(r'^@@FILE (.+?)@@$', repl, src, flags=re.M)
(base / 'final.md').write_text(out)
print('wrote', base / 'final.md', len(out), 'chars', out.count('\n'), 'lines')
