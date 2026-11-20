# AD Player

An accessible web audio player with a play queue, M3U playlist support, and
real-time compression and limiting on everything it plays.

Live site (once GitHub Pages is enabled): https://kyle95wm.github.io/ad-player/

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

All audio goes through a custom AudioWorklet (`dsp-processor.js`):

| Stage      | Setting         | Value      |
|------------|-----------------|------------|
| Compressor | Threshold       | −34 dBFS   |
|            | Ratio           | 4:1        |
|            | Knee            | 6 dB (soft)|
|            | Attack          | 30 ms      |
|            | Release         | 300 ms     |
|            | Makeup gain     | +15 dB     |
| Limiter    | Ceiling         | −3 dBFS (sample peak) |
|            | Release         | 60 ms      |
|            | Lookahead       | 5 ms       |

The compressor uses stereo-linked peak detection. The limiter is a lookahead
brick-wall limiter: the output never goes over −3 dBFS, and gain changes ramp
smoothly over the 5 ms lookahead instead of clipping. That lookahead adds 5 ms
of latency. Volume is applied after the limiter, so turning it down doesn't
change how hard the compressor works.

The browser's built-in `DynamicsCompressorNode` isn't used because it adds its
own automatic makeup gain and has no limiter, so it can't match these settings.

The settings are constants at the top of `dsp-processor.js`.

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
- `dsp-processor.js`: compressor and limiter AudioWorklet
