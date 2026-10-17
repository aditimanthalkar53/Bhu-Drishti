import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useLayoutEffect, type DependencyList, type RefObject } from "react";

gsap.registerPlugin(ScrollTrigger);
gsap.defaults({ ease: "power3.out", duration: 0.8 });

export { gsap, ScrollTrigger };

const MOTION_OK = "(prefers-reduced-motion: no-preference)";

/**
 * Run GSAP animations scoped to ``scope``; everything is reverted on unmount or when deps change.
 * ``build`` only runs when the user has not asked for reduced motion.
 */
export function useGsap(scope: RefObject<HTMLElement | null>, build: (root: HTMLElement) => void, deps: DependencyList = []) {
  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return;
    const mm = gsap.matchMedia(root);
    mm.add(MOTION_OK, () => build(root));
    return () => mm.revert();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Staggered rise-in for a freshly mounted app page (cards, KPI tiles, list sections). */
export function pageEnter(root: HTMLElement) {
  const items = root.querySelectorAll(".page > *, .kpis > *, .dash-grid > *, .stack > *, .pane");
  if (!items.length) return;
  gsap.from(items, { y: 22, autoAlpha: 0, duration: 0.7, stagger: 0.045, clearProps: "transform,opacity,visibility" });
}

/** Scroll-triggered reveals: ``[data-reveal]`` fades up; ``[data-stagger]`` reveals its children in turn. */
export function scrollReveals(root: HTMLElement, scroller?: Element | null) {
  root.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
    gsap.from(el, { y: 40, autoAlpha: 0, duration: 1, scrollTrigger: { trigger: el, scroller: scroller ?? undefined, start: "top 85%" } });
  });
  root.querySelectorAll<HTMLElement>("[data-stagger]").forEach((el) => {
    gsap.from(el.children, { y: 36, autoAlpha: 0, duration: 0.9, stagger: 0.09, scrollTrigger: { trigger: el, scroller: scroller ?? undefined, start: "top 82%" } });
  });
}

/** Count a number up when it scrolls into view; ``data-count`` holds the target, ``data-decimals`` the precision. */
export function scrollCounters(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count ?? "0");
    const decimals = parseInt(el.dataset.decimals ?? "0", 10);
    const obj = { v: 0 };
    const original = el.textContent;
    el.textContent = (0).toFixed(decimals);
    gsap.to(obj, {
      onComplete: () => { el.textContent = original; },
      v: target, duration: 1.8, ease: "power2.out",
      scrollTrigger: { trigger: el, start: "top 90%" },
      onUpdate: () => { el.textContent = obj.v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); },
    });
  });
}

/** Subtle magnetic pull on hover for elements marked ``data-magnetic``. Returns a cleanup. */
export function magnetic(root: HTMLElement) {
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-magnetic]"));
  const offs = els.map((el) => {
    const xTo = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3" });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.25);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.35);
    };
    const leave = () => { xTo(0); yTo(0); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); };
  });
  return () => offs.forEach((f) => f());
}
