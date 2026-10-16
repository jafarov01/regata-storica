/**
 * Phone screen logic (src/phone/view.ts) and the phone client's dead-link rule (src/net/client.ts).
 * Pure functions only: no DOM, no sockets.
 */
import { describe, expect, it } from 'vitest';
import type { ErrCode, Lobby, LobbyMember } from '@shared/protocol.ts';
import { HUD_SILENCE_MS, TERMINAL_ERRORS, linkLooksDead } from '../src/net/client.ts';
import { HUD_WARN_MS, clock, describeErr, linkWarning, nextRole, nextTeam, phoneView, type ViewInput } from '../src/phone/view.ts';

const base: ViewInput = { phase: 'lobby', hasPid: true, team: 0, controller: false, trying: false, landscape: true, role: 'pilot', blocked: false };

describe('phone view', () => {
  it('lobby before Enable controls, pads once a match runs with controls on', () => {
    expect(phoneView(base)).toMatchObject({ lobby: true, playing: false, resume: false, spectate: false });
    expect(phoneView({ ...base, controller: true })).toMatchObject({ lobby: true, playing: false });
    expect(phoneView({ ...base, controller: true, phase: 'battle' })).toMatchObject({ lobby: false, playing: true, strip: true, resume: false });
  });

  it('Try controls shows the pads in the lobby without the match strip', () => {
    expect(phoneView({ ...base, controller: true, trying: true })).toMatchObject({ playing: true, strip: false, backToLobby: true, lobby: false });
  });

  it('a reload during a match asks for one tap instead of showing the lobby (A6)', () => {
    const v = phoneView({ ...base, phase: 'battle', controller: false });
    expect(v).toMatchObject({ resume: true, lobby: false, playing: false });
    // Before the welcome nothing is known: the lobby (with its status line) stays.
    expect(phoneView({ ...base, phase: 'battle', hasPid: false, team: -1 })).toMatchObject({ lobby: true, resume: false });
  });

  it('spectators in a running match get the up-next screen', () => {
    expect(phoneView({ ...base, phase: 'battle', team: -1, controller: true })).toMatchObject({ spectate: true, playing: false, lobby: false });
  });

  it('rotate overlay for Pilot and Gunner in portrait, never for the Engineer; inputs coast under it', () => {
    const playing = { ...base, controller: true, phase: 'battle' as const, landscape: false };
    expect(phoneView({ ...playing, role: 'pilot' })).toMatchObject({ rotate: true, suspended: true });
    expect(phoneView({ ...playing, role: 'gunner' })).toMatchObject({ rotate: true, suspended: true });
    expect(phoneView({ ...playing, role: 'engineer' })).toMatchObject({ rotate: false, suspended: false });
    expect(phoneView({ ...playing, landscape: true })).toMatchObject({ rotate: false });
    // Not playing (lobby, no Try): no overlay, whatever the orientation.
    expect(phoneView({ ...base, landscape: false }).rotate).toBe(false);
  });

  it('a blocking error hides every other layer', () => {
    const v = phoneView({ ...base, phase: 'battle', controller: true, blocked: true });
    expect(v).toMatchObject({ playing: false, lobby: false, resume: false, spectate: false, rotate: false });
  });
});

describe('phone errors', () => {
  const codes: ErrCode[] = ['bad_version', 'bad_hello', 'no_room', 'room_full', 'match_running', 'room_closed', 'kicked', 'replaced', 'rate_limited', 'not_in_room'];

  it('every relay error has a sentence; wrong code and full room name the room and offer another code (A8)', () => {
    for (const c of codes) expect(describeErr(c, 'DAMU').text.length).toBeGreaterThan(10);
    expect(describeErr('no_room', 'DAMU')).toMatchObject({ blocking: true, otherCode: true, action: 'retry' });
    expect(describeErr('no_room', 'DAMU').text).toContain('DAMU');
    expect(describeErr('room_full', 'DAMU')).toMatchObject({ blocking: true, otherCode: true });
    expect(describeErr('room_full', 'DAMU').text).toContain('full');
  });

  it('another tab offers to take the slot back; rate limits are a short non-blocking note', () => {
    expect(describeErr('replaced', 'DAMU')).toMatchObject({ blocking: true, action: 'takeover' });
    expect(describeErr('bad_version', 'DAMU').action).toBe('reload');
    expect(describeErr('rate_limited', 'DAMU')).toMatchObject({ blocking: false });
    expect(describeErr('rate_limited', 'DAMU').ms).toBeGreaterThan(0);
  });

  it('the client stops reconnecting only after kicked / replaced / closed / version errors', () => {
    expect([...TERMINAL_ERRORS].sort()).toEqual(['bad_version', 'kicked', 'replaced', 'room_closed']);
    // A wrong code or a full room must keep retrying on reconnect.
    expect(TERMINAL_ERRORS.has('no_room')).toBe(false);
    expect(TERMINAL_ERRORS.has('room_full')).toBe(false);
  });
});

describe('link warnings and dead links (A10, A6)', () => {
  const ok = { online: true, sceneOnline: true, hudAgeMs: 100, hudStale: false, playing: true };

  it('warns when the scene flags us stale or the HUD goes quiet during a match', () => {
    expect(linkWarning(ok)).toBe('');
    expect(linkWarning({ ...ok, hudStale: true })).toContain("can't hear you");
    expect(linkWarning({ ...ok, hudAgeMs: HUD_WARN_MS + 1 })).toContain("can't hear you");
    // In the lobby a quiet HUD is not worth a banner.
    expect(linkWarning({ ...ok, playing: false, hudAgeMs: 9000 })).toBe('');
    expect(linkWarning({ ...ok, online: false })).toContain('Reconnecting');
    expect(linkWarning({ ...ok, sceneOnline: false })).toContain('big screen is reconnecting');
  });

  it('a link with no HUD for 4 s while the scene is online is dead; before the first HUD it is not', () => {
    const l = { connected: true, sceneOnline: true, hudAgeMs: 200, serverAgeMs: 200, pingIntervalMs: 10_000 };
    expect(linkLooksDead(l)).toBe(false);
    expect(linkLooksDead({ ...l, hudAgeMs: HUD_SILENCE_MS + 1, serverAgeMs: HUD_SILENCE_MS + 1 })).toBe(true);
    expect(linkLooksDead({ ...l, hudAgeMs: null, serverAgeMs: 5000 })).toBe(false);
    // Scene away (grace period): only the ping rule applies.
    expect(linkLooksDead({ ...l, sceneOnline: false, hudAgeMs: 9000, serverAgeMs: 9000 })).toBe(false);
    expect(linkLooksDead({ ...l, sceneOnline: false, hudAgeMs: null, serverAgeMs: 20_001 })).toBe(true);
    expect(linkLooksDead({ ...l, connected: false, hudAgeMs: 60_000 })).toBe(false);
  });
});

describe('lobby buttons', () => {
  const m = (pid: string): LobbyMember => ({ pid, name: pid, role: 'pilot', ready: false, calibrated: false, connected: true, virtual: false });
  const lobby: Lobby = {
    t: 'lobby',
    phase: 'lobby',
    teamSize: 3,
    spectators: [],
    teams: [
      { index: 0, name: 'Rosso', colour: '#e04a3a', members: [m('a'), m('b'), m('c')], capacity: 3 },
      { index: 1, name: 'Azzurro', colour: '#3a8fe0', members: [m('d'), m('e')], capacity: 3 },
      { index: 2, name: 'Verde', colour: '#3fbf5f', members: [m('f'), m('g'), m('h')], capacity: 3 },
    ],
  };

  it('Swap role cycles through the seats the team has', () => {
    expect(nextRole('pilot', 3, 3)).toBe('gunner');
    expect(nextRole('engineer', 3, 3)).toBe('pilot');
    expect(nextRole('gunner', 3, 2)).toBe('pilot');
    expect(nextRole('gunner', 2, 3)).toBe('pilot');
    expect(nextRole('pilot', 3, 1)).toBeNull();
  });

  it('Move team picks the next team with a free seat, wrapping around', () => {
    expect(nextTeam(lobby, 0)).toBe(1);
    expect(nextTeam(lobby, 2)).toBe(1);
    expect(nextTeam(lobby, 1)).toBeNull();
    expect(nextTeam(lobby, -1)).toBe(1);
  });

  it('clock is m:ss, rounded up, never negative', () => {
    expect(clock(300)).toBe('5:00');
    expect(clock(59.2)).toBe('1:00');
    expect(clock(9.5)).toBe('0:10');
    expect(clock(-3)).toBe('0:00');
  });
});
