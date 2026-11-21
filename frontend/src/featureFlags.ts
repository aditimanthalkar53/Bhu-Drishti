/**
 * VITE_FEATURE_MODE: "full" (default) shows every page: the satellite product (Explore/AEQE, change detection, digital
 * twins, Drift Simulator, monitors, areas, history, usage, API keys) and the Maun disaster-coordination pages together.
 * "disaster" builds the optional slimmed coordination edition: the satellite pages redirect to the dashboard there,
 * and the backend's FEATURE_MODE=disaster answers 404. Nothing is ever deleted.
 */
export const FEATURE_MODE: "disaster" | "full" = import.meta.env.VITE_FEATURE_MODE === "disaster" ? "disaster" : "full";
export const DISASTER = FEATURE_MODE === "disaster";
export const PRODUCT = DISASTER ? "Maun" : "Bhu-Drishti";
