# Benchmark results

100 runs per row with different random seeds, generated 2026-10-13 17:05:11.

Simulated districts; 'coverage' = share of runs whose interval contained the exhaustive oracle answer. Nominal level 95%. For find-all, 'coverage' refers to the interval on the number of target tiles and 'recall_target_met_share' to the recall certificate.

| Question | District | Tiles | Exhaustive answer | Mean estimate | Interval covered exhaustive | Mean ± at stop | Oracle tiles used | Fewer model runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| flood share ±3pp | A | 1,719 | 37.5 | 37.5 | 97% | 2.4 | 157 | 10.9× |
| flood share ±3pp | B | 1,784 | 24.4 | 24.7 | 98% | 2.3 | 134 | 13.3× |
| flood share ±1.5pp | A | 1,721 | 14.3 | 14.3 | 98% | 1.3 | 257 | 6.7× |
| flood share ±1.5pp | B | 1,785 | 6.9 | 6.9 | 97% | 1.3 | 203 | 8.8× |
| new built-up ±10% | A | 1,819 | 40.7 | 40.2 | 89% | 3.7 | 352 | 5.2× |
| new built-up ±10% | B | 1,816 | 45.0 | 45.0 | 96% | 4.1 | 272 | 6.7× |
| kiln count ±15% | A | 1,819 | 159.0 | 161.3 | 98% | 22.6 | 813 | 2.2× |
| kiln count ±15% | B | 1,816 | 371.0 | 369.6 | 97% | 51.2 | 500 | 3.6× |
| find kilns recall 90% (recall target met in 100% of runs, mean recall 99.4%) | A | 1,819 | 111.0 | 111.0 | 100% | 4.1 | 1526 | 1.2× |
| find kilns recall 90% (recall target met in 100% of runs, mean recall 98.3%) | B | 1,816 | 207.0 | 206.9 | 100% | 7.4 | 1540 | 1.2× |
| flood total ±10% | A | 1,721 | 196.4 | 197.3 | 100% | 17.6 | 272 | 6.3× |
| flood total ±10% | B | 1,785 | 96.7 | 97.2 | 99% | 8.8 | 484 | 3.7× |
