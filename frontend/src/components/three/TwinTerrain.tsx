import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CLOSE, loadMosaic, planMosaic, sharpen, textureUv, WIDE, type Corners, type Mosaic, type MosaicPlan } from "./imagery";

export interface TerrainData {
  width: number;
  height: number;
  res_m: number;
  heights: number[];
  min_m: number;
  max_m: number;
  lines: number[][][];
  /** lon/lat of the terrain square's corners (NW, NE, SW, SE), used to drape sharper imagery */
  corners?: Corners;
  satellite: string | null;
  displacement: string | null;
}

export interface Building {
  /** footprint as fractions of the terrain square */
  ring: number[][];
  h: number;
  estimated: boolean;
}

/** "sharp": high-resolution tiles (the Sentinel-2 image shows first, then is replaced); "sentinel": the 10 m image only. */
export type Imagery = "sharp" | "sentinel";
export type ImageryState = "sentinel" | "loading" | "sharp" | "unavailable";

const SKY = 0xdcebf7;
const ASSET_LINE_PX = 2;
const ASSET_POINT_PX = 10;
/** The surrounding imagery reaches this many terrain widths across, so the terrain does not float in empty space. */
const SURROUND = 3;
const CONCRETE = [0.74, 0.72, 0.68];

interface Drape { plan: MosaicPlan; mosaic: Mosaic }

/** Bilinear position on the terrain square; u and v outside 0..1 extend it. */
function extendCorners([nw, ne, sw, se]: Corners, k: number): Corners {
  const a = (1 - k) / 2, b = (1 + k) / 2;
  const at = (u: number, v: number) => [0, 1].map((i) => nw[i] * (1 - u) * (1 - v) + ne[i] * u * (1 - v) + sw[i] * (1 - u) * v + se[i] * u * v);
  return [at(a, a), at(b, a), at(a, b), at(b, b)];
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff";
  x.beginPath();
  x.arc(32, 32, 30, 0, Math.PI * 2);
  x.fill();
  return new THREE.CanvasTexture(c);
}

/**
 * Terrain as a mesh with the asset drawn on it. Elevation is measured (30 m DEM). Buildings are footprints raised to their
 * stated height or a plain estimate; the asset's own height above ground is not modelled.
 */
export default function TwinTerrain({ data, exaggeration, showDisplacement, assetColor, imagery = "sharp", close = false, buildings = null, onImagery }:
  { data: TerrainData; exaggeration: number; showDisplacement: boolean; assetColor: string; imagery?: Imagery; close?: boolean; buildings?: Building[] | null; onImagery?: (s: ImageryState) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // moving a slider or receiving the buildings rebuilds the scene: it must not download the imagery again or lose the view
  const kept = useRef<{ key: string; main?: Drape; around?: Drape; view?: { pos: THREE.Vector3; target: THREE.Vector3 } }>({ key: "" });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    // at least 1.5x, so roads and roof edges stay crisp on ordinary screens too
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 1.5), 2));
    el.appendChild(renderer.domElement);

    const key = JSON.stringify([data.corners, close]);
    if (kept.current.key !== key) kept.current = { key };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 1.5, 2.7);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.005, 30);
    camera.up.set(0, 0, 1);
    camera.position.copy(kept.current.view?.pos ?? new THREE.Vector3(0, -0.8, 0.55));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.minDistance = 0.03;
    controls.maxDistance = 1.8;
    controls.maxPolarAngle = Math.PI / 2 - 0.08;
    if (kept.current.view) controls.target.copy(kept.current.view.target);

    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-1, -1, 2);
    scene.add(sun);

    const { width: w, height: h, heights, min_m: lo, res_m: res } = data;
    const aspect = h / w;
    const sizeM = (w - 1) * res;
    const toZ = (m: number) => ((m - lo) / sizeM) * exaggeration;
    const at = (u: number, v: number) => {
      const x = Math.min(w - 1.001, Math.max(0, u * (w - 1)));
      const y = Math.min(h - 1.001, Math.max(0, v * (h - 1)));
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const v00 = heights[y0 * w + x0], v10 = heights[y0 * w + x0 + 1], v01 = heights[(y0 + 1) * w + x0], v11 = heights[(y0 + 1) * w + x0 + 1];
      return toZ(v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy);
    };

    // the elevation model is 30 m; the surface is subdivided and interpolated so it reads as ground, not as blocks
    const sub = Math.max(1, Math.min(4, Math.floor(260 / Math.max(w, h))));
    const mw = (w - 1) * sub + 1, mh = (h - 1) * sub + 1;
    const geometry = new THREE.PlaneGeometry(1, aspect, mw - 1, mh - 1);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, at((i % mw) / (mw - 1), Math.floor(i / mw) / (mh - 1)));
    geometry.computeVertexNormals();

    const loader = new THREE.TextureLoader();
    const textures: THREE.Texture[] = [];
    const load = (uri: string) => {
      const t = loader.load(uri);
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      return t;
    };
    const canvasTexture = (canvas: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textures.push(t);
      return t;
    };
    const materials: THREE.Material[] = [];
    const shapes: THREE.BufferGeometry[] = [geometry];

    // the ground gets its own copy of the mesh so sharper imagery can have its own texture coordinates while the
    // displacement overlay keeps the ones that match its picture
    const groundGeometry = geometry.clone();
    shapes.push(groundGeometry);
    const ground = new THREE.MeshStandardMaterial({ color: data.satellite ? 0xffffff : 0x9aa78f, map: data.satellite ? load(data.satellite) : null, roughness: 1 });
    materials.push(ground);
    scene.add(new THREE.Mesh(groundGeometry, ground));

    if (showDisplacement && data.displacement) {
      const drape = new THREE.MeshBasicMaterial({ map: load(data.displacement), transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2 });
      scene.add(new THREE.Mesh(geometry, drape));
      materials.push(drape);
    }

    /** Footprints raised from the ground: roofs show the imagery, walls take the colour of the roof they carry. */
    const addBuildings = (drape?: Drape) => {
      if (!buildings?.length) return;
      const roof: number[] = [], roofUv: number[] = [], wall: number[] = [], wallColor: number[] = [];
      const ctx = drape?.mosaic.canvas.getContext("2d") ?? null;
      const world = (u: number, v: number, z: number) => [u - 0.5, (0.5 - v) * aspect, z];
      for (const b of buildings) {
        // sampled first: a footprint whose roof is plainly vegetation does not line up with this image, and would be a box of treetops
        let shade = CONCRETE;
        if (ctx && drape) {
          const cu = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length, cv = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
          const [tu, tv] = textureUv(drape.plan, data.corners!, cu, cv);
          const px = ctx.getImageData(Math.floor(tu * drape.plan.width), Math.floor((1 - tv) * drape.plan.height), 1, 1).data;
          if (px[1] > px[0] * 1.08 && px[1] > px[2] * 1.08) continue;
          shade = CONCRETE.map((c, i) => c * 0.65 + (px[i] / 255) * 0.35);
        }
        const base = Math.min(...b.ring.map(([u, v]) => at(u, v)));
        const top = base + b.h / sizeM;       // true scale: the height slider exaggerates the land, not the buildings
        const faces = THREE.ShapeUtils.triangulateShape(b.ring.map(([u, v]) => new THREE.Vector2(u, v)), []);
        for (const face of faces) {
          for (const i of face) {
            const [u, v] = b.ring[i];
            roof.push(...world(u, v, top));
            if (drape) roofUv.push(...textureUv(drape.plan, data.corners!, u, v));
            else roofUv.push(u, 1 - v);
          }
        }
        b.ring.forEach(([u, v], i) => {
          const [u2, v2] = b.ring[(i + 1) % b.ring.length];
          const quad = [world(u, v, base), world(u2, v2, base), world(u2, v2, top), world(u, v, base), world(u2, v2, top), world(u, v, top)];
          for (const p of quad) { wall.push(...p); wallColor.push(...shade); }
        });
      }
      const roofGeometry = new THREE.BufferGeometry();
      roofGeometry.setAttribute("position", new THREE.Float32BufferAttribute(roof, 3));
      roofGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(roofUv, 2));
      roofGeometry.computeVertexNormals();
      const wallGeometry = new THREE.BufferGeometry();
      wallGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wall, 3));
      wallGeometry.setAttribute("color", new THREE.Float32BufferAttribute(wallColor, 3));
      wallGeometry.computeVertexNormals();
      const roofMaterial = new THREE.MeshStandardMaterial({ color: drape ? 0xffffff : 0xcfc9bd, map: drape ? ground.map : null, roughness: 1, side: THREE.DoubleSide });
      const wallMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
      shapes.push(roofGeometry, wallGeometry);
      materials.push(roofMaterial, wallMaterial);
      scene.add(new THREE.Mesh(roofGeometry, roofMaterial), new THREE.Mesh(wallGeometry, wallMaterial));
    };

    const abort = new AbortController();
    const sharpWanted = imagery === "sharp" && !!data.corners && data.corners.length === 4 && !showDisplacement;
    onImagery?.(sharpWanted ? "loading" : "sentinel");
    if (sharpWanted) {
      const corners = data.corners!;
      void (async () => {
        try {
          let main = kept.current.main;
          if (!main) {
            const plan = planMosaic(corners, close ? CLOSE : WIDE);
            const mosaic = await loadMosaic(plan, abort.signal);
            if (abort.signal.aborted) return;
            // most tiles missing (offline, blocked): keep the Sentinel-2 picture and say so
            if (mosaic.loaded < mosaic.total / 2) { addBuildings(); onImagery?.("unavailable"); return; }
            sharpen(mosaic.canvas);
            main = { plan, mosaic };
            kept.current.main = main;
          }
          const uv = new Float32Array(groundGeometry.attributes.position.count * 2);
          for (let i = 0; i < groundGeometry.attributes.position.count; i++) {
            const [tu, tv] = textureUv(main.plan, corners, (i % mw) / (mw - 1), Math.floor(i / mw) / (mh - 1));
            uv[i * 2] = tu;
            uv[i * 2 + 1] = tv;
          }
          groundGeometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          ground.map = canvasTexture(main.mosaic.canvas);
          ground.color.set(0xffffff);
          ground.needsUpdate = true;
          addBuildings(main);
          onImagery?.("sharp");

          // the land around the terrain, coarser and flat, so the view has no empty edge
          let around = kept.current.around;
          const big = extendCorners(corners, SURROUND);
          if (!around) {
            const plan = planMosaic(big, { maxZoom: 17, maxSide: 2816 });
            const mosaic = await loadMosaic(plan, abort.signal);
            if (abort.signal.aborted || mosaic.loaded < mosaic.total / 2) return;
            sharpen(mosaic.canvas);
            around = { plan, mosaic };
            kept.current.around = around;
          }
          const segments = 16;
          const plane = new THREE.PlaneGeometry(SURROUND, SURROUND * aspect, segments, segments);
          const planeUv = plane.attributes.uv;
          for (let i = 0; i < planeUv.count; i++) {
            const [tu, tv] = textureUv(around.plan, big, (i % (segments + 1)) / segments, Math.floor(i / (segments + 1)) / segments);
            planeUv.setXY(i, tu, tv);
          }
          plane.translate(0, 0, -0.002);
          const aroundMaterial = new THREE.MeshStandardMaterial({ map: canvasTexture(around.mosaic.canvas), roughness: 1 });
          shapes.push(plane);
          materials.push(aroundMaterial);
          scene.add(new THREE.Mesh(plane, aroundMaterial));
        } catch {
          if (!abort.signal.aborted) onImagery?.("unavailable");
        }
      })();
    } else {
      addBuildings();
    }

    // The asset keeps the same thin width on screen at every zoom, and runs straight between its own points. It is drawn
    // over everything, so a hill or a building never hides where it is.
    const lift = 0.001;
    const place = ([u, v]: number[]) => [u - 0.5, (0.5 - v) * aspect, at(u, v) + lift];
    // one point per terrain cell, so the line lies on the ground instead of cutting through it
    const follow = (line: number[][]) => line.flatMap((p, i) => {
      if (i === 0) return [p];
      const [u0, v0] = line[i - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot((p[0] - u0) * (w - 1), (p[1] - v0) * (h - 1))));
      return Array.from({ length: steps }, (_, k) => [u0 + ((p[0] - u0) * (k + 1)) / steps, v0 + ((p[1] - v0) * (k + 1)) / steps]);
    });
    const lineMaterial = new LineMaterial({ color: new THREE.Color(assetColor).getHex(), linewidth: ASSET_LINE_PX, depthTest: false, transparent: true });
    const dot = dotTexture();
    textures.push(dot);
    const pointMaterial = new THREE.PointsMaterial({ color: assetColor, size: ASSET_POINT_PX, sizeAttenuation: false, map: dot, alphaTest: 0.5, depthTest: false, transparent: true });
    materials.push(lineMaterial, pointMaterial);
    for (const line of data.lines) {
      if (line.length < 2) {
        const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(place(line[0]), 3));
        shapes.push(g);
        const points = new THREE.Points(g, pointMaterial);
        points.renderOrder = 2;
        scene.add(points);
      } else {
        const g = new LineGeometry();
        g.setPositions(follow(line).flatMap(place));
        shapes.push(g);
        const mesh = new Line2(g, lineMaterial);
        mesh.renderOrder = 2;
        scene.add(mesh);
      }
    }

    const fit = () => {
      const { clientWidth: cw, clientHeight: ch } = el;
      if (!cw || !ch) return;
      renderer.setSize(cw, ch);
      lineMaterial.resolution.set(cw, ch);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      abort.abort();
      kept.current.view = { pos: camera.position.clone(), target: controls.target.clone() };
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      shapes.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, exaggeration, showDisplacement, assetColor, imagery, close, buildings]);

  if (failed) return <p className="notice notice-warn">This browser could not start 3D graphics, so the terrain view is unavailable.</p>;
  return <div ref={host} className="twin-canvas" role="img" aria-label="3D view of the terrain around the asset. Drag to rotate, right-drag to move, scroll to zoom." />;
}
