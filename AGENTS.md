# AD Player: project outline for coding agents

## What this is

A static, client-side web player for audio description (AD) tracks, hosted on
GitHub Pages. AD tracks are the audio-only versions of films and TV programmes,
with a narrator describing what's on screen between the dialogue.

- Repo: https://github.com/kyle95wm/ad-player (branch `main`, served from `/`)
- Live: https://kyle95wm.github.io/ad-player/

Its main users are people who use screen readers. The point of the app is its
always-on **night mode**: easier listening in loud environments and at night,
by taming action scenes (explosions, gunfire, loud music) while keeping
dialogue and description audible. Night mode is Plezy's fixed FFmpeg compressor
and limiter chain, ported to an AudioWorklet and verified bit-identical to
FFmpeg. The compressor (with +15 dB makeup) lifts quiet speech and pulls down
loud passages, and the limiter catches peaks at −3 dBFS. In user-facing text,
call it "night mode"; in code and technical docs, "the DSP" is fine.

Core requirements:

1. Plays the formats the browser can decode natively: MP3, AAC/M4A, WAV, FLAC,
   Ogg Vorbis, Opus and WebM. There is no ffmpeg/WASM fallback, by design.
2. Opens several files at once, a folder, or an M3U/M3U8 playlist, into a play
   queue.
3. Night mode: processes audio in real time exactly like Plezy's fixed chain. The settings
   are not user-adjustable, and there is no UI for them, by design:
   `acompressor=threshold=-34dB:ratio=4:knee=6dB:attack=30:release=300:makeup=15dB:link=maximum,alimiter=limit=-3dB:attack=1:release=60:level=false`
   - Compressor: threshold −34 dBFS, ratio 4:1, knee 6 dB, attack 30 ms,
     release 300 ms, RMS detection, maximum channel link, makeup +15 dB.
   - Limiter: ceiling −3 dBFS sample peak, attack/lookahead 1 ms, release
     60 ms, output normalization off.
   - Out of scope, so don't add: programme-dependent timing, level riding,
     input loudness calibration, dialogue detection, LUFS/LRA targeting,
     threshold or makeup linking, sidechain filtering, or any automatic change to
     the settings.
4. Fully usable with a screen reader and keyboard, with obvious buttons for
   play/pause, previous/next track and back/forward 10 s.

## Stack and constraints

- Plain HTML, CSS and ES modules. There is **no build step, no package.json and
  no dependencies**, so keep it that way. GitHub Pages serves the files as they
  are.
- It must be served over http(s). AudioWorklet and ES modules don't load from
  `file://`. To run it locally:
  `python3 -m http.server 8000`, then open http://localhost:8000.
- The only automated test is the DSP comparison in `tests/`, which needs Node,
  FFmpeg and clang++. It is excluded from GitHub Pages by `_config.yml` and is
  never loaded by the player (see "How it was verified").

## File map

| File | Lines | Role |
|---|---|---|
| `index.html` | ~96 | Page structure, landmarks, all static controls. Hidden `<input type=file>` elements for files and folders (`webkitdirectory`). |
| `style.css` | ~314 | Colour tokens on `:root` with a dark-mode override, focus styles, responsive layout, forced-colors and reduced-motion rules, tooltip styles. |
| `app.js` | ~650 | Player: audio graph, queue state, rendering, controls, announcements, Media Session, volume. |
| `playlist.js` | ~155 | Sorting picked files into audio and playlists, M3U parsing, matching playlist entries to picked files. |
| `dsp-processor.js` | ~250 | `AudioWorkletProcessor` named `dynamics-processor`, wrapping `FixedDSP`: a port of Plezy's FFmpeg compressor and limiter. LGPL-2.1-or-later (derived from FFmpeg). |
| `tooltip.js` | ~115 | One shared tooltip element for any element with `data-tip`. |
| `sw.js` | ~80 | Service worker for offline use. Saves the page's own files on install, then serves network-first with a cache fallback. Registered at the end of `app.js`. |
| `README.md` | | User-facing documentation. |
| `tests/compare-dsp.mjs` | | Renders identical PCM through FFmpeg, the reference C++ and the worklet, and compares them. Writes `tests/dsp-comparison-results.json`. |
| `tests/render-reference.cpp` | | Command-line driver for the reference `AndroidDSP.h`. |
| `_config.yml` | | Excludes `tests/` from the GitHub Pages build. |

## Audio graph (`app.js`, `setUpAudioGraph`)

```
HTMLAudioElement (object URL of picked File)
  -> MediaElementAudioSourceNode
  -> AudioWorkletNode('dynamics-processor')   [compressor -> makeup -> limiter]
  -> GainNode (user volume, post-limiter)
  -> destination
```

- The worklet node uses `channelCountMode: 'max'` and
  `channelInterpretation: 'speakers'`, with no `outputChannelCount`, so every
  channel of the track reaches the DSP unmixed and the output keeps the same
  layout. It posts `{type:'latency', samples, sampleRate, channels}` whenever it
  (re)prepares, and `app.js` logs this with `console.info`.
- The AudioContext is created at page load, so it starts suspended. It is
  resumed by `wakeAudio()`, which is called synchronously in every user-gesture
  handler (play, skip, add files, queue clicks, drop).
- If the worklet fails to load, or isn't supported, the source connects straight
  to the volume node. A visible warning is shown and announced. On `file://` the
  warning says to serve the page over http.
- Volume: slider 0–100, step 5, default `DEFAULT_VOLUME = 100`. Gain = (v/100)²,
  applied after the limiter so the volume setting doesn't change how hard the
  compressor works. It is saved in `localStorage` under `ad-player-volume`, with
  every access wrapped in try/catch.

## DSP details (`dsp-processor.js`)

This is a line-by-line port of the fixed path in `AndroidDSP.h`
(`DSP::configure` and `DSP::processFrame`) from the Android Normalize Audio Unit
project, with programme mode off. That file adapts FFmpeg n8.0.1
`af_sidechaincompress.c`, `af_alimiter.c` and `hermite.h`.

**Keep the statement order and the operations exactly as they are.** The output
is bit-identical to FFmpeg only because the arithmetic order matches. That
includes the C integer division in the limiter's `pdelta`, the
`1e-13`/`1e-14` snapping, and the final clamp.

- **Settings:** a frozen `SETTINGS` object. There is no override path:
  `processorOptions` and messages are ignored.
- **Arithmetic:** all doubles (JS numbers, `Float64Array`); output is rounded
  to float32. Non-finite input samples are replaced with 0.

**Compressor** (`acompressor`, `detection=rms` default, `link=maximum`)

- Per frame:
  - `peak = max_c |x_c|`, then `peak *= peak`.
  - `slope += (peak − slope) · (peak > slope ? attackCoeff : releaseCoeff)`,
    where `attackCoeff = min(1, 1 / (30 · rate / 4000))` and
    `releaseCoeff = min(1, 1 / (300 · rate / 4000))`.
- If `slope > adjStart` (`adjStart = (threshold / √knee)²`, using linear
  threshold and knee):
  - `level = ln(slope) / 2`;
  - `compressed = (level − thres) / ratio + thres` in natural-log units;
  - below `kneeStop`, `compressed` is replaced by the Hermite curve between
    `kneeStart` and `kneeStop`;
  - `gain = exp(compressed − level)`.
- Every channel is multiplied by `gain · makeup` (`makeup` = 10^(15/20)).

**Limiter** (`alimiter`, `attack=1`, `asc=false`, `level=false`, `level_in` and `level_out` = 1)

- **Lookahead buffer:** interleaved, `size = trunc(rate · 0.001 · channels)`,
  minus `size % channels`.
- **Gain schedule:** when the compressed frame peak exceeds `limit` (0.708), it
  schedules a linear gain ramp `delta` toward `limit / peak` over the buffer.
  Later peaks are queued in `nextPos`/`nextDelta`. The release ramp is
  `(1 − limit/peak) / (rate · 0.06)` per sample.
- **Output frame:** each output frame is the oldest buffered frame times `att`,
  then clamped to ±limit.
- **Delay:** `size / channels − 1` frames. That's 43 at 44.1 kHz, 47 at
  48 kHz, 95 at 96 kHz and 191 at 192 kHz, always just under 1 ms. The delay
  doesn't depend on the channel count.

**Wrapper** (`DynamicsProcessor`)

- **Channel layout:** it follows `inputs[0].length`, capped at 8. If the input
  has no channels, it keeps the last layout and feeds silence, so buffered audio
  drains.
- **Reset:** a change in channel count re-prepares (resets) the DSP, as the
  reference's `prepare()` does.
- **Block size:** output doesn't depend on it, which was checked at 1, 127,
  128, 512 and 4096 frames.
- **CPU** (Node, Apple Silicon): about 0.2% of one core for stereo at 48 kHz,
  and 0.8% for 8 channels.

**Browser effects outside the DSP** (documented, not "fixable" in the DSP)

- **Sample rate:** the DSP runs at `AudioContext.sampleRate`, usually the
  device rate. Tracks at other rates are resampled by the browser **before**
  the DSP. Plezy runs the chain at the track's own rate, so a 44.1 kHz file is
  processed with 48 kHz coefficients on resampled samples.
- **Downmix:** `destination` is stereo by default (Chrome reported 2 channels).
  Multichannel tracks are downmixed with Web Audio speaker rules **after** the
  limiter, so that sum can exceed −3 dBFS. Mono and stereo tracks aren't
  affected.

## Queue and playlist behaviour

- State in `app.js`: `queue` (array of `{id, file, title}`), `current` (index,
  −1 when none), and `currentUrl` (only the loaded track has an object URL; it
  is revoked when the track changes).
- Adding files appends them to the queue. If the queue was empty, the first new
  track starts playing.
- `buildTracks()` in `playlist.js`:
  - With no playlist among the picked files, all audio files are queued, sorted
    by path with numeric collation.
  - With one or more `.m3u`/`.m3u8` files, **only their entries** are queued,
    in playlist order. Each entry is matched against the picked files in this
    order:
    1. path relative to the playlist's folder (folder picks only, using
       `webkitRelativePath`);
    2. full normalised path;
    3. file name alone, case-insensitive.
  - `normalizePath` handles backslashes, drive letters, `file://` URIs, `.` and
    `..`.
  - `http(s)` entries are **skipped by design** (local files only).
  - The text is decoded as UTF-8 first, falling back to Windows-1252.
    `#EXTINF` titles are used as track titles.
  - Returns a report (missing entries, remote entries, unused audio files,
    non-audio files) that `addFiles()` announces.
- At the end of a track, playback advances to the next one, and stops at the
  end of the queue.
- When a track fails to play, the error is announced and playback moves on to
  the next track (or stops if it was the last).
- Previous: restarts the track if it's more than 3 s in, or if it's the first
  track; otherwise goes to the previous track.
- Skipping always starts playback.

## Accessibility decisions (intentional, so don't "fix" these)

- **Structure:**
  - Landmarks with `h1` "AD Player" and `h2` "Now playing" / "Queue".
  - A skip link to `#controls`, a `role=group` with `tabindex=-1`.
- **Transport buttons:**
  - Each has visible text labels. Icons are SVGs with `aria-hidden`.
  - The Play/Pause label text changes (not `aria-pressed`).
  - Buttons are **never disabled**. They announce why they can't act (for
    example "The queue is empty").
- **Live region:** a single `role=status` (`#status`). `announce()` clears it,
  then sets the text after 50 ms so repeated messages are read again.
- **Position slider:**
  - `aria-valuetext` reads as words ("1 minute 5 seconds of 3 minutes"),
    updated only when the whole second changes.
  - Arrow keys move ±5 s and Page Up/Down move ±30 s (custom `keydown`).
  - The visible time text is `aria-hidden`.
- **Volume:**
  - The visible percentage `#volume-value` is `aria-hidden` because the slider's
    `aria-valuetext` already says "N percent".
  - The **Reset volume** button announces "Volume reset to 100 percent." or
    that it's already at the default.
  - It doesn't use `<output>`, which some screen readers treat as a live region
    and would announce twice.
- **Queue items:**
  - Each item is an `<li>` with a title button plus ↑ ↓ ✕ buttons whose
    `aria-label` names the track ("Move X up", "Remove X").
  - The current item has `aria-current="true"` and a "(now playing)" or
    "(current, paused)" text suffix.
  - Focus is restored after a move or remove (`focusQueueButton`).
- **Tooltips (`tooltip.js`):**
  - Shown on mouse hover after 400 ms and on `:focus-visible`.
  - Escape dismisses them, and the pointer can move onto the tooltip without it
    closing (WCAG 1.4.13).
  - The tooltip element is `aria-hidden` because button names already carry the
    same information.
- **No single-key keyboard shortcuts.** They would clash with screen reader
  browse-mode quick keys. Hardware media keys work through the Media Session
  API (play, pause, previoustrack, nexttrack, seekbackward, seekforward,
  seekto).
- **Visual:** touch targets are at least 44 px. There are forced-colors and
  reduced-motion rules, and dark mode via `prefers-color-scheme`.

## How it was verified

- **DSP against FFmpeg and the reference** (`tests/compare-dsp.mjs`, run
  19 November 2026, FFmpeg 8.1.1). The reference project's own validation shows
  its C++ is bit-identical to the FFmpeg CLI, and that its limiter and Hermite
  sources are byte-identical between n8.0.1 and 8.1.1.
  - **Coverage.** 56 signal runs:
    - rates and channels: 44.1 kHz in 1 and 2 channels; 48 kHz in 1, 2, 6 and
      8 channels; 96, 22.05 and 192 kHz in stereo;
    - signals: sustained tones from −60 to +3 dBFS, level steps, transients
      and isolated peaks, unequal and moving channel levels, silence, synthetic
      programme material, and macOS text-to-speech over a music bed.
  - **Method.** Delay was measured with an impulse in each implementation and
    was identical, so the alignment offset was 0.
  - **Result.** The maximum sample error was **0** against both FFmpeg and the
    reference, at block sizes 1, 127, 128, 512 and 4096. Output was
    bit-identical across block sizes and the peak never went over −3.000 dBFS.
  - **Sensitivity check.** The harness does catch real errors. Changing the
    release by 1 ms gave a maximum error of 2.4e-4, attack by 1 ms gave 4.2e-3,
    and limiter release by 1 ms gave 9.6e-4.
  - **Other checks.** NaN and ±Infinity input gives finite output within the
    ceiling. With linking, the ratio between channels is preserved exactly.
- **In Chrome 156** (the desktop app's browser pane):
  - An `OfflineAudioContext` render through the worklet was bit-identical to
    the Node render, at 48 kHz in stereo and 6 channels. Node's render is
    bit-identical to FFmpeg's.
  - In the live player, mono, stereo and 6-channel WAVs reached the DSP with
    1, 2 and 6 channels, at the context rate of 48 kHz.
  - The UI was driven with synthesized WAV `File`s set on the file input
    through `DataTransfer`. Checked: queue, M3U matching (including the
    report), auto-advance, error skip, move/remove focus handling, the
    seek-slider keys, tooltips (hover, focus, Escape), and volume reset.
- **Offline support** (20 November 2026, headless Chromium driven over CDP,
  local server):
  - The first visit registered the worker, controlled the page and saved all
    seven entries.
  - With the server stopped, reloading and navigating to
    `index.html?x=1` opened the full player with no DSP warning, and an
    `OfflineAudioContext` loaded `dsp-processor.js` from the saved copy and
    rendered a tone limited to −3.000 dBFS.
  - With the server back, a reload fetched from the network again.
- **Not verified:**
  - real screen readers (NVDA, JAWS, VoiceOver, TalkBack);
  - Safari and Firefox, including their AudioWorklet output and multichannel
    decoding;
  - iOS and Android;
  - real multichannel output devices;
  - listening comparisons against Plezy on Android;
  - offline use in Safari, Firefox, iOS and Android, and on the live site.

## Known limitations and areas worth checking

- **Autoplay:** Safari may block autoplay after the file picker closes. The
  player then announces "Press Play to start playback."
- **iOS:** the folder picker isn't available on iOS, so the "Add folder" button
  is hidden. iOS may also suspend the AudioContext in the background or when
  the screen locks.
- **Sample peak only:** the −3 dBFS ceiling is sample peak (as in FFmpeg), so
  inter-sample peaks can go slightly over it after reconstruction.
- **Multichannel on stereo devices:** the browser downmixes after the limiter,
  so peaks can exceed −3 dBFS (see "Browser effects outside the DSP").
- **Resampling:** tracks whose rate differs from the AudioContext's are
  resampled before the DSP (see "Browser effects outside the DSP").
- **Unplayable files:** several bad files in a row each trigger an
  announce-and-skip.
- **Previous track:** when the first track has played for less than 3 s,
  Previous restarts it and says it's the first track.
- **Large queues:** `renderQueue()` rebuilds the whole list on every change.
  This is fine for hundreds of tracks but hasn't been tested at thousands.
- **Track titles:** they come from `#EXTINF` or the file name. ID3 and other
  metadata tags aren't read.
- **Offline fallback on slow networks:** if some requests time out (5 s) and
  others don't, one page load could mix saved and new files just after a
  deploy. A normal reload fixes it.
- **Browser pane:** the desktop app's browser pane refuses service worker
  registration, so offline support can't be tested there (the player still
  works; it only logs a warning).

## Offline support (`sw.js`)

- Registered from `app.js` (skipped on `file://`; failure only logs a
  `console.warn`). Scope is the player's folder (`/ad-player/` on Pages).
- **Install:** pre-caches the `FILES` list (`./`, `index.html`, `style.css`,
  `app.js`, `playlist.js`, `tooltip.js`, `dsp-processor.js`) into cache
  `ad-player-v1`, fetched with `cache: 'reload'`, then `skipWaiting()`.
- **Activate:** deletes other `ad-player-*` caches, then `clients.claim()`.
- **Fetch:** same-origin GETs only. Network first, and every OK response
  refreshes the saved copy. The saved copy is served only when the network
  fails or takes longer than 5 s (`NETWORK_TIMEOUT_MS`). Offline navigations
  to any address in scope fall back to the saved `./`.
- Audio files are played from `blob:` object URLs, which never pass through
  the service worker, so nothing the user opens is cached.
- **When adding, renaming or removing a file the page loads, update `FILES`
  in `sw.js`.** Bump `CACHE` only if old saved copies must be thrown away.

## Conventions for changes

- No build tools, frameworks or external runtime dependencies.
- Keep the DSP settings and the algorithm exact. After any change to
  `dsp-processor.js`, run
  `REFERENCE_SRC=/path/to/android_normalize_plugin/src node tests/compare-dsp.mjs`
  and keep the maximum error at 0. Never modify the reference project.
- Every new control needs:
  - a visible text label or an accessible name;
  - a `data-tip` tooltip;
  - outcomes announced through `announce()` where the result isn't otherwise
    obvious.
- Don't disable controls. Make them explain why they can't act.
- Wrap every `localStorage` access in try/catch.
- Commits go to `main`, which deploys to GitHub Pages automatically.
