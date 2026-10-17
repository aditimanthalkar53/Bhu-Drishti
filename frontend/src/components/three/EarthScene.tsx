import { gsap } from "gsap";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cssVar, useTheme } from "../../theme";
import { prefersReducedMotion, runWhileVisible } from "./loop";

// India's centroid, used to turn the globe so the subcontinent faces the camera and to place the pulse marker.
const INDIA = { lat: 22.5, lon: 79 };

function latLonToVec(lat: number, lon: number, r: number) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

const ATMOSPHERE_VERT = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const ATMOSPHERE_FRAG = `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec3 vNormal;
  void main() {
    float i = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
    gl_FragColor = vec4(uColor, clamp(i * uStrength, 0.0, 1.0));
  }`;

/**
 * A dotted Earth with a fresnel atmosphere, an orbiting satellite and a pulse over India.
 * Decorative only: it renders nothing that claims to be data.
 */
export default function EarthScene({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const { mode } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = prefersReducedMotion();
    // colours come from the active theme's CSS tokens; the scene is rebuilt when the theme flips
    const light = mode === "light";
    const accent = new THREE.Color(cssVar("--water"));
    const accent2 = new THREE.Color(cssVar("--cyan"));
    const violet = new THREE.Color(cssVar("--violet"));

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, reduced ? 3.4 : 5.2);

    const world = new THREE.Group();
    scene.add(world);
    const globe = new THREE.Group();
    world.add(globe);

    // solid core so the far-side dots are hidden
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 64), new THREE.MeshBasicMaterial({ color: light ? 0xfbfbfd : 0x0b0b10 }));
    globe.add(core);

    // fibonacci dot sphere, coloured blue → cyan by latitude
    const N = 5200;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const a = accent, b = accent2, c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = Math.PI * (3 - Math.sqrt(5)) * i;
      pos.set([Math.cos(t) * r, y, Math.sin(t) * r], i * 3);
      c.copy(a).lerp(b, (y + 1) / 2);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const dotsGeo = new THREE.BufferGeometry();
    dotsGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    dotsGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const dotsMat = new THREE.PointsMaterial({ size: 0.012, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
    globe.add(new THREE.Points(dotsGeo, dotsMat));

    // faint graticule
    const gratMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: light ? 0.18 : 0.12 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = 0; lon <= 360; lon += 4) pts.push(latLonToVec(lat, lon, 1.002));
      globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 4) pts.push(latLonToVec(lat, lon, 1.002));
      globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
    }

    // pulse over India
    const marker = new THREE.Group();
    const mpos = latLonToVec(INDIA.lat, INDIA.lon, 1.01);
    marker.position.copy(mpos);
    marker.lookAt(mpos.clone().multiplyScalar(2));
    const pin = new THREE.Mesh(new THREE.CircleGeometry(0.018, 24), new THREE.MeshBasicMaterial({ color: accent2 }));
    const ringMat = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 48), ringMat);
    marker.add(pin, ring);
    globe.add(marker);

    // atmosphere
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.18, 64, 64),
      new THREE.ShaderMaterial({ vertexShader: ATMOSPHERE_VERT, fragmentShader: ATMOSPHERE_FRAG,
        uniforms: { uColor: { value: accent }, uStrength: { value: light ? 0.32 : 0.8 } },
        blending: light ? THREE.NormalBlending : THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false }),
    );
    world.add(atmo);

    // orbit + satellite
    const orbit = new THREE.Group();
    orbit.rotation.set(THREE.MathUtils.degToRad(68), 0, THREE.MathUtils.degToRad(-18));
    const curve = new THREE.EllipseCurve(0, 0, 1.42, 1.42, 0, Math.PI * 2, false, 0);
    const orbitLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(160).map((p) => new THREE.Vector3(p.x, p.y, 0))),
      new THREE.LineBasicMaterial({ color: violet, transparent: true, opacity: light ? 0.45 : 0.35 }),
    );
    const sat = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 16), new THREE.MeshBasicMaterial({ color: light ? 0x1d1d1f : 0xf5f5f7 }));
    const satGlow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), new THREE.MeshBasicMaterial({ color: violet, transparent: true, opacity: 0.35 }));
    sat.add(satGlow);
    orbit.add(orbitLine, sat);
    world.add(orbit);

    // stars
    const S = 900;
    const spos = new Float32Array(S * 3);
    for (let i = 0; i < S; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 10);
      spos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(spos, 3));
    const starMat = new THREE.PointsMaterial({ size: 0.03, color: 0xc7c7cc, transparent: true, opacity: 0.55 });
    const stars = new THREE.Points(starGeo, starMat);
    if (!light) scene.add(stars);

    // face India toward the camera, tilted like Earth's axis
    globe.rotation.y = -THREE.MathUtils.degToRad(INDIA.lon + 90);
    world.rotation.x = THREE.MathUtils.degToRad(18);
    world.rotation.z = THREE.MathUtils.degToRad(-8);

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

    // pointer parallax (eased toward the target in the loop)
    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });

    // cinematic intro
    const intro = reduced ? null : gsap.timeline({ defaults: { ease: "power3.out" } })
      .to(camera.position, { z: 3.4, duration: 2.4 })
      .from(world.scale, { x: 0.7, y: 0.7, z: 0.7, duration: 2.4 }, 0)
      .from(dotsMat, { opacity: 0, duration: 1.6 }, 0.1)
      .from(orbitLine.material, { opacity: 0, duration: 1.2 }, 1);

    const clock = new THREE.Clock();
    let satT = 0.15;
    const frame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      globe.rotation.y += dt * 0.06;
      satT = (satT + dt * 0.035) % 1;
      const p = curve.getPoint(satT);
      sat.position.set(p.x, p.y, 0);
      const pulse = (t * 0.6) % 1;
      ring.scale.setScalar(1 + pulse * 2.6);
      ringMat.opacity = 0.85 * (1 - pulse);
      world.rotation.y += (pointer.x * 0.25 - world.rotation.y) * 0.04;
      world.rotation.x += (THREE.MathUtils.degToRad(18) + pointer.y * 0.12 - world.rotation.x) * 0.04;
      stars.rotation.y = t * 0.004;
      renderer.render(scene, camera);
    };
    const stop = reduced ? (renderer.render(scene, camera), () => undefined) : runWhileVisible(el, frame);

    return () => {
      stop();
      intro?.kill();
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mode]);

  return <div ref={host} className={className} aria-hidden="true" />;
}
