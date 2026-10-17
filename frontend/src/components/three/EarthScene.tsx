import { gsap } from "gsap";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cssVar, useTheme } from "../../theme";
import { MASK_H, MASK_RLE, MASK_W } from "./landmask";
import { prefersReducedMotion, runWhileVisible } from "./loop";

// India's centroid: the globe sways around it so the subcontinent stays in view, and the pulse sits here.
const INDIA = { lat: 22.5, lon: 79 };
const DEG = Math.PI / 180;

function latLonToVec(lat: number, lon: number, r: number) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

/** Decode the run-length land mask once: 0 ocean, 1 land, 2 India. */
let maskCache: Uint8Array | null = null;
function landMask(): Uint8Array {
  if (maskCache) return maskCache;
  const m = new Uint8Array(MASK_W * MASK_H);
  MASK_RLE.split("|").forEach((row, r) => {
    let c = r * MASK_W;
    for (const run of row.split(",")) {
      const v = Number(run[0]);
      const n = Number(run.slice(1));
      m.fill(v, c, c + n);
      c += n;
    }
  });
  maskCache = m;
  return m;
}
function kindAt(mask: Uint8Array, lat: number, lon: number) {
  const r = Math.min(MASK_H - 1, Math.max(0, Math.floor((90 - lat) / (180 / MASK_H))));
  const c = Math.min(MASK_W - 1, Math.max(0, Math.floor((lon + 180) / (360 / MASK_W))));
  return mask[r * MASK_W + c];
}

const DOTS_VERT = `
  uniform float uTime, uScale;
  uniform vec3 uIndia, uSun;
  attribute float aKind, aSeed;
  varying float vKind, vLight, vWave, vTw, vRim;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * position);
    vRim = clamp(n.z, 0.0, 1.0);                       // 1 facing the camera, 0 at the limb
    vLight = 0.6 + 0.4 * max(dot(n, uSun), 0.0);       // light fixed relative to the viewer (top-left-front)
    float d = distance(position, uIndia);
    vWave = smoothstep(0.09, 0.0, abs(fract(d * 1.6 - uTime * 0.22) - 0.5) - 0.38) * smoothstep(1.2, 0.2, d);
    vTw = 0.85 + 0.15 * sin(aSeed * 6.2831 + uTime * 1.3);
    vKind = aKind;
    float size = aKind > 1.5 ? 1.45 : aKind > 0.5 ? 1.12 : 0.5;
    gl_PointSize = size * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const DOTS_FRAG = `
  uniform float uTime, uOpacity, uOcean, uLight, uBoost;
  uniform vec3 uA, uB, uC, uD, uHot;
  varying float vKind, vLight, vWave, vTw, vRim;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r2 = dot(p, p);
    if (r2 > 0.25) discard;
    float soft = smoothstep(0.25, 0.12, r2);
    vec3 c; float a;
    if (vKind > 1.5) {                                   // India: warm and bright, gently breathing
      c = mix(uHot, vec3(1.0), 0.12 + 0.12 * sin(uTime * 1.6)) * uBoost;
      a = 1.0;
    } else if (vKind > 0.5) {                            // land: theme palette drifting across continents
      float w1 = 0.5 + 0.5 * sin(gl_FragCoord.y * 0.004 + uTime * 0.25);
      float w2 = 0.5 + 0.5 * sin(gl_FragCoord.x * 0.003 - uTime * 0.18);
      c = mix(mix(uA, uB, w1), uC, w2 * 0.45);
      c = mix(c, uD, 0.18 * (0.5 + 0.5 * sin(gl_FragCoord.x * 0.011 + gl_FragCoord.y * 0.007 + uTime * 0.4)));
      c *= uBoost;
      a = 1.0;
    } else {                                             // ocean: a quiet grid
      c = uA;
      a = uOcean;
    }
    if (vKind < 1.5) c = mix(c, uB, vWave * 0.6);         // "monitoring" ripples spreading from India (India keeps its colour)
    c *= mix(1.0, vLight, uLight);
    gl_FragColor = vec4(c, a * soft * vTw * uOpacity * (0.35 + 0.65 * vRim) + vWave * 0.25 * uOpacity);
  }`;

const ATMO_VERT = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const ATMO_FRAG = `
  uniform vec3 uColor, uColor2;
  uniform float uStrength, uPower, uTime;
  varying vec3 vNormal;
  void main() {
    float i = pow(clamp(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), uPower);
    vec3 c = mix(uColor, uColor2, 0.5 + 0.5 * sin(uTime * 0.15 + vNormal.y * 2.0));
    gl_FragColor = vec4(c, clamp(i * uStrength, 0.0, 1.0));
  }`;

/** A satellite on its orbit with a fading trail. */
function makeSatellite(radius: number, incl: number, node: number, color: THREE.Color, light: boolean, speed: number, phase: number) {
  const group = new THREE.Group();
  group.rotation.set(incl * DEG, node * DEG, 0, "YXZ");
  const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0);
  const orbit = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(200).map((p) => new THREE.Vector3(p.x, p.y, 0))),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: light ? 0.28 : 0.22 }),
  );
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 16), new THREE.MeshBasicMaterial({ color: light ? 0x1d1d1f : 0xffffff }));
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  body.add(glow);
  // trail: last N positions, alpha fading to 0
  const N = 70;
  const tp = new Float32Array(N * 3);
  const tc = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) tc.set([color.r, color.g, color.b, (1 - i / N) ** 2 * 0.9], i * 4);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(tp, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(tc, 4));
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  group.add(orbit, body, trail);
  let t = phase;
  const update = (dt: number) => {
    t = (t + dt * speed) % 1;
    const p = curve.getPoint(t);
    body.position.set(p.x, p.y, 0);
    for (let i = 0; i < N; i++) {
      const q = curve.getPoint((t - i * 0.0022 + 1) % 1);
      tp.set([q.x, q.y, 0], i * 3);
    }
    trailGeo.attributes.position.needsUpdate = true;
  };
  return { group, body, orbit, update };
}

/**
 * The landing globe: real continents as dots (Natural Earth land mask), India highlighted with
 * "monitoring" ripples, a breathing atmosphere and two satellites on orbits with trails that beam
 * down to India as they pass. Decorative only: it renders nothing that claims to be data.
 */
export default function EarthScene({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const { mode } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = prefersReducedMotion();
    const light = mode === "light";
    const water = new THREE.Color(cssVar("--water") || "#0a84ff");
    const cyan = new THREE.Color(cssVar("--cyan") || "#64d2ff");
    const violet = new THREE.Color(cssVar("--violet") || "#7d7aff");
    const green = new THREE.Color(cssVar("--ok") || "#30d158");
    const hot = light ? new THREE.Color("#f26b1d") : new THREE.Color("#ffab3d");   // warm accent for India only

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, reduced ? 4.0 : 5.8);   // 4.0: the globe rises below the headline like a horizon

    const world = new THREE.Group();
    scene.add(world);
    const globe = new THREE.Group();
    world.add(globe);

    // core: hides far-side dots; a faint inner tint gives the sphere body
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.99, 96, 96),
      new THREE.MeshBasicMaterial({ color: light ? new THREE.Color("#f3f5fb") : new THREE.Color("#07080f") }));
    globe.add(core);

    // dots: dense fibonacci sphere, kept on land (all) and ocean (sparse grid)
    const mask = landMask();
    const N = 30000;
    const pos: number[] = [];
    const kind: number[] = [];
    const seed: number[] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = Math.PI * (3 - Math.sqrt(5)) * i;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      const lat = Math.asin(y) / DEG;
      const lon = ((Math.atan2(z, -x) / DEG - 180 + 540) % 360) - 180;
      const k = kindAt(mask, lat, lon);
      if (k === 0 && i % 4 !== 0) continue;   // sparse ocean
      pos.push(x * 1.001, y * 1.001, z * 1.001);
      kind.push(k);
      seed.push((Math.sin(i * 12.9898) * 43758.5453) % 1);
    }
    const dotsGeo = new THREE.BufferGeometry();
    dotsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    dotsGeo.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
    dotsGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
    const indiaVec = latLonToVec(INDIA.lat, INDIA.lon, 1);
    const sun = new THREE.Vector3(-0.35, 0.45, 0.82).normalize();   // view space
    const dotsMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uScale: { value: 300 }, uOpacity: { value: light ? 0.9 : 1.0 },
        uOcean: { value: light ? 0.13 : 0.07 }, uLight: { value: light ? 0.2 : 0.6 }, uBoost: { value: light ? 1.0 : 1.45 },
        uIndia: { value: indiaVec }, uSun: { value: sun },
        uA: { value: water }, uB: { value: cyan }, uC: { value: violet }, uD: { value: green }, uHot: { value: hot },
      },
      vertexShader: DOTS_VERT, fragmentShader: DOTS_FRAG,
    });
    globe.add(new THREE.Points(dotsGeo, dotsMat));
    const uScaleBase = 0.0115;

    // faint graticule
    const gratMat = new THREE.LineBasicMaterial({ color: water, transparent: true, opacity: light ? 0.1 : 0.07 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = 0; lon <= 360; lon += 3) pts.push(latLonToVec(lat, lon, 1.003));
      globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
    }

    // India marker: pin + two expanding rings
    const marker = new THREE.Group();
    const mpos = latLonToVec(INDIA.lat, INDIA.lon, 1.012);
    marker.position.copy(mpos);
    marker.lookAt(mpos.clone().multiplyScalar(2));
    const pin = new THREE.Mesh(new THREE.CircleGeometry(0.014, 24), new THREE.MeshBasicMaterial({ color: hot }));
    const rings = [0, 0.5].map(() => {
      const m = new THREE.MeshBasicMaterial({ color: hot, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 48), m);
      marker.add(ring);
      return { ring, m };
    });
    marker.add(pin);
    globe.add(marker);

    // atmosphere: outer halo + inner rim
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
      uniforms: { uColor: { value: water }, uColor2: { value: violet }, uStrength: { value: light ? 0.35 : 0.95 }, uPower: { value: 3.0 }, uTime: { value: 0 } },
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false,
    });
    world.add(new THREE.Mesh(new THREE.SphereGeometry(1.2, 64, 64), atmoMat));
    const rimMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: `
        uniform vec3 uColor; uniform float uStrength; varying vec3 vNormal;
        void main() { float i = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.6); gl_FragColor = vec4(uColor, i * uStrength); }`,
      uniforms: { uColor: { value: cyan }, uStrength: { value: light ? 0.25 : 0.55 } },
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    world.add(new THREE.Mesh(new THREE.SphereGeometry(1.004, 64, 64), rimMat));

    // two satellites: an inclined orbit and a near-polar, sun-synchronous one (like Sentinel)
    const satA = makeSatellite(1.42, 64, -20, violet, light, 0.032, 0.1);
    const satB = makeSatellite(1.3, 98, 35, cyan, light, 0.045, 0.6);
    world.add(satA.group, satB.group);

    // beam from a passing satellite down to India
    const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const beamMat = new THREE.LineBasicMaterial({ color: hot, transparent: true, opacity: 0, depthWrite: false });
    const beam = new THREE.Line(beamGeo, beamMat);
    scene.add(beam);
    const coneMat = new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 1, 32, 1, true), coneMat);
    scene.add(cone);

    // stars (dark theme)
    const S = 1100;
    const spos = new Float32Array(S * 3);
    for (let i = 0; i < S; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 10);
      spos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(spos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 0.03, color: 0xc7c7cc, transparent: true, opacity: 0.5 }));
    if (!light) scene.add(stars);

    // face India, tilted like Earth's axis
    const baseY = -(INDIA.lon + 90) * DEG;
    globe.rotation.y = baseY;
    world.rotation.x = 16 * DEG;
    world.rotation.z = -8 * DEG;

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dotsMat.uniforms.uScale.value = uScaleBase * (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov / 2) * DEG));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });

    const intro = reduced ? null : gsap.timeline({ defaults: { ease: "power3.out" } })
      .to(camera.position, { z: 4.0, duration: 2.6 })
      .from(world.scale, { x: 0.65, y: 0.65, z: 0.65, duration: 2.6 }, 0)
      .from(dotsMat.uniforms.uOpacity, { value: 0, duration: 1.8 }, 0.1)
      .from(globe.rotation, { y: baseY + 1.6, duration: 3.2, ease: "power2.out" }, 0);

    const clock = new THREE.Clock();
    const tmpA = new THREE.Vector3(), tmpI = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const frame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      // sway around India instead of spinning it away
      if (!intro?.isActive()) globe.rotation.y = baseY + Math.sin(t * 0.07) * 0.55;
      dotsMat.uniforms.uTime.value = t;
      atmoMat.uniforms.uTime.value = t;
      satA.update(dt);
      satB.update(dt);
      rings.forEach(({ ring, m }, i) => {
        const p = (t * 0.5 + i * 0.5) % 1;
        ring.scale.setScalar(1 + p * 3);
        m.opacity = 0.8 * (1 - p);
      });
      // beam when a satellite is roughly overhead India
      marker.getWorldPosition(tmpI);
      let best = 0;
      for (const s of [satA, satB]) {
        s.body.getWorldPosition(tmpA);
        const align = tmpA.clone().normalize().dot(tmpI.clone().normalize());
        if (align > best) {
          best = align;
          beamGeo.attributes.position.setXYZ(0, tmpA.x, tmpA.y, tmpA.z);
          beamGeo.attributes.position.setXYZ(1, tmpI.x, tmpI.y, tmpI.z);
          const mid = tmpA.clone().add(tmpI).multiplyScalar(0.5);
          const dir = tmpA.clone().sub(tmpI);
          cone.position.copy(mid);
          cone.scale.set(1, dir.length(), 1);
          cone.quaternion.setFromUnitVectors(up, dir.normalize());
        }
      }
      const on = THREE.MathUtils.smoothstep(best, 0.86, 0.97) * (tmpI.z > 0 ? 1 : 0);
      beamGeo.attributes.position.needsUpdate = true;
      beamMat.opacity = on * (0.55 + 0.25 * Math.sin(t * 12));
      coneMat.opacity = on * (light ? 0.1 : 0.14);
      world.rotation.y += (pointer.x * 0.22 - world.rotation.y) * 0.04;
      world.rotation.x += (16 * DEG + pointer.y * 0.1 - world.rotation.x) * 0.04;
      stars.rotation.y = t * 0.004;
      renderer.render(scene, camera);
    };
    if (reduced) {
      dotsMat.uniforms.uTime.value = 3;
      satA.update(0);
      satB.update(0);
    }
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
