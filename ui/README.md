# Transcript search UI

Static, client-side search over the transcripts produced by `transcribe.py` +
`cluster_speakers.py`. No backend — builds to a folder of HTML/CSS/JS you can
serve with anything (e.g. `python3 -m http.server`).

- One **chronological timeline** (vertical rail with year/month/week markers and
  gaps sized by elapsed time) — the search box lives on it.
- **Search** (MiniSearch, in-browser) filters the timeline to just the matching
  sentences; **Show entire archive** reveals the full context with matches still
  highlighted (toggling keeps your scroll position). It searches **every language
  version** (see `--keep-versions`) and flips a block to the language a match was
  found in.
- **Multi-language:** when sentences carry multiple language versions, each
  speaker block shows its most-confident language with a **per-block language
  switch** (e.g. `NL | EN | AR`).
- Each speaker turn is a coloured box labelled with its global id; **click any
  sentence** → opens the YouTube video at that timestamp in a new tab.
- **Tag speakers** (name the cross-video `GLOBAL_xx` clusters, with per-video
  overrides); names are stored in your browser (localStorage) and can be
  exported/imported as JSON.
- **LLM / crawler friendly:** the search UI is client-side JS, so the build also
  emits no-JS, fully-inlined copies of the whole archive (`corpus.txt`,
  `timeline.html`) plus an `llms.txt` pointer — and `index.html` carries a
  `<noscript>` fallback linking to them. See [LLMs & crawlers](#llms--crawlers).

## Setup

```shell
cd ui
yarn install
```

## 1. Build the search index from your transcripts

```shell
# points at the --output folder you gave transcribe.py
yarn index --transcripts ../transcripts
#   --no-clips        skip copying per-speaker audio samples (smaller, but the
#                     tagging panel can't play voices)
#   --out <dir>       where to write assets (default: ./public)
#   --site-url <url>  absolute base of the deployed UI, e.g.
#                     https://example.com/yt/ui  — baked into corpus.txt/llms.txt
#                     so LLMs get a real citation link instead of a placeholder.
```

This writes `public/search-index.json`, `videos.json`, `speakers.json`,
`meta.json`, and `clips/`. Re-run it whenever you re-transcribe or re-cluster.

It also writes the no-JS `corpus.txt` / `timeline.html` / `llms.txt` artifacts —
see [LLMs & crawlers](#llms--crawlers) for those and the `--site-url` flag.

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

## LLMs & crawlers

The interactive UI renders entirely in the browser, so a tool that fetches the
page without running JS (most LLMs, crawlers, `curl`) sees an empty shell. To
make the archive readable and **citable** anyway, `yarn index` also writes:

- **`weeks/`** — the transcript split into one small file per ISO week
  (`weeks/2025-W24.txt`) plus `weeks/index.txt` listing every week and its video
  titles. Each line carries a ready-made citation link. This is the **reliable
  path for citing a specific quote**: the full dump is multi-MB and most LLM
  fetch tools truncate it, so a model that can't see a quote ends up guessing its
  id (wrong video/index) or paraphrasing it. The shards are small enough to read
  whole, so the model copies the real link instead of inventing one.
- **`corpus.txt`** — the whole archive as plain text, one line per sentence
  tagged `id=<video_id>:<index>`. Good for tools that can ingest big files.
- **`timeline.html`** — the same content as static, no-JS HTML, every sentence
  hyperlinked.
- **`llms.txt`** — a short pointer file describing the above and the citation
  format below.

`index.html` also carries a `<noscript>` block linking to these, so anything
landing on the SPA is pointed at the readable copies.

### Citing a sentence

Every sentence has a stable id `<video_id>:<index>`, where **`<index>` is the
sentence's position in the video, not a timestamp**. Link to a sentence with:

```
<site-url>/#s=<video_id>:<index>
```

which opens the timeline scrolled to and highlighting that exact sentence. The
index must be read from the line in `corpus.txt` — it can't be guessed.

Pass `--site-url` at build time so `corpus.txt`/`llms.txt` contain real,
absolute citation links instead of a `<SITE_URL>` placeholder:

```shell
yarn index --transcripts ../transcripts --site-url https://example.com/yt/ui
```

Because those links are absolute, the generated `llms.txt` works both at
`<site-url>/llms.txt` and copied to your **domain root** (`/llms.txt`), which is
where crawlers conventionally look.

## Notes
- Speaker names live only in your browser. **Export before re-running
  `cluster_speakers.py`** — it can renumber `GLOBAL_xx` ids.
- Big archives: the index is one JSON file loaded into memory. ~280k sentences
  is fine; if it ever gets unwieldy we can shard or switch to SQLite-WASM.
