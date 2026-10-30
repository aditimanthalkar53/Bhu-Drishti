import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface TerrainData {
  width: number;
  height: number;
  res_m: number;
  heights: number[];
  min_m: number;
  max_m: number;
  lines: number[][][];
  satellite: string | null;
  displacement: string | null;
}

/** Terrain as a mesh with the asset drawn on it. Elevation is measured (30 m DEM); the asset's height above ground is not modelled. */
export default function TwinTerrain({ data, exaggeration, showDisplacement, assetColor }: { data: TerrainData; exaggeration: number; showDisplacement: boolean; assetColor: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
    camera.position.set(0, -1.1, 0.9);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
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

    const geometry = new THREE.PlaneGeometry(1, aspect, w - 1, h - 1);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, toZ(heights[i]));
    geometry.computeVertexNormals();

    const loader = new THREE.TextureLoader();
    const textures: THREE.Texture[] = [];
    const load = (uri: string) => {
      const t = loader.load(uri);
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      return t;
    };
    const ground = new THREE.MeshStandardMaterial({ color: data.satellite ? 0xffffff : 0x9aa78f, map: data.satellite ? load(data.satellite) : null, roughness: 1 });
    scene.add(new THREE.Mesh(geometry, ground));
    const materials: THREE.Material[] = [ground];
    if (showDisplacement && data.displacement) {
      const drape = new THREE.MeshBasicMaterial({ map: load(data.displacement), transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2 });
      scene.add(new THREE.Mesh(geometry, drape));
      materials.push(drape);
    }

    const lift = 0.004;
    const place = ([u, v]: number[]) => new THREE.Vector3(u - 0.5, (0.5 - v) * aspect, at(u, v) + lift);
    // drawn over the terrain, so a hill between the camera and the asset never hides where it is
    const assetMat = new THREE.MeshBasicMaterial({ color: assetColor, depthTest: false, transparent: true });
    // one point per terrain cell, so the line follows the ground instead of cutting through it
    const follow = (line: number[][]) => line.flatMap((p, i) => {
      if (i === 0) return [p];
      const [u0, v0] = line[i - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot((p[0] - u0) * (w - 1), (p[1] - v0) * (h - 1))));
      return Array.from({ length: steps }, (_, k) => [u0 + ((p[0] - u0) * (k + 1)) / steps, v0 + ((p[1] - v0) * (k + 1)) / steps]);
    });
    materials.push(assetMat);
    const shapes: THREE.BufferGeometry[] = [geometry];
    for (const line of data.lines) {
      const g = line.length < 2
        ? new THREE.SphereGeometry(0.012, 16, 12).translate(...place(line[0]).toArray() as [number, number, number])
        : new THREE.TubeGeometry(new THREE.CatmullRomCurve3(follow(line).map(place), false, "catmullrom", 0.01), Math.max(16, follow(line).length * 2), 0.004, 8);
      shapes.push(g);
      const mesh = new THREE.Mesh(g, assetMat);
      mesh.renderOrder = 2;
      scene.add(mesh);
    }

    const fit = () => {
      const { clientWidth: cw, clientHeight: ch } = el;
      if (!cw || !ch) return;
      renderer.setSize(cw, ch);
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
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      shapes.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [data, exaggeration, showDisplacement, assetColor]);

  if (failed) return <p className="notice notice-warn">This browser could not start 3D graphics, so the terrain view is unavailable.</p>;
  return <div ref={host} className="twin-canvas" role="img" aria-label="3D view of the terrain around the asset. Drag to rotate, scroll to zoom." />;
}
