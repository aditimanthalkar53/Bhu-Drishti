"""AEQE — Anytime Earth-observation Query Engine.

The engine compiles a natural-language question into a typed query plan once,
uses cheap precomputed signals (annual satellite embeddings, coarse event
proxies) to stratify the area of interest into tiles, and runs expensive
specialist models ("oracles") only on a statistically designed sample of tiles.
It streams an estimate whose confidence interval narrows as compute is spent.
"""

__version__ = "0.2.0"
