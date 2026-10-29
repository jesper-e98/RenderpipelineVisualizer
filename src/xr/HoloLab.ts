import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
} from 'three';
import { glowTexture } from '../views/three-helpers';

/** Lab layout in the lab's local frame: user at the origin, looking down −z, y up from the floor. */
export const LAB = {
  // Far enough ahead that the holo-console fits between the user and the hologram's grab volume.
  tableCenter: new Vector3(0, 0, -0.9),
  tableRadius: 0.42,
  tableHeight: 0.9,
  /** Where the hologram floats (its centre). */
  holoHome: new Vector3(0, 1.3, -0.9),
  holoScale: 0.2,
};

const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBoot;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  if (r > 1.0) discard;
  float rings = smoothstep(0.035, 0.0, abs(fract(r * 6.0 - uTime * 0.25) - 0.5) - 0.44);
  float spokes = smoothstep(0.02, 0.0, abs(fract(a * 3.8197) - 0.5) - 0.47) * step(0.25, r);
  float rim = smoothstep(0.04, 0.0, abs(r - 0.97));
  float sweep = pow(max(0.0, cos(a - uTime * 1.4)), 24.0) * step(0.2, r) * 0.7;
  float k = (rings * 0.55 + spokes * 0.25 + rim * 1.2 + sweep) * smoothstep(1.0, 0.85, r / max(uBoot, 0.001));
  gl_FragColor = vec4(uColor * k, k);
}
`;

const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float fade = pow(1.0 - vUv.y, 1.4) * 0.45 + 0.05;
  float streak = 0.6 + 0.4 * sin(vUv.x * 120.0 + uTime * 2.0) * sin(vUv.x * 37.0 - uTime);
  float scan = smoothstep(0.06, 0.0, abs(fract(vUv.y - uTime * 0.35) - 0.5));
  float a = (fade * streak + scan * 0.25) * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uWave;
varying vec2 vUv;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * 3.0;
  float r = length(p);
  float grid = smoothstep(0.02, 0.0, abs(fract(r * 2.0) - 0.5) - 0.48);
  float a = atan(p.y, p.x);
  float spokes = smoothstep(0.01, 0.0, abs(fract(a * 1.9099) - 0.5) - 0.49);
  float wave = smoothstep(0.12, 0.0, abs(r - uWave)) * 1.2;
  float k = (grid * 0.35 + spokes * 0.12) * smoothstep(3.0, 0.6, r) + wave * smoothstep(3.0, 0.0, r);
  gl_FragColor = vec4(vec3(0.42, 0.36, 1.0) * k + vec3(0.2, 0.85, 1.0) * wave * 0.6, k);
}
`;

const VERT_UV = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

function shader(frag: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT_UV,
    fragmentShader: frag,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/**
 * The holographic lab around the user: a glowing table with a projector beam, rotating rings and
 * a scan line around the hologram, a floor grid with a boot wave, and floating dust.
 */
export class HoloLab {
  readonly root = new Group();
  private floor: Mesh;
  private tableTop: Mesh;
  private tableBody: Mesh;
  private rim: Mesh;
  private beam: Mesh;
  private rings: Mesh[] = [];
  private scan: Mesh;
  private dust: Points;
  private t = 0;
  private bootT = 10;
  private materials: ShaderMaterial[] = [];

  constructor() {
    const c = LAB.tableCenter;
    // Floor.
    const floorMat = shader(FLOOR_FRAG, { uTime: { value: 0 }, uWave: { value: 99 } });
    this.floor = new Mesh(new CircleGeometry(3, 64), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(c.x, 0.002, c.z);
    // Table body + glowing top.
    this.tableBody = new Mesh(
      new CylinderGeometry(LAB.tableRadius, LAB.tableRadius * 0.8, LAB.tableHeight, 48, 1, true),
      new MeshBasicMaterial({ color: 0x0b1236, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false }),
    );
    this.tableBody.position.set(c.x, LAB.tableHeight / 2, c.z);
    const topMat = shader(RING_FRAG, { uTime: { value: 0 }, uBoot: { value: 1 }, uColor: { value: [0.22, 0.88, 1.0] } });
    this.tableTop = new Mesh(new CircleGeometry(LAB.tableRadius, 64), topMat);
    this.tableTop.rotation.x = -Math.PI / 2;
    this.tableTop.position.set(c.x, LAB.tableHeight + 0.002, c.z);
    this.rim = new Mesh(
      new TorusGeometry(LAB.tableRadius, 0.006, 8, 96),
      new MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false }),
    );
    this.rim.rotation.x = -Math.PI / 2;
    this.rim.position.copy(this.tableTop.position);
    // Projector beam: narrow at the table, wide around the hologram.
    const beamMat = shader(BEAM_FRAG, { uTime: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: [0.25, 0.8, 1.0] } });
    this.beam = new Mesh(new CylinderGeometry(0.3, 0.05, 0.5, 48, 1, true), beamMat);
    this.beam.position.set(c.x, LAB.tableHeight + 0.25, c.z);
    // Rings around the hologram's base.
    [0.26, 0.31, 0.35].forEach((r, i) => {
      const m = new Mesh(
        new RingGeometry(r - 0.004, r, 96, 1, 0, Math.PI * (1.2 + i * 0.25)),
        new MeshBasicMaterial({ color: i === 1 ? 0xff3fd2 : 0x38e1ff, transparent: true, opacity: 0.7, blending: AdditiveBlending, side: DoubleSide, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(c.x, LAB.tableHeight + 0.06 + i * 0.02, c.z);
      this.rings.push(m);
    });
    // Scan line moving through the hologram.
    this.scan = new Mesh(
      new RingGeometry(0.0, 0.27, 64),
      new MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.12, blending: AdditiveBlending, side: DoubleSide, depthWrite: false }),
    );
    this.scan.rotation.x = -Math.PI / 2;
    // Dust.
    const n = 380;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.4 + Math.random() * 2.6;
      pos.set([c.x + Math.cos(a) * r, Math.random() * 2.6, c.z + Math.sin(a) * r], i * 3);
    }
    const dg = new BufferGeometry();
    dg.setAttribute('position', new BufferAttribute(pos, 3));
    this.dust = new Points(
      dg,
      new PointsMaterial({ color: 0x9fdcff, size: 0.012, map: glowTexture(), transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false }),
    );
    this.materials = [floorMat, topMat, beamMat];
    this.root.add(this.floor, this.tableBody, this.tableTop, this.rim, this.beam, ...this.rings, this.scan, this.dust, new HemisphereLight(0xffffff, 0x223355, 1));
  }

  /** AR: keep the table and rings (a floating projector), drop the floor and dust. */
  setAR(ar: boolean): void {
    this.floor.visible = !ar;
    this.dust.visible = !ar;
    this.tableBody.visible = !ar;
  }

  /** Start the boot sequence (floor wave, table rises, beam turns on). */
  boot(): void {
    this.bootT = 0;
  }

  /** 0..1 how far the hologram should have materialized (for the controller's scale-in). */
  get materialize(): number {
    return smooth((this.bootT - 1.0) / 0.9);
  }

  /** Quick scan sweep, e.g. when the slide changes. */
  pulse(): void {
    this.pulseT = 0;
  }
  private pulseT = 10;

  update(dt: number): void {
    this.t += dt;
    this.bootT += dt;
    this.pulseT += dt;
    const t = this.t;
    const b = this.bootT;
    for (const m of this.materials) m.uniforms.uTime.value = t;
    (this.floor.material as ShaderMaterial).uniforms.uWave.value = b < 3 ? b * 1.6 : 99;
    const rise = smooth(b / 0.7);
    this.tableBody.scale.y = Math.max(0.001, rise);
    this.tableBody.position.y = (LAB.tableHeight * rise) / 2;
    (this.tableTop.material as ShaderMaterial).uniforms.uBoot.value = smooth((b - 0.4) / 0.8);
    (this.beam.material as ShaderMaterial).uniforms.uOpacity.value = smooth((b - 0.7) / 0.6) * (0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 3.1));
    this.rings.forEach((r, i) => {
      r.rotation.z = t * (0.35 + i * 0.22) * (i % 2 ? -1 : 1);
      r.scale.setScalar(Math.max(0.001, smooth((b - 0.9 - i * 0.1) / 0.5)));
    });
    // Scan line: slow sweep normally, fast after a pulse.
    const fast = this.pulseT < 0.8;
    const ph = fast ? this.pulseT / 0.8 : (Math.sin(t * 0.9) + 1) / 2;
    const y0 = LAB.tableHeight + 0.08;
    const y1 = LAB.holoHome.y + 0.24;
    this.scan.position.set(LAB.tableCenter.x, y0 + (y1 - y0) * ph, LAB.tableCenter.z);
    (this.scan.material as MeshBasicMaterial).opacity = (fast ? 0.35 : 0.1) * smooth((b - 1.2) / 0.5);
    const dp = this.dust.geometry.attributes.position.array as Float32Array;
    for (let i = 1; i < dp.length; i += 3) {
      dp[i] += dt * 0.03;
      if (dp[i] > 2.6) dp[i] = 0;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
