# zij-zei-hij-zei
quick little repo to archive an youtube channel and ui with searchable, linked transcriptions of the videos.
Instructions are focussed on linux(ubuntu), other OS like windows likely possible but not tested.

## installation yt-dlp (ubuntu)
Install ffmpeg:   
```shell
sudo apt update && sudo apt install -y curl unzip ffmpeg;
```
Install deno:  
```shell 
curl -fsSL https://deno.land/install.sh | sh
```

yt-dlp  
```shell
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp;
sudo chmod a+rx /usr/local/bin/yt-dlp;
```

refresh terminal
```shell
source ~/.bashrc 
```


## archive with yt-dlp
**Notice:** --cookies-from-browser firefox is an option needed to get age restricted videos or other reasons youtube might be difficult. I recommend running without it as much as possible since to avoid your youtube account being banned.

usage: change the channels_url from @PewDiePie to your channel; And copy paste entire thing into your shell.
```shell
channel_url="https://www.youtube.com/@PewDiePie/videos";
resolution="bv*+ba/b";
# resolution="bv*+ba/b" that is best possible
# for 720@30 fps do "bv*[height<=720][fps<=30]+ba/bv*[height<=720]+ba/b[height<=720]/b"
yt-dlp --download-archive archive.txt   --continue --retries 10 --ignore-errors   -f "bv*+ba/b"   --merge-output-format mkv   --write-info-json   --write-description   --write-thumbnail   --write-comments   --write-subs --write-auto-subs --sub-langs "en.*,nl.*"   --embed-metadata --embed-thumbnail --embed-subs   --sleep-requests 2 --sleep-interval 3 --max-sleep-interval 8   -o "%(upload_date)s_%(title)s [%(id)s]/%(upload_date)s_%(title)s [%(id)s].%(ext)s"  $channel_url --js-runtimes deno:/home/$USER/.deno/bin/deno  --cookies-from-browser firefox
```
<!-- command ran for test:
```shell
channel_url="https://www.youtube.com/@PewDiePie/videos";
resolution="bv*[height<=720][fps<=30]+ba/bv*[height<=720]+ba/b[height<=720]/b";
yt-dlp --download-archive archive.txt   --continue --retries 10 --ignore-errors   -f "bv*+ba/b"   --merge-output-format mkv   --write-info-json   --write-description   --write-thumbnail   --write-subs --write-auto-subs --sub-langs "en.*,nl.*"   --embed-metadata --embed-thumbnail --embed-subs   --sleep-requests 2 --sleep-interval 3 --max-sleep-interval 8   -o "%(upload_date)s_%(title)s [%(id)s]/%(upload_date)s_%(title)s [%(id)s].%(ext)s"  $channel_url --js-runtimes deno:/home/$USER/.deno/bin/deno  --playlist-items -30
``` -->


## transcription with speaker diarization

YouTube's auto-captions are censored, error-prone, and have no idea *who* is
talking (PewDiePie vs. a friend vs. the game). We re-transcribe locally with
[whisper-diarization](https://github.com/MahmoudAshraf97/whisper-diarization):

- **faster-whisper `large-v3`** — accurate, uncensored speech-to-text.
- **NVIDIA NeMo MSDD** — speaker diarization (no Hugging Face token needed).
- **Demucs** — isolates vocals from game audio/music *before* diarizing.

All local, all open source. A GPU is strongly recommended (developed on an
RTX 4090; the full ~4 h archive transcribes in minutes).

### install

System packages (Ubuntu); `ffmpeg` is also used by the archive step above:
```shell
sudo apt update && sudo apt install -y python3-venv build-essential ffmpeg git
```

Create the virtualenv, fetch the engine, and install everything (downloads
PyTorch + NeMo, a few GB):
```shell
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip setuptools wheel
git clone --depth 1 https://github.com/MahmoudAshraf97/whisper-diarization.git engine/whisper-diarization
.venv/bin/python -m pip install -c engine/whisper-diarization/constraints.txt -r engine/whisper-diarization/requirements.txt
```

Then install the **CUDA-12 cuBLAS/cuDNN** runtime libraries. This step is
required: torch ships CUDA-13 libs, but faster-whisper (CTranslate2) needs the
CUDA-12 ones (`libcublas.so.12`, `libcudnn.so.9`) or it fails at load with
`Library libcublas.so.12 is not found`:
```shell
.venv/bin/python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```
(`transcribe.py` finds these automatically and puts them on `LD_LIBRARY_PATH`
for you — you don't need to set any environment variable yourself.)

### run

The full pipeline is two steps — transcribe, then link speakers across videos.
Input and output folders are explicit flags. This is exactly what produced the
data in this repo:

```shell
# 1. transcribe every video in ./videos/pewdiepie -> ./transcripts (per-video speaker labels)
.venv/bin/python transcribe.py --input videos/pewdiepie --output transcripts

# 2. link those per-video speakers into archive-wide ids (adds global_speaker)
.venv/bin/python cluster_speakers.py --transcripts transcripts
```

The first transcribe run also downloads the model weights (whisper `large-v3`,
Demucs `htdemucs`, the punctuation model, and the NeMo diarizer). Step 2 is
explained in detail under *cross-video speaker clustering* below.

`transcribe.py` runs a 3-stage pipeline: background threads extract audio
*ahead* of the GPU and write per-speaker samples + JSON *behind* it, so the GPU
never waits on disk or ffmpeg. The GPU still runs one video at a time (one model
set, no extra VRAM), so it's safe on long videos. Scratch audio is written under
`<output>/.work/` and cleaned up automatically — keep a few GB free there.
Videos with no detectable speech (pure gameplay/music) are written with an empty
`segments` list instead of failing the batch.

### transcribe options

```shell
# all channels at once (scans every sub-folder of ./videos)
.venv/bin/python transcribe.py --input videos --output transcripts

# a single file
.venv/bin/python transcribe.py --output transcripts -- "videos/pewdiepie/<dir>/<file>.mkv"

# re-do transcripts that already exist (by default, done ones are skipped)
.venv/bin/python transcribe.py --input videos/pewdiepie --output transcripts --force
```

### multi-language / code-switching videos

By default Whisper detects **one** language for a whole video (from the opening)
and transcribes everything in it — so a speaker who switches languages mid-video
(e.g. Dutch then English then Arabic) gets the other languages mangled into the
first one. Pass a candidate list to handle this:

```shell
# detect + transcribe per ~30s window, restricted to these languages
.venv/bin/python transcribe.py --input videos/pewdiepie --output transcripts \
    --languages nl,en,ar

# force a single language (no detection) — also via --languages with one code
.venv/bin/python transcribe.py --input videos/pewdiepie --output transcripts --languages nl

# tune the detection window (smaller = catches faster switches, less reliable)
.venv/bin/python transcribe.py ... --languages nl,en,ar --lang-window 20
```

Use Whisper language **codes** (`nl` Dutch, `en` English, `ar` Arabic, `sv`
Swedish, `de` German, `fr` French, `es` Spanish, ...). With >1 code it windows
the audio, detects each window's language from your list, and transcribes it in
that language; every segment is tagged with its `language`, and the video's
`transcript.json` gets a `languages` list. Caveats: detection is **per window**,
so a short switch *inside* a window inherits that window's language; and this
mode uses Whisper's sentence-level timestamps (no forced alignment). Without
`--languages`, behavior is unchanged (single auto-detected language + alignment).

### output

Per video, under `<output>/<video_id>/` (e.g. `transcripts/<video_id>/`):

- `transcript.json` — sentence-level segments `{ start, end, speaker, text,
  language }` plus video metadata (`video_id`, `title`, `webpage_url`,
  `source_path`, `languages`, ...). This is the canonical data the search UI
  will index.
- `transcript.txt` — human-readable, one `[SPEAKER_00] ...` line per sentence.
- `speakers/SPEAKER_xx.mp3` — a ~30 s sample of each speaker cluster, so the UI
  can play it and let you identify who that cluster is.

**Note on speaker labels:** diarization produces *anonymous, per-video*
clusters (`SPEAKER_00`, `SPEAKER_01`, ...). They are **not** consistent across
videos — `SPEAKER_00` in one video is unrelated to `SPEAKER_00` in another.
The pass below links them; final human naming happens in the UI.

### cross-video speaker clustering

This is step 2 of the run above. `cluster_speakers.py` links the per-video
clusters into archive-wide identities.
It computes a TitaNet voiceprint for each `(video, local-speaker)` cluster
(reusing the saved per-speaker samples), clusters them across all videos, and
assigns `GLOBAL_00`, `GLOBAL_01`, ... (`GLOBAL_00` = most-talking, usually the
channel owner).

It is **strictly additive**: it never edits the per-video diarization. Each
segment keeps its original local `speaker`; the pass only adds a parallel
`global_speaker` field, plus a top-level `<transcripts>/speakers.json`. Re-run
any time with a different threshold — it's idempotent. The `--transcripts` flag
points at the same folder you passed to `transcribe.py --output`.

```shell
# cluster speakers across everything in ./transcripts (default threshold 0.47)
.venv/bin/python cluster_speakers.py --transcripts transcripts

# preview only: threshold sweep + distances, writes nothing
.venv/bin/python cluster_speakers.py --transcripts transcripts --analyze

# merge more aggressively
.venv/bin/python cluster_speakers.py --transcripts transcripts --threshold 0.6

# only emit speakers.json, don't touch the transcript.json files
.venv/bin/python cluster_speakers.py --transcripts transcripts --no-write-back
```

Embeddings are cached (`<transcripts>/.speaker_embeddings.npz`), so threshold
sweeps are instant after the first run; pass `--recompute` to rebuild them.

The default `0.47` was chosen from the data, not by eyeballing labels: it sits
in a stable plateau (~0.45–0.50) that keeps **distinct people apart** — e.g. a
recurring co-op friend stays separate from the host even when they talk in the
same video — while still unifying each speaker across videos and bucketing game
audio separately. Above ~0.52 it starts over-merging different speakers (two
people in one video collapse into one id, which makes a dialogue look like a
monologue). Lower errs toward splitting one person into several ids (just name
them all the same in the UI). Run `--analyze` to re-check the plateau on a new
or larger set, and remember **two speakers in the same video are always
different people** — if they share a global id, the threshold is too high.
