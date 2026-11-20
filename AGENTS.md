# AD Player: project outline for coding agents

## What this is

A static, client-side web audio player hosted on GitHub Pages.

- Repo: https://github.com/kyle95wm/ad-player (branch `main`, served from `/`)
- Live: https://kyle95wm.github.io/ad-player/

Its main users are people who use screen readers. All audio passes through a
fixed compressor and a brick-wall limiter in real time.

Core requirements:

1. Plays the formats the browser can decode natively: MP3, AAC/M4A, WAV, FLAC,
   Ogg Vorbis, Opus and WebM. There is no ffmpeg/WASM fallback, by design.
2. Opens several files at once, a folder, or an M3U/M3U8 playlist, into a play
   queue.
3. Processes audio in real time with these exact settings (they are not
   user-adjustable, and there is no UI for them, by design):
   - Compressor: threshold −34 dBFS, ratio 4:1, soft knee 6 dB, attack 30 ms,
     release 300 ms, makeup gain +15 dB.
   - Limiter: ceiling −3 dBFS, release 60 ms.
4. Fully usable with a screen reader and keyboard, with obvious buttons for
   play/pause, previous/next track and back/forward 10 s.

## Stack and constraints

- Plain HTML, CSS and ES modules. There is **no build step, no package.json and
  no dependencies**, so keep it that way. GitHub Pages serves the files as they
  are.
- It must be served over http(s). AudioWorklet and ES modules don't load from
  `file://`. To run it locally:
  `python3 -m http.server 8000`, then open http://localhost:8000.
- There is no automated test suite in the repo (see "How it was verified").

## File map

| File | Lines | Role |
|---|---|---|
| `index.html` | ~96 | Page structure, landmarks, all static controls. Hidden `<input type=file>` elements for files and folders (`webkitdirectory`). |
| `style.css` | ~314 | Colour tokens on `:root` with a dark-mode override, focus styles, responsive layout, forced-colors and reduced-motion rules, tooltip styles. |
| `app.js` | ~632 | Player: audio graph, queue state, rendering, controls, announcements, Media Session, volume. |
| `playlist.js` | ~155 | Sorting picked files into audio and playlists, M3U parsing, matching playlist entries to picked files. |
| `dsp-processor.js` | ~188 | `AudioWorkletProcessor` named `dynamics-processor`: the compressor and limiter. |
| `tooltip.js` | ~115 | One shared tooltip element for any element with `data-tip`. |
| `README.md` | | User-facing documentation. |

## Audio graph (`app.js`, `setUpAudioGraph`)

```
HTMLAudioElement (object URL of picked File)
  -> MediaElementAudioSourceNode
  -> AudioWorkletNode('dynamics-processor')   [compressor -> makeup -> limiter]
  -> GainNode (user volume, post-limiter)
  -> destination
```

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

Settings live in `DEFAULTS` at the top of the file. `processorOptions` can
override them; this is only used for testing.

**Compressor**

- Detection is stereo-linked: per sample, the largest absolute value across
  channels.
- Level detector is a "smooth decoupled" peak detector in the linear domain:
  - `peakEnv = max(|x|, rel*peakEnv + (1-rel)*|x|)` with the 300 ms release
    coefficient;
  - `levelEnv = att*levelEnv + (1-att)*peakEnv` with the 30 ms attack
    coefficient;
  - coefficients are `exp(-1/(τ·fs))`.
- Gain computer works in dB with a soft knee (Giannoulis/Reiss form) in
  `curve(x)`:
  - below `T − W/2`: unchanged;
  - inside the knee: quadratic;
  - above `T + W/2`: `T + (x−T)/R`.
- The gain is `curve(level) − level + makeup`, applied to all channels.

**Limiter** (lookahead L = 5 ms, rounded to samples)

1. `need = min(1, ceiling / max|s_c|)` per sample, after compression.
2. Sliding-window minimum of `need` over L samples, using a monotonic deque.
3. Release smoothing: instant drop, exponential rise with the 60 ms
   coefficient. The smoothed value is always ≤ the held value.
4. Box-filter average over L samples, which gives a smooth attack ramp. The
   running sum is recomputed once per 128-frame block to prevent drift.
5. Audio is delayed by **L − 1** samples, so every gain value averaged is ≤ the
   need of the delayed sample. This guarantees the output never exceeds the
   ceiling.
6. A final hard clip at ±ceiling (`safetyClip`) only catches float rounding.

Other DSP facts:

- The ceiling is **sample peak**, not true peak (no oversampling).
- The compressor sees undelayed audio; only the limiter path is delayed.
- Added latency is about 5 ms.
- Delay buffers are allocated for up to 8 channels. Output channel count
  follows the input. Missing input channels are treated as silence, and
  `process` always returns `true`.

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

- **DSP in Node.** A throwaway harness, not in the repo, loaded
  `dsp-processor.js` with `vm.runInNewContext`. It stubbed `sampleRate`,
  `AudioWorkletProcessor` and `registerProcessor`, then called `process()` in
  128-frame blocks. Results:
  - Steady 1 kHz sine, static curve: output matched `curve(x) + 15` to 0.01 dB
    from −60 to 0 dBFS (for example −10 → −13.00, 0 → −10.50, −40 → −25.00).
  - With `safetyClip: false`, peak output never went over −3.000 dBFS. This was
    tested with stereo noise bursts, single-sample spikes and a full-scale
    square wave.
  - No NaN on silence, an empty input array, or mono input.
  - CPU: about 1.2–1.5% of real time.
- **In the browser** (Chromium, desktop app pane):
  - An `OfflineAudioContext` render through the worklet matched the Node
    results.
  - The UI was driven with synthesized WAV `File`s set on the file input
    through `DataTransfer`.
  - Checked: queue, M3U matching (including the report), auto-advance, error
    skip, move/remove focus handling, the seek-slider keys, tooltips (hover,
    focus, Escape), and volume reset.
- **Not verified:**
  - with real screen readers (NVDA, JAWS, VoiceOver, TalkBack);
  - in Safari or Firefox;
  - on iOS or Android.

## Known limitations and areas worth checking

- **Autoplay:** Safari may block autoplay after the file picker closes. The
  player then announces "Press Play to start playback."
- **iOS:** the folder picker isn't available on iOS, so the "Add folder" button
  is hidden. iOS may also suspend the AudioContext in the background or when
  the screen locks.
- **Sample peak only:** the −3 dBFS ceiling is sample peak, so inter-sample
  peaks can go slightly over it after reconstruction.
- **Unplayable files:** several bad files in a row each trigger an
  announce-and-skip.
- **Previous track:** when the first track has played for less than 3 s,
  Previous restarts it and says it's the first track.
- **Large queues:** `renderQueue()` rebuilds the whole list on every change.
  This is fine for hundreds of tracks but hasn't been tested at thousands.
- **Track titles:** they come from `#EXTINF` or the file name. ID3 and other
  metadata tags aren't read.

## Conventions for changes

- No build tools, frameworks or external runtime dependencies.
- Keep the DSP settings exact. If you change the DSP, re-verify the static curve
  and the ceiling with `safetyClip: false`.
- Every new control needs:
  - a visible text label or an accessible name;
  - a `data-tip` tooltip;
  - outcomes announced through `announce()` where the result isn't otherwise
    obvious.
- Don't disable controls. Make them explain why they can't act.
- Wrap every `localStorage` access in try/catch.
- Commits go to `main`, which deploys to GitHub Pages automatically.
