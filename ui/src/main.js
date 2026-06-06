import './style.css'
import { loadData, loadTimeline, loadComments, search, clipUrl } from './search.js'
import { MIN_QUERY } from './searchConfig.js'
import * as spk from './speakers.js'
import * as fav from './favorites.js'

let DATA = { videos: {}, speakers: { global_speakers: {} }, meta: {} }
let ITEMS = []        // timeline videos (chronological) with date parts
let ITEMS_BY_ID = {}
let matches = null    // Map videoId -> Map(idx -> Set(matchedLang)), or null when no filter
let metaMatches = new Map()   // videoId -> { title, desc, comments:Set(cidx) } (title/desc/comment hits)
let textQueryActive = false   // only highlight when there's a real search term (not just a toggle)
let tlBlocks = []     // current .tl-vid elements (for scroll-spy)
let activeKey = null
let spyTick = false
let regexError = null
const state = { query: '', speaker: '', lang: '', localSpeaker: null, showRest: false, exact: false, regex: false, searchComments: true }

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ytLink = (vid, start) => `https://www.youtube.com/watch?v=${vid}&t=${Math.floor(start || 0)}s`
const thumbUrl = (vid) => `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function dateParts(ud) {
  if (!ud || ud.length < 8) return null
  const y = +ud.slice(0, 4), mo = +ud.slice(4, 6), d = +ud.slice(6, 8)
  return (y && mo && d) ? { y, mo, d, date: new Date(Date.UTC(y, mo - 1, d)) } : null
}
function isoWeek(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3)
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)
}
const prettyDate = (ud) => { const p = dateParts(ud); return p ? `${p.d} ${MONTHS[p.mo - 1].slice(0, 3)} ${p.y}` : '' }
// well-separated hue per speaker (golden angle on the speaker number)
function hueFor(s) {
  const m = String(s).match(/(\d+)/)
  const n = m ? +m[1] : [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0)
  return Math.round((n * 137.508) % 360)
}
// language versions of a segment (single-language segments => one entry)
const segVersions = (s) => s.versions || (s.text != null ? { [s.lang || 'und']: s.text } : {})
const blockLang = new Map()   // blockKey -> manually chosen display language

// ---- init ----
init()
async function init() {
  try {
    const [d, tl] = await Promise.all([loadData(), loadTimeline()])
    DATA = d
    ITEMS = tl.map((v) => {
      const p = dateParts(v.upload_date)
      return { ...v, y: p ? p.y : 'Undated', mo: p ? p.mo : 0, wk: p ? isoWeek(p.date) : 0, date: p ? p.date : null }
    })
    ITEMS_BY_ID = Object.fromEntries(ITEMS.map((v) => [v.id, v]))
  } catch (e) {
    $('#tl-main').innerHTML = `<p class="loading pad">Couldn't load data — did you run <code>yarn index</code>?<br><small>${esc(String(e))}</small></p>`
    return
  }
  const segCount = DATA.meta.segmentCount ?? ITEMS.reduce((a, v) => a + v.segments.length, 0)
  $('#count').textContent = `${segCount} sentences · ${ITEMS.length} videos`
  renderSpeakers()
  refreshSpeakerSelect()
  refreshLangFilter()
  renderFavorites()
  wireEvents()
  render()
  gotoShared()   // jump to a shared sentence if the URL has one
}

// speaker filter dropdown, labelled with current names
function refreshSpeakerSelect() {
  const sel = $('#f-speaker'); if (!sel) return
  const cur = sel.value
  const gs = DATA.speakers.global_speakers || {}
  const opts = Object.keys(gs).sort().map((g) => {
    const name = spk.getTags().globals[g]
    return `<option value="${esc(g)}">${esc(name ? `${name} (${g})` : g)}</option>`
  }).join('')
  sel.innerHTML = `<option value="">all speakers</option>${opts}`
  sel.value = cur
}

// combined selection -> Map videoId -> Map(segmentIndex -> Set(matchedLang)).
// null when no filter is active.
function computeSelection() {
  regexError = null
  metaMatches = new Map()
  const spkSel = state.speaker, langSel = state.lang, locSel = state.localSpeaker
  const textActive = state.regex ? state.query.length >= 1 : state.query.trim().length >= MIN_QUERY
  textQueryActive = textActive
  if (!textActive && !spkSel && !langSel && !locSel) return null

  const m = new Map()
  const add = (vid, idx, lang) => {
    let mp = m.get(vid); if (!mp) { mp = new Map(); m.set(vid, mp) }
    let s = mp.get(idx); if (!s) { s = new Set(); mp.set(idx, s) }
    if (lang) s.add(lang)
  }
  const addMeta = (vid, kind, cidx) => {
    let e = metaMatches.get(vid); if (!e) { e = { comments: new Set() }; metaMatches.set(vid, e) }
    if (kind === 'title') e.title = true
    else if (kind === 'description') e.desc = true
    else if (kind === 'comment') e.comments.add(cidx)
  }

  if (textActive && state.regex) {
    let re
    try { re = new RegExp(state.query, 'i') } catch (e) { regexError = e.message; return new Map() }
    for (const v of ITEMS) v.segments.forEach((s, idx) => {
      for (const [L, t] of Object.entries(segVersions(s))) if (re.test(t)) add(v.id, idx, L)
    })
    // regex also covers title + description (not comments — those are lazy files)
    for (const [vid, info] of Object.entries(DATA.videos)) {
      if (info.title && re.test(info.title)) addMeta(vid, 'title')
      if (info.description && re.test(info.description)) addMeta(vid, 'description')
    }
    if (spkSel) intersectSpeaker(m, spkSel)
    if (locSel) intersectLocalSpeaker(m, locSel)
    if (langSel) intersectLang(m, langSel)
  } else if (textActive) {
    const opts = state.exact ? { prefix: false, fuzzy: false, combineWith: 'AND' } : null
    for (const r of search(state.query.trim(), {}, 1e6, opts).hits) {
      if (!r.kind || r.kind === 'sentence') add(r.videoId, r.idx, r.lang)
      else if (r.kind === 'comment') { if (state.searchComments) addMeta(r.videoId, 'comment', r.cidx) }
      else addMeta(r.videoId, r.kind, r.cidx)   // title / description always
    }
    if (spkSel) intersectSpeaker(m, spkSel)
    if (locSel) intersectLocalSpeaker(m, locSel)
    if (langSel) intersectLang(m, langSel)
  } else {                                     // no text query: filter by speaker and/or language
    for (const v of ITEMS) v.segments.forEach((s, idx) => {
      if (spkSel && s.global !== spkSel) return
      if (locSel && (v.id !== locSel.vid || s.speaker !== locSel.local)) return
      if (langSel && s.lang !== langSel) return   // s.lang = most-confident language
      add(v.id, idx, s.lang)
    })
  }
  if (spkSel || langSel || locSel) metaMatches = new Map()   // metadata isn't speaker/language specific
  return m
}

// highlight regex for the current query (g-flagged), or null
function currentRe() {
  const q = state.query.trim()
  if (!q) return null
  try {
    if (state.regex) return new RegExp(state.query, 'gi')
    const words = q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return words.length ? new RegExp(`(${words.join('|')})`, 'gi') : null
  } catch { return null }
}
// escape + wrap query matches in <mark>
function hl(text) {
  const re = currentRe()
  if (!re) return esc(text)
  let out = '', last = 0, m
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'
    last = m.index + m[0].length
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out + esc(text.slice(last))
}

function intersectSpeaker(m, spkSel) {
  for (const [vid, mp] of [...m]) {
    const segs = ITEMS_BY_ID[vid]?.segments || []
    for (const idx of [...mp.keys()]) if (segs[idx]?.global !== spkSel) mp.delete(idx)
    if (!mp.size) m.delete(vid)
  }
}
// keep only this one video's segments spoken by a specific local (per-video) speaker
function intersectLocalSpeaker(m, locSel) {
  for (const [vid, mp] of [...m]) {
    if (vid !== locSel.vid) { m.delete(vid); continue }
    const segs = ITEMS_BY_ID[vid]?.segments || []
    for (const idx of [...mp.keys()]) if (segs[idx]?.speaker !== locSel.local) mp.delete(idx)
    if (!mp.size) m.delete(vid)
  }
}
function intersectLang(m, langSel) {
  for (const [vid, mp] of [...m]) {
    const segs = ITEMS_BY_ID[vid]?.segments || []
    for (const idx of [...mp.keys()]) if (segs[idx]?.lang !== langSel) mp.delete(idx)   // s.lang = most-confident
    if (!mp.size) m.delete(vid)
  }
}
// language filter dropdown (only shown when the archive has >1 language)
function refreshLangFilter() {
  const sel = $('#f-lang'); if (!sel) return
  const langs = DATA.meta.languages || []
  if (langs.length < 2) { sel.hidden = true; return }
  sel.hidden = false
  const cur = sel.value
  sel.innerHTML = `<option value="">all languages</option>` + langs.map((l) => `<option value="${esc(l)}">${esc(l)} only</option>`).join('')
  sel.value = cur
}

// videos to render: entire archive when no filter or when "show entire archive"
// is on; otherwise only the videos that contain a selection.
const shownItems = () => {
  if (!matches || state.showRest) return ITEMS
  return ITEMS.filter((v) => matches.has(v.id) || metaMatches.has(v.id))
}

function render() {
  matches = computeSelection()
  if (!matches) state.showRest = false
  const items = shownItems()
  buildNav(items)
  $('#tl-main').innerHTML = buildMain(items)
  tlBlocks = [...document.querySelectorAll('.tl-vid')]
  setupLazy()

  const sr = $('#show-rest'), status = $('#tl-status')
  status.classList.toggle('err', !!regexError)
  if (regexError) {
    status.textContent = `⚠ bad regex: ${regexError}`
    sr.hidden = false
    sr.textContent = state.showRest ? 'Only matches' : 'Show all'
  } else if (matches) {
    const total = [...matches.values()].reduce((a, s) => a + s.size, 0)
    const count = total
      ? `${total} sentence${total === 1 ? '' : 's'} · ${matches.size} video${matches.size === 1 ? '' : 's'}`
      : 'no matches'
    const loc = state.localSpeaker
    if (loc) {
      const nm = esc(spk.resolveName(loc.vid, loc.local, loc.global) || loc.local)
      const t = esc(DATA.videos[loc.vid]?.title || loc.vid)
      status.innerHTML = `${esc(count)} <span class="filt-chip" title="${t}">${nm} in this video <button class="clear-local" title="clear this filter">×</button></span>`
    } else {
      status.textContent = count
    }
    sr.hidden = false
    sr.textContent = state.showRest ? 'Only matches' : 'Show all'
  } else {
    status.textContent = ''
    sr.hidden = true
  }
  activeKey = null
  spy()
  for (const [vid, mm] of metaMatches) if (mm.comments && mm.comments.size) openComments(vid, true)
}

// which sentences of a video are shown under the current filter (with .idx kept)
function segsToShow(v) {
  const all = v.segments.map((s, idx) => ({ ...s, idx }))
  if (!matches || state.showRest) return all
  const mset = matches.get(v.id)
  return all.filter((s) => mset?.has(s.idx))
}

function buildMain(items) {
  const gapTier = (days) => (days <= 1 ? 1 : days <= 7 ? 2 : days <= 31 ? 3 : 4)
  let html = '<div class="tl-track">', cy = null, cym = null, cymw = null, prev = null
  for (const v of items) {
    const segs = segsToShow(v)
    if (!segs.length && !metaMatches.has(v.id)) continue   // keep metadata-only matches
    if (v.y !== cy) { cy = v.y; cym = cymw = null; html += `<div class="mk mk-year">${esc(String(v.y))}</div>` }
    const ym = `${v.y}-${v.mo}`
    if (ym !== cym) { cym = ym; cymw = null; html += `<div class="mk mk-month">${v.mo ? esc(MONTHS[v.mo - 1]) : 'Undated'}</div>` }
    const ymw = `${ym}-${v.wk}`
    if (ymw !== cymw) { cymw = ymw; if (v.wk) html += `<div class="mk mk-week">week ${v.wk}</div>` }
    let tier = 1
    if (prev && v.date) tier = gapTier((v.date - prev) / 86400000)
    if (v.date) prev = v.date
    // title / description / comments under the header
    const vm = DATA.videos[v.id] || {}
    const mm = metaMatches.get(v.id)
    const titleHtml = mm?.title ? hl(v.title || v.id) : esc(v.title || v.id)
    const desc = vm.description || ''
    const descHtml = desc
      ? `<div class="vdesc${mm?.desc ? ' open' : ''}">${mm?.desc ? hl(desc) : esc(desc)}</div>` +
        (desc.length > 140 ? `<button class="more" data-act="desc">read more</button>` : '')
      : ''
    const cc = vm.commentCount || 0
    const cmtBtn = cc ? `<button class="cmt-toggle" data-vid="${esc(v.id)}">💬 ${cc} comment${cc === 1 ? '' : 's'}</button>` : ''
    const vmeta = (descHtml || cmtBtn)
      ? `<div class="vmeta">${descHtml}${cmtBtn}<div class="cmts" data-vid="${esc(v.id)}"></div></div>` : ''

    // sentences are rendered lazily (see fillBlock); reserve approx height to limit scroll jump
    html += `<article class="tl-vid gap-${tier}" id="v-${esc(v.id)}" data-y="${v.y}" data-mo="${v.mo}" data-wk="${v.wk}">
      <span class="tl-node"></span>
      <div class="tl-body">
        <div class="tl-vh">
          <a class="tl-title" href="${ytLink(v.id, 0)}" target="_blank" rel="noopener">${titleHtml}</a>
          <button class="share-vid" data-vid="${esc(v.id)}" title="copy a link to this video" aria-label="copy link to video">🔗</button>
          <span class="tl-date">${esc(prettyDate(v.upload_date))}</span>
        </div>
        ${vmeta}
        ${segs.length
          ? `<div class="tl-sentences" data-vid="${esc(v.id)}" style="min-height:${segs.length * 24}px"></div>`
          : `<div class="tl-note">matched in title / description / comments — <button class="show-vid" data-vid="${esc(v.id)}">show transcript ↓</button></div>`}
      </div>
      <img class="thumb" loading="lazy" alt="" width="140" height="79" src="${thumbUrl(v.id)}" onerror="this.style.visibility='hidden'" />
    </article>`
  }
  return html + '</div>'
}

// lazy-render each video's sentences as it nears the viewport
let lazyIO = null
function setupLazy() {
  if (lazyIO) lazyIO.disconnect()
  lazyIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { lazyIO.unobserve(e.target); fillBlock(e.target) }
  }, { rootMargin: '800px 0px' })
  document.querySelectorAll('.tl-sentences[data-vid]').forEach((el) => lazyIO.observe(el))
}
function fillBlock(el) {
  if (el.dataset.filled || !el.dataset.vid) return
  const v = ITEMS_BY_ID[el.dataset.vid]; if (!v) return
  el.innerHTML = sentencesHtml(v.id, segsToShow(v), matches ? matches.get(v.id) : null)
  el.style.minHeight = ''
  el.dataset.filled = '1'
}
function fillBlockForVid(vid) {
  const el = document.querySelector(`.tl-sentences[data-vid="${CSS.escape(vid)}"]`)
  if (el) fillBlock(el)
}

// after a filter/search change the result set changes, so go to the top
function afterFilter() { window.scrollTo({ top: 0 }) }

// mobile: show Favorites / Speakers as a full page (one at a time)
function togglePage(which) {
  const cls = which + '-page'
  const on = !document.body.classList.contains(cls)
  document.body.classList.remove('speakers-page', 'favorites-page')
  if (on) document.body.classList.add(cls)
  syncPageButtons()
  window.scrollTo({ top: 0 })
}
function showSpeakersPage() { document.body.classList.remove('favorites-page'); document.body.classList.add('speakers-page'); syncPageButtons() }
function syncPageButtons() {
  $('#label-speakers').textContent = document.body.classList.contains('speakers-page') ? 'Back to timeline' : 'Label speakers'
  $('#show-favorites').textContent = document.body.classList.contains('favorites-page') ? 'Back to timeline' : '★ Favorites'
}
function downloadJSON(text, name) {
  const blob = new Blob([text], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  URL.revokeObjectURL(a.href)
}

// favorites list (left panel / mobile page)
function renderFavorites() {
  const box = $('#fav-list'); if (!box) return
  const items = fav.list()
  if (!items.length) { box.innerHTML = `<p class="hint">Click the ★ on any sentence to save it here.</p>`; return }
  box.innerHTML = items.map((sid) => {
    const k = sid.lastIndexOf(':'); const vid = sid.slice(0, k), idx = +sid.slice(k + 1)
    const v = ITEMS_BY_ID[vid]; const s = v?.segments[idx]
    const text = s ? (s.text || Object.values(segVersions(s))[0] || '') : '(missing)'
    const title = DATA.videos[vid]?.title || vid
    return `<div class="fav">
      <button class="fav-go" data-sid="${esc(sid)}" title="jump to this sentence">${esc(text.slice(0, 100))}</button>
      <div class="fav-meta"><span title="${esc(title)}">${esc(title)}</span><button class="share" data-share="${esc(sid)}" title="copy a link to this sentence" aria-label="copy link to sentence">🔗</button><button class="fav-x" data-fav="${esc(sid)}" title="remove from favorites">×</button></div>
    </div>`
  }).join('')
}

// load + render a video's comments (lazy); `force` opens without toggling
async function openComments(vid, force) {
  const box = document.querySelector(`.cmts[data-vid="${CSS.escape(vid)}"]`)
  if (!box) return
  if (box.dataset.loaded) { box.classList[force ? 'add' : 'toggle']('open'); return }
  box.dataset.loaded = '1'; box.classList.add('open')
  box.innerHTML = '<div class="cmt loading">loading…</div>'
  let comments = []
  try { comments = await loadComments(vid) } catch {}
  const mm = metaMatches.get(vid)
  box.innerHTML = comments.map((c) =>
    `<div class="cmt"><span class="cmt-a">${esc(c.author)}</span> ${hl(c.text)}</div>`
  ).join('') || '<div class="cmt loading">(no comments)</div>'
}

// consecutive same-speaker sentences -> one boxed turn (coloured by local speaker,
// labelled with the global id). The matched query term is highlighted inline.
function sentencesHtml(vid, segs, mset) {
  const matchedLang = (idx) => { const s = mset?.get(idx); return s && s.size ? [...s][0] : null }
  const out = []
  for (let i = 0; i < segs.length;) {
    const key = segs[i].speaker, g = segs[i].global
    const bseg = []
    while (i < segs.length && segs[i].speaker === key) bseg.push(segs[i++])

    // languages available for this block, and which one to display
    const avail = new Set()
    bseg.forEach((s) => Object.keys(segVersions(s)).forEach((L) => avail.add(L)))
    const blockKey = `${vid}:${bseg[0].idx}`
    let displayLang = blockLang.get(blockKey)                            // 1. manual switch
    if (!displayLang) {
      for (const s of bseg) { const ml = matchedLang(s.idx); if (ml) { displayLang = ml; break } }  // 2. matched language
    }
    if (!displayLang) {                                                  // 3. most-confident across the block
      const c = {}; bseg.forEach((s) => { const L = s.lang || 'und'; c[L] = (c[L] || 0) + 1 })
      displayLang = Object.keys(c).sort((a, b) => c[b] - c[a])[0]
    }

    const links = bseg.map((s) => {
      const sid = `${vid}:${s.idx}`
      const text = segVersions(s)[displayLang] ?? s.text ?? ''
      const body = textQueryActive ? hl(text) : esc(text)   // highlight only the actual query term
      return `<span class="sent"><button class="star${fav.has(sid) ? ' on' : ''}" data-fav="${esc(sid)}" title="favorite this sentence" aria-label="favorite sentence">★</button><button class="share" data-share="${esc(sid)}" title="Copy a link to this sentence" aria-label="copy link to sentence">🔗</button><a class="s-txt" data-sid="${esc(sid)}" href="${ytLink(vid, s.start)}" target="_blank" rel="noopener">${body}</a></span>`
    })
    const name = spk.resolveName(vid, key, g), gid = g || key
    const label = name === gid ? `<span class="gid">${esc(gid)}</span>` : `${esc(name)} <span class="gid">${esc(gid)}</span>`
    const loc = `<span class="turn-loc" data-video="${esc(vid)}" data-spk="${esc(key)}" title="click to label this video's ${esc(key)}">${esc(key.replace('SPEAKER_', 'S'))}</span>`
    let switcher = ''
    if (avail.size > 1) {
      switcher = `<span class="langsw">` + [...avail].sort().map((L) =>
        `<button class="lang-btn${L === displayLang ? ' on' : ''}" data-block="${esc(blockKey)}" data-lang="${esc(L)}" title="show this block in ${esc(L)}">${esc(L)}</button>`).join('') + `</span>`
    }
    out.push(`<div class="turn" style="--hue:${hueFor(key)}"><span class="turn-spk" data-global="${esc(g || '')}" title="click to label this speaker (all videos)">${label}</span>${loc}${switcher}${links.join(' ')}</div>`)
  }
  return out.join('') || '<span class="loading">(no speech)</span>'
}

function buildNav(items) {
  const years = {}
  for (const v of items) {
    const Y = (years[v.y] ||= { count: 0, months: {} }); Y.count++
    const M = (Y.months[v.mo] ||= { count: 0, weeks: {} }); M.count++
    const W = (M.weeks[v.wk] ||= { count: 0, first: v.id, vids: [] }); W.count++
    W.vids.push({ id: v.id, title: v.title || DATA.videos[v.id]?.title || v.id })
  }
  $('#tl-nav').innerHTML = Object.keys(years).sort().map((yk) => {
    const Y = years[yk]
    const months = Object.keys(Y.months).map(Number).sort((a, b) => a - b).map((mk) => {
      const M = Y.months[mk]
      const weeks = Object.keys(M.weeks).map(Number).sort((a, b) => a - b).map((wk) => {
        const W = M.weeks[wk]
        // video titles live under each week, collapsed by default so the whole archive
        // of titles isn't dumped on the user at load — expand a week to reveal them.
        const titles = W.vids.map((vd) =>
          `<a class="tl-vid-link" data-target="v-${esc(vd.id)}" title="${esc(vd.title)}">${esc(vd.title)}</a>`).join('')
        return `<details class="tl-wk" data-ymw="${yk}-${mk}-${wk}" data-target="v-${esc(W.first)}"><summary>wk ${wk} <span>(${W.count})</span></summary>${titles}</details>`
      }).join('')
      // months open by default so the tree is expanded down to the week level
      return `<details class="tl-mo" data-ym="${yk}-${mk}" open><summary>${mk ? esc(MONTHS[mk - 1]) : 'Undated'} <span>(${M.count})</span></summary>${weeks}</details>`
    }).join('')
    return `<details class="tl-yr" data-y="${yk}" open><summary>${esc(String(yk))} <span>(${Y.count})</span></summary>${months}</details>`
  }).join('')
  $('#tl-nav').onclick = (e) => {
    const a = e.target.closest('[data-target]')
    if (a) scrollToVideo(a.dataset.target.slice(2))   // data-target is "v-<id>"
  }
}

// ---- scroll spy (current year/month/week) ----
const headOffset = () => (document.querySelector('header')?.offsetHeight || 50) + (document.querySelector('.tl-head')?.offsetHeight || 0)
function spy() {
  const off = headOffset()
  let cur = tlBlocks[0]
  for (const b of tlBlocks) { if (b.getBoundingClientRect().top - off <= 14) cur = b; else break }
  if (!cur) { $('#tl-crumb').innerHTML = ''; return }
  const { y, mo, wk } = cur.dataset, key = `${y}-${mo}-${wk}`
  if (key === activeKey) return
  activeKey = key
  $('#tl-crumb').innerHTML = `<span>${esc(y)}</span><span>${mo > 0 ? esc(MONTHS[mo - 1]) : 'Undated'}</span><span>week ${esc(wk)}</span>`
  const nav = $('#tl-nav')
  nav.querySelectorAll('.active').forEach((el) => el.classList.remove('active'))
  const yEl = nav.querySelector(`.tl-yr[data-y="${y}"]`)
  const mEl = nav.querySelector(`.tl-mo[data-ym="${y}-${mo}"]`)
  const wEl = nav.querySelector(`.tl-wk[data-ymw="${key}"]`)
  if (yEl) { yEl.classList.add('active'); yEl.open = true }
  if (mEl) { mEl.classList.add('active'); mEl.open = true }
  if (wEl) wEl.classList.add('active')
}

// topmost visible matched sentence (one containing a highlighted term) — used as
// a stable anchor across re-renders
function topVisibleHit() {
  const off = headOffset()
  for (const el of document.querySelectorAll('.s-txt')) {
    if (!el.querySelector('mark')) continue
    const top = el.getBoundingClientRect().top
    if (top - off >= -1) return { sid: el.dataset.sid, top }
  }
  return null
}

function wireEvents() {
  let t
  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value
    clearTimeout(t)
    t = setTimeout(() => { blockLang.clear(); render(); afterFilter() }, 160)
  })
  $('#f-speaker').addEventListener('change', (e) => { state.speaker = e.target.value; state.localSpeaker = null; blockLang.clear(); render(); afterFilter() })
  $('#tl-status').addEventListener('click', (e) => { if (e.target.closest('.clear-local')) clearLocalFilter() })
  $('#f-lang').addEventListener('change', (e) => { state.lang = e.target.value; blockLang.clear(); render(); afterFilter() })
  $('#opt-exact').addEventListener('change', (e) => { state.exact = e.target.checked; blockLang.clear(); render(); afterFilter() })
  $('#opt-regex').addEventListener('change', (e) => {
    state.regex = e.target.checked
    $('#opt-exact').disabled = state.regex          // exact is irrelevant in regex mode
    $('#q').placeholder = state.regex ? 'Regular expression… (case-insensitive)' : 'Search everything said… (min 2 chars)'
    blockLang.clear(); render(); afterFilter()
  })
  $('#opt-comments').addEventListener('change', (e) => { state.searchComments = e.target.checked; blockLang.clear(); render(); afterFilter() })
  $('#show-rest').addEventListener('click', () => {
    const anchor = topVisibleHit()          // keep this match visually fixed
    state.showRest = !state.showRest
    render()
    if (anchor) {
      fillBlockForVid(anchor.sid.slice(0, anchor.sid.lastIndexOf(':')))
      const el = document.querySelector(`.s-txt[data-sid="${CSS.escape(anchor.sid)}"]`)
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchor.top)
    }
  })
  window.addEventListener('scroll', () => {
    if (spyTick) return
    spyTick = true
    requestAnimationFrame(() => { spy(); spyTick = false })
  }, { passive: true })
  $('#tl-main').addEventListener('click', (e) => {
    const lng = e.target.closest('.lang-btn')
    if (lng) {
      blockLang.set(lng.dataset.block, lng.dataset.lang)
      const vid = lng.dataset.block.slice(0, lng.dataset.block.lastIndexOf(':'))
      const el = document.querySelector(`.tl-sentences[data-vid="${CSS.escape(vid)}"]`)
      if (el) { el.dataset.filled = ''; fillBlock(el) }
      return
    }
    const more = e.target.closest('.more')
    if (more) {
      const d = more.previousElementSibling
      d?.classList.toggle('open')
      more.textContent = d?.classList.contains('open') ? 'read less' : 'read more'
      return
    }
    const ct = e.target.closest('.cmt-toggle')
    if (ct) { openComments(ct.dataset.vid); return }
    const star = e.target.closest('.star')
    if (star) {
      e.preventDefault()
      star.classList.toggle('on', fav.toggle(star.dataset.fav))
      renderFavorites()
      return
    }
    const sv = e.target.closest('.show-vid')
    if (sv) {                                   // go to this video (updates URL -> shareable)
      location.hash = '#v=' + encodeURIComponent(sv.dataset.vid)
      return
    }
    const svid = e.target.closest('.share-vid')
    if (svid) { e.preventDefault(); copyText(shareUrlVid(svid.dataset.vid), svid); return }
    const loc = e.target.closest('.turn-loc')
    if (loc) { openOverride(loc.dataset.video, loc.dataset.spk); return }
    const lab = e.target.closest('.turn-spk')
    if (lab) { openLabel(lab.dataset.global); return }
    const b = e.target.closest('.share')
    if (b) { e.preventDefault(); copyLink(b) }
  })
  window.addEventListener('hashchange', gotoShared)
  $('#label-speakers').addEventListener('click', () => togglePage('speakers'))
  $('#show-favorites').addEventListener('click', () => togglePage('favorites'))

  // favorites list: jump to a sentence, or remove it
  $('#fav-list').addEventListener('click', (e) => {
    const share = e.target.closest('.share')
    if (share) { e.preventDefault(); copyLink(share); return }
    const go = e.target.closest('.fav-go')
    if (go) { location.hash = '#s=' + encodeURIComponent(go.dataset.sid); return }
    const x = e.target.closest('.fav-x')
    if (x) {
      fav.remove(x.dataset.fav)
      renderFavorites()
      document.querySelector(`.star[data-fav="${CSS.escape(x.dataset.fav)}"]`)?.classList.remove('on')
    }
  })
  $('#fav-export').addEventListener('click', () => downloadJSON(fav.exportFavs(), 'favorites.json'))
  $('#fav-import-btn').addEventListener('click', () => $('#fav-import-file').click())
  $('#fav-import-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return
    try { fav.importFavs(await f.text()); renderFavorites(); render() } catch (err) { alert('Import failed: ' + err) }
    e.target.value = ''
  })

  $('#export').addEventListener('click', onExport)
  $('#import-btn').addEventListener('click', () => $('#import-file').click())
  $('#import-file').addEventListener('change', onImport)
  $('#speakers').addEventListener('change', (e) => {
    if (e.target.classList.contains('gname')) { spk.setGlobalName(e.target.dataset.global, e.target.value); refreshSpeakerSelect(); render() }
    else if (e.target.classList.contains('ov')) { spk.setOverride(e.target.dataset.video, e.target.dataset.spk, e.target.value); render() }
  })
  $('#speakers').addEventListener('click', (e) => {
    const gf = e.target.closest('.g-filter')
    if (gf) { filterByGlobal(gf.dataset.gfilter); return }
    const mf = e.target.closest('.m-filter')
    if (mf) { filterByLocal(mf.dataset.video, mf.dataset.spk, mf.dataset.global); return }
    const b = e.target.closest('.jump')
    if (!b) return
    const sid = firstSidFor(b.dataset.video, b.dataset.spk)
    if (sid) { history.replaceState(null, '', '#s=' + encodeURIComponent(sid)); showSentence(sid) }
  })

  setupResizer()
}

// drag the divider to resize the left (timeline nav) column; width persists locally
const LEFTW_KEY = 'transcript-ui.leftw'
function setLeftWidth(px) {
  const w = Math.max(160, Math.min(560, px))
  document.documentElement.style.setProperty('--leftw', w + 'px')
  return w
}
function setupResizer() {
  const bar = $('#leftcol-resizer'); if (!bar) return
  const saved = +localStorage.getItem(LEFTW_KEY)
  if (saved) setLeftWidth(saved)
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    bar.classList.add('dragging'); document.body.classList.add('col-resizing')
    bar.setPointerCapture(e.pointerId)
    const move = (ev) => setLeftWidth(ev.clientX)
    const up = (ev) => {
      bar.classList.remove('dragging'); document.body.classList.remove('col-resizing')
      bar.releasePointerCapture(e.pointerId)
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up)
      localStorage.setItem(LEFTW_KEY, String(setLeftWidth(ev.clientX)))
    }
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up)
  })
}

// ---- shareable links: #s=<vid:idx> (a sentence) and #v=<vid> (a whole video) ----
const base = () => `${location.origin}${location.pathname}`
const shareUrlSid = (sid) => `${base()}#s=${encodeURIComponent(sid)}`
const shareUrlVid = (vid) => `${base()}#v=${encodeURIComponent(vid)}`

function copyText(url, btn) {
  const ok = () => { const o = btn.textContent; btn.textContent = '✓'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = o; btn.classList.remove('copied') }, 1000) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(ok, () => fallbackCopy(url, ok))
  else fallbackCopy(url, ok)
}
function copyLink(btn) { copyText(shareUrlSid(btn.dataset.share), btn) }
function fallbackCopy(text, cb) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); ta.remove()
    cb && cb()
  } catch { prompt('Copy this link:', text) }
}

// reset filters + leave the label page (shared links open into a clean view)
function clearFilters() {
  document.body.classList.remove('speakers-page', 'favorites-page')
  syncPageButtons()
  Object.assign(state, { query: '', speaker: '', lang: '', localSpeaker: null, showRest: false, exact: false, regex: false })
  for (const sel of ['#q', '#f-speaker', '#f-lang']) { const el = $(sel); if (el) el.value = '' }
  const ex = $('#opt-exact'); if (ex) { ex.checked = false; ex.disabled = false }
  const rx = $('#opt-regex'); if (rx) rx.checked = false
}

// "filter" buttons in the Label-speakers panel: jump straight to a filtered timeline
function filterByGlobal(g) {
  state.localSpeaker = null
  state.speaker = g
  const sel = $('#f-speaker'); if (sel) sel.value = g
  document.body.classList.remove('speakers-page', 'favorites-page'); syncPageButtons()
  render(); afterFilter()
}
function filterByLocal(vid, local, global) {
  state.speaker = ''
  const sel = $('#f-speaker'); if (sel) sel.value = ''
  state.localSpeaker = { vid, local, global: global || '' }
  document.body.classList.remove('speakers-page', 'favorites-page'); syncPageButtons()
  render(); afterFilter()
}
function clearLocalFilter() { state.localSpeaker = null; render(); afterFilter() }

// Fill a video's transcript block and every block above it, so their real heights are
// in place before we scroll. The placeholder heights are only estimates
// (segs.length * 24px); left to lazy-load they re-flow afterwards and the scroll target
// drifts — the same title can otherwise land at a different spot on each click.
function fillUpToVid(vid) {
  const blocks = [...document.querySelectorAll('.tl-sentences[data-vid]')]
  const targetIdx = blocks.findIndex((b) => b.dataset.vid === vid)
  for (let i = 0; i <= targetIdx; i++) fillBlock(blocks[i])
}

// jump the nav's chosen video to the centre of the viewport and glow its title
function scrollToVideo(vid) {
  fillUpToVid(vid)
  const art = document.getElementById('v-' + vid); if (!art) return
  const head = art.querySelector('.tl-vh') || art
  head.scrollIntoView({ block: 'center' })
  head.classList.add('s-flash'); setTimeout(() => head.classList.remove('s-flash'), 1800)
}

// open a shared sentence: scroll to + flash it, centred
function showSentence(sid) {
  // Only reset + re-render when the timeline isn't already showing the full archive
  // (a filter is active, or we're on the mobile speakers/favorites page). Skipping it
  // keeps previously-filled transcript blocks, so back-to-back jumps stay fast.
  if (matches || document.body.classList.contains('speakers-page') || document.body.classList.contains('favorites-page')) {
    clearFilters(); render()
  }
  const vid = sid.slice(0, sid.lastIndexOf(':'))
  requestAnimationFrame(() => {
    fillUpToVid(vid)
    const el = document.querySelector(`.s-txt[data-sid="${CSS.escape(sid)}"]`)
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('s-flash'); setTimeout(() => el.classList.remove('s-flash'), 1800) }
  })
}
// open a shared video: land on its TITLE (top), not the middle
function showVideo(vid) {
  clearFilters(); render()
  const land = () => {
    fillBlockForVid(vid)
    const el = document.getElementById('v-' + vid)
    if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('g-flash'); setTimeout(() => el.classList.remove('g-flash'), 1600) }
  }
  requestAnimationFrame(land)
  setTimeout(land, 90)        // re-land after lazy blocks above settle (avoids drift to the middle)
}
function gotoShared() {
  const ms = location.hash.match(/^#s=(.+)$/); if (ms) { showSentence(decodeURIComponent(ms[1])); return }
  const mv = location.hash.match(/^#v=(.+)$/); if (mv) showVideo(decodeURIComponent(mv[1]))
}
// first sentence id where a given local speaker talks in a video
function firstSidFor(vid, local) {
  const v = ITEMS_BY_ID[vid]; if (!v) return null
  const i = v.segments.findIndex((s) => s.speaker === local)
  return i >= 0 ? `${vid}:${i}` : null
}

// open the tagging panel focused on a global speaker (switches to the label page
// on mobile where the panel is otherwise hidden)
function openLabel(globalId) {
  if (!globalId) return
  if (getComputedStyle($('#rightcol')).display === 'none') showSpeakersPage()
  const input = $('#speakers').querySelector(`.gname[data-global="${CSS.escape(globalId)}"]`)
  if (!input) return
  requestAnimationFrame(() => {
    const box = input.closest('.gspk') || input
    box.scrollIntoView({ block: 'center' })
    input.focus()
    box.classList.add('g-flash'); setTimeout(() => box.classList.remove('g-flash'), 1600)
  })
}

// open the per-video override for one local speaker (SPEAKER_xx) in the panel
function openOverride(vid, local) {
  if (getComputedStyle($('#rightcol')).display === 'none') showSpeakersPage()
  const inp = $('#speakers').querySelector(`.ov[data-video="${CSS.escape(vid)}"][data-spk="${CSS.escape(local)}"]`)
  if (!inp) return
  requestAnimationFrame(() => {
    inp.closest('details')?.setAttribute('open', '')   // member list is collapsed by default
    const box = inp.closest('.gspk') || inp
    box.scrollIntoView({ block: 'center' })
    inp.focus()
    box.classList.add('g-flash'); setTimeout(() => box.classList.remove('g-flash'), 1600)
  })
}

// ---- speaker tagging panel ----
function renderSpeakers() {
  const gs = DATA.speakers.global_speakers || {}
  const ids = Object.keys(gs).sort()
  const box = $('#speakers')
  if (!ids.length) { box.innerHTML = `<p class="hint">No speakers.json — run cluster_speakers.py.</p>`; return }
  box.innerHTML = ids.map((g) => {
    const info = gs[g]
    const name = spk.getTags().globals[g] || ''
    const members = (info.members || []).map((m) => {
      const ov = spk.getTags().overrides[m.video_id]?.[m.local_speaker] || ''
      const clip = m.sample_clip ? `<audio controls preload="none" src="${clipUrl(m.sample_clip)}"></audio>` : ''
      const title = DATA.videos[m.video_id]?.title || m.video_id
      return `<div class="member">
        <div class="m-title" title="${esc(title)}">${esc(title)} · ${esc(m.local_speaker)}</div>
        ${clip}
        <div class="m-row">
          <input class="ov" data-video="${esc(m.video_id)}" data-spk="${esc(m.local_speaker)}" placeholder="override name" value="${esc(ov)}" />
          <button class="m-filter" data-video="${esc(m.video_id)}" data-spk="${esc(m.local_speaker)}" data-global="${esc(g)}" title="show only this speaker in this video">filter</button>
          <button class="jump" data-video="${esc(m.video_id)}" data-spk="${esc(m.local_speaker)}" title="jump to where this speaker talks in this video">jump ↗</button>
        </div>
      </div>`
    }).join('')
    return `<div class="gspk">
      <div class="g-head">
        <input class="gname" data-global="${esc(g)}" placeholder="name ${esc(g)}" value="${esc(name)}" />
        <button class="g-filter" data-gfilter="${esc(g)}" title="show only this speaker across the whole archive">filter</button>
      </div>
      <div class="g-meta">${info.member_count ?? (info.members || []).length} clusters · ${info.total_segments ?? '?'} segs</div>
      <details><summary>members</summary>${members}</details>
    </div>`
  }).join('')
}

function onExport() { downloadJSON(spk.exportTags(), 'speaker-tags.json') }

async function onImport(e) {
  const file = e.target.files?.[0]
  if (!file) return
  try { spk.importTags(await file.text()); renderSpeakers(); refreshSpeakerSelect(); render() }
  catch (err) { alert('Import failed: ' + err) }
  e.target.value = ''
}
