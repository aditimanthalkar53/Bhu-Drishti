# Benchmark results

100 runs per row with different random seeds, generated 2026-10-17 22:21:10.

Simulated districts; 'coverage' = share of runs whose interval contained the exhaustive oracle answer. Nominal level 95%. For find-all, 'coverage' refers to the interval on the number of target tiles and 'recall_target_met_share' to the recall certificate.

| Question | District | Tiles | Exhaustive answer | Mean estimate | Interval covered exhaustive | Mean ± at stop | Oracle tiles used | Fewer model runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| flood share ±3pp | A | 1,719 | 37.5 | 37.6 | 100% | 2.7 | 304 | 5.7× |
| flood share ±3pp | B | 1,784 | 24.4 | 24.6 | 100% | 2.7 | 236 | 7.6× |
| flood share ±1.5pp | A | 1,721 | 14.3 | 14.3 | 100% | 1.4 | 601 | 2.9× |
| flood share ±1.5pp | B | 1,785 | 6.9 | 6.9 | 100% | 1.4 | 426 | 4.2× |
| new built-up ±10% | A | 1,819 | 40.7 | 40.6 | 100% | 3.9 | 889 | 2.0× |
| new built-up ±10% | B | 1,816 | 45.0 | 44.9 | 100% | 4.3 | 719 | 2.5× |
| kiln count ±15% | A | 1,819 | 159.0 | 158.9 | 100% | 22.1 | 1462 | 1.2× |
| kiln count ±15% | B | 1,816 | 371.0 | 370.5 | 100% | 52.1 | 1142 | 1.6× |
| find kilns recall 90% (recall target met in 100% of runs, mean recall 99.4%) | A | 1,819 | 111.0 | 111.0 | 100% | 4.1 | 1526 | 1.2× |
| find kilns recall 90% (recall target met in 100% of runs, mean recall 98.3%) | B | 1,816 | 207.0 | 206.9 | 100% | 7.4 | 1540 | 1.2× |
| flood total ±10% | A | 1,721 | 196.4 | 197.3 | 100% | 18.3 | 636 | 2.7× |
| flood total ±10% | B | 1,785 | 96.7 | 96.8 | 100% | 9.1 | 1039 | 1.7× |
