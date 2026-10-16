#!/usr/bin/env python3
"""Long-lived EmbeddingGemma 2 embedding worker (text-only).

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.

Request shapes
--------------
{"id": 1, "op": "ping"}
{"id": 2, "op": "embed", "kind": "query"|"doc", "texts": ["..."], "keys": ["..."]}
{"id": 3, "op": "shutdown"}

* ``kind`` selects the task prefix.  ``"query"`` applies the model's
  ``SearchQuery`` prompt (``task: search result | query: {q}``).  ``"doc"``
  assumes the caller already formatted the text as
  ``title: {title} | text: {abstract}`` and applies no prompt.
* ``keys`` is optional and, when given, must have one entry per text.  It is
  the on-disk cache key (the caller composes ``model + doc id + text hash``).
  Without it the sha1 of the kind plus the text is used, so a re-run never
  re-embeds the same text.
* The cache directory is ``EMBED_CACHE_DIR`` (default
  ``~/.cache/outreach-embeddings``).  The model is ``EMBED_MODEL`` (default
  ``google/embeddinggemma-2``); the device is ``EMBED_DEVICE`` (``auto``,
  ``mps`` or ``cpu``).

Response shapes
---------------
{"id": 1, "ok": true, "model": "...", "device": "...", "dim": 768,
 "vectors": [[...]], "cached": [false, ...], "encoded": 2, "ms": 41.2}
{"id": 1, "ok": false, "error": "..."}

Embeddings are always float32 (never float16) and L2-normalized.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import traceback
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

DEFAULT_MODEL = "google/embeddinggemma-2"
DIM = 768
BATCH_SIZE = 16
# Title + first ~350 words of an abstract carry the topic; full-length fp32 attention on MPS is quadratic and
# made 600 real abstracts take >30 min. Long texts are truncated to this many tokens.
MAX_SEQ_TOKENS = 512

HERE = Path(__file__).resolve().parent
QUERY_PROMPT_NAME = "SearchQuery"


def _cache_dir() -> Path:
    raw = os.environ.get("EMBED_CACHE_DIR")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".cache" / "outreach-embeddings"


def _log(msg: str) -> None:
    """Diagnostics go to stderr so stdout stays a clean JSONL channel."""
    print(f"[embed] {msg}", file=sys.stderr, flush=True)


class Cache:
    """SQLite cache of normalized vectors keyed by (model, kind, key)."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS embeddings ("
            "  model TEXT NOT NULL,"
            "  kind TEXT NOT NULL,"
            "  key TEXT NOT NULL,"
            "  dim INTEGER NOT NULL,"
            "  vec BLOB NOT NULL,"
            "  PRIMARY KEY (model, kind, key)"
            ")"
        )
        self._db.commit()

    def get_many(self, model: str, kind: str, keys: list[str]) -> list[bytes | None]:
        out: list[bytes | None] = []
        with self._lock:
            cur = self._db.cursor()
            for key in keys:
                row = cur.execute(
                    "SELECT dim, vec FROM embeddings WHERE model=? AND kind=? AND key=?",
                    (model, kind, key),
                ).fetchone()
                # Reject short/corrupt blobs so a bad row cannot poison a run.
                if row is None or int(row[0]) != DIM:
                    out.append(None)
                    continue
                blob = bytes(row[1])
                if len(blob) != DIM * 4:
                    out.append(None)
                    continue
                out.append(blob)
        return out

    def put_many(self, model: str, kind: str, items: list[tuple[str, bytes]]) -> None:
        if not items:
            return
        with self._lock:
            self._db.executemany(
                "INSERT OR REPLACE INTO embeddings (model, kind, key, dim, vec) VALUES (?,?,?,?,?)",
                [(model, kind, key, DIM, blob) for key, blob in items],
            )
            self._db.commit()

    def count(self, model: str) -> int:
        with self._lock:
            return int(
                self._db.execute(
                    "SELECT COUNT(*) FROM embeddings WHERE model=?", (model,)
                ).fetchone()[0]
            )


def _text_key(kind: str, text: str) -> str:
    return f"{kind}:sha1:{hashlib.sha1(text.encode('utf-8')).hexdigest()}"


class Embedder:
    def __init__(self, model_name: str, device: str | None = None) -> None:
        import numpy as np  # noqa: F401  (availability check for a clear error)
        import torch
        from sentence_transformers import SentenceTransformer

        self.torch = torch
        self.model_name = model_name
        self.cache = Cache(_cache_dir() / "embeddings.sqlite")

        requested = (device or os.environ.get("EMBED_DEVICE") or "auto").lower()
        candidates: list[str]
        if requested in ("auto", ""):
            candidates = (["mps", "cpu"] if torch.backends.mps.is_available() else ["cpu"])
        else:
            candidates = [requested]

        last_error: Exception | None = None
        for candidate in candidates:
            try:
                _log(f"loading {model_name} on {candidate} (float32, text-only)")
                model = SentenceTransformer(
                    model_name,
                    device=candidate,
                    model_kwargs={"dtype": torch.float32},
                    config_kwargs={"vision_config": None, "audio_config": None},
                )
                model.max_seq_length = min(model.max_seq_length or MAX_SEQ_TOKENS, MAX_SEQ_TOKENS)
                probe = model.encode(
                    ["warmup"],
                    batch_size=1,
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                )
                if int(probe.shape[1]) != DIM:
                    raise RuntimeError(
                        f"unexpected embedding dim {probe.shape[1]} (expected {DIM})"
                    )
                self.model = model
                self.device = candidate
                self.dtype = "float32"
                return
            except Exception as exc:  # noqa: BLE001 - device fallback by design
                last_error = exc
                _log(f"{candidate} failed: {type(exc).__name__}: {exc}")
        raise RuntimeError(f"could not load {model_name}: {last_error}")

    def embed(
        self, kind: str, texts: list[str], keys: list[str] | None
    ) -> tuple[list[list[float]], list[bool], int, float]:
        import numpy as np

        if kind not in ("query", "doc"):
            raise ValueError(f"unknown kind {kind!r}")
        if keys is not None and len(keys) != len(texts):
            raise ValueError("keys and texts must have the same length")

        cache_keys = [
            str(keys[i]) if keys is not None and keys[i] else _text_key(kind, texts[i])
            for i in range(len(texts))
        ]

        cached_blobs = self.cache.get_many(self.model_name, kind, cache_keys)
        vectors: list[list[float] | None] = [None] * len(texts)
        cached_flags = [blob is not None for blob in cached_blobs]
        for i, blob in enumerate(cached_blobs):
            if blob is not None:
                vectors[i] = np.frombuffer(blob, dtype=np.float32).tolist()

        # Length-sorted so each batch pads to similar lengths.
        missing = sorted((i for i, blob in enumerate(cached_blobs) if blob is None), key=lambda i: len(texts[i]))
        encoded = 0
        elapsed_ms = 0.0
        if missing:
            _log(f"embedding {len(missing)}/{len(texts)} {kind} texts on {self.device}")
            to_store: list[tuple[str, bytes]] = []
            started = time.perf_counter()
            for start in range(0, len(missing), BATCH_SIZE):
                chunk = missing[start : start + BATCH_SIZE]
                batch = [texts[i] for i in chunk]
                kwargs = {
                    "batch_size": BATCH_SIZE,
                    "normalize_embeddings": True,
                    "convert_to_numpy": True,
                    "show_progress_bar": False,
                }
                if kind == "query":
                    kwargs["prompt_name"] = QUERY_PROMPT_NAME
                emb = self.model.encode(batch, **kwargs)
                emb = np.asarray(emb, dtype=np.float32)
                if emb.ndim == 1:
                    emb = emb.reshape(1, -1)
                if emb.shape[1] != DIM:
                    raise RuntimeError(f"unexpected embedding dim {emb.shape[1]}")
                for row, idx in zip(emb, chunk):
                    row = np.ascontiguousarray(row, dtype=np.float32)
                    if not np.isfinite(row).all():
                        raise RuntimeError(f"non-finite embedding for key {cache_keys[idx]}")
                    vectors[idx] = row.tolist()
                    to_store.append((cache_keys[idx], row.tobytes()))
                encoded += len(chunk)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            # Only persist fully valid batches.
            self.cache.put_many(self.model_name, kind, to_store)

        return [v if v is not None else [] for v in vectors], cached_flags, encoded, elapsed_ms


def main() -> int:
    model_name = os.environ.get("EMBED_MODEL") or DEFAULT_MODEL
    embedder = Embedder(model_name, os.environ.get("EMBED_DEVICE"))
    _log(f"ready: {model_name} on {embedder.device}, cache={embedder.cache.count(model_name)} vectors")

    print(
        json.dumps(
            {
                "id": "ready",
                "ok": True,
                "model": model_name,
                "device": embedder.device,
                "dtype": embedder.dtype,
                "dim": DIM,
                "cacheDir": str(_cache_dir()),
                "cached": embedder.cache.count(model_name),
            }
        ),
        flush=True,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"id": None, "ok": False, "error": f"bad json: {exc}"}), flush=True)
            continue

        req_id = req.get("id")
        op = req.get("op", "embed")
        try:
            if op == "ping":
                print(json.dumps({"id": req_id, "ok": True, "pong": True}), flush=True)
                continue
            if op == "shutdown":
                print(json.dumps({"id": req_id, "ok": True, "shutdown": True}), flush=True)
                return 0
            if op != "embed":
                raise ValueError(f"unknown op {op!r}")

            texts = req.get("texts") or []
            if not isinstance(texts, list):
                raise ValueError("texts must be a list")
            vectors, cached, encoded, ms = embedder.embed(
                str(req.get("kind", "doc")), [str(t) for t in texts], req.get("keys")
            )
            print(
                json.dumps(
                    {
                        "id": req_id,
                        "ok": True,
                        "model": model_name,
                        "device": embedder.device,
                        "dim": DIM,
                        "vectors": vectors,
                        "cached": cached,
                        "encoded": encoded,
                        "ms": ms,
                    }
                ),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the worker
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"id": req_id, "ok": False, "error": str(exc)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
