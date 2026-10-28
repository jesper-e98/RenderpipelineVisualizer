import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Vector3,
  WireframeGeometry,
} from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MeshData } from '../model/types';
import { meshToGeometry } from '../model/normalize';
import { BASE_COLOR, FRAGMENT_GLSL, LIGHT_DIR, VERTEX_GLSL } from '../pipeline/shade';
import { DEFAULT_CAMERA } from '../pipeline/transform';

export const COLORS = {
  cyan: 0x38e1ff,
  magenta: 0xff3fd2,
  amber: 0xffb547,
  violet: 0x9b7bff,
  green: 0x5cf08f,
  red: 0xff5a6e,
  white: 0xffffff,
};

/** A standard scene + camera placed like the pipeline's DEFAULT_CAMERA. */
export function makeScene(fov = DEFAULT_CAMERA.fovY): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(fov, 1, 0.05, 100);
  camera.position.set(...DEFAULT_CAMERA.eye);
  camera.lookAt(0, 0, 0);
  scene.add(new AmbientLight(0xffffff, 0.4));
  return { scene, camera };
}

/** The mesh shaded with exactly the same Blinn–Phong shader the CPU rasterizer uses. */
export function shadedMesh(mesh: MeshData, color = BASE_COLOR): Mesh {
  const material = new ShaderMaterial({
    vertexShader: VERTEX_GLSL,
    fragmentShader: FRAGMENT_GLSL,
    uniforms: {
      uLightDir: { value: new Vector3(...LIGHT_DIR) },
      uBaseColor: { value: new Color(...color) },
    },
  });
  return new Mesh(meshToGeometry(mesh), material);
}

export function wireframe(mesh: MeshData, color = COLORS.cyan, opacity = 0.35): LineSegments {
  const geo = mesh.triangleCount > 20000 ? new EdgesGeometry(meshToGeometry(mesh), 25) : new WireframeGeometry(meshToGeometry(mesh));
  return new LineSegments(geo, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

export function vertexPoints(mesh: MeshData, color = COLORS.cyan, size = 0.035): Points {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  return new Points(
    g,
    new PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
  );
}

/** A slowly drifting field of glowing dust behind the scene. */
export function starfield(count = 900, radius = 18): Points & { tick: (t: number) => void } {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const palette = [new Color(COLORS.cyan), new Color(COLORS.magenta), new Color(COLORS.violet), new Color(COLORS.white)];
  for (let i = 0; i < count; i++) {
    const r = radius * (0.35 + Math.random() * 0.65);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
    const c = palette[i % palette.length];
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  const pts = new Points(
    g,
    new PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }),
  ) as unknown as Points & { tick: (t: number) => void };
  pts.tick = (t) => {
    pts.rotation.y = t * 0.02;
    pts.rotation.x = Math.sin(t * 0.05) * 0.1;
  };
  return pts;
}

/** An HTML label anchored to a 3D position (rendered by the CSS2DRenderer). */
export function label(text: string, className = ''): CSS2DObject {
  const el = document.createElement('div');
  el.className = `three-label ${className}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

export function disposeScene(scene: Scene): void {
  scene.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
    else mat?.dispose?.();
  });
}
