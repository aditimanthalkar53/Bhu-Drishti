import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cssVar, useTheme } from "../../theme";
import { prefersReducedMotion, runWhileVisible } from "./loop";

/** A slow, low-density particle field behind the app shell. Purely decorative. */
export default function AmbientField() {
  const host = useRef<HTMLDivElement>(null);
  const { mode } = useTheme();

  useEffect(() => {
    const light = mode === "light";
    const el = host.current;
    if (!el) return;
    const reduced = prefersReducedMotion();
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 50);
    camera.position.z = 10;

    const N = 520;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const palette = [new THREE.Color(cssVar("--water")), new THREE.Color(cssVar("--cyan")), new THREE.Color(cssVar("--violet"))];
    for (let i = 0; i < N; i++) {
      pos.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 12], i * 3);
      const c = palette[i % 3];
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    // soft round sprite so particles read as glints, not square pixels
    const dot = document.createElement("canvas");
    dot.width = dot.height = 64;
    const g = dot.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(dot);
    const mat = new THREE.PointsMaterial({ size: 0.14, map: sprite, vertexColors: true, transparent: true, opacity: light ? 0.35 : 0.6, depthWrite: false,
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending });
    const field = new THREE.Points(geo, mat);
    scene.add(field);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX / window.innerWidth - 0.5;
      pointer.y = e.clientY / window.innerHeight - 0.5;
    };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });

    const clock = new THREE.Clock();
    const frame = () => {
      const t = clock.getElapsedTime();
      field.rotation.y = t * 0.012 + pointer.x * 0.15;
      field.rotation.x = Math.sin(t * 0.05) * 0.05 + pointer.y * 0.08;
      renderer.render(scene, camera);
    };
    const stop = reduced ? (renderer.render(scene, camera), () => undefined) : runWhileVisible(el, frame);

    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      geo.dispose();
      mat.dispose();
      sprite.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mode]);

  return <div ref={host} className="ambient-field" aria-hidden="true" />;
}
