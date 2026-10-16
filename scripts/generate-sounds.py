#!/usr/bin/env python3
"""
Synthesises every game sound into public/assets/sounds/*.mp3 (mono, 44.1 kHz).

Why synthesised: no downloads, no licences to track, and every file is reproducible. A real
recording can replace any file later under the same name; src/render/audio.ts only knows names.

Run:  python3 scripts/generate-sounds.py          (needs numpy and ffmpeg with libmp3lame)
"""
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets', 'sounds')
rng = np.random.default_rng(7)


# ----------------------------------------------------------------------------- building blocks

def t(d):
    return np.arange(int(d * SR)) / SR


def n(d):
    return int(d * SR)


def noise(d):
    return rng.standard_normal(n(d))


def spectrum_filter(x, lo=None, hi=None, order=4):
    """Zero-phase Butterworth-shaped filter in the frequency domain. Apply envelopes afterwards.
    Padded on both sides so the filter's ringing cannot wrap from one end of the clip to the other."""
    pad = n(0.5)
    xp = np.concatenate([np.zeros(pad), x, np.zeros(pad)])
    X = np.fft.rfft(xp)
    f = np.fft.rfftfreq(len(xp), 1 / SR)
    g = np.ones_like(f)
    if hi is not None:
        g *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo is not None:
        g *= 1 - 1 / np.sqrt(1 + (f / max(lo, 1)) ** (2 * order))
    return np.fft.irfft(X * g, len(xp))[pad : pad + len(x)]


def band(x, centre, width_oct=1.0, order=3):
    lo = centre / 2 ** (width_oct / 2)
    hi = centre * 2 ** (width_oct / 2)
    return spectrum_filter(x, lo, hi, order)


def swept_noise(d, f_from, f_to, width_oct=1.2, bands=10):
    """Band-passed noise whose centre glides from f_from to f_to (crossfaded filter bank)."""
    x = noise(d)
    centres = np.geomspace(min(f_from, f_to), max(f_from, f_to), bands)
    layers = np.array([band(x, c, width_oct) for c in centres])
    path = np.geomspace(f_from, f_to, len(x))
    pos = np.interp(np.log(path), np.log(centres), np.arange(bands))
    i0 = np.clip(np.floor(pos).astype(int), 0, bands - 1)
    i1 = np.clip(i0 + 1, 0, bands - 1)
    w = pos - np.floor(pos)
    idx = np.arange(len(x))
    return layers[i0, idx] * (1 - w) + layers[i1, idx] * w


def env(d, attack=0.005, decay=5.0, hold=0.0):
    tt = t(d)
    a = np.clip(tt / max(attack, 1e-4), 0, 1)
    dec = np.exp(-np.clip(tt - attack - hold, 0, None) * decay)
    return a * dec


def adsr(d, a, dcy, s, r):
    tt = t(d)
    e = np.where(tt < a, tt / a, np.where(tt < a + dcy, 1 - (1 - s) * (tt - a) / dcy, s))
    rel = np.clip((d - tt) / r, 0, 1)
    return e * rel


def sine_sweep(d, f0, f1, curve='exp'):
    tt = t(d)
    f = f0 * (f1 / f0) ** (tt / d) if curve == 'exp' else f0 + (f1 - f0) * tt / d
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def saw(freq, d, detune_cents=0.0):
    f = freq * 2 ** (detune_cents / 1200)
    ph = (np.arange(n(d)) * f / SR) % 1.0
    return 2 * ph - 1


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def reverb(x, seconds=1.2, mix=0.25, bright=4000):
    """Convolution with a synthetic decaying-noise impulse response."""
    # Filter the noise first, then shape the decay: filtering after would smear the loud start.
    ir = spectrum_filter(noise(seconds), 120, bright, 2) * np.exp(-t(seconds) * (6.9 / seconds))
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    size = len(x) + len(ir)
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)
    dry = np.concatenate([x, np.zeros(len(ir))])
    out = dry * (1 - mix) + wet * mix * 2.2
    return out


def mix_at(base, sound, at):
    i = n(at)
    end = min(len(base), i + len(sound))
    if end > i:
        base[i:end] += sound[: end - i]
    return base


def fit(x, d):
    """Pad or cut to exactly d seconds, with a short fade-out at the end."""
    m = n(d)
    y = np.zeros(m)
    y[: min(m, len(x))] = x[:m]
    fade = min(n(0.03), m)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y


def make_loop(x, d, xfade=0.5):
    """Seamless loop of length d from a signal at least d + xfade long (end crossfades into start)."""
    m, k = n(d), n(xfade)
    y = x[: m + k].copy()
    ramp = np.linspace(0, 1, k)
    y[:k] = y[:k] * ramp + y[m : m + k] * (1 - ramp)
    return y[:m]


def circular_tail(x, d):
    """Fold a reverb tail past d seconds back onto the start (for musical loops)."""
    m = n(d)
    y = x[:m].copy()
    tail = x[m:]
    y[: len(tail)] += tail[:m]
    return y


def bubbles(d, count, f_lo=300, f_hi=1200, level=0.25):
    out = np.zeros(n(d))
    for _ in range(count):
        at = rng.uniform(0, d * 0.8)
        f = rng.uniform(f_lo, f_hi)
        dur = rng.uniform(0.03, 0.08)
        b = sine_sweep(dur, f, f * rng.uniform(1.4, 2.2)) * env(dur, 0.002, 40)
        mix_at(out, b * level * rng.uniform(0.4, 1), at)
    return out


def normalise(x, peak_db=-1.0):
    p = np.max(np.abs(x)) + 1e-9
    return x / p * 10 ** (peak_db / 20)


# ----------------------------------------------------------------------------- the sounds

def cannon():
    d = 1.6
    thump = sine_sweep(0.5, 95, 38) * env(0.5, 0.002, 7)
    body = spectrum_filter(noise(d), 40, 1400) * env(d, 0.001, 9)
    crack = spectrum_filter(noise(0.02), 2500, None) * env(0.02, 0.0005, 200)
    rattle = band(noise(0.3), 420, 1.0) * env(0.3, 0.01, 18) * 0.35
    x = np.zeros(n(d))
    mix_at(x, thump * 1.4, 0)
    mix_at(x, body, 0)
    mix_at(x, crack * 0.8, 0)
    mix_at(x, rattle, 0.08)
    return fit(reverb(x, 1.3, 0.22, 3000), d)


def explosion_water():
    d = 2.6
    boom = sine_sweep(0.9, 70, 28) * env(0.9, 0.003, 3.5) * 1.6
    rumble = spectrum_filter(noise(d), 30, 600) * env(d, 0.005, 2.6)
    column = swept_noise(2.0, 4500, 1200, 1.4) * adsr(2.0, 0.25, 0.4, 0.6, 1.0) * 0.55
    x = np.zeros(n(d))
    mix_at(x, boom, 0)
    mix_at(x, rumble, 0)
    mix_at(x, column, 0.35)
    mix_at(x, bubbles(1.8, 40, 200, 900, 0.2), 0.6)
    return fit(reverb(x, 1.6, 0.25, 3500), d)


def splash(d=1.0, f_from=3200, f_to=700, n_bubbles=8, low=1.0):
    s = swept_noise(d, f_from, f_to, 1.5) * env(d, 0.004, 6 / d)
    thud = spectrum_filter(noise(0.15), 60, 400) * env(0.15, 0.002, 25) * 0.6 * low
    x = np.zeros(n(d))
    mix_at(x, s, 0)
    mix_at(x, thud, 0)
    mix_at(x, bubbles(d, n_bubbles), 0.08)
    return fit(reverb(x, 0.8, 0.15), d)


def water_cannon():
    d = 2.0
    x = band(noise(d + 0.6), 2300, 1.6) + 0.35 * spectrum_filter(noise(d + 0.6), 5000, 11000)
    flutter = 1 + 0.18 * np.sin(2 * np.pi * 9.3 * t(d + 0.6)) + 0.1 * spectrum_filter(noise(d + 0.6), None, 15)
    return make_loop(x * flutter, d, 0.5)


def torpedo_launch():
    d = 1.5
    thunk = sine_sweep(0.18, 160, 70) * env(0.18, 0.002, 20)
    whoosh = swept_noise(1.2, 300, 1600, 1.4) * adsr(1.2, 0.15, 0.3, 0.6, 0.6)
    whoosh *= 1 + 0.5 * np.sin(2 * np.pi * 17 * t(1.2))
    x = np.zeros(n(d))
    mix_at(x, thunk * 1.2, 0)
    mix_at(x, whoosh * 0.6, 0.05)
    mix_at(x, bubbles(1.2, 25, 250, 1000, 0.25), 0.1)
    return fit(reverb(x, 0.9, 0.18), d)


def mortar_launch():
    d = 1.3
    thump = sine_sweep(0.3, 120, 50) * env(0.3, 0.002, 14)
    whistle = sine_sweep(1.0, 700, 1900) * adsr(1.0, 0.05, 0.2, 0.7, 0.4) * 0.35
    whistle *= 1 + 0.05 * np.sin(2 * np.pi * 7 * t(1.0))
    x = np.zeros(n(d))
    mix_at(x, thump * 1.3, 0)
    mix_at(x, spectrum_filter(noise(0.2), 100, 2000) * env(0.2, 0.001, 30) * 0.7, 0)
    mix_at(x, whistle, 0.12)
    return fit(reverb(x, 1.0, 0.2), d)


def firework_burst():
    d = 2.2
    boom = sine_sweep(0.6, 80, 35) * env(0.6, 0.002, 6) * 1.2
    x = np.zeros(n(d))
    mix_at(x, boom, 0)
    mix_at(x, spectrum_filter(noise(0.4), 80, 3000) * env(0.4, 0.001, 12), 0)
    for _ in range(140):
        at = 0.15 + rng.exponential(0.45)
        if at > d - 0.1:
            continue
        click = spectrum_filter(noise(0.006), 1500, 9000) * env(0.006, 0.0003, 600)
        mix_at(x, click * rng.uniform(0.2, 0.7) * np.exp(-at * 1.2), at)
    return fit(reverb(x, 1.4, 0.3, 6000), d)


def shield_up():
    d = 1.0
    x = np.zeros(n(d))
    for k, det in enumerate([0, 7, -9, 14]):
        x += sine_sweep(d, 300 * 2 ** (det / 1200), 900 * 2 ** (det / 1200)) * (0.35 if k else 0.5)
    x *= adsr(d, 0.15, 0.3, 0.7, 0.4) * (1 + 0.3 * np.sin(2 * np.pi * 12 * t(d)))
    shimmer = sum(np.sin(2 * np.pi * f * t(d)) * 0.06 for f in (2100, 2650, 3300)) * adsr(d, 0.3, 0.2, 0.6, 0.4)
    return fit(reverb(x + shimmer, 0.9, 0.3, 7000), d)


def shield_hit():
    d = 0.8
    tt = t(d)
    index = 6 * np.exp(-tt * 10)
    zap = np.sin(2 * np.pi * 1200 * tt + index * np.sin(2 * np.pi * 330 * tt)) * env(d, 0.001, 7)
    glass = sum(np.sin(2 * np.pi * f * tt) * a for f, a in ((2100, 0.3), (3350, 0.22), (4700, 0.14))) * env(d, 0.001, 5)
    return fit(reverb(zap * 0.6 + glass, 0.7, 0.25, 8000), d)


def bell_tone(freq, d, decay=6.0):
    tt = t(d)
    tone = np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(2 * np.pi * freq * 2 * tt) * np.exp(-tt * decay * 0.8) + 0.15 * np.sin(2 * np.pi * freq * 3 * tt) * np.exp(-tt * decay * 1.5)
    return tone * env(d, 0.002, decay)


def pickup():
    d = 0.55
    x = np.zeros(n(d))
    mix_at(x, bell_tone(1318.5, 0.3, 9) * 0.6, 0)
    mix_at(x, bell_tone(1975.5, 0.4, 7) * 0.6, 0.09)
    return fit(reverb(x, 0.5, 0.2, 9000), d)


def respawn():
    d = 0.9
    x = np.zeros(n(d))
    for i, m in enumerate((72, 76, 79, 84)):
        mix_at(x, bell_tone(midi(m), 0.5, 6) * 0.45, i * 0.07)
    return fit(reverb(x, 0.7, 0.25, 8000), d)


def boost():
    d = 1.0
    whoosh = swept_noise(d, 400, 3500, 1.3) * adsr(d, 0.1, 0.2, 0.6, 0.5)
    tone = sine_sweep(d, 180, 520) * adsr(d, 0.05, 0.3, 0.4, 0.4) * 0.25
    return fit(reverb(whoosh * 0.8 + tone, 0.5, 0.15), d)


def wood_bump():
    d = 0.6
    tt = t(d)
    tone = sum(np.sin(2 * np.pi * f * tt) * a * np.exp(-tt * k) for f, a, k in ((112, 1.0, 9), (187, 0.6, 12), (311, 0.4, 16), (520, 0.2, 25)))
    click = spectrum_filter(noise(0.015), 200, 2500) * env(0.015, 0.0005, 150)
    x = tone * env(d, 0.001, 0)
    mix_at(x, click * 0.8, 0)
    creak = band(noise(0.25), 650, 0.6) * env(0.25, 0.02, 10) * 0.25
    mix_at(x, creak, 0.05)
    return fit(reverb(x, 0.5, 0.12, 3000), d)


def wood_scrape():
    d = 1.0
    x = band(noise(d), 900, 1.0)
    stick = (spectrum_filter(noise(d), None, 30) > 0.0).astype(float) * 0.7 + 0.3
    return fit(x * stick * adsr(d, 0.05, 0.2, 0.7, 0.3), d)


def horn():
    d = 2.3
    x = np.zeros(n(d))
    for f, a in ((98, 1.0), (147, 0.7), (196, 0.25)):
        for det in (-6, 5):
            x += saw(f, d, det) * a * 0.5
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5 * t(d))
    x = spectrum_filter(x * vib, 60, 900, 3)
    x *= adsr(d, 0.25, 0.2, 0.85, 0.55)
    return fit(reverb(x, 2.2, 0.3, 2500), d + 0.0)


def beep():
    d = 0.28
    tt = t(d)
    x = (np.sin(2 * np.pi * 880 * tt) + 0.2 * np.sin(2 * np.pi * 1760 * tt)) * adsr(d, 0.005, 0.05, 0.8, 0.12)
    return fit(x, d)


def water_lapping():
    d = 20.0
    total = d + 1.0
    brown = np.cumsum(noise(total))
    brown = spectrum_filter(brown - np.mean(brown), 40, 520, 3)
    swell = 0.55 + 0.45 * (0.5 * np.sin(2 * np.pi * 0.23 * t(total)) + 0.3 * np.sin(2 * np.pi * 0.41 * t(total) + 1) + 0.2 * np.sin(2 * np.pi * 0.67 * t(total) + 2))
    x = normalise(brown) * swell * 0.7
    at = 0.3
    while at < total - 0.6:
        lap = swept_noise(0.5, 1800, 600, 1.2) * env(0.5, 0.06, 7) * rng.uniform(0.15, 0.3)
        mix_at(x, lap, at)
        at += rng.uniform(0.9, 2.1)
    return make_loop(x, d, 1.0)


def gull_call(d=0.35, f0=1900, f1=1150):
    tt = t(d)
    f = f0 * (f1 / f0) ** (tt / d)
    ph = 2 * np.pi * np.cumsum(f) / SR
    raw = np.tanh(2.5 * np.sin(ph) + 0.6 * np.sin(2 * ph))
    return band(raw, 1600, 1.6) * adsr(d, 0.03, 0.08, 0.7, 0.12)


def seagulls():
    d = 8.0
    x = np.zeros(n(d))
    at = 0.4
    while at < d - 1.5:
        for k in range(rng.integers(2, 5)):
            mix_at(x, gull_call(rng.uniform(0.25, 0.4), rng.uniform(1700, 2100), rng.uniform(1000, 1300)) * rng.uniform(0.5, 1.0), at + k * rng.uniform(0.32, 0.45))
        at += rng.uniform(1.6, 2.8)
    x = spectrum_filter(x, 300, 4500)
    return fit(reverb(x, 1.8, 0.45, 4000), d)


def bell_strike(f):
    d = 4.5
    tt = t(d)
    partials = ((0.5, 0.6, 0.6), (1.0, 1.0, 1.0), (1.183, 0.5, 1.6), (1.506, 0.45, 2.0), (2.0, 0.35, 2.4), (2.514, 0.25, 3.0), (2.662, 0.2, 3.3), (3.011, 0.15, 4.0), (4.166, 0.08, 5.0))
    x = sum(np.sin(2 * np.pi * f * r * tt) * a * np.exp(-tt * k * 0.9) for r, a, k in partials)
    return x * env(d, 0.002, 0)


def bells_distant():
    d = 6.5
    x = np.zeros(n(d))
    mix_at(x, bell_strike(233), 0.05)
    mix_at(x, bell_strike(196) * 0.9, 2.3)
    x = spectrum_filter(x, 80, 2600)
    return fit(reverb(x, 3.0, 0.5, 2500), d)


def accordion_note(m, d, level=1.0):
    f = midi(m)
    tremolo = 1 + 0.12 * np.sin(2 * np.pi * 6.2 * t(d))
    x = saw(f, d, -7) + saw(f, d, 6) + 0.5 * saw(f * 2, d, 2)
    x = spectrum_filter(x, 150, 2800, 2) * tremolo
    return x * adsr(d, 0.03, 0.08, 0.8, min(0.08, d / 3)) * level


def lobby_loop():
    beat = 0.5  # 120 bpm waltz, 16 bars = 24 s
    bar = 3 * beat
    d = 16 * bar
    chords = {
        'C': (48, (60, 64, 67)), 'G7': (43, (59, 62, 65)), 'F': (41, (57, 60, 65)),
        'Am': (45, (57, 60, 64)), 'Dm': (50, (57, 62, 65)),
    }
    progression = ['C', 'G7', 'G7', 'C', 'C', 'F', 'G7', 'C', 'Am', 'Dm', 'G7', 'C', 'F', 'C', 'G7', 'C']
    melody = [  # (bar, beat offset, beats, midi)
        (0, 0, 1, 76), (0, 1, 1, 79), (0, 2, 1, 84),
        (1, 0, 1.5, 83), (1, 1.5, 0.5, 81), (1, 2, 1, 79),
        (2, 0, 1, 77), (2, 1, 1, 74), (2, 2, 1, 71),
        (3, 0, 2, 72), (3, 2, 1, 67),
        (4, 0, 1, 76), (4, 1, 1, 79), (4, 2, 1, 84),
        (5, 0, 1.5, 81), (5, 1.5, 0.5, 79), (5, 2, 1, 77),
        (6, 0, 1, 76), (6, 1, 1, 74), (6, 2, 1, 77),
        (7, 0, 2, 76),
        (8, 0, 1, 81), (8, 1, 1, 84), (8, 2, 1, 88),
        (9, 0, 1.5, 86), (9, 1.5, 0.5, 84), (9, 2, 1, 81),
        (10, 0, 1, 83), (10, 1, 1, 79), (10, 2, 1, 74),
        (11, 0, 1, 76), (11, 1, 1, 79), (11, 2, 1, 84),
        (12, 0, 1, 84), (12, 1, 1, 81), (12, 2, 1, 77),
        (13, 0, 1.5, 79), (13, 1.5, 0.5, 76), (13, 2, 1, 72),
        (14, 0, 1, 74), (14, 1, 1, 77), (14, 2, 1, 71),
        (15, 0, 2, 72),
    ]
    x = np.zeros(n(d + 2.5))
    for i, name in enumerate(progression):
        bass, tones = chords[name]
        mix_at(x, accordion_note(bass, beat * 0.9, 0.55), i * bar)
        for b in (1, 2):
            for m in tones:
                mix_at(x, accordion_note(m, beat * 0.55, 0.16), i * bar + b * beat)
    for b, off, beats, m in melody:
        mix_at(x, accordion_note(m, beats * beat * 0.95, 0.42), b * bar + off * beat)
    x = reverb(x, 1.2, 0.18, 5000)
    return circular_tail(x, d)


def win_fanfare():
    d = 3.2
    x = np.zeros(n(d))

    def brass(m, dur, level):
        f = midi(m)
        tone = sum(saw(f, dur, det) for det in (-5, 0, 6)) / 3
        bright = np.exp(-t(dur) * 2.5) * 2500 + 900
        y = spectrum_filter(tone, 100, 2200, 2) * 0.7 + spectrum_filter(tone, 100, 5000, 2) * 0.3 * (bright / 3400)
        return y * adsr(dur, 0.03, 0.1, 0.8, 0.15) * level

    for i, m in enumerate((67, 72, 76)):
        mix_at(x, brass(m, 0.14, 0.6), i * 0.13)
    mix_at(x, brass(79, 0.55, 0.7), 0.39)
    for m in (72, 76, 79, 84):
        mix_at(x, brass(m, 1.6, 0.42), 1.0)
    timp = sine_sweep(0.6, 90, 70) * env(0.6, 0.003, 5)
    mix_at(x, timp * 0.9, 0.0)
    mix_at(x, timp * 1.0, 1.0)
    return fit(reverb(x, 1.6, 0.28, 6000), d)


SOUNDS = {
    'cannon': cannon,
    'explosion-water': explosion_water,
    'splash-small': lambda: splash(1.0, 3200, 700, 8, 0.8),
    'splash-big': lambda: splash(2.0, 2600, 450, 30, 1.4),
    'water-cannon': water_cannon,
    'torpedo-launch': torpedo_launch,
    'mortar-launch': mortar_launch,
    'firework-burst': firework_burst,
    'shield-up': shield_up,
    'shield-hit': shield_hit,
    'pickup': pickup,
    'respawn': respawn,
    'boost': boost,
    'wood-bump': wood_bump,
    'wood-scrape': wood_scrape,
    'horn': horn,
    'beep': beep,
    'water-lapping': water_lapping,
    'seagulls': seagulls,
    'bells-distant': bells_distant,
    'lobby-loop': lobby_loop,
    'win-fanfare': win_fanfare,
}

# Peak level per file: loops and ambience sit lower so the mix in audio.ts starts sensible.
PEAK_DB = {'water-lapping': -6.0, 'seagulls': -4.0, 'bells-distant': -4.0, 'lobby-loop': -3.0, 'water-cannon': -4.0}


def write_mp3(name, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        path = tmp.name
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    dest = os.path.join(OUT, f'{name}.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-codec:a', 'libmp3lame', '-q:a', '4', dest], check=True)
    os.unlink(path)
    return dest


def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    for name, make in SOUNDS.items():
        if only and name not in only:
            continue
        x = normalise(make(), PEAK_DB.get(name, -1.0))
        dest = write_mp3(name, x)
        print(f'{name:16s} {len(x) / SR:5.2f} s  {os.path.getsize(dest) // 1024:4d} KB')


if __name__ == '__main__':
    main()
