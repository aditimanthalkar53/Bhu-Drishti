"""Speech to text for citizens' voice messages, run locally with faster-whisper (Whisper on CTranslate2, CPU by default).

Browsers' own speech recognition is unreliable (Edge fails with "network", Brave and Firefox have none) and must be
told the language in advance. Here the recording is sent to our own server, Whisper detects the language itself, and
nothing leaves the machine.

Language detection is limited to the languages people in India are likely to speak (WHISPER_LANGUAGES). Without that,
Whisper often labels Hindi speech as Urdu and writes it in Urdu script, or Assamese as Bengali; restricting the choice
to plausible languages and taking the most probable among them avoids both.

Settings: WHISPER_MODEL (default "small", ~480 MB, downloaded once on first use), WHISPER_DEVICE (cpu | cuda),
WHISPER_COMPUTE (int8 on CPU), WHISPER_DIR (where models are kept), WHISPER_LANGUAGES (comma-separated ISO codes).
"""
from __future__ import annotations

import io
import os
import threading
import time
from typing import Any, Optional

MODEL = os.getenv("WHISPER_MODEL", "small")
LANGUAGES = [code.strip() for code in os.getenv(
    "WHISPER_LANGUAGES", "en,hi,kn,as,bn,mr,ta,te,ml,gu,pa,or,ne,ur").split(",") if code.strip()]
MAX_SECONDS = 120          # a voice message, not a meeting: longer recordings are cut here
SAMPLE_RATE = 16000

_model: Any = None
_load_lock = threading.Lock()
_run_lock = threading.Lock()   # one transcription at a time keeps a CPU-only machine responsive


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def loaded() -> bool:
    return _model is not None


def _get_model():
    global _model
    with _load_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            _model = WhisperModel(MODEL, device=os.getenv("WHISPER_DEVICE", "cpu"),
                                  compute_type=os.getenv("WHISPER_COMPUTE", "int8"),
                                  download_root=os.getenv("WHISPER_DIR") or None)
        return _model


def pick_language(all_probs: list[tuple[str, float]], allowed: list[str]) -> tuple[str, float]:
    """The most probable language among `allowed`; Whisper's overall best if none of them scored at all."""
    scores = dict(all_probs)
    candidates = [(code, scores.get(code, 0.0)) for code in allowed]
    best = max(candidates, key=lambda c: c[1], default=("", 0.0))
    if best[1] > 0:
        return best
    return max(all_probs, key=lambda c: c[1]) if all_probs else ("en", 0.0)


def decode(audio: bytes, max_seconds: float = MAX_SECONDS):
    """Mono float32 samples at 16 kHz from any format PyAV reads (webm/opus, ogg, mp4/aac, wav).

    Done here rather than with faster_whisper.decode_audio, which passes an argument that PyAV 16+ no longer accepts.
    """
    import av
    import numpy as np

    limit = int(max_seconds * SAMPLE_RATE)
    chunks, total = [], 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(io.BytesIO(audio), mode="r") as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
                total += chunks[-1].size
            if total >= limit:
                break
        for out in resampler.resample(None):   # flush
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return (np.concatenate(chunks)[:limit].astype(np.float32) / 32768.0)


def transcribe(audio: bytes, language: Optional[str] = None) -> dict:
    """Text and detected language of one recording (any format PyAV can read: webm/opus, ogg, mp4/aac, wav)."""
    started = time.time()
    samples = decode(audio)
    duration = len(samples) / SAMPLE_RATE
    if duration < 0.3:
        return {"text": "", "language": language or "und", "language_probability": 0.0,
                "duration_s": round(duration, 1), "model": MODEL, "seconds": 0.0}
    model = _get_model()
    with _run_lock:
        if duration <= WINDOW_S:
            text, lang, prob = _one_window(model, samples, language)
        else:
            text, lang, prob = _long(model, samples, language)
    return {"text": text, "language": lang, "language_probability": round(float(prob), 3),
            "duration_s": round(duration, 1), "model": MODEL, "seconds": round(time.time() - started, 1)}


WINDOW_S = 30   # Whisper always encodes a fixed 30-second window


def _choose(all_probs: list[tuple[str, float]]) -> tuple[str, float]:
    lang, prob = pick_language(all_probs, LANGUAGES)
    # Hindi and Urdu sound the same; the people using this write Hindi in Devanagari
    if lang == "ur" and "hi" in LANGUAGES:
        lang = "hi"
    return lang, prob


def _one_window(model, samples, language: Optional[str]) -> tuple[str, str, float]:
    """Most voice messages: encode the audio ONCE and use that for both language detection and decoding.

    Going through model.detect_language() and then model.transcribe() runs Whisper's encoder twice over the same
    30-second window, which is most of the cost on a CPU (~2.5 s each for "small").
    """
    from faster_whisper.tokenizer import Tokenizer

    features = model.feature_extractor(samples)
    frames = model.feature_extractor.nb_max_frames
    features = features[:, :frames]
    if features.shape[-1] < frames:   # pad to the full window, as Whisper was trained
        import numpy as np
        features = np.pad(features, ((0, 0), (0, frames - features.shape[-1])))
    encoded = model.encode(features)
    if language:
        lang, prob = language, 1.0
    else:
        probs = model.model.detect_language(encoded)[0]   # [("<|en|>", p), …]
        lang, prob = _choose([(token[2:-2], p) for token, p in probs])
    tok = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language=lang)
    result = model.model.generate(encoded, [list(tok.sot_sequence) + [tok.no_timestamps]], beam_size=1,
                                  max_length=448, suppress_blank=True, suppress_tokens=[-1], return_no_speech_prob=True)[0]
    if result.no_speech_prob > 0.6:
        return "", lang, prob
    ids = [t for t in result.sequences_ids[0] if t < tok.eot]
    return tok.decode(ids).strip(), lang, prob


def _long(model, samples, language: Optional[str]) -> tuple[str, str, float]:
    """Recordings longer than one window: detect once, then let faster-whisper walk the windows."""
    if language:
        lang, prob = language, 1.0
    else:
        _, _, all_probs = model.detect_language(samples, vad_filter=True)
        lang, prob = _choose(all_probs)
    segments, _ = model.transcribe(samples, language=lang, task="transcribe", beam_size=1, vad_filter=True,
                                   condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segments).strip(), lang, prob
