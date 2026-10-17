"""Sampling design and estimators.

Design
------
Tiles are split into H strata by quantiles of a cheap proxy score (finer at the
top so rare targets get their own strata). Within each stratum, tiles are
visited in a seeded random order, so every batch is a simple random sample
without replacement (SRSWOR) within strata. Strata are fixed for the run;
only the *allocation* of new samples adapts (sequential Neyman allocation).

Estimators
----------
* Stratified expansion estimator (Cochran 1977; Olofsson et al. 2014 for EO
  area estimation):  Ŷ = Σ_h N_h ȳ_h,  V = Σ_h N_h² (1 − n_h/N_h) s_h² / n_h.
* Cross-fitted difference estimator (model-assisted / cross-prediction-powered
  inference, Zrnic & Candès 2024): a ridge model f predicts y from cheap
  features for *every* tile; oracle samples only correct its bias:
      Ŷ = Σ_{i∈U} f̄(x_i) + Σ_h N_h · mean_{i∈S_h}(y_i − f_{−k(i)}(x_i))
  where f_{−k} is fitted without fold k, so residuals are out-of-sample.
  If the proxy is good, residual variance ≪ y variance and the interval is
  much narrower for the same number of oracle calls. If the proxy is useless,
  it degrades gracefully towards the stratified estimator.

Both intervals cover *what the oracle would report over the whole population*.
They do not cover the oracle's own error against reality.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy import stats

STRATUM_EDGES = (0.0, 0.30, 0.55, 0.75, 0.88, 0.96, 1.0)
MIN_PER_STRATUM = 3
ALLOC_FLOOR = 0.10  # every stratum keeps ≥ this share of the pooled SD in Neyman allocation
CROSSFIT_MIN_N = 30
RIDGE_LAMBDA = 5.0


def build_strata(score: np.ndarray, edges=STRATUM_EDGES) -> np.ndarray:
    """Assign stratum ids 0..H-1 by rank quantiles of ``score`` (0 = lowest)."""
    n = len(score)
    order = np.argsort(score, kind="mergesort")
    ranks = np.empty(n, dtype=float)
    ranks[order] = (np.arange(n) + 0.5) / n
    strata = np.searchsorted(np.asarray(edges[1:-1]), ranks, side="right")
    # merge strata that would be too small to estimate a variance
    for h in range(len(edges) - 1):
        if 0 < (strata == h).sum() < 2 * MIN_PER_STRATUM and h > 0:
            strata[strata == h] = h - 1
    _, strata = np.unique(strata, return_inverse=True)
    return strata.astype(int)


class RidgeProxy:
    """Small ridge regression on standardised features (closed form)."""

    def __init__(self, lam: float = RIDGE_LAMBDA):
        self.lam = lam
        self.mu = self.sd = self.beta = None
        self.intercept = 0.0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "RidgeProxy":
        self.mu = X.mean(0)
        self.sd = X.std(0) + 1e-9
        Z = (X - self.mu) / self.sd
        self.intercept = float(y.mean())
        yc = y - self.intercept
        p = Z.shape[1]
        self.beta = np.linalg.solve(Z.T @ Z + self.lam * np.eye(p), Z.T @ yc)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.intercept + ((X - self.mu) / self.sd) @ self.beta


@dataclass
class Estimate:
    estimate: float          # total (Ŷ) in oracle units
    se: float
    lo: float
    hi: float
    df: int
    method: str
    n: int
    r2: Optional[float] = None   # out-of-fold R² of the proxy model, if used
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        d = {
            "estimate": float(self.estimate),
            "se": float(self.se),
            "lo": float(self.lo),
            "hi": float(self.hi),
            "df": int(self.df),
            "method": self.method,
            "n": int(self.n),
        }
        if self.r2 is not None:
            d["proxy_r2"] = round(float(self.r2), 4)
        d.update(self.extra)
        return d


class SampleState:
    """Book-keeping for a stratified sequential sample."""

    def __init__(self, strata: np.ndarray, seed: int, n_folds: int = 2):
        self.seed = int(seed)
        self.strata = strata
        self.H = int(strata.max()) + 1
        self.N_h = np.bincount(strata, minlength=self.H)
        rng = np.random.default_rng(seed)
        self.queues = [rng.permutation(np.flatnonzero(strata == h)) for h in range(self.H)]
        self.cursor = np.zeros(self.H, dtype=int)
        self.y = np.full(len(strata), np.nan)
        self.sampled = np.zeros(len(strata), dtype=bool)
        self.fold = rng.integers(0, n_folds, size=len(strata))
        self.n_folds = n_folds
        self.order: list[int] = []

    @property
    def n(self) -> int:
        return int(self.sampled.sum())

    def n_h(self) -> np.ndarray:
        return np.bincount(self.strata[self.sampled], minlength=self.H)

    def remaining_h(self) -> np.ndarray:
        return self.N_h - self.cursor

    def take(self, alloc: np.ndarray) -> list[int]:
        out: list[int] = []
        for h in range(self.H):
            k = int(min(alloc[h], self.remaining_h()[h]))
            out.extend(int(i) for i in self.queues[h][self.cursor[h] : self.cursor[h] + k])
            self.cursor[h] += k
        return out

    def record(self, idx: int, value: float) -> None:
        self.y[idx] = value
        self.sampled[idx] = True
        self.order.append(idx)

    # ---------------------------------------------------------------- allocation
    def allocate(self, batch: int, weights: Optional[np.ndarray] = None) -> np.ndarray:
        """Sequential Neyman allocation of the next ``batch`` samples.

        ``weights`` (per stratum, ≥0) are the quantities whose spread drives
        allocation — std. dev. of y or of residuals. A floor keeps every
        stratum alive so an all-zero stratum is still re-checked.
        """
        n_h = self.n_h()
        rem = self.remaining_h()
        alloc = np.zeros(self.H, dtype=int)
        # pilot: every stratum gets MIN_PER_STRATUM first
        need_pilot = np.minimum(np.maximum(MIN_PER_STRATUM - n_h, 0), rem)
        if need_pilot.sum() > 0:
            return need_pilot
        if weights is None:
            weights = self.stratum_sd(self.y)
        pooled = float(np.nanstd(self.y[self.sampled])) if self.n > 1 else 1.0
        w = np.maximum(weights, ALLOC_FLOOR * pooled + 1e-12) * self.N_h
        w = np.where(rem > 0, w, 0.0)
        if w.sum() <= 0:
            return alloc
        target_total = self.n + batch
        desired = target_total * w / w.sum()
        need = np.clip(desired - n_h, 0, None)
        need = np.minimum(need, rem)
        if need.sum() <= 0:
            need = np.where(rem > 0, w, 0.0)
        share = batch * need / need.sum()
        alloc = np.floor(share).astype(int)
        leftover = batch - alloc.sum()
        frac = share - alloc
        for h in np.argsort(-frac):
            if leftover <= 0:
                break
            if alloc[h] < rem[h]:
                alloc[h] += 1
                leftover -= 1
        return np.minimum(alloc, rem)

    def allocate_direct(self, batch: int, weights: np.ndarray) -> np.ndarray:
        """Split ``batch`` in proportion to ``weights`` (pilot first), capped by what remains."""
        n_h, rem = self.n_h(), self.remaining_h()
        need_pilot = np.minimum(np.maximum(MIN_PER_STRATUM - n_h, 0), rem)
        if need_pilot.sum() > 0:
            return need_pilot
        w = np.where(rem > 0, np.maximum(weights, 0.0), 0.0)
        if w.sum() <= 0:
            w = rem.astype(float)
        if w.sum() <= 0:
            return np.zeros(self.H, dtype=int)
        share = batch * w / w.sum()
        alloc = np.minimum(np.floor(share).astype(int), rem)
        for h in np.argsort(-(share - np.floor(share))):
            if alloc.sum() >= min(batch, rem.sum()):
                break
            if alloc[h] < rem[h]:
                alloc[h] += 1
        # spill any remainder into strata that still have tiles
        for h in np.argsort(-w):
            while alloc.sum() < min(batch, rem.sum()) and alloc[h] < rem[h]:
                alloc[h] += 1
        return alloc

    def stratum_sd(self, values: np.ndarray) -> np.ndarray:
        out = np.zeros(self.H)
        for h in range(self.H):
            m = self.sampled & (self.strata == h)
            if m.sum() >= 2:
                out[h] = np.std(values[m], ddof=1)
        return out

    # ---------------------------------------------------------------- estimators
    def _strat_total(self, values: np.ndarray) -> tuple[float, float]:
        est, var = 0.0, 0.0
        for h in range(self.H):
            m = self.sampled & (self.strata == h)
            n_h, N_h = int(m.sum()), int(self.N_h[h])
            if n_h == 0:
                continue
            est += N_h * float(values[m].mean())
            if n_h >= 2 and n_h < N_h:
                var += N_h**2 * (1 - n_h / N_h) * float(np.var(values[m], ddof=1)) / n_h
        return est, var

    def stratified(self, conf: float) -> Estimate:
        est, var = self._strat_total(self.y)
        df = max(self.n - self.H, 1)
        t = stats.t.ppf((1 + conf) / 2, df)
        se = float(np.sqrt(var))
        return Estimate(est, se, est - t * se, est + t * se, df, "stratified", self.n)

    def crossfit_models(self, X: np.ndarray) -> Optional[tuple[list[RidgeProxy], np.ndarray, float]]:
        idx = np.flatnonzero(self.sampled)
        if len(idx) < CROSSFIT_MIN_N:
            return None
        models = []
        oof = np.full(len(self.y), np.nan)
        for k in range(self.n_folds):
            tr = idx[self.fold[idx] != k]
            te = idx[self.fold[idx] == k]
            if len(tr) < 8 or len(te) == 0:
                return None
            mdl = RidgeProxy().fit(X[tr], self.y[tr])
            models.append(mdl)
            oof[te] = mdl.predict(X[te])
        yy = self.y[idx]
        ss = float(((yy - yy.mean()) ** 2).sum())
        r2 = 1 - float(((yy - oof[idx]) ** 2).sum()) / ss if ss > 0 else 0.0
        return models, oof, r2

    def _diff_point(self, S: np.ndarray, X: np.ndarray, Xsum: np.ndarray) -> Optional[tuple[float, np.ndarray]]:
        """Cross-fitted difference estimate from sample index array S (may repeat)."""
        N = len(self.y)
        oofv = np.empty(len(S))
        pred_sums = []
        for k in range(self.n_folds):
            te = self.fold[S] == k
            tr = S[~te]
            if len(tr) < 8 or te.sum() == 0:
                return None
            mdl = RidgeProxy().fit(X[tr], self.y[tr])
            oofv[te] = mdl.predict(X[S[te]])
            pred_sums.append(N * mdl.intercept + ((Xsum - N * mdl.mu) / mdl.sd) @ mdl.beta)
        resid = self.y[S] - oofv
        st = self.strata[S]
        corr = 0.0
        for h in range(self.H):
            m = st == h
            if m.any():
                corr += self.N_h[h] * float(resid[m].mean())
        return float(np.mean(pred_sums)) + corr, resid

    def difference(self, X: np.ndarray, conf: float, n_boot: int = 200) -> Optional[Estimate]:
        """Cross-fitted difference estimator with a conservative standard error.

        SE = max(analytic stratified SE of out-of-fold residuals,
                 stratified-bootstrap SE that refits the proxy each replicate).
        The bootstrap captures the variance from fitting the proxy on the same
        small sample, which the analytic formula ignores and which made early
        intervals under-cover in our benchmark.
        """
        cf = self.crossfit_models(X)
        if cf is None:
            return None
        models, oof, r2 = cf
        Xsum = X.sum(0)
        S = np.flatnonzero(self.sampled)
        pt = self._diff_point(S, X, Xsum)
        if pt is None:
            return None
        est, _ = pt
        resid = np.where(self.sampled, self.y - oof, np.nan)
        _, var = self._strat_total(resid)
        se_analytic = float(np.sqrt(var))
        rng = np.random.default_rng(self.seed * 7919 + self.n)
        groups = [S[self.strata[S] == h] for h in range(self.H)]
        boots = []
        for _ in range(n_boot):
            Sb = np.concatenate([rng.choice(g, size=len(g), replace=True) for g in groups if len(g)])
            r = self._diff_point(Sb, X, Xsum)
            if r is not None:
                boots.append(r[0])
        fpc = float(np.sqrt(max(1 - self.n / len(self.y), 0.0)))
        se_boot = float(np.std(boots, ddof=1)) * fpc if len(boots) > 20 else 0.0
        se = max(se_analytic, se_boot)
        p = X.shape[1] + 1
        df = max(self.n - self.H - p, 1)
        t = stats.t.ppf((1 + conf) / 2, df)
        fbar_total = float(np.mean([m.predict(X) for m in models], axis=0).sum())
        return Estimate(est, se, est - t * se, est + t * se, df, "crossfit_difference", self.n, r2=r2,
                        extra={"proxy_total": fbar_total, "bias_correction": float(est - fbar_total),
                               "se_analytic": se_analytic, "se_bootstrap": se_boot})

    def best(self, X: Optional[np.ndarray], conf: float) -> Estimate:
        """Difference estimator once enough labels exist, else stratified.

        The switch is decided by sample size alone (not by which interval is
        narrower) so the choice does not depend on the observed outcomes.
        """
        if X is not None:
            d = self.difference(X, conf)
            if d is not None:
                return d
        return self.stratified(conf)

    def residual_sd(self, X: np.ndarray) -> Optional[np.ndarray]:
        cf = self.crossfit_models(X)
        if cf is None:
            return None
        _, oof, _ = cf
        return self.stratum_sd(np.where(self.sampled, self.y - oof, np.nan))

    def scores(self, X: Optional[np.ndarray], fallback: np.ndarray) -> np.ndarray:
        """Per-tile predicted value: out-of-fold for sampled tiles, f̄ elsewhere."""
        if X is None:
            return fallback
        cf = self.crossfit_models(X)
        if cf is None:
            return fallback
        models, oof, _ = cf
        s = np.mean([m.predict(X) for m in models], axis=0)
        return np.where(self.sampled, oof, s)


# ---------------------------------------------------------------------------- find-all

def cp_upper(k: int, n: int, a: float) -> float:
    """One-sided Clopper–Pearson upper bound for a proportion (k of n)."""
    if n <= 0 or k >= n:
        return 1.0
    return float(stats.beta.ppf(1 - a, k + 1, n - k))


def hyper_bounds(k: int, n: int, N: int, a: float) -> tuple[int, int]:
    """Exact one-sided (lower, upper) bounds on the number of positives M in a finite
    population of N, after k positives in a simple random sample of n without replacement.

    upper = largest M with P(X ≤ k | M) > a ;  lower = smallest M with P(X ≥ k | M) > a.
    Both tail probabilities are monotone in M, so each bound is a binary search.
    """
    if N <= 0:
        return 0, 0
    if n >= N:
        return k, k
    m_min, m_max = k, N - (n - k)

    # upper: P(X ≤ k | M) decreases with M → largest M with cdf > a
    lo, hi = m_min, m_max
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if stats.hypergeom.cdf(k, N, mid, n) > a:
            lo = mid
        else:
            hi = mid - 1
    upper = lo
    # lower: P(X ≥ k | M) increases with M → smallest M with sf > a
    lo, hi = m_min, m_max
    while lo < hi:
        mid = (lo + hi) // 2
        if k == 0 or stats.hypergeom.sf(k - 1, N, mid, n) > a:
            hi = mid
        else:
            lo = mid + 1
    return lo, upper


def cp_lower(k: int, n: int, a: float) -> float:
    if n <= 0 or k <= 0:
        return 0.0
    return float(stats.beta.ppf(a, k, n - k + 1))


@dataclass
class RecallSelection:
    threshold: float
    selected: np.ndarray            # boolean mask over the population
    recall_est: float
    recall_lo: float
    positives_est: float
    positives_lo: float
    positives_hi: float
    precision_est: float

    def to_json(self) -> dict:
        return {
            "threshold": float(self.threshold) if np.isfinite(self.threshold) else None,
            "selected_tiles": int(self.selected.sum()),
            "recall_estimate": round(float(self.recall_est), 4),
            "recall_lower_bound": round(float(self.recall_lo), 4),
            "positive_tiles_estimate": round(float(self.positives_est), 1),
            "positive_tiles_lo": round(float(self.positives_lo), 1),
            "positive_tiles_hi": round(float(self.positives_hi), 1),
            "selected_precision_estimate": round(float(self.precision_est), 4),
        }


def _domain_counts(state: SampleState, dom: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per stratum, inside domain ``dom``: (#sampled, #sampled positives, #unsampled)."""
    pos = state.sampled & (np.nan_to_num(state.y) > 0)
    m = np.bincount(state.strata[dom & state.sampled], minlength=state.H)
    k = np.bincount(state.strata[dom & pos], minlength=state.H)
    u = np.bincount(state.strata[dom & ~state.sampled], minlength=state.H)
    return m, k, u


def _unsampled_bounds(state: SampleState, dom: np.ndarray, a: float) -> tuple[float, float, float]:
    """(lower, point, upper) bound on the number of *unsampled* positive tiles in ``dom``.

    Within a stratum, the sampled tiles that fall in a fixed domain are a simple
    random sample of that domain, so a per-stratum Clopper–Pearson bound on the
    positive rate times the unsampled count is valid; ``a`` should already be
    Bonferroni-split across strata.
    """
    m, k, u = _domain_counts(state, dom)
    lo = pt = hi = 0.0
    for h in range(state.H):
        if u[h] == 0:
            continue
        lo += u[h] * cp_lower(int(k[h]), int(m[h]), a)
        pt += u[h] * ((k[h] + 0.5) / (m[h] + 1.0))
        hi += u[h] * cp_upper(int(k[h]), int(m[h]), a)
    return lo, pt, hi


class FrontierAudit:
    """Find-all with a recall certificate: verify top-down + audit the rest.

    * **Frontier** — tiles are verified by the oracle in descending order of a
      proxy score that is fixed before any labels are seen.
    * **Audit** — a uniform random sample of the not-yet-verified remainder.

    Every reported tile is oracle-confirmed (precision 100 % w.r.t. the oracle).
    The only tiles that can be missed are unverified, unaudited tiles below the
    frontier. Audit draws are uniform over a superset of the final remainder,
    so the audited tiles that still lie in the remainder are a uniform sample
    of it (without replacement), and an exact hypergeometric bound gives

        recall ≥ K / (K + U_hi),   U_hi = M_hi(k_a, n_a, N_rem; α) − k_a

    with K = confirmed positive tiles, N_rem = tiles below the frontier
    (audited + unlabelled), (k_a, n_a) = positives / size of the audit sample
    there, and M_hi the upper bound on positives below the frontier.
    Each batch goes to whichever of {advance frontier, audit} is expected to
    raise that bound more (greedy).

    Optional stopping: checking the bound after every batch and stopping the
    first time it passes would inflate the error rate. The certificate is
    therefore only evaluated at preset audit sizes (geometric checkpoints), and
    look j spends α_j = α · 6/(π² j²), so Σ α_j ≤ α over all looks
    (alpha spending). The bound shown between looks is the last certified one.
    """

    CHECKPOINT0 = 48
    CHECKPOINT_GROWTH = 1.35

    def __init__(self, score: np.ndarray, seed: int):
        self.N = len(score)
        self.order = np.argsort(-score, kind="mergesort")
        self.rank = np.empty(self.N, dtype=int)
        self.rank[self.order] = np.arange(self.N)
        self.front = 0                                  # tiles with rank < front are frontier-verified
        self.labelled = np.zeros(self.N, dtype=bool)
        self.audit = np.zeros(self.N, dtype=bool)
        self.y = np.full(self.N, np.nan)
        self.rng = np.random.default_rng(seed)
        self.last_front_yield: Optional[float] = None
        self.sample_order: list[int] = []
        self.looks = 0
        self.next_checkpoint = float(self.CHECKPOINT0)
        self.certified = {"recall_lower_bound": 0.0, "alpha_spent": 0.0, "look": 0, "at_audit_n": 0,
                          "positives_lo": None, "positives_hi": None}

    def maybe_certify(self, alpha: float) -> bool:
        """Run a certificate look if the audit sample reached the next checkpoint."""
        _, na = self.audit_in_remainder()
        if na < self.next_checkpoint and self.remainder().sum() > 0:
            return False
        while self.next_checkpoint <= na:
            self.next_checkpoint *= self.CHECKPOINT_GROWTH
        self.looks += 1
        a_j = alpha * 6.0 / (math.pi ** 2 * self.looks ** 2)
        r_lo, _ = self.bound(a_j)
        K = float(self.confirmed().sum())
        R = float(self.remainder().sum())
        ka, na = self.audit_in_remainder()
        m_lo, m_hi = hyper_bounds(ka, na, int(R) + na, a_j / 2)
        self.certified = {"recall_lower_bound": round(r_lo, 4), "alpha_spent": a_j, "look": self.looks,
                          "at_audit_n": na, "positives_lo": float(K + max(m_lo - ka, 0)),
                          "positives_hi": float(K + max(m_hi - ka, 0))}
        return True

    # -- state ------------------------------------------------------------------
    @property
    def n(self) -> int:
        return int(self.labelled.sum())

    def remainder(self) -> np.ndarray:
        return (self.rank >= self.front) & ~self.labelled

    def audit_in_remainder(self) -> tuple[int, int]:
        m = self.audit & (self.rank >= self.front)
        return int((self.y[m] > 0).sum()), int(m.sum())

    def confirmed(self) -> np.ndarray:
        return self.labelled & (np.nan_to_num(self.y) > 0)

    def bound(self, alpha: float, K=None, R=None, ka=None, na=None) -> tuple[float, float]:
        K = float(self.confirmed().sum()) if K is None else K
        R = float(self.remainder().sum()) if R is None else R
        if ka is None:
            ka, na = self.audit_in_remainder()
        if R <= 0:
            return 1.0, 1.0
        ka_i, na_i = int(round(ka)), int(round(na))
        _, m_hi = hyper_bounds(ka_i, na_i, int(round(R)) + na_i, alpha)
        u_hi = float(m_hi - ka_i)
        u_pt = R * (ka + 0.5) / (na + 1.0)
        r_lo = K / (K + u_hi) if K + u_hi > 0 else 0.0
        r_pt = K / (K + u_pt) if K + u_pt > 0 else 0.0
        return r_lo, r_pt

    # -- planning ---------------------------------------------------------------
    def _audit_needed(self, alpha_plan: float, target: float, K: float, R: float, ka: float, na: float,
                      dens: float, step: int) -> float:
        """Extra audit labels needed (projected at the current density) to certify recall."""
        extra = 0
        step = max(step, int(R) // 20 + 1)   # cap the look-ahead at ~20 bound evaluations
        while extra <= R:
            Rx = R - extra
            k = ka + extra * dens
            n = na + extra
            if Rx > 0:
                kk = int(round(k))
                uhi = float(hyper_bounds(kk, int(n), int(Rx) + int(n), alpha_plan)[1] - kk)
            else:
                uhi = 0.0
            Kx = K + extra * dens
            if Kx > 0 and Kx / (Kx + uhi) >= target:
                return float(extra)
            extra += step
        return float(R) + 1.0

    def plan(self, batch: int, alpha: float, target: float) -> tuple[list[int], str]:
        """Choose the next batch: frontier tiles, audit tiles, or a split.

        One-step look-ahead on *total remaining labels*: compare
        "stop the frontier here and only audit" with "verify one more frontier
        batch, then audit", using the latest frontier yield and the audit
        density. Early on, a quarter of each batch is audit so a density
        estimate exists.
        """
        rem = np.flatnonzero(self.remainder())
        if len(rem) == 0:
            return [], "none"
        b = min(batch, len(rem))
        K = float(self.confirmed().sum())
        ka, na = self.audit_in_remainder()
        if self.front < 2 * batch:
            n_f = b
        elif self.audit.sum() < self.CHECKPOINT0:
            n_f = b - max(1, b // 4)
        else:
            dens = (ka + 0.5) / (na + 1.0)
            fy = self.last_front_yield if self.last_front_yield is not None else dens
            a_plan = alpha * 6.0 / (math.pi ** 2 * max(self.looks + 2, 2) ** 2)
            R = float(len(rem))
            c_stop = self._audit_needed(a_plan, target, K, R, ka, na, dens, b)
            c_adv = b + self._audit_needed(a_plan, target, K + b * fy, max(R - b, 0.0), ka, na, dens, b)
            n_f = b if c_adv < c_stop else 0
        out: list[int] = []
        while len(out) < n_f and self.front < self.N:
            i = int(self.order[self.front])
            self.front += 1
            if not self.labelled[i]:
                out.append(i)
        pool = np.setdiff1d(np.flatnonzero(self.remainder()), out)
        k = min(b - len(out), len(pool))
        audit = [int(i) for i in self.rng.choice(pool, size=k, replace=False)] if k > 0 else []
        for i in audit:
            self.audit[i] = True
        kind = "frontier" if not audit else ("audit" if not out else "split")
        self._pending_front = out
        return out + audit, kind

    def record(self, idx: int, value: float) -> None:
        self.y[idx] = value
        self.labelled[idx] = True
        self.sample_order.append(idx)

    def finish_batch(self) -> None:
        f = getattr(self, "_pending_front", [])
        if f:
            self.last_front_yield = float(np.mean(self.y[f] > 0))

    def summary(self, alpha: float, conf: float) -> dict:
        K = int(self.confirmed().sum())
        R = int(self.remainder().sum())
        ka, na = self.audit_in_remainder()
        _, r_pt = self.bound(alpha)
        c = self.certified
        r_lo = c["recall_lower_bound"]
        pt = K + R * (ka + 0.5) / (na + 1.0) if R else K
        if c["positives_lo"] is None:
            lo, hi = float(K), float(K + R)      # nothing certified yet: only the trivial bounds
        else:
            lo, hi = c["positives_lo"], c["positives_hi"]
        return {
            "confirmed_positive_tiles": K, "remainder_tiles": R, "frontier_depth": int(self.front),
            "audit_tiles": int(self.audit.sum()), "audit_positives_in_remainder": ka, "audit_in_remainder": na,
            "recall_lower_bound": round(r_lo, 4), "recall_estimate": round(r_pt, 4),
            "positive_tiles_estimate": round(pt, 1), "positive_tiles_lo": round(lo, 1), "positive_tiles_hi": round(hi, 1),
            "selected_tiles": K, "selected_precision_estimate": 1.0,
            "certificate_looks": c["look"], "certificate_alpha": round(c["alpha_spent"], 5),
        }


def select_with_recall(state: SampleState, score: np.ndarray, target: float, conf: float,
                       n_thresholds: int = 40) -> RecallSelection:
    """Smallest threshold set {score ≥ τ} whose recall *lower confidence bound* ≥ target.

    ``score`` must be fixed before sampling (the stratification score), so that
    the sample restricted to "below τ" is still a random sample of that domain.
    Sampled positives are always added to the returned set, so the only tiles
    that can be missed are *unsampled* positives below τ.

        recall ≥ (A_lo + K_below) / (A_lo + K_below + U_below_hi)

    A = positives with score ≥ τ (sampled confirmed + Clopper–Pearson lower
    bound on unsampled), K_below = sampled positives below τ, U_below_hi =
    Clopper–Pearson upper bound on unsampled positives below τ. Error is split
    between the two sides and Bonferroni-split across strata, so the bound is
    conservative. Candidate thresholds are nested, so the bound is monotone in τ.
    Related to SUPG (Kang et al., VLDB 2020) but with exact binomial bounds.
    """
    H = state.H
    a = (1 - conf) / (2 * H)
    pos = state.sampled & (np.nan_to_num(state.y) > 0)
    qs = np.unique(np.quantile(score, np.linspace(0, 1, n_thresholds + 1)[1:]))[::-1]
    cands = list(qs) + [-np.inf]
    chosen = None
    for t in cands:
        above = score >= t
        below = ~above
        a_lo, a_pt, _ = _unsampled_bounds(state, above, a)
        _, u_pt, u_hi = _unsampled_bounds(state, below, a)
        conf_above = float((pos & above).sum())
        k_below = float((pos & below).sum())
        A_lo, A_pt = conf_above + a_lo, conf_above + a_pt
        den_lo = A_lo + k_below + u_hi
        r_lo = (A_lo + k_below) / den_lo if den_lo > 0 else 1.0
        den_pt = A_pt + k_below + u_pt
        r_pt = (A_pt + k_below) / den_pt if den_pt > 0 else 1.0
        if r_lo >= target or not np.isfinite(t):
            chosen = (t, r_pt, r_lo, A_pt)
            break
    t, r_pt, r_lo, A_pt = chosen
    selected = (score >= t) | pos
    all_dom = np.ones(len(score), dtype=bool)
    p_lo, p_pt, p_hi = _unsampled_bounds(state, all_dom, a)
    k_all = float(pos.sum())
    sel_pos = A_pt + float((pos & (score < t)).sum())
    precision = sel_pos / max(int(selected.sum()), 1)
    return RecallSelection(float(t), selected, r_pt, r_lo, k_all + p_pt, k_all + p_lo, k_all + p_hi, min(precision, 1.0))
