import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vP = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
  float bands = 0.75 + 0.25 * sin(vP.y * 40.0 - uTime * 2.0);
  float k = rim * bands * uIntensity;
  gl_FragColor = vec4(uColor * k, k);
}
`;

export type VolumeState = 'idle' | 'near' | 'grab' | 'explode';

const STATE_STYLE: Record<VolumeState, { color: string; intensity: number }> = {
  idle: { color: '#38e1ff', intensity: 0.07 },
  near: { color: '#38e1ff', intensity: 0.5 },
  grab: { color: '#b9f6ff', intensity: 0.85 },
  explode: { color: '#ffb547', intensity: 0.75 },
};

/**
 * Feedback for grabbing the hologram: a soft glowing shell around it (faint at rest, lit when a
 * hand is within reach, bright while held), a cursor ring at each grab point, and a line between
 * the hands with a pivot dot during two-hand manipulation.
 */
export class GrabVolume {
  readonly group = new Group();
  private shell: Mesh;
  private mat: ShaderMaterial;
  private intensity = 0;
  private color = new Color('#38e1ff');
  private cursors: Mesh[] = [];
  private link: Line;
  private pivot: Mesh;

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uColor: { value: this.color }, uIntensity: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.shell = new Mesh(new SphereGeometry(1, 48, 32), this.mat);
    this.shell.renderOrder = 15;
    this.group.add(this.shell);
    for (let i = 0; i < 2; i++) {
      const m = new Mesh(
        new RingGeometry(0.011, 0.015, 40),
        new MeshBasicMaterial({ color: i ? 0x9b7bff : 0x38e1ff, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, depthTest: false, side: DoubleSide }),
      );
      m.add(new Mesh(new RingGeometry(0, 0.004, 24), m.material as MeshBasicMaterial));
      m.renderOrder = 46;
      m.visible = false;
      this.cursors.push(m);
      this.group.add(m);
    }
    this.link = new Line(
      new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
      new LineBasicMaterial({ color: 0xb9f6ff, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }),
    );
    this.link.frustumCulled = false;
    this.pivot = new Mesh(new SphereGeometry(0.006, 12, 8), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
    this.link.visible = this.pivot.visible = false;
    this.group.add(this.link, this.pivot);
  }

  /** Shell around the hologram: centre, radius and state; eases between states. */
  update(dt: number, time: number, centre: Vector3, radius: number, state: VolumeState): void {
    const st = STATE_STYLE[state];
    const k = 1 - Math.exp(-dt / 0.08);
    this.intensity += (st.intensity - this.intensity) * k;
    this.color.lerp(new Color(st.color), k);
    this.mat.uniforms.uIntensity.value = this.intensity;
    this.mat.uniforms.uTime.value = time;
    this.shell.position.copy(centre);
    this.shell.scale.setScalar(radius);
  }

  /** Cursor `i` at a grab point (null hides it); `grabbing` makes it small and bright. */
  cursor(i: number, at: Vector3 | null, head: Vector3, grabbing: boolean): void {
    const c = this.cursors[i];
    if (!c) return;
    c.visible = !!at;
    if (!at) return;
    c.position.copy(at);
    c.lookAt(head);
    const d = Math.max(0.3, at.distanceTo(head));
    c.scale.setScalar((grabbing ? 0.7 : 1.1) * (d / 0.6));
    (c.material as MeshBasicMaterial).opacity = grabbing ? 1 : 0.75;
  }

  /** Two-hand link: a line between the hands and a dot at the pivot (their midpoint). */
  twoHand(a: Vector3 | null, b: Vector3 | null): void {
    const on = !!a && !!b;
    this.link.visible = this.pivot.visible = on;
    if (!on) return;
    const arr = this.link.geometry.attributes.position.array as Float32Array;
    arr.set([a!.x, a!.y, a!.z, b!.x, b!.y, b!.z]);
    this.link.geometry.attributes.position.needsUpdate = true;
    this.pivot.position.copy(a!).add(b!).multiplyScalar(0.5);
  }
}
