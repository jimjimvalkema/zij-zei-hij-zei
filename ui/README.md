# Transcript search UI

Static, client-side search over the transcripts produced by `transcribe.py` +
`cluster_speakers.py`. No backend — builds to a folder of HTML/CSS/JS you can
serve with anything (e.g. `python3 -m http.server`).

- One **chronological timeline** (vertical rail with year/month/week markers and
  gaps sized by elapsed time) — the search box lives on it.
- **Search** (MiniSearch, in-browser) filters the timeline to just the matching
  sentences; **Show rest** reveals the full context with matches still
  highlighted (toggling keeps your scroll position).
- Each speaker turn is a coloured box labelled with its global id; **click any
  sentence** → opens the YouTube video at that timestamp in a new tab.
- **Tag speakers** (name the cross-video `GLOBAL_xx` clusters, with per-video
  overrides); names are stored in your browser (localStorage) and can be
  exported/imported as JSON.

## Setup

```shell
cd ui
yarn install
```

## 1. Build the search index from your transcripts

```shell
# points at the --output folder you gave transcribe.py
yarn index --transcripts ../transcripts
#   --no-clips   skip copying per-speaker audio samples (smaller, but the
#                tagging panel can't play voices)
#   --out <dir>  where to write assets (default: ./public)
```

This writes `public/search-index.json`, `videos.json`, `speakers.json`,
`meta.json`, and `clips/`. Re-run it whenever you re-transcribe or re-cluster.

## 2a. Develop

```shell
yarn dev          # http://localhost:5173
```

## 2b. Build a static site and host it

```shell
yarn build        # -> dist/  (index.html + js/css + the index json + clips)
cd dist && python3 -m http.server 8000
# open http://localhost:8000
```

`dist/` is fully static and path-relative — copy it anywhere (GitHub Pages,
Netlify, a USB stick) and it works.

## Notes
- Speaker names live only in your browser. **Export before re-running
  `cluster_speakers.py`** — it can renumber `GLOBAL_xx` ids.
- Big archives: the index is one JSON file loaded into memory. ~280k sentences
  is fine; if it ever gets unwieldy we can shard or switch to SQLite-WASM.
