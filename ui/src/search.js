import MiniSearch from 'minisearch'
import { MS_OPTIONS, MIN_QUERY } from './searchConfig.js'

let mini = null

const BASE = import.meta.env.BASE_URL // './' in the built site

export async function loadData() {
  const [idxText, videos, speakers, meta] = await Promise.all([
    fetch(`${BASE}search-index.json`).then((r) => r.text()),
    fetch(`${BASE}videos.json`).then((r) => r.json()),
    fetch(`${BASE}speakers.json`).then((r) => r.json()).catch(() => ({ global_speakers: {} })),
    fetch(`${BASE}meta.json`).then((r) => r.json()).catch(() => ({})),
  ])
  mini = MiniSearch.loadJSON(idxText, MS_OPTIONS)
  return { videos, speakers, meta }
}

// returns ranked results; empty array if query too short. `opts` overrides the
// default search options (e.g. {prefix:false, fuzzy:false} for exact matching).
export function search(query, { langs, globals, videoId } = {}, limit = 500, opts = null) {
  if (!query || query.trim().length < MIN_QUERY) return { hits: [], total: 0 }
  const filter = (r) =>
    (!langs?.size || langs.has(r.lang)) &&
    (!globals?.size || globals.has(r.global)) &&
    (!videoId || r.videoId === videoId)
  const all = mini.search(query.trim(), { ...(opts || MS_OPTIONS.searchOptions), filter })
  return { hits: all.slice(0, limit), total: all.length }
}

export function clipUrl(file) { return `${BASE}clips/${file}` }

// all videos + sentences, chronological, for the timeline view (one fetch)
export async function loadTimeline() {
  const r = await fetch(`${BASE}timeline-data.json`)
  if (!r.ok) throw new Error(`timeline ${r.status}`)
  return r.json()
}
