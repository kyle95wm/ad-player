# AD Player

An accessible web audio player with a play queue, M3U playlist support, and
real-time compression and limiting on everything it plays.

Live site: https://kyle95wm.github.io/ad-player/

## Features

- Plays the formats your browser supports: MP3, AAC/M4A, WAV, FLAC, Ogg Vorbis,
  Opus and WebM (and AIFF/ALAC in Safari).
- Add several files at once, a whole folder, or drag files onto the page. They
  go to the end of the queue.
- Play queue with play, move up, move down and remove for each track.
- M3U and M3U8 playlists, including `#EXTINF` titles (see below).
- Large, labelled buttons for previous track, back 10 seconds, play/pause,
  forward 10 seconds and next track.
- Hardware media keys, headset buttons and lock-screen controls through the
  Media Session API.
- Volume setting remembered between visits.

## Audio processing

All audio goes through an AudioWorklet (`dsp-processor.js`) that reproduces
Plezy's fixed FFmpeg chain:

```
acompressor=threshold=-34dB:ratio=4:knee=6dB:attack=30:release=300:makeup=15dB:link=maximum,
alimiter=limit=-3dB:attack=1:release=60:level=false
```

It's a JavaScript port of the fixed path in the Android Normalize Audio Unit's
`AndroidDSP.h`, with programme-dependent mode off. That file is itself a port of
FFmpeg n8.0.1 `af_sidechaincompress.c`, `af_alimiter.c` and `hermite.h`.

| Stage      | Setting                | Value |
|------------|------------------------|-------|
| Compressor | Threshold              | −34 dBFS |
|            | Ratio                  | 4:1 |
|            | Knee                   | 6 dB (Hermite curve) |
|            | Attack / release       | 30 ms / 300 ms |
|            | Detection              | RMS (FFmpeg default) |
|            | Channel link           | Maximum: one shared gain for all channels |
|            | Makeup gain            | +15 dB, after compression and before limiting |
| Limiter    | Ceiling                | −3 dBFS, sample peak |
|            | Attack / lookahead     | 1 ms |
|            | Release                | 60 ms |
|            | Output normalization   | Off (`level=false`) |

The settings are fixed constants. The compressor's and limiter's gains follow
the audio as normal, but nothing adjusts their settings. There is no level
riding, loudness targeting, dialogue detection or sidechain filtering.

How it works:

- **Compressor.** Each sample, it takes the largest absolute value across
  channels and squares it. That energy is smoothed with FFmpeg's coefficients:
  `min(1, 4000 / (ms × sampleRate))` for attack and for release. The gain comes
  from the log-domain curve with the Hermite soft knee. The same gain, times the
  makeup, is applied to every channel.
- **Limiter.** This is FFmpeg's `alimiter` algorithm. It keeps an interleaved
  lookahead buffer of `trunc(sampleRate × 0.001 × channels)` samples, and
  schedules linear gain ramps toward `ceiling / peak`. Release is linear over
  60 ms. A final clamp keeps output within ±0.708 (−3 dBFS).
- **Precision.** All maths uses doubles. The output is rounded to float32, as
  in FFmpeg.
- **Volume** is applied after the limiter, so it never changes how hard the
  compressor works.

**Processing delay** is `buffer frames − 1` samples:

| Sample rate | Delay |
|---|---|
| 22.05 kHz | 21 samples (0.952 ms) |
| 44.1 kHz | 43 samples (0.975 ms) |
| 48 kHz | 47 samples (0.979 ms) |
| 96 kHz | 95 samples (0.990 ms) |
| 192 kHz | 191 samples (0.995 ms) |

This delay is the same as FFmpeg's and the reference's at every rate tested.

### What the browser does around the DSP

These come from the browser, not the DSP:

- **Sample rate.** The DSP runs at the audio context's rate, which is usually
  the output device's rate (often 48 kHz). The browser resamples tracks at other
  rates before the DSP sees them. Plezy runs the chain at the track's own rate.
  So a 44.1 kHz file goes through the same algorithm, but with 48 kHz
  coefficients, on resampled samples.
- **Channels.** The worklet uses `channelCountMode: 'max'`, so every channel of
  the track reaches the DSP unmixed. This was checked with mono, stereo and
  6-channel files in Chrome. Up to 8 channels are processed. Channels beyond 8,
  which are very rare, are output as silence. When the channel count changes
  between tracks, the DSP resets, as the reference does on re-prepare.
- **Downmix after the DSP.** The audio output (`AudioContext.destination`) is
  stereo by default. Chrome's output for a 6-channel file reported 2 channels,
  so multichannel audio is downmixed to stereo by Web Audio's speaker rules
  **after** the limiter: `L + 0.707 × (C + SL)`. That sum can go over −3 dBFS,
  and even over full scale, as it can when mpv downmixes after its filters.
  Mono and stereo tracks aren't affected.

### Checking the DSP against FFmpeg

`tests/` holds the verification tools. They aren't loaded by the player and
aren't published to GitHub Pages. To run them you need Node 18+, `ffmpeg` and
`clang++`, plus the reference project's `src/` folder:

```bash
REFERENCE_SRC=/path/to/android_normalize_plugin/src node tests/compare-dsp.mjs
```

The script renders identical float32 PCM through three implementations:

- the FFmpeg CLI chain above;
- the reference C++ (`tests/render-reference.cpp`);
- the worklet, at block sizes 1, 127, 128, 512 and 4096.

It measures each one's delay with an impulse and compares samples after
aligning them. Results are written to `tests/dsp-comparison-results.json`.

Last run (FFmpeg 8.1.1, Node, 19 November 2026):

- **Test coverage.**
  - 56 signal runs across 44.1 kHz mono and stereo; 48 kHz mono, stereo, 6 and
    8 channels; 96, 22.05 and 192 kHz stereo.
  - Signals: sustained tones from −60 to +3 dBFS, level steps, transient
    bursts and isolated peaks, unequal and moving channel levels, silence,
    synthetic programme material, and recorded-style speech over a music bed.
- **Result.** The maximum sample error was 0 against both FFmpeg and the
  reference, at every block size. Output was bit-identical across block sizes
  and never went over −3.000 dBFS.
- **Delay.** Identical in all three implementations, so the alignment offset
  was 0.
- **In Chrome.** An `OfflineAudioContext` render through the worklet, at 48 kHz
  in stereo and 6 channels, was bit-identical to the Node render.
- **CPU.** About 0.2% of one core in real time for stereo at 48 kHz, and 0.8%
  for 8 channels (Node, Apple Silicon).

The browser's built-in `DynamicsCompressorNode` isn't used because its detector,
knee and automatic makeup differ, and it has no limiter.

## Playlists

A web page can't open files from the paths written inside an M3U. It only gets
the files you choose. To play a playlist, do one of these:

- **Add files** and select the `.m3u` together with the audio files it lists.
- **Add folder** and choose a folder that contains the playlist and its music.

Entries are matched first by their path relative to the playlist, then by file
name alone, so absolute paths like `C:\Music\Song.mp3` still match a picked
`Song.mp3`. When a playlist is included, only the tracks it lists are queued, in
its order. Entries that can't be found, web URLs, and extra audio files that
aren't in the playlist are skipped, and the player announces how many.

## Accessibility

- Landmarks and headings ("Now playing", "Queue") for quick navigation, plus a
  skip link to the playback controls.
- Every control has a visible text label. Queue buttons have labels such as
  "Remove Song name".
- A polite live region announces what's playing, what was added, errors and
  skipped files. The position slider reads as "1 minute 5 seconds of 3
  minutes".
- Position slider keys: arrows move 5 seconds, Page Up and Page Down move 30
  seconds.
- Focus stays in a sensible place after you reorder or remove tracks.
- Every button has a tooltip. It appears on mouse hover and on keyboard focus,
  and Escape closes it. Tooltips are hidden from screen readers because the
  button labels already say the same thing.
- There are no single-key shortcuts that would clash with screen reader quick
  navigation. Use the media keys on your keyboard or headset instead.
- Supports dark mode, Windows high contrast (forced colors) and reduced motion.
  Touch targets are at least 44 px.

## Running locally

AudioWorklets and ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publishing on GitHub Pages

No build step is needed.

1. Push these files to the `main` branch of `kyle95wm/ad-player`.
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**,
   then choose `main` and `/ (root)` and save.
4. After a minute the player is live at https://kyle95wm.github.io/ad-player/.

## Files

- `index.html`: page structure
- `style.css`: styles, including the light and dark themes
- `app.js`: player, queue, controls and announcements
- `playlist.js`: file sorting and M3U parsing and matching
- `tooltip.js`: tooltips for buttons
- `dsp-processor.js`: compressor and limiter AudioWorklet (LGPL-2.1-or-later, derived from FFmpeg)
- `tests/`: DSP verification tools (not part of the deployed player)
