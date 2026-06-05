// Favorited sentences (by "videoId:idx"), stored locally in the browser.
const KEY = 'transcript-ui.favorites.v1'
let favs = load()

function load() {
  try { const r = localStorage.getItem(KEY); return Array.isArray(JSON.parse(r)) ? JSON.parse(r) : [] }
  catch { return [] }
}
function persist() { localStorage.setItem(KEY, JSON.stringify(favs)) }

export function list() { return favs }
export function has(sid) { return favs.includes(sid) }
export function toggle(sid) {
  const i = favs.indexOf(sid)
  if (i >= 0) favs.splice(i, 1); else favs.push(sid)
  persist()
  return i < 0   // true if now favorited
}
export function remove(sid) { const i = favs.indexOf(sid); if (i >= 0) { favs.splice(i, 1); persist() } }
export function exportFavs() { return JSON.stringify({ version: 1, favorites: favs }, null, 2) }
export function importFavs(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json
  favs = Array.isArray(o) ? o : (o.favorites || [])
  persist()
  return favs
}
