import pathlib
root = pathlib.Path('.')
files = [
  ('shared/config.ts', 'shared/config.ts'),
  ('shared/state.ts', 'shared/state.ts'),
  ('src/sim/teams.ts', 'src/sim/teams.ts'),
  ('src/sim/rules.ts', 'src/sim/rules.ts'),
  ('src/sim/items.ts', 'src/sim/items.ts'),
  ('src/sim/aim.ts', 'src/sim/aim.ts'),
  ('src/sim/hud.ts', 'src/sim/hud.ts'),
  ('src/scene/layout.ts', 'src/scene/layout.ts'),
  ('src/scene/keyboard.ts', 'src/scene/keyboard.ts'),
  ('src/scene/bot.ts', 'src/scene/bot.ts'),
  ('tests/teams.test.ts', 'tests/teams.test.ts'),
  ('tests/rules.test.ts', 'tests/rules.test.ts'),
  ('tests/aim.test.ts', 'tests/aim.test.ts'),
  ('tests/layout.test.ts', 'tests/layout.test.ts'),
]
out = []
out.append((root / 'parts/01-problem-decisions.md').read_text())
out.append('\n## 3. Code, ready to paste (type-checked and tested)\n\n'
           'Target paths are relative to the repo root. Imports use the `@shared/*` alias with `.ts` extensions '
           '(as `tsconfig.json` and `vite.config.ts` allow) inside `src/`, relative `./` imports inside `shared/` '
           'and `../` from `tests/` (matching the existing `tests/math.test.ts`). `src/scene/keyboard.ts` and '
           '`src/scene/bot.ts` import `PilotIn`, `GunnerIn`, `EngIn` from `@shared/protocol.ts`; the stand-in used '
           'for type-checking declares exactly the SPEC section 11 types:\n\n'
           '```ts\n// shared/protocol.ts (excerpt that these files depend on)\n'
           "export type PilotIn = { t: 'in'; role: 'pilot'; steer: number; gas: boolean; brake: boolean };\n"
           "export type GunnerIn = { t: 'in'; role: 'gunner'; dYaw: number; fire: boolean; recenter: boolean };\n"
           "export type EngIn = { t: 'in'; role: 'engineer'; use: 0 | 1 | null; shake: number };\n```\n")
for path, label in files:
    code = (root / path).read_text().rstrip('\n')
    out.append(f'\n### `{label}`\n\n```ts\n{code}\n```\n')
out.append('\n' + (root / 'parts/04-edge-cases.md').read_text())
out.append('\n' + (root / 'parts/05-testing-sources.md').read_text())
(root / 'final.md').write_text('\n'.join(out))
print('final.md', len((root / 'final.md').read_text().splitlines()), 'lines')
