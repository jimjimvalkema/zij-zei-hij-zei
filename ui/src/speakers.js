// Speaker name tags, stored locally in the browser. Names are an overlay on top
// of the (anonymous) GLOBAL_xx / SPEAKER_xx ids — the index never stores them.
const KEY = 'transcript-ui.speaker-tags.v1'

// shape: { globals: {GLOBAL_00: "Felix"}, overrides: {videoId: {SPEAKER_01: "friend"}} }
let tags = load()

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return normalize(JSON.parse(raw))
  } catch { /* ignore */ }
  return { globals: {}, overrides: {} }
}

function normalize(o) {
  return { globals: o.globals || {}, overrides: o.overrides || {} }
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(tags))
}

export function getTags() { return tags }

export function setGlobalName(globalId, name) {
  name = (name || '').trim()
  if (name) tags.globals[globalId] = name
  else delete tags.globals[globalId]
  persist()
}

export function setOverride(videoId, speaker, name) {
  name = (name || '').trim()
  tags.overrides[videoId] ||= {}
  if (name) tags.overrides[videoId][speaker] = name
  else delete tags.overrides[videoId][speaker]
  if (!Object.keys(tags.overrides[videoId]).length) delete tags.overrides[videoId]
  persist()
}

// resolve a display name: per-video override > global name > raw global id > local id
export function resolveName(videoId, speaker, globalId) {
  const ov = tags.overrides[videoId]?.[speaker]
  if (ov) return ov
  if (globalId && tags.globals[globalId]) return tags.globals[globalId]
  return globalId || speaker
}

export function exportTags() {
  return JSON.stringify({ version: 1, ...tags }, null, 2)
}

export function importTags(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json
  tags = normalize(o)
  persist()
  return tags
}
