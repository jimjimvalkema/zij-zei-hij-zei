import './style.css'
import { loadData, loadTimeline, search, clipUrl } from './search.js'
import { MIN_QUERY } from './searchConfig.js'
import * as spk from './speakers.js'

let DATA = { videos: {}, speakers: { global_speakers: {} }, meta: {} }
let ITEMS = []        // timeline videos (chronological) with date parts
let ITEMS_BY_ID = {}
let matches = null    // Map videoId -> Set(segmentIndex) selected, or null when no filter
let tlBlocks = []     // current .tl-vid elements (for scroll-spy)
let activeKey = null
let spyTick = false
let regexError = null
const state = { query: '', speaker: '', showRest: false, exact: false, regex: false }

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

// combined selection from the text query (smart / exact / regex) AND/OR the
// speaker filter -> Map videoId -> Set(segmentIndex). null when no filter.
function computeSelection() {
  regexError = null
  const spkSel = state.speaker
  const textActive = state.regex ? state.query.length >= 1 : state.query.trim().length >= MIN_QUERY
  if (!textActive && !spkSel) return null

  const m = new Map()
  const add = (vid, idx) => { (m.get(vid) || m.set(vid, new Set()).get(vid)).add(idx) }

  if (textActive && state.regex) {
    let re
    try { re = new RegExp(state.query, 'i') } catch (e) { regexError = e.message; return new Map() }
    for (const v of ITEMS) v.segments.forEach((s, idx) => { if (re.test(s.text)) add(v.id, idx) })
    if (spkSel) intersectSpeaker(m, spkSel)
  } else if (textActive) {
    const opts = state.exact ? { prefix: false, fuzzy: false, combineWith: 'AND' } : null
    for (const r of search(state.query.trim(), {}, 1e6, opts).hits) {
      const k = r.id.lastIndexOf(':')
      add(r.id.slice(0, k), +r.id.slice(k + 1))
    }
    if (spkSel) intersectSpeaker(m, spkSel)
  } else {                                     // speaker only: all of that speaker's lines
    for (const v of ITEMS) v.segments.forEach((s, idx) => { if (s.global === spkSel) add(v.id, idx) })
  }
  return m
}

function intersectSpeaker(m, spkSel) {
  for (const [vid, set] of [...m]) {
    const segs = ITEMS_BY_ID[vid]?.segments || []
    for (const idx of [...set]) if (segs[idx]?.global !== spkSel) set.delete(idx)
    if (!set.size) m.delete(vid)
  }
}

// videos to render: entire archive when no filter or when "show entire archive"
// is on; otherwise only the videos that contain a selection.
const shownItems = () => (matches && !state.showRest ? ITEMS.filter((v) => matches.has(v.id)) : ITEMS)

function render() {
  matches = computeSelection()
  if (!matches) state.showRest = false
  const items = shownItems()
  buildNav(items)
  $('#tl-main').innerHTML = buildMain(items)
  tlBlocks = [...document.querySelectorAll('.tl-vid')]

  const sr = $('#show-rest'), status = $('#tl-status')
  status.classList.toggle('err', !!regexError)
  if (regexError) {
    status.textContent = `⚠ bad regex: ${regexError}`
    sr.hidden = false
    sr.textContent = state.showRest ? 'Only matches' : 'Show all'
  } else if (matches) {
    const total = [...matches.values()].reduce((a, s) => a + s.size, 0)
    status.textContent = total
      ? `${total} sentence${total === 1 ? '' : 's'} · ${matches.size} video${matches.size === 1 ? '' : 's'}`
      : 'no matches'
    sr.hidden = false
    sr.textContent = state.showRest ? 'Only matches' : 'Show all'
  } else {
    status.textContent = ''
    sr.hidden = true
  }
  activeKey = null
  spy()
}

function buildMain(items) {
  const showRest = state.showRest
  const gapTier = (days) => (days <= 1 ? 1 : days <= 7 ? 2 : days <= 31 ? 3 : 4)
  let html = '<div class="tl-track">', cy = null, cym = null, cymw = null, prev = null
  for (const v of items) {
    const mset = matches ? matches.get(v.id) : null
    const all = v.segments.map((s, idx) => ({ ...s, idx }))
    const segs = (matches && !showRest) ? all.filter((s) => mset.has(s.idx)) : all
    if (!segs.length) continue
    if (v.y !== cy) { cy = v.y; cym = cymw = null; html += `<div class="mk mk-year">${esc(String(v.y))}</div>` }
    const ym = `${v.y}-${v.mo}`
    if (ym !== cym) { cym = ym; cymw = null; html += `<div class="mk mk-month">${v.mo ? esc(MONTHS[v.mo - 1]) : 'Undated'}</div>` }
    const ymw = `${ym}-${v.wk}`
    if (ymw !== cymw) { cymw = ymw; if (v.wk) html += `<div class="mk mk-week">week ${v.wk}</div>` }
    let tier = 1
    if (prev && v.date) tier = gapTier((v.date - prev) / 86400000)
    if (v.date) prev = v.date
    const isHit = (idx) => (mset ? mset.has(idx) : false)
    html += `<article class="tl-vid gap-${tier}" id="v-${esc(v.id)}" data-y="${v.y}" data-mo="${v.mo}" data-wk="${v.wk}">
      <span class="tl-node"></span>
      <div class="tl-body">
        <div class="tl-vh">
          <a class="tl-title" href="${ytLink(v.id, 0)}" target="_blank" rel="noopener">${esc(v.title || v.id)}</a>
          <span class="tl-date">${esc(prettyDate(v.upload_date))}</span>
        </div>
        <div class="tl-sentences">${sentencesHtml(v.id, segs, isHit)}</div>
      </div>
      <img class="thumb" loading="lazy" alt="" width="140" height="79" src="${thumbUrl(v.id)}" onerror="this.style.visibility='hidden'" />
    </article>`
  }
  return html + '</div>'
}

// consecutive same-speaker sentences -> one boxed turn (coloured by local speaker,
// labelled with the global id). Matching sentences get the .s-hit highlight.
function sentencesHtml(vid, segs, isHit) {
  const out = []
  for (let i = 0; i < segs.length;) {
    const key = segs[i].speaker, g = segs[i].global
    const name = spk.resolveName(vid, key, g), gid = g || key
    const links = []
    while (i < segs.length && segs[i].speaker === key) {
      const s = segs[i++]
      const sid = `${vid}:${s.idx}`
      links.push(`<span class="sent"><button class="share" data-share="${esc(sid)}" title="Copy a link to this sentence" aria-label="copy link to sentence">🔗</button><a class="s-txt${isHit(s.idx) ? ' s-hit' : ''}" data-sid="${esc(sid)}" href="${ytLink(vid, s.start)}" target="_blank" rel="noopener">${esc(s.text)}</a></span>`)
    }
    const label = name === gid ? `<span class="gid">${esc(gid)}</span>` : `${esc(name)} <span class="gid">${esc(gid)}</span>`
    out.push(`<div class="turn" style="--hue:${hueFor(key)}"><span class="turn-spk">${label}</span>${links.join(' ')}</div>`)
  }
  return out.join('') || '<span class="loading">(no speech)</span>'
}

function buildNav(items) {
  const years = {}
  for (const v of items) {
    const Y = (years[v.y] ||= { count: 0, months: {} }); Y.count++
    const M = (Y.months[v.mo] ||= { count: 0, weeks: {} }); M.count++
    const W = (M.weeks[v.wk] ||= { count: 0, first: v.id }); W.count++
  }
  $('#tl-nav').innerHTML = Object.keys(years).sort().map((yk) => {
    const Y = years[yk]
    const months = Object.keys(Y.months).map(Number).sort((a, b) => a - b).map((mk) => {
      const M = Y.months[mk]
      const weeks = Object.keys(M.weeks).map(Number).sort((a, b) => a - b).map((wk) =>
        `<a class="tl-wk" data-ymw="${yk}-${mk}-${wk}" data-target="v-${esc(M.weeks[wk].first)}">wk ${wk} <span>(${M.weeks[wk].count})</span></a>`).join('')
      return `<details class="tl-mo" data-ym="${yk}-${mk}"><summary>${mk ? esc(MONTHS[mk - 1]) : 'Undated'} <span>(${M.count})</span></summary>${weeks}</details>`
    }).join('')
    return `<details class="tl-yr" data-y="${yk}" open><summary>${esc(String(yk))} <span>(${Y.count})</span></summary>${months}</details>`
  }).join('')
  $('#tl-nav').onclick = (e) => {
    const a = e.target.closest('.tl-wk')
    if (a) document.getElementById(a.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  if (wEl) { wEl.classList.add('active'); wEl.scrollIntoView({ block: 'nearest' }) }
}

// topmost visible matched sentence — used as a stable anchor across re-renders
function topVisibleHit() {
  const off = headOffset()
  for (const el of document.querySelectorAll('.s-hit')) {
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
    t = setTimeout(() => { render(); window.scrollTo({ top: 0 }) }, 160)
  })
  $('#f-speaker').addEventListener('change', (e) => { state.speaker = e.target.value; render(); window.scrollTo({ top: 0 }) })
  $('#opt-exact').addEventListener('change', (e) => { state.exact = e.target.checked; render(); window.scrollTo({ top: 0 }) })
  $('#opt-regex').addEventListener('change', (e) => {
    state.regex = e.target.checked
    $('#opt-exact').disabled = state.regex          // exact is irrelevant in regex mode
    $('#q').placeholder = state.regex ? 'Regular expression… (case-insensitive)' : 'Search everything said… (min 2 chars)'
    render(); window.scrollTo({ top: 0 })
  })
  $('#show-rest').addEventListener('click', () => {
    const anchor = topVisibleHit()          // keep this match visually fixed
    state.showRest = !state.showRest
    render()
    if (anchor) {
      const el = document.querySelector(`[data-sid="${anchor.sid}"]`)
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchor.top)
    }
  })
  window.addEventListener('scroll', () => {
    if (spyTick) return
    spyTick = true
    requestAnimationFrame(() => { spy(); spyTick = false })
  }, { passive: true })
  $('#tl-main').addEventListener('click', (e) => {
    const b = e.target.closest('.share')
    if (!b) return
    e.preventDefault()
    copyLink(b)
  })
  window.addEventListener('hashchange', gotoShared)
  $('#label-speakers').addEventListener('click', () => {
    const on = document.body.classList.toggle('speakers-page')
    $('#label-speakers').textContent = on ? 'Back to timeline' : 'Label speakers'
    window.scrollTo({ top: 0 })
  })

  $('#export').addEventListener('click', onExport)
  $('#import-btn').addEventListener('click', () => $('#import-file').click())
  $('#import-file').addEventListener('change', onImport)
  $('#speakers').addEventListener('change', (e) => {
    if (e.target.classList.contains('gname')) { spk.setGlobalName(e.target.dataset.global, e.target.value); refreshSpeakerSelect(); render() }
    else if (e.target.classList.contains('ov')) { spk.setOverride(e.target.dataset.video, e.target.dataset.spk, e.target.value); render() }
  })
}

// ---- shareable per-sentence links ----
const shareUrl = (sid) => `${location.origin}${location.pathname}#s=${encodeURIComponent(sid)}`

function copyLink(btn) {
  const url = shareUrl(btn.dataset.share)
  const ok = () => { const o = btn.textContent; btn.textContent = '✓'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = o; btn.classList.remove('copied') }, 1000) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(ok, () => fallbackCopy(url, ok))
  else fallbackCopy(url, ok)
}
function fallbackCopy(text, cb) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); ta.remove()
    cb && cb()
  } catch { prompt('Copy this link:', text) }
}

// open a shared link: clear filters so the sentence renders, then scroll + flash
function gotoShared() {
  const m = location.hash.match(/^#s=(.+)$/)
  if (!m) return
  const sid = decodeURIComponent(m[1])
  Object.assign(state, { query: '', speaker: '', showRest: false, exact: false, regex: false })
  const q = $('#q'); if (q) q.value = ''
  const fs = $('#f-speaker'); if (fs) fs.value = ''
  const ex = $('#opt-exact'); if (ex) { ex.checked = false; ex.disabled = false }
  const rx = $('#opt-regex'); if (rx) rx.checked = false
  render()
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-sid="${CSS.escape(sid)}"]`)
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('s-flash'); setTimeout(() => el.classList.remove('s-flash'), 1800) }
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
        <input class="ov" data-video="${esc(m.video_id)}" data-spk="${esc(m.local_speaker)}" placeholder="override name" value="${esc(ov)}" />
      </div>`
    }).join('')
    return `<div class="gspk">
      <div class="g-head">
        <input class="gname" data-global="${esc(g)}" placeholder="name ${esc(g)}" value="${esc(name)}" />
        <span class="g-meta">${info.member_count ?? (info.members || []).length} clusters · ${info.total_segments ?? '?'} segs</span>
      </div>
      <details><summary>members</summary>${members}</details>
    </div>`
  }).join('')
}

function onExport() {
  const blob = new Blob([spk.exportTags()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'speaker-tags.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

async function onImport(e) {
  const file = e.target.files?.[0]
  if (!file) return
  try { spk.importTags(await file.text()); renderSpeakers(); refreshSpeakerSelect(); render() }
  catch (err) { alert('Import failed: ' + err) }
  e.target.value = ''
}
