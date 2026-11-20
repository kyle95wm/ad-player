import { buildTracks } from './playlist.js';
import { refreshTip } from './tooltip.js';

const $ = (id) => document.getElementById(id);
const els = {
  nowTitle: $('now-title'),
  nowMeta: $('now-meta'),
  seek: $('seek'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  prev: $('btn-prev'),
  back: $('btn-back'),
  play: $('btn-play'),
  playLabel: $('btn-play-label'),
  fwd: $('btn-fwd'),
  next: $('btn-next'),
  volume: $('volume'),
  volumeValue: $('volume-value'),
  volumeReset: $('btn-volume-reset'),
  status: $('status'),
  dspWarning: $('dsp-warning'),
  addFiles: $('btn-add-files'),
  addFolder: $('btn-add-folder'),
  clear: $('btn-clear'),
  fileInput: $('file-input'),
  folderInput: $('folder-input'),
  queueList: $('queue-list'),
  queueEmpty: $('queue-empty'),
  queueCount: $('queue-count'),
};

const SKIP_SECONDS = 10;
const DEFAULT_VOLUME = 100;
const RESTART_THRESHOLD = 3; // "Previous" restarts the track if past this point

/** @type {{id:number, file:File, title:string}[]} */
let queue = [];
let current = -1;      // index into queue, -1 = nothing loaded
let currentUrl = null; // object URL for the loaded track
let nextId = 1;
let seeking = false;
let lastSpokenSecond = -1;

const audio = new Audio();
audio.preload = 'auto';

// ---------------------------------------------------------------------------
// Audio graph: <audio> -> compressor/limiter worklet -> volume -> speakers
// ---------------------------------------------------------------------------

let ctx = null;
let volumeNode = null;

function setUpAudioGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    showDspWarning('This browser does not support Web Audio, so audio plays without compression or limiting.');
    return;
  }
  ctx = new AC({ latencyHint: 'playback' });
  const source = ctx.createMediaElementSource(audio);
  volumeNode = ctx.createGain();
  volumeNode.gain.value = volumeToGain(Number(els.volume.value));
  volumeNode.connect(ctx.destination);

  if (!ctx.audioWorklet) {
    source.connect(volumeNode);
    showDspWarning('This browser does not support AudioWorklet, so audio plays without compression or limiting. Try an up-to-date Chrome, Edge, Firefox or Safari.');
    return;
  }
  ctx.audioWorklet.addModule(new URL('./dsp-processor.js', import.meta.url))
    .then(() => {
      const dsp = new AudioWorkletNode(ctx, 'dynamics-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
      });
      dsp.onprocessorerror = () => {
        source.disconnect();
        source.connect(volumeNode);
        showDspWarning('The audio processor stopped working, so audio now plays without compression or limiting. Reload the page to try again.');
      };
      source.connect(dsp).connect(volumeNode);
    })
    .catch((err) => {
      console.error(err);
      source.connect(volumeNode);
      showDspWarning(location.protocol === 'file:'
        ? 'Audio processing can\'t load when the page is opened as a local file, so audio plays without compression or limiting. Serve the folder over http (see the README) or use the GitHub Pages site.'
        : 'Audio processing failed to load, so audio plays without compression or limiting.');
    });
}

function showDspWarning(text) {
  els.dspWarning.textContent = text;
  els.dspWarning.hidden = false;
  announce(text);
}

// Must be called synchronously inside a user action for browsers to allow sound.
function wakeAudio() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

function volumeToGain(v) {
  const x = v / 100;
  return x * x; // closer to how loudness is perceived than a straight line
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

let announceTimer = 0;
function announce(text) {
  // Clearing first makes screen readers repeat a message even if it's unchanged.
  els.status.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { els.status.textContent = text; }, 50);
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function spoken(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const part = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const out = [];
  if (h) out.push(part(h, 'hour'));
  if (m) out.push(part(m, 'minute'));
  if (s || out.length === 0) out.push(part(s, 'second'));
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function load(index) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  current = index;
  const track = queue[index];
  currentUrl = URL.createObjectURL(track.file);
  audio.src = currentUrl;
  lastSpokenSecond = -1;
  updateNowPlaying();
  updateMediaSession();
  renderQueue();
}

function startPlayback() {
  wakeAudio();
  const p = audio.play();
  if (p) {
    p.catch((err) => {
      if (err.name === 'NotAllowedError') announce('Press Play to start playback.');
      // Other failures surface through the audio element's error event.
    });
  }
}

function playIndex(index) {
  if (index < 0 || index >= queue.length) return;
  load(index);
  startPlayback();
  announce(`Now playing: ${queue[index].title}. Track ${index + 1} of ${queue.length}.`);
}

function togglePlay() {
  wakeAudio();
  if (queue.length === 0) {
    announce('The queue is empty. Add files first.');
    return;
  }
  if (current === -1) {
    playIndex(0);
  } else if (audio.paused) {
    if (audio.ended) audio.currentTime = 0;
    startPlayback();
  } else {
    audio.pause();
  }
}

function previous() {
  wakeAudio();
  if (current === -1) return togglePlay();
  const nearStart = audio.currentTime <= RESTART_THRESHOLD;
  if (!nearStart || current === 0) {
    audio.currentTime = 0;
    startPlayback();
    announce(nearStart
      ? `Restarted ${queue[current].title}. This is the first track.`
      : `Restarted ${queue[current].title}.`);
    return;
  }
  playIndex(current - 1);
}

function next() {
  wakeAudio();
  if (queue.length === 0) return announce('The queue is empty. Add files first.');
  if (current >= queue.length - 1) return announce('This is the last track in the queue.');
  playIndex(current + 1);
}

function seekBy(delta) {
  if (current === -1 || !Number.isFinite(audio.duration)) return;
  const t = Math.min(Math.max(audio.currentTime + delta, 0), audio.duration);
  audio.currentTime = t;
  announce(`${spoken(t)} of ${spoken(audio.duration)}`);
}

function stopAndUnload() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  current = -1;
  updateNowPlaying();
  updateMediaSession();
  updateTime();
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function addFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  let result;
  try {
    result = await buildTracks(fileList);
  } catch (err) {
    console.error(err);
    announce('Could not read the selected files.');
    return;
  }
  const { tracks, report } = result;
  const wasEmpty = queue.length === 0;
  for (const t of tracks) queue.push({ id: nextId++, ...t });
  renderQueue();

  const parts = [];
  parts.push(tracks.length === 0
    ? 'No playable tracks were added.'
    : `Added ${tracks.length} track${tracks.length === 1 ? '' : 's'}${report.playlists ? ` from ${report.playlists === 1 ? 'the playlist' : `${report.playlists} playlists`}` : ''}.`);
  if (report.missing.length) {
    const n = report.missing.length;
    const names = report.missing.slice(0, 3).join(', ');
    parts.push(`${n} playlist entr${n === 1 ? 'y was' : 'ies were'} not found among the selected files: ${names}${n > 3 ? ', and others' : ''}.`);
  }
  if (report.remote) parts.push(`${report.remote} web address${report.remote === 1 ? ' was' : 'es were'} skipped.`);
  if (report.unused) parts.push(`${report.unused} selected audio file${report.unused === 1 ? ' was' : 's were'} not in the playlist and ${report.unused === 1 ? 'was' : 'were'} not added.`);
  if (report.ignored) parts.push(`${report.ignored} file${report.ignored === 1 ? ' was' : 's were'} not audio and ${report.ignored === 1 ? 'was' : 'were'} ignored.`);

  if (wasEmpty && tracks.length > 0) {
    load(0);
    startPlayback();
    parts.push(`Now playing: ${queue[0].title}.`);
  }
  announce(parts.join(' '));
}

function removeTrack(index) {
  const [removed] = queue.splice(index, 1);
  if (index === current) {
    if (queue.length === 0) {
      stopAndUnload();
    } else {
      const wasPlaying = !audio.paused;
      load(Math.min(index, queue.length - 1));
      if (wasPlaying) startPlayback();
    }
  } else if (index < current) {
    current--;
  }
  renderQueue();
  announce(`Removed ${removed.title}. ${queue.length} track${queue.length === 1 ? '' : 's'} left.`);

  // Put focus somewhere sensible now that the button is gone.
  const target = queue[Math.min(index, queue.length - 1)];
  if (target) focusQueueButton(target.id, 'play');
  else els.addFiles.focus();
}

function moveTrack(index, delta) {
  const to = index + delta;
  const track = queue[index];
  if (to < 0 || to >= queue.length) {
    announce(`${track.title} is already ${delta < 0 ? 'first' : 'last'}.`);
    return;
  }
  queue.splice(index, 1);
  queue.splice(to, 0, track);
  if (current === index) current = to;
  else if (current === to) current = index;
  renderQueue();
  focusQueueButton(track.id, delta < 0 ? 'up' : 'down');
  announce(`Moved ${track.title} to position ${to + 1} of ${queue.length}.`);
}

function clearQueue() {
  if (queue.length === 0) return announce('The queue is already empty.');
  stopAndUnload();
  queue = [];
  renderQueue();
  announce('Queue cleared.');
}

function focusQueueButton(id, role) {
  const btn = els.queueList.querySelector(`[data-id="${id}"][data-role="${role}"]`);
  if (btn) btn.focus();
}

function makeButton(role, id, label, text, className, tip) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  if (tip) b.dataset.tip = tip;
  b.dataset.role = role;
  b.dataset.id = String(id);
  if (label) b.setAttribute('aria-label', label);
  b.textContent = text;
  return b;
}

function renderQueue() {
  const frag = document.createDocumentFragment();
  queue.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    const isCurrent = i === current;
    if (isCurrent) li.setAttribute('aria-current', 'true');

    const play = makeButton('play', track.id, null, '', 'queue-play', trackTip(isCurrent));
    const num = document.createElement('span');
    num.className = 'queue-num';
    num.textContent = `${i + 1}.`;
    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = track.title;
    play.append(num, ' ', title);
    if (isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'queue-tag';
      tag.textContent = audio.paused ? ' (current, paused)' : ' (now playing)';
      play.append(tag);
    }

    const tools = document.createElement('span');
    tools.className = 'queue-tools';
    tools.append(
      makeButton('up', track.id, `Move ${track.title} up`, '↑', 'queue-tool', 'Move up'),
      makeButton('down', track.id, `Move ${track.title} down`, '↓', 'queue-tool', 'Move down'),
      makeButton('remove', track.id, `Remove ${track.title}`, '✕', 'queue-tool queue-remove', 'Remove from queue'),
    );
    li.append(play, tools);
    frag.append(li);
  });
  els.queueList.replaceChildren(frag);
  els.queueEmpty.hidden = queue.length > 0;
  els.queueCount.textContent = queue.length ? `(${queue.length} track${queue.length === 1 ? '' : 's'})` : '';
  refreshTip();
}

function trackTip(isCurrent) {
  if (!isCurrent) return 'Play this track';
  return audio.paused ? 'Resume this track' : 'Pause this track';
}

els.queueList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-role]');
  if (!btn) return;
  const index = queue.findIndex((t) => String(t.id) === btn.dataset.id);
  if (index === -1) return;
  wakeAudio();
  switch (btn.dataset.role) {
    case 'play':
      if (index === current) togglePlay();
      else playIndex(index);
      break;
    case 'up': moveTrack(index, -1); break;
    case 'down': moveTrack(index, 1); break;
    case 'remove': removeTrack(index); break;
  }
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function updateNowPlaying() {
  if (current === -1) {
    els.nowTitle.textContent = 'Nothing playing';
    els.nowMeta.textContent = queue.length
      ? 'Press Play to start the queue.'
      : 'Add audio files or a playlist to get started.';
    document.title = 'AD Player';
    return;
  }
  const t = queue[current];
  els.nowTitle.textContent = t.title;
  els.nowMeta.textContent = `Track ${current + 1} of ${queue.length}`;
  document.title = `${t.title} – AD Player`;
}

function updatePlayButton() {
  const playing = !audio.paused;
  els.playLabel.textContent = playing ? 'Pause' : 'Play';
  els.play.dataset.tip = playing ? 'Pause playback' : 'Start or resume playback';
  els.play.classList.toggle('is-playing', playing);
  refreshTip();
}

function updateTime() {
  const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
  const pos = current === -1 ? 0 : audio.currentTime;
  els.timeCurrent.textContent = clock(pos);
  els.timeTotal.textContent = clock(dur);
  if (!seeking) {
    els.seek.max = String(Math.floor(dur));
    els.seek.value = String(Math.floor(pos));
  }
  // Only touch aria-valuetext when the spoken second changes.
  const sec = Math.floor(pos);
  if (sec !== lastSpokenSecond || current === -1) {
    lastSpokenSecond = sec;
    els.seek.setAttribute('aria-valuetext', current === -1
      ? 'No track loaded'
      : `${spoken(pos)} of ${spoken(dur)}`);
  }
}

// ---------------------------------------------------------------------------
// Media Session (hardware media keys, lock screen, headset buttons)
// ---------------------------------------------------------------------------

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = current === -1 ? null
    : new MediaMetadata({ title: queue[current].title, artist: '', album: 'AD Player' });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* some browsers reject during loading */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => { if (audio.paused) togglePlay(); },
    pause: () => { if (!audio.paused) togglePlay(); },
    previoustrack: previous,
    nexttrack: next,
    seekbackward: (d) => seekBy(-(d.seekOffset || SKIP_SECONDS)),
    seekforward: (d) => seekBy(d.seekOffset || SKIP_SECONDS),
    seekto: (d) => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
  }
}

// ---------------------------------------------------------------------------
// Audio element events
// ---------------------------------------------------------------------------

audio.addEventListener('play', () => {
  updatePlayButton();
  renderQueueTag();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  updatePlayButton();
  renderQueueTag();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('loadedmetadata', () => { updateTime(); updatePositionState(); });
audio.addEventListener('durationchange', updateTime);
audio.addEventListener('timeupdate', updateTime);
audio.addEventListener('seeked', updatePositionState);
audio.addEventListener('ended', () => {
  if (current < queue.length - 1) {
    playIndex(current + 1);
  } else {
    announce('End of queue.');
    updatePlayButton();
  }
});
audio.addEventListener('error', () => {
  if (current === -1 || !audio.getAttribute('src')) return;
  const bad = queue[current];
  const code = audio.error && audio.error.code;
  const why = code === 4 ? 'its format is not supported by this browser' : 'the file could not be read';
  if (current < queue.length - 1) {
    const nextIndex = current + 1;
    announce(`Could not play ${bad.title} because ${why}. Skipping to ${queue[nextIndex].title}.`);
    setTimeout(() => {
      load(nextIndex);
      startPlayback();
    }, 0);
  } else {
    announce(`Could not play ${bad.title} because ${why}.`);
  }
});

// Updates just the "(now playing)/(paused)" tag without rebuilding the list,
// so focus inside the queue isn't disturbed.
function renderQueueTag() {
  const tag = els.queueList.querySelector('[aria-current="true"] .queue-tag');
  if (tag) tag.textContent = audio.paused ? ' (current, paused)' : ' (now playing)';
  const btn = els.queueList.querySelector('[aria-current="true"] .queue-play');
  if (btn) btn.dataset.tip = trackTip(true);
  refreshTip();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

els.play.addEventListener('click', togglePlay);
els.prev.addEventListener('click', previous);
els.next.addEventListener('click', next);
els.back.addEventListener('click', () => seekBy(-SKIP_SECONDS));
els.fwd.addEventListener('click', () => seekBy(SKIP_SECONDS));

els.seek.addEventListener('keydown', (e) => {
  const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
  if (!(e.key in steps)) return;
  e.preventDefault();
  if (current === -1 || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(Math.max(audio.currentTime + steps[e.key], 0), audio.duration);
  updateTime();
});
els.seek.addEventListener('input', () => {
  seeking = true;
  if (current === -1) return;
  audio.currentTime = Number(els.seek.value);
  updateTime();
});
els.seek.addEventListener('change', () => { seeking = false; updateTime(); });
els.seek.addEventListener('pointerup', () => { seeking = false; });
els.seek.addEventListener('blur', () => { seeking = false; });

function applyVolume() {
  const v = Number(els.volume.value);
  els.volume.setAttribute('aria-valuetext', `${v} percent`);
  els.volumeValue.textContent = `${v}%`;
  if (volumeNode) volumeNode.gain.setTargetAtTime(volumeToGain(v), ctx.currentTime, 0.02);
  else audio.volume = volumeToGain(v);
  try { localStorage.setItem('ad-player-volume', String(v)); } catch { /* storage unavailable */ }
}
els.volume.addEventListener('input', applyVolume);

els.volumeReset.addEventListener('click', () => {
  if (Number(els.volume.value) === DEFAULT_VOLUME) {
    announce(`Volume is already at the default of ${DEFAULT_VOLUME} percent.`);
    return;
  }
  els.volume.value = String(DEFAULT_VOLUME);
  applyVolume();
  announce(`Volume reset to ${DEFAULT_VOLUME} percent.`);
});

els.addFiles.addEventListener('click', () => { wakeAudio(); els.fileInput.click(); });
els.addFolder.addEventListener('click', () => { wakeAudio(); els.folderInput.click(); });
els.clear.addEventListener('click', clearQueue);
for (const input of [els.fileInput, els.folderInput]) {
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = ''; // so picking the same files again still fires "change"
    await addFiles(files);
  });
}

// Drag and drop anywhere on the page.
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    e.preventDefault();
    document.body.classList.add('is-dragging');
  }
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('is-dragging');
});
document.addEventListener('drop', (e) => {
  document.body.classList.remove('is-dragging');
  if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
  e.preventDefault();
  wakeAudio();
  addFiles(e.dataTransfer.files);
});

// The folder picker isn't available on iPhone and iPad.
if (!('webkitdirectory' in els.folderInput)) els.addFolder.hidden = true;

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

try {
  const saved = localStorage.getItem('ad-player-volume');
  if (saved !== null && !Number.isNaN(Number(saved))) els.volume.value = saved;
} catch { /* storage unavailable */ }

setUpAudioGraph();
applyVolume();
updatePlayButton();
updateNowPlaying();
renderQueue();
