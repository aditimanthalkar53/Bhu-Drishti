from aeqe.speech import pick_language


def test_pick_language_prefers_allowed_languages():
    # Whisper's top guess (Arabic) is not a language this service expects; the best allowed one wins
    probs = [("ar", 0.5), ("hi", 0.3), ("ur", 0.15), ("en", 0.05)]
    assert pick_language(probs, ["en", "hi", "ur"]) == ("hi", 0.3)


def test_pick_language_falls_back_to_overall_best():
    assert pick_language([("fr", 0.9), ("de", 0.1)], ["hi", "kn"]) == ("fr", 0.9)
    assert pick_language([], ["hi"]) == ("en", 0.0)


def test_decode_resamples_to_16k_mono_and_caps_length():
    import io
    import wave

    import numpy as np

    from aeqe.speech import decode

    rate, seconds = 44100, 3
    t = np.arange(rate * seconds) / rate
    tone = (np.sin(2 * np.pi * 440 * t) * 0.5 * 32767).astype("<i2")
    stereo = np.repeat(tone[:, None], 2, axis=1)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(rate); w.writeframes(stereo.tobytes())
    samples = decode(buf.getvalue())
    assert samples.dtype == np.float32
    assert abs(samples.size - 16000 * seconds) < 400, samples.size
    assert 0.3 < float(np.abs(samples).max()) <= 1.0
    assert decode(buf.getvalue(), max_seconds=1).size == 16000
