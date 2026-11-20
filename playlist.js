// File sorting and M3U playlist handling.

export const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'm4b', 'aac', 'mp4', 'wav', 'wave', 'flac', 'ogg', 'oga',
  'opus', 'webm', 'weba', 'aif', 'aiff', 'caf', 'alac',
];
export const PLAYLIST_EXTENSIONS = ['m3u', 'm3u8'];

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isPlaylist(file) {
  return PLAYLIST_EXTENSIONS.includes(extensionOf(file.name));
}

export function isAudio(file) {
  if (isPlaylist(file)) return false;
  if (AUDIO_EXTENSIONS.includes(extensionOf(file.name))) return true;
  return typeof file.type === 'string' && file.type.startsWith('audio/');
}

// "Artist - Song.mp3" -> "Artist - Song"
export function titleFromName(name) {
  const base = basename(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function basename(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

// Path of a picked file. Files picked from a folder carry their path inside it.
function pathOf(file) {
  return file.webkitRelativePath || file.name;
}

// Turns any path an M3U might contain into lower-case, forward-slash form
// with "." and ".." resolved. Drive letters and file:// prefixes are dropped.
export function normalizePath(path) {
  let p = path.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(localhost)?/i, '');
    try { p = decodeURIComponent(p); } catch { /* leave as is */ }
  }
  p = p.replace(/\\/g, '/').replace(/^\/?[a-zA-Z]:\//, '/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/').toLowerCase();
}

// Decodes playlist text. .m3u8 is UTF-8; older .m3u files are often
// Windows-1252, so fall back to that when the bytes aren't valid UTF-8.
export async function readPlaylistText(file) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// Returns [{ location, title }] in playlist order.
export function parseM3U(text) {
  const entries = [];
  let pendingTitle = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (m && m[1].trim()) pendingTitle = m[1].trim();
      continue;
    }
    entries.push({ location: line, title: pendingTitle });
    pendingTitle = null;
  }
  return entries;
}

function isRemote(location) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) && !/^file:\/\//i.test(location);
}

/*
 * Sorts picked files into queue entries.
 *
 * If any playlists were picked, only the tracks they list are queued, in their
 * order. Each entry is matched to a picked audio file by its path relative to
 * the playlist (when a folder was picked), then by its full path, then by
 * file name alone. With no playlist, every audio file is queued, sorted by path.
 *
 * Returns { tracks: [{ file, title }], report } where report counts what was
 * skipped so it can be announced.
 */
export async function buildTracks(fileList) {
  const files = Array.from(fileList);
  const playlists = files.filter(isPlaylist);
  const audio = files.filter(isAudio);
  const report = {
    playlists: playlists.length,
    missing: [],      // playlist entries with no matching picked file
    remote: 0,        // web URLs in playlists (not supported)
    unused: 0,        // picked audio files that no playlist listed
    ignored: files.length - playlists.length - audio.length, // not audio
  };

  if (playlists.length === 0) {
    const sorted = audio.slice().sort((a, b) =>
      pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: 'base' }));
    return { tracks: sorted.map((file) => ({ file, title: titleFromName(file.name) })), report };
  }

  const byPath = new Map();
  const byName = new Map();
  for (const file of audio) {
    const full = normalizePath(pathOf(file));
    if (!byPath.has(full)) byPath.set(full, file);
    const name = file.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, file);
  }

  const tracks = [];
  const used = new Set();
  playlists.sort((a, b) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true }));
  for (const pl of playlists) {
    const plPath = pathOf(pl);
    const plDir = plPath.includes('/') ? plPath.slice(0, plPath.lastIndexOf('/') + 1) : '';
    const entries = parseM3U(await readPlaylistText(pl));
    for (const entry of entries) {
      if (isRemote(entry.location)) { report.remote++; continue; }
      const loc = entry.location;
      const isAbsolute = /^(\/|\\|[a-zA-Z]:[\\/]|file:)/i.test(loc);
      let file = null;
      if (!isAbsolute) file = byPath.get(normalizePath(plDir + loc));
      if (!file) file = byPath.get(normalizePath(loc));
      if (!file) {
        const name = normalizePath(loc).split('/').pop();
        file = byName.get(name);
      }
      if (!file) { report.missing.push(entry.title || loc); continue; }
      used.add(file);
      tracks.push({ file, title: entry.title || titleFromName(file.name) });
    }
  }
  report.unused = audio.filter((f) => !used.has(f)).length;
  return { tracks, report };
}
