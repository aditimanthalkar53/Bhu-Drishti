/**
 * VITE_FEATURE_MODE: "disaster" (default) builds the Maun disaster-coordination product; "full" restores every page.
 * Hidden pages are not deleted: their routes redirect to the dashboard, and the backend's FEATURE_MODE answers 404.
 */
export const FEATURE_MODE: "disaster" | "full" = import.meta.env.VITE_FEATURE_MODE === "full" ? "full" : "disaster";
export const DISASTER = FEATURE_MODE === "disaster";
export const PRODUCT = DISASTER ? "Maun" : "Bhu-Drishti";
