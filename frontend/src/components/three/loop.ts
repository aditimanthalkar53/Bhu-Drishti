export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Run ``frame`` on every animation frame while ``el`` is on screen and the tab is visible.
 * Returns a stop function. Keeps WebGL scenes from burning battery off-screen.
 */
export function runWhileVisible(el: Element, frame: () => void): () => void {
  let raf = 0;
  let onScreen = true;
  const tick = () => {
    frame();
    raf = requestAnimationFrame(tick);
  };
  const update = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (onScreen && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; update(); });
  io.observe(el);
  document.addEventListener("visibilitychange", update);
  update();
  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    document.removeEventListener("visibilitychange", update);
  };
}
