#!/usr/bin/env python3
"""
Re-transcribe archived videos with speaker diarization (in-process, models
loaded once and reused across all videos).

Engine: MahmoudAshraf97/whisper-diarization building blocks
  - Demucs (htdemucs)            isolate vocals from game audio/music
  - faster-whisper large-v3      uncensored speech-to-text
  - ctc-forced-aligner           word-level timestamps
  - NVIDIA NeMo MSDD             speaker diarization (no Hugging Face token)
  - deepmultilingualpunctuation  sentence segmentation
All local, all open source, all on the GPU.

Unlike calling the engine's diarize.py per file (which reloads ~6 models every
time), this loads every model ONCE and loops, so the whole archive runs in a
single warm process.

For each video, under transcripts/<video_id>/:
  - transcript.json   sentence-level segments {start, end, speaker, text} + meta
  - transcript.txt    human-readable "[SPEAKER_00] ..." per line
  - speakers/SPEAKER_xx.mp3   ~30s sample of each speaker cluster (for the UI to
                              play so a human can identify who the cluster is)

Speaker labels are anonymous, per-video clusters (SPEAKER_00, ...). Naming /
merging across videos is deferred to the web UI.

Usage:
  .venv/bin/python transcribe.py                 # all videos under videos/
  .venv/bin/python transcribe.py --root videos/pewdiepie
  .venv/bin/python transcribe.py -- "videos/.../some video [id].mkv"
  .venv/bin/python transcribe.py --force         # re-do already-transcribed videos
"""
import glob
import os
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
VENV_LIB = os.path.join(REPO, ".venv", "lib")
ENGINE = os.path.join(REPO, "engine", "whisper-diarization")
OUT_ROOT = os.path.join(REPO, "transcripts")


def _ensure_cuda_libs():
    """faster-whisper/CTranslate2 needs CUDA-12 cuBLAS/cuDNN (libcublas.so.12,
    libcudnn.so.9) which ship as pip wheels alongside torch's CUDA-13 libs.
    They must be on LD_LIBRARY_PATH *before* the dynamic linker loads them, so
    set it and re-exec ourselves once if needed."""
    libdirs = sorted(glob.glob(os.path.join(
        VENV_LIB, "python*", "site-packages", "nvidia", "*", "lib")))
    cur = os.environ.get("LD_LIBRARY_PATH", "")
    have = cur.split(os.pathsep)
    if libdirs and any(d not in have for d in libdirs) and not os.environ.get("_TRANSCRIBE_REEXEC"):
        os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(libdirs + ([cur] if cur else []))
        os.environ["_TRANSCRIBE_REEXEC"] = "1"
        os.execv(sys.executable, [sys.executable] + sys.argv)


_ensure_cuda_libs()

# Heavy imports happen only after the LD_LIBRARY_PATH guard above.
import argparse  # noqa: E402
import json  # noqa: E402
import queue  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import traceback  # noqa: E402

import torch  # noqa: E402
import faster_whisper  # noqa: E402

sys.path.insert(0, ENGINE)
from ctc_forced_aligner import (  # noqa: E402
    generate_emissions, get_alignments, get_spans, load_alignment_model,
    postprocess_results, preprocess_text,
)
from deepmultilingualpunctuation import PunctuationModel  # noqa: E402
from helpers import (  # noqa: E402
    find_numeral_symbol_tokens, get_realigned_ws_mapping_with_punctuation,
    get_sentences_speaker_mapping, get_words_speaker_mapping, langs_to_iso,
    process_language_arg, punct_model_langs, write_srt,
)
from diarization import MSDDDiarizer  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
WHISPER_CT = {"cpu": "int8", "cuda": "float16"}[DEVICE]
ALIGN_DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
VIDEO_EXTS = (".mkv", ".mp4", ".webm", ".m4a", ".mp3", ".wav")
SRT_TS = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")


# --- models (loaded once) ----------------------------------------------------

class Models:
    def __init__(self, whisper_model, batch_size):
        from demucs.api import Separator
        print(f"loading models on {DEVICE} ...", flush=True)
        self.batch_size = batch_size
        self.whisper = faster_whisper.WhisperModel(
            whisper_model, device=DEVICE, compute_type=WHISPER_CT)
        self.whisper_pipe = faster_whisper.BatchedInferencePipeline(self.whisper)
        self.align_model, self.align_tokenizer = load_alignment_model(DEVICE, dtype=ALIGN_DTYPE)
        self.diarizer = MSDDDiarizer(device=DEVICE)
        self.punct = PunctuationModel(model="kredor/punctuate-all")
        self.demucs = Separator(model="htdemucs", device=DEVICE)
        print("models ready.", flush=True)


# --- core transcription (mirrors the engine's diarize.py, reusing models) ----

def separate_vocals(models, audio_wav, workdir):
    """Run Demucs and return the path to the isolated-vocals wav (or the
    original audio if separation fails)."""
    try:
        from demucs.api import save_audio
        _, stems = models.demucs.separate_audio_file(audio_wav)
        vocals = os.path.join(workdir, "vocals.wav")
        save_audio(stems["vocals"], vocals, samplerate=models.demucs.samplerate)
        return vocals
    except Exception as e:
        print(f"     (demucs failed, using original audio: {e})", flush=True)
        return audio_wav


def diarize_segments(models, audio_wav, workdir, language_arg):
    vocal_target = separate_vocals(models, audio_wav, workdir)
    audio_waveform = faster_whisper.decode_audio(vocal_target)

    transcript_segments, info = models.whisper_pipe.transcribe(
        audio_waveform, language_arg, suppress_tokens=[-1], batch_size=models.batch_size)
    full_transcript = "".join(s.text for s in transcript_segments)

    # Videos with no detectable speech (pure gameplay audio/music) yield an empty
    # transcript; alignment would assert. Return no segments instead of crashing.
    if not full_transcript.strip():
        print("     (no speech detected — empty transcript)", flush=True)
        return [], info.language

    emissions, stride = generate_emissions(
        models.align_model,
        torch.from_numpy(audio_waveform).to(models.align_model.dtype).to(models.align_model.device),
        batch_size=models.batch_size)
    tokens_starred, text_starred = preprocess_text(
        full_transcript, romanize=True, language=langs_to_iso[info.language])
    aligned, scores, blank = get_alignments(emissions, tokens_starred, models.align_tokenizer)
    spans = get_spans(tokens_starred, aligned, blank)
    word_timestamps = postprocess_results(text_starred, spans, stride, scores)

    # Diarization can abort when its VAD finds no speech (Demucs left near-silence,
    # or the audio is mostly music) even though Whisper produced text. In that case
    # keep the transcript and label it all as one speaker rather than losing it.
    try:
        speaker_ts = models.diarizer.diarize(torch.from_numpy(audio_waveform).unsqueeze(0))
    except Exception as e:
        print(f"     (diarization found no speakers: {e}; labeling as single speaker)", flush=True)
        speaker_ts = []
    if not speaker_ts:
        speaker_ts = [(0, int(len(audio_waveform) / 16000 * 1000), 0)]
    wsm = get_words_speaker_mapping(word_timestamps, speaker_ts, "start")

    if info.language in punct_model_langs:
        words_list = [x["word"] for x in wsm]
        labeled = None
        # The punctuation model errors if a chunk tokenizes past its 512-token
        # limit; shrink the chunk on failure, then give up gracefully rather
        # than crashing the whole video.
        for cs in (230, 120, 60):
            try:
                labeled = models.punct.predict(words_list, chunk_size=cs)
                break
            except Exception as e:
                print(f"     (punctuation chunk_size={cs} failed: {e})", flush=True)
        if labeled is None:
            print("     (skipping punctuation restoration for this video)", flush=True)
        else:
            ending, model_p = ".?!", ".,;:!?"
            is_acronym = lambda x: re.fullmatch(r"\b(?:[a-zA-Z]\.){2,}", x)
            for wd, labeled_tuple in zip(wsm, labeled):
                w, lbl = wd["word"], labeled_tuple[1]
                if w and lbl in ending and (w[-1] not in model_p or is_acronym(w)):
                    w += lbl
                    if w.endswith(".."):
                        w = w.rstrip(".")
                    wd["word"] = w

    wsm = get_realigned_ws_mapping_with_punctuation(wsm)
    ssm = get_sentences_speaker_mapping(wsm, speaker_ts)
    return ssm, info.language


def parse_srt(path):
    with open(path, encoding="utf-8-sig") as f:
        blocks = re.split(r"\n\s*\n", f.read().strip())
    segments = []
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        m = re.search(r"(\S+)\s*-->\s*(\S+)", lines[1])
        if not m:
            continue
        def to_s(ts):
            h, mi, s, ms = SRT_TS.match(ts).groups()
            return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms) / 1000.0
        text = " ".join(lines[2:]).strip()
        sm = re.match(r"Speaker\s+(\d+)\s*:\s*(.*)", text, re.DOTALL)
        speaker = f"SPEAKER_{int(sm.group(1)):02d}" if sm else "SPEAKER_00"
        if sm:
            text = sm.group(2).strip()
        segments.append({"start": round(to_s(m.group(1)), 3),
                         "end": round(to_s(m.group(2)), 3),
                         "speaker": speaker, "text": text})
    return segments


def ssm_to_segments(ssm, workdir):
    srt_path = os.path.join(workdir, "out.srt")
    with open(srt_path, "w", encoding="utf-8-sig") as f:
        write_srt(ssm, f)
    return parse_srt(srt_path)


# --- multilingual (code-switching) path --------------------------------------

def diarize_whole(models, audio_waveform):
    """Diarize the full audio, with the same no-speech -> single-speaker fallback."""
    try:
        speaker_ts = models.diarizer.diarize(torch.from_numpy(audio_waveform).unsqueeze(0))
    except Exception as e:
        print(f"     (diarization found no speakers: {e}; single speaker)", flush=True)
        speaker_ts = []
    if not speaker_ts:
        speaker_ts = [(0, int(len(audio_waveform) / 16000 * 1000), 0)]
    return speaker_ts


def detect_lang_restricted(models, chunk, candidates):
    """Most likely language for an audio chunk, restricted to `candidates`."""
    try:
        _, _, probs = models.whisper.detect_language(audio=chunk, vad_filter=True)
    except Exception:
        return candidates[0]
    best, best_p = candidates[0], -1.0
    for code, p in (probs or []):
        if code in candidates and p > best_p:
            best, best_p = code, p
    return best


def assign_speaker(start_s, end_s, speaker_ts):
    """Speaker label whose diarization interval overlaps [start,end] the most."""
    s_ms, e_ms = start_s * 1000.0, end_s * 1000.0
    best_spk, best_ov = 0, -1.0
    for a, b, spk in speaker_ts:
        ov = min(e_ms, b) - max(s_ms, a)
        if ov > best_ov:
            best_ov, best_spk = ov, spk
    return f"SPEAKER_{int(best_spk):02d}"


def transcribe_multilang(models, audio_wav, workdir, candidates, window_s):
    """Code-switching transcription: window the audio, detect the language of
    each window (restricted to `candidates`), transcribe each window in its own
    language, then diarize the whole file and assign a speaker per segment by
    overlap. Uses Whisper's segment timestamps (sentence-level, no forced
    alignment) and Whisper's own punctuation."""
    SR = 16000
    vocal_target = separate_vocals(models, audio_wav, workdir)
    audio = faster_whisper.decode_audio(vocal_target)
    win = max(1, int(window_s * SR))
    raw = []
    for w0 in range(0, len(audio), win):
        chunk = audio[w0:w0 + win]
        if len(chunk) < int(0.5 * SR):
            continue
        lang = detect_lang_restricted(models, chunk, candidates)
        segs, _ = models.whisper.transcribe(
            chunk, language=lang, vad_filter=True, suppress_tokens=[-1])
        off = w0 / SR
        for s in segs:
            t = s.text.strip()
            if t:
                raw.append({"start": off + s.start, "end": off + s.end,
                            "text": t, "language": lang})
    if not raw:
        print("     (no speech detected — empty transcript)", flush=True)
        return [], "multi"
    speaker_ts = diarize_whole(models, audio)
    segments = [{"start": round(r["start"], 3), "end": round(r["end"], 3),
                 "speaker": assign_speaker(r["start"], r["end"], speaker_ts),
                 "text": r["text"], "language": r["language"]} for r in raw]
    return segments, "multi"


def transcribe_video(models, audio_wav, workdir, args, language_arg):
    """Route to the multilingual path if a >1 candidate set was given, else the
    single-language forced-alignment path. Always tags each segment's language."""
    if args.lang_list and len(args.lang_list) > 1:
        return transcribe_multilang(models, audio_wav, workdir, args.lang_list, args.lang_window)
    ssm, lang = diarize_segments(models, audio_wav, workdir, language_arg)
    segments = ssm_to_segments(ssm, workdir)
    for s in segments:
        s["language"] = lang
    return segments, lang


# --- discovery / metadata ----------------------------------------------------

def find_videos(root):
    for info in sorted(glob.glob(os.path.join(root, "**", "*.info.json"), recursive=True)):
        d = os.path.dirname(info)
        media = next((h for ext in VIDEO_EXTS
                      for h in glob.glob(os.path.join(glob.escape(d), f"*{ext}"))), None)
        if media:
            yield media, info


def load_meta(info_path):
    try:
        with open(info_path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return {}
    return {k: d.get(k) for k in
            ("id", "title", "upload_date", "channel", "uploader", "duration", "webpage_url")}


def video_id_from(path, meta):
    if meta.get("id"):
        return meta["id"]
    m = re.search(r"\[([0-9A-Za-z_-]{11})\]", os.path.basename(path))
    return m.group(1) if m else os.path.splitext(os.path.basename(path))[0]


# --- ffmpeg helpers ----------------------------------------------------------

import subprocess  # noqa: E402


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def extract_audio(src, dst):
    run(["ffmpeg", "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100", dst])


# take at most this many seconds from any single segment, so a sample is a few
# varied snippets (~target_sec total) rather than one long monologue -- keeps the
# mp3 small and avoids feeding minutes of audio to the speaker-embedding model.
PART_SECONDS = 8.0


def build_speaker_samples(audio_wav, segments, out_dir, target_sec=30.0):
    os.makedirs(out_dir, exist_ok=True)
    by_spk = {}
    for s in segments:
        by_spk.setdefault(s["speaker"], []).append(s)
    made = {}
    for spk, segs in sorted(by_spk.items()):
        chosen, total = [], 0.0  # chosen = (start, end) snippets, capped per segment
        for s in sorted(segs, key=lambda x: x["end"] - x["start"], reverse=True):
            if s["end"] - s["start"] < 0.4:
                continue
            take = min(s["end"] - s["start"], PART_SECONDS)
            chosen.append((s["start"], s["start"] + take))
            total += take
            if total >= target_sec:
                break
        if not chosen:
            continue
        chosen.sort()
        with tempfile.TemporaryDirectory() as td:
            parts = []
            for i, (a, b) in enumerate(chosen):
                part = os.path.join(td, f"{i:04d}.wav")
                run(["ffmpeg", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}",
                     "-i", audio_wav, part])
                parts.append(part)
            listf = os.path.join(td, "l.txt")
            with open(listf, "w") as lf:
                lf.writelines(f"file '{p}'\n" for p in parts)
            out_mp3 = os.path.join(out_dir, f"{spk}.mp3")
            run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
                 "-ac", "1", "-b:a", "96k", out_mp3])
        made[spk] = {"file": os.path.relpath(out_mp3, OUT_ROOT),
                     "sample_seconds": round(total, 1), "segment_count": len(segs)}
    return made


# --- per-video pipeline ------------------------------------------------------
#
# Three stages run concurrently so the GPU never waits on disk/USB or ffmpeg:
#   producer (CPU threads): read source off USB + extract audio  -- runs AHEAD
#   GPU stage (main thread, ONE stream): demucs/whisper/align/diarize/punct
#   writer (CPU thread): cut speaker samples + write json/txt     -- runs BEHIND
# Only the main thread touches the models, so there is no extra VRAM use and no
# CUDA contention -- the speedup is purely from overlapping the CPU/IO work.

SENTINEL = object()


def prepare_job(media, info, args):
    """Resolve metadata + skip already-done videos. Returns a job dict or None."""
    meta = load_meta(info) if info else {}
    vid = video_id_from(media, meta)
    out_dir = os.path.join(OUT_ROOT, vid)
    json_path = os.path.join(out_dir, "transcript.json")
    if os.path.exists(json_path) and not args.force:
        return None
    return {"media": media, "meta": meta, "vid": vid,
            "out_dir": out_dir, "json_path": json_path}


def finalize_job(job, args):
    """Writer stage: cut per-speaker samples, write json + txt. Returns speakers."""
    meta, vid, segments = job["meta"], job["vid"], job["segments"]
    os.makedirs(job["out_dir"], exist_ok=True)
    samples = build_speaker_samples(job["audio"], segments,
                                    os.path.join(job["out_dir"], "speakers"),
                                    target_sec=args.sample_seconds)
    speakers = sorted({s["speaker"] for s in segments})
    languages = sorted({s["language"] for s in segments if s.get("language")})
    doc = {
        "video_id": vid,
        "title": meta.get("title"),
        "channel": meta.get("channel") or meta.get("uploader"),
        "upload_date": meta.get("upload_date"),
        "duration": meta.get("duration"),
        "language": job["lang"],
        "languages": languages,        # all languages present (per-segment)
        "webpage_url": meta.get("webpage_url") or f"https://www.youtube.com/watch?v={vid}",
        "source_path": os.path.relpath(job["media"], REPO),
        "engine": "whisper-diarization (faster-whisper large-v3 + NeMo MSDD)",
        "speakers": speakers,
        "speaker_samples": samples,
        "segments": segments,
    }
    with open(job["json_path"], "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    with open(os.path.join(job["out_dir"], "transcript.txt"), "w", encoding="utf-8") as f:
        for s in segments:
            f.write(f"[{s['speaker']}] {s['text']}\n")
    return speakers


def producer(prepared, work_root, gpu_q, failures):
    """Extract audio for each job (ahead of the GPU), feed the GPU queue."""
    for job in prepared:
        work = tempfile.mkdtemp(prefix="tx_", dir=work_root)
        try:
            job["work"] = work
            job["audio"] = os.path.join(work, "audio.wav")
            extract_audio(job["media"], job["audio"])
            gpu_q.put(job)
        except Exception as e:
            failures.append((job["media"], f"extract: {e}"))
            print(f"  !! extract FAILED {job['vid']}: {e}", flush=True)
            shutil.rmtree(work, ignore_errors=True)
    gpu_q.put(SENTINEL)


def writer(write_q, failures, args):
    """Finalize each job (behind the GPU): samples + json/txt, then clean temp."""
    while True:
        job = write_q.get()
        if job is SENTINEL:
            return
        try:
            speakers = finalize_job(job, args)
            print(f"     {job['vid']}: {len(job['segments'])} segments, "
                  f"speakers: {', '.join(speakers) or '(none)'}", flush=True)
        except Exception as e:
            failures.append((job["media"], f"write: {e}"))
            print(f"  !! write FAILED {job['vid']}: {e}", flush=True)
        finally:
            shutil.rmtree(job["work"], ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="specific media files (default: scan --input)")
    ap.add_argument("--input", default="videos",
                    help="folder of archived videos to scan (default: videos)")
    ap.add_argument("--output", default="transcripts",
                    help="folder to write transcripts into (default: transcripts)")
    ap.add_argument("--model", default="large-v3", help="faster-whisper model")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--language", default=None, help="force one language (default: auto-detect)")
    ap.add_argument("--languages", default=None,
                    help="comma-separated candidate languages for code-switching within a "
                    "video, e.g. 'nl,en,ar'. With >1, detects + transcribes per window in "
                    "each language; with 1, forces it. Overrides --language.")
    ap.add_argument("--lang-window", type=float, default=30.0,
                    help="window length (s) for per-window language detection in multi-language mode")
    ap.add_argument("--sample-seconds", type=float, default=30.0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    args.lang_list = [c.strip() for c in args.languages.split(",") if c.strip()] if args.languages else []
    if len(args.lang_list) == 1:                 # single candidate == force that language
        language_arg = args.lang_list[0]
    elif len(args.lang_list) > 1:
        language_arg = None                      # multilingual path detects per window
        print(f"multi-language mode: {', '.join(args.lang_list)} "
              f"({args.lang_window:.0f}s windows)")
    else:
        language_arg = process_language_arg(args.language, args.model)

    global OUT_ROOT
    OUT_ROOT = os.path.abspath(args.output)

    jobs = [(p, None) for p in args.paths] if args.paths else list(find_videos(os.path.abspath(args.input)))
    print(f"found {len(jobs)} video(s)")
    prepared = [j for j in (prepare_job(m, i, args) for m, i in jobs) if j]
    skipped = len(jobs) - len(prepared)
    if skipped:
        print(f"skipping {skipped} already transcribed (use --force to redo)")
    if not prepared:
        print("nothing to do.")
        return
    print(f"transcribing {len(prepared)} video(s)")

    # temp audio lives on the output disk (not /tmp, which may be RAM-backed and
    # would blow up on hour-long wavs); bounded queue caps in-flight extractions.
    work_root = os.path.join(OUT_ROOT, ".work")
    os.makedirs(work_root, exist_ok=True)

    models = Models(args.model, args.batch_size)
    failures = []
    gpu_q = queue.Queue(maxsize=2)      # at most ~2 extracted audios waiting
    write_q = queue.Queue(maxsize=4)

    pt = threading.Thread(target=producer, args=(prepared, work_root, gpu_q, failures), daemon=True)
    wt = threading.Thread(target=writer, args=(write_q, failures, args), daemon=True)
    pt.start()
    wt.start()

    # GPU stage: single stream, main thread only.
    while True:
        job = gpu_q.get()
        if job is SENTINEL:
            break
        print(f"  -> {job['vid']}  {(job['meta'].get('title') or '')[:60]}", flush=True)
        try:
            job["segments"], job["lang"] = transcribe_video(
                models, job["audio"], job["work"], args, language_arg)
            write_q.put(job)              # hand off; writer cleans job["work"]
        except Exception as e:
            traceback.print_exc()
            print(f"  !! FAILED {job['vid']}: {e}", flush=True)
            failures.append((job["media"], str(e)))
            shutil.rmtree(job["work"], ignore_errors=True)

    write_q.put(SENTINEL)
    wt.join()
    pt.join()
    shutil.rmtree(work_root, ignore_errors=True)

    if failures:
        print(f"\n{len(failures)} failure(s):")
        for m, e in failures:
            print(f"  - {m}: {e}")
        sys.exit(1)
    print("done")


if __name__ == "__main__":
    main()
