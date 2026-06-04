#!/usr/bin/env python3
"""
Cross-video speaker clustering (additive, non-destructive).

Each video was diarized independently, so its SPEAKER_00/01 labels are local and
arbitrary. This pass links them across the whole archive: it computes a TitaNet
voiceprint for every (video, local-speaker) cluster -- reusing the per-speaker
audio samples transcribe.py already saved -- clusters those voiceprints, and
assigns archive-wide GLOBAL_xx identities (GLOBAL_00 = most-talking, usually the
channel owner).

It NEVER edits the per-video diarization. Each segment keeps its original local
`speaker`; we only add a parallel `global_speaker` overlay you can ignore or
hand-correct. Re-run any time with a different --threshold; it's idempotent.

Outputs:
  transcripts/speakers.json          authoritative global map (members + clips)
  transcripts/<id>/transcript.json   gains `global_speaker` per segment +
                                     a `global_speaker_map` at the top level
                                     (the local `speaker` field is untouched)

Usage:
  .venv/bin/python cluster_speakers.py
  .venv/bin/python cluster_speakers.py --threshold 0.55   # bigger = merge more
  .venv/bin/python cluster_speakers.py --no-write-back    # only speakers.json
"""
import glob
import os
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
VENV_LIB = os.path.join(REPO, ".venv", "lib")
OUT_ROOT = os.path.join(REPO, "transcripts")


def _ensure_cuda_libs():
    libdirs = sorted(glob.glob(os.path.join(
        VENV_LIB, "python*", "site-packages", "nvidia", "*", "lib")))
    cur = os.environ.get("LD_LIBRARY_PATH", "")
    if libdirs and any(d not in cur.split(os.pathsep) for d in libdirs) \
            and not os.environ.get("_CLUSTER_REEXEC"):
        os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(libdirs + ([cur] if cur else []))
        os.environ["_CLUSTER_REEXEC"] = "1"
        os.execv(sys.executable, [sys.executable] + sys.argv)


_ensure_cuda_libs()
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import argparse  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

logging.getLogger("nemo_logger").setLevel(logging.ERROR)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def load_embedder():
    from nemo.collections.asr.models import EncDecSpeakerLabelModel
    print(f"loading TitaNet speaker model on {DEVICE} ...", flush=True)
    m = EncDecSpeakerLabelModel.from_pretrained("titanet_large")
    return m.to(DEVICE).eval()


# A few seconds of clean speech is plenty for a TitaNet voiceprint; feeding a
# multi-minute clip blows up the attentive-pooling tensors (OOM on long videos).
EMBED_SECONDS = 20


def embed_clip(model, clip_path):
    """16k-mono-resample (capped to EMBED_SECONDS), return an L2-normalized
    embedding vector. Falls back to CPU if the GPU is momentarily out of memory."""
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "c.wav")
        subprocess.run(["ffmpeg", "-y", "-t", str(EMBED_SECONDS), "-i", clip_path,
                        "-ac", "1", "-ar", "16000", wav],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with torch.no_grad():
                emb = model.get_embedding(wav).squeeze()
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            with torch.no_grad():
                emb = model.to("cpu").get_embedding(wav).squeeze()
            model.to(DEVICE)
    v = emb.detach().cpu().numpy().astype("float64")
    n = np.linalg.norm(v)
    return v / n if n else v


def gather_clusters():
    """Return list of dicts, one per (video, local speaker) that has a sample."""
    items = []
    for jpath in sorted(glob.glob(os.path.join(OUT_ROOT, "*", "transcript.json"))):
        d = json.load(open(jpath, encoding="utf-8"))
        samples = d.get("speaker_samples", {})
        for spk, meta in samples.items():
            clip = os.path.join(OUT_ROOT, meta["file"])
            if os.path.exists(clip):
                items.append({
                    "video_id": d["video_id"],
                    "title": d.get("title"),
                    "local": spk,
                    "clip": clip,
                    "segments": meta.get("segment_count", 0),
                    "json": jpath,
                })
    return items


CACHE = os.path.join(OUT_ROOT, ".speaker_embeddings.npz")


def load_cache():
    if not os.path.exists(CACHE):
        return {}
    z = np.load(CACHE, allow_pickle=True)
    return {k: e for k, e in zip(z["keys"], z["embs"])}


def save_cache(cache):
    keys = list(cache.keys())
    np.savez(CACHE, keys=np.array(keys, dtype=object),
             embs=np.vstack([cache[k] for k in keys]) if keys else np.zeros((0, 1)))


def cluster(embeddings, threshold):
    from sklearn.cluster import AgglomerativeClustering
    if len(embeddings) == 1:
        return np.array([0])
    clu = AgglomerativeClustering(
        n_clusters=None, distance_threshold=threshold,
        metric="cosine", linkage="average")
    return clu.fit_predict(np.vstack(embeddings))


def analyze(items, embs):
    """Print the distance structure so a threshold can be chosen from the data,
    not by eyeballing labels. Looks for a stable gap (cluster count flat over a
    range) and the margin to the nearest different speaker."""
    X = np.vstack(embs)
    print("\n=== threshold sweep (look for a flat, stable range) ===")
    prev = None
    for t in [round(0.30 + 0.025 * i, 3) for i in range(21)]:  # 0.30 .. 0.80
        n = len(set(cluster(embs, t)))
        flag = "  <-- count changes" if (prev is not None and n != prev) else ""
        print(f"  threshold {t:.3f} -> {n:2d} global speakers{flag}")
        prev = n
    # nearest-neighbor distance from the top cluster (host) at default 0.5
    labels = cluster(embs, 0.5)
    groups = {}
    for it, l in zip(items, labels):
        groups.setdefault(int(l), []).append((it, embs[items.index(it)]))
    ordered = sorted(groups.items(), key=lambda kv: -sum(i["segments"] for i, _ in kv[1]))
    cents = {gi: np.mean([e for _, e in mem], axis=0) for gi, (_, mem) in enumerate(
        [(k, v) for k, v in ordered])}
    print("\n=== centroid cosine distances between the (0.5) global speakers ===")
    gids = list(cents)
    def cos_d(a, b):
        return 1 - float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    print("      " + " ".join(f"G{j:02d}" for j in gids))
    for i in gids:
        row = " ".join(f"{cos_d(cents[i], cents[j]):.2f}" for j in gids)
        print(f"  G{i:02d} {row}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--threshold", type=float, default=0.47,
                    help="cosine-distance merge threshold (0=identical, higher=merge more). "
                    "0.47 sits mid-plateau (0.45-0.50): keeps distinct people apart (e.g. the "
                    "co-op friend vs the host) while unifying each across videos. Above ~0.52 "
                    "it starts over-merging different speakers. Re-run --analyze on a new set.")
    ap.add_argument("--no-write-back", action="store_true",
                    help="only write transcripts/speakers.json, don't touch transcript.json files")
    ap.add_argument("--analyze", action="store_true",
                    help="print the threshold sweep + distance structure and exit (writes nothing)")
    ap.add_argument("--recompute", action="store_true",
                    help="ignore the embedding cache and re-embed every clip")
    ap.add_argument("--transcripts", default="transcripts",
                    help="transcripts folder produced by transcribe.py; it is read and, "
                    "unless --no-write-back, augmented in place (default: transcripts)")
    args = ap.parse_args()

    global OUT_ROOT, CACHE
    OUT_ROOT = os.path.abspath(args.transcripts)
    CACHE = os.path.join(OUT_ROOT, ".speaker_embeddings.npz")

    items = gather_clusters()
    if not items:
        sys.exit("no speaker samples found under transcripts/ (run transcribe.py first)")
    print(f"found {len(items)} local speaker clusters across "
          f"{len({i['video_id'] for i in items})} videos", flush=True)

    # embeddings are cached; threshold sweeps don't re-run the model
    cache = {} if args.recompute else load_cache()
    missing = [it for it in items if f"{it['video_id']}/{it['local']}" not in cache]
    if missing:
        print(f"embedding {len(missing)} clusters (cached progress saved as we go)", flush=True)
        model = load_embedder()
        for n, it in enumerate(missing, 1):
            cache[f"{it['video_id']}/{it['local']}"] = embed_clip(model, it["clip"])
            if n % 25 == 0:
                save_cache(cache)
                print(f"  embedded {n}/{len(missing)} (progress cached)", flush=True)
        save_cache(cache)
        print(f"  embedded {len(missing)}/{len(missing)}", flush=True)
    else:
        print("using cached embeddings (all clips present)", flush=True)
    embs = [cache[f"{it['video_id']}/{it['local']}"] for it in items]

    if args.analyze:
        analyze(items, embs)
        return

    labels = cluster(embs, args.threshold)

    # group, then order global ids by total segments (most-talking = GLOBAL_00)
    groups = {}
    for it, lab in zip(items, labels):
        groups.setdefault(int(lab), []).append(it)
    ordered = sorted(groups.values(), key=lambda g: -sum(i["segments"] for i in g))
    gid_of = {}  # (video_id, local) -> GLOBAL_xx
    global_map = {}
    for gi, members in enumerate(ordered):
        gid = f"GLOBAL_{gi:02d}"
        for m in members:
            gid_of[(m["video_id"], m["local"])] = gid
        global_map[gid] = {
            "total_segments": sum(m["segments"] for m in members),
            "member_count": len(members),
            "members": [{"video_id": m["video_id"], "title": m["title"],
                         "local_speaker": m["local"], "segments": m["segments"],
                         "sample_clip": os.path.relpath(m["clip"], OUT_ROOT)}
                        for m in members],
        }

    side = {"threshold": args.threshold, "global_speakers": global_map}
    with open(os.path.join(OUT_ROOT, "speakers.json"), "w", encoding="utf-8") as f:
        json.dump(side, f, ensure_ascii=False, indent=2)

    print("\n=== global speakers (most-talking first) ===")
    for gid, info in global_map.items():
        vids = ", ".join(f"{m['video_id']}/{m['local_speaker']}" for m in info["members"][:6])
        more = "" if info["member_count"] <= 6 else f" +{info['member_count']-6} more"
        print(f"{gid}: {info['member_count']} clusters, {info['total_segments']} segs  [{vids}{more}]")

    if not args.no_write_back:
        for jpath in sorted(glob.glob(os.path.join(OUT_ROOT, "*", "transcript.json"))):
            d = json.load(open(jpath, encoding="utf-8"))
            vid = d["video_id"]
            local_to_global = {}
            for s in d["segments"]:
                g = gid_of.get((vid, s["speaker"]))
                s["global_speaker"] = g          # additive; local `speaker` kept
                if g:
                    local_to_global[s["speaker"]] = g
            d["global_speaker_map"] = local_to_global
            with open(jpath, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
        print(f"\nwrote speakers.json + added global_speaker to {len(items)} clusters' segments")
    else:
        print("\nwrote speakers.json only (--no-write-back)")


if __name__ == "__main__":
    main()
