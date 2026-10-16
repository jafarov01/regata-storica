/**
 * "Choose your player": the phone's character picker, after the QR scan and before the lobby.
 * A big card for the person in focus, a grid of every player of the retreat, and one button.
 * People somebody else already plays are greyed with that player's name; the gondolier at the
 * end is open to anyone (and covers rooms with more than 14 players).
 *
 * Pure DOM: main.ts decides when it shows and sends the pick.
 */
import { CHARACTERS, GONDOLIER, GONDOLIER_ID, characterById, portraitUrl } from '@shared/characters.ts';
import { ferroMark } from '../ui/icons.ts';

export const PICKER_HTML = `
  <section id="picker" class="phone-overlay picker" hidden>
    <header class="picker-head">
      <h1 class="display">Choose your player</h1>
      <span class="picker-count">${CHARACTERS.length} players</span>
    </header>
    <div class="picker-hero">
      <div class="picker-portrait" id="picker-portrait"></div>
      <div class="picker-who">
        <span class="picker-num" id="picker-num"></span>
        <b class="display" id="picker-name"></b>
        <span class="picker-note" id="picker-note"></span>
      </div>
    </div>
    <ul class="picker-grid" id="picker-grid"></ul>
    <div class="picker-foot">
      <p class="picker-msg" id="picker-msg" role="alert"></p>
      <button class="plate-btn picker-go" id="picker-go" type="button"></button>
    </div>
  </section>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function portraitHtml(id: string, size: 256 | 512 = 256): string {
  const url = portraitUrl(id, size);
  return url ? `<img src="${url}" alt="" draggable="false" />` : `<span class="gondolier-mark">${ferroMark()}</span>`;
}

export class CharacterPicker {
  private readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly portrait: HTMLElement;
  private readonly num: HTMLElement;
  private readonly name: HTMLElement;
  private readonly note: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly go: HTMLButtonElement;
  private focus: string = CHARACTERS[0]?.id ?? GONDOLIER_ID;
  private taken = new Map<string, string>();
  private gridKey = '';
  private showKey = '';

  constructor(
    root: ParentNode,
    private readonly onPick: (id: string) => void,
  ) {
    const q = <T extends HTMLElement>(sel: string): T => {
      const e = root.querySelector<T>(sel);
      if (!e) throw new Error(`missing ${sel}`);
      return e;
    };
    this.el = q('#picker');
    this.grid = q('#picker-grid');
    this.portrait = q('#picker-portrait');
    this.num = q('#picker-num');
    this.name = q('#picker-name');
    this.note = q('#picker-note');
    this.msg = q('#picker-msg');
    this.go = q<HTMLButtonElement>('#picker-go');
    this.grid.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]');
      const id = b?.dataset['id'];
      if (!id) return;
      this.focus = id;
      this.renderFocus();
      this.renderGrid(true);
    });
    this.go.addEventListener('click', () => {
      if (this.taken.has(this.focus)) return;
      this.onPick(this.focus);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /**
   * Shows the picker. `current`: what this player plays now (focused first); `taken`: person id ->
   * the name of the player who has it; `message`: why the picker came back (a refused pick).
   */
  show(current: string | null, taken: ReadonlyMap<string, string>, message = ''): void {
    const wasHidden = this.el.hidden;
    const key = `${current}|${[...taken.entries()].join(',')}|${message}`;
    if (!wasHidden && key === this.showKey) return;
    this.showKey = key;
    this.taken = new Map(taken);
    if (wasHidden) {
      // Focus the current pick, else the first person still free.
      const free = CHARACTERS.find((c) => !taken.has(c.id))?.id ?? GONDOLIER_ID;
      this.focus = current && !taken.has(current) ? current : free;
    } else if (this.taken.has(this.focus) && this.focus !== GONDOLIER_ID) {
      // Somebody took the one in focus while we looked at it.
      this.focus = CHARACTERS.find((c) => !taken.has(c.id))?.id ?? GONDOLIER_ID;
    }
    this.msg.textContent = message;
    this.el.hidden = false;
    this.renderFocus();
    this.renderGrid(false);
  }

  hide(): void {
    this.el.hidden = true;
    this.showKey = '';
  }

  private renderFocus(): void {
    const c = characterById(this.focus) ?? GONDOLIER;
    const i = CHARACTERS.findIndex((x) => x.id === c.id);
    this.portrait.innerHTML = portraitHtml(c.id, 512);
    this.num.textContent = i >= 0 ? `Player ${String(i + 1).padStart(2, '0')} of ${CHARACTERS.length}` : 'Anyone can be one';
    this.name.textContent = c.name;
    const by = this.taken.get(c.id);
    this.note.textContent = by ? `${by} is playing this one` : c.id === GONDOLIER_ID ? 'Striped shirt, straw hat, your team colour on the ribbon' : '';
    this.go.disabled = !!by;
    this.go.textContent = by ? 'Taken' : `Play as ${c.short}`;
  }

  private renderGrid(force: boolean): void {
    const key = `${this.focus}|${[...this.taken.entries()].join(',')}`;
    if (!force && key === this.gridKey) return;
    this.gridKey = key;
    this.grid.innerHTML = [...CHARACTERS, GONDOLIER]
      .map((c) => {
        const by = this.taken.get(c.id);
        const cls = [c.id === this.focus ? 'on' : '', by ? 'taken' : '', c.id === GONDOLIER_ID ? 'gondolier' : ''].filter(Boolean).join(' ');
        return `<li><button type="button" data-id="${c.id}" class="${cls}" aria-pressed="${c.id === this.focus}" aria-label="${esc(c.name)}${by ? `, taken by ${esc(by)}` : ''}">${portraitHtml(c.id)}<span>${esc(c.short)}</span></button></li>`;
      })
      .join('');
  }
}
