import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  IcosahedronGeometry,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three';
import { TeapotGeometry } from 'three/examples/jsm/geometries/TeapotGeometry.js';
import { L } from '../core/i18n';
import { geometryToMesh, geometryToObj, textPreview } from './normalize';
import type { MeshData } from './types';

function triangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.9, -0.7, 0, 0.9, -0.7, 0, 0, 0.85, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  g.setIndex([0, 1, 2]);
  return g;
}

export const BUILTINS = [
  { id: 'teapot', label: L('Utah-tekanna', 'Utah teapot'), make: () => new TeapotGeometry(1, 5) },
  { id: 'cube', label: L('Kub', 'Cube'), make: () => new BoxGeometry(1.2, 1.2, 1.2) },
  { id: 'sphere', label: L('Sfär', 'Sphere'), make: () => new SphereGeometry(1, 20, 14) },
  { id: 'torusknot', label: L('Torusknut', 'Torus knot'), make: () => new TorusKnotGeometry(0.8, 0.28, 96, 12) },
  { id: 'ico', label: L('Ikosaeder', 'Icosahedron'), make: () => new IcosahedronGeometry(1, 0) },
  { id: 'triangle', label: L('En triangel', 'A single triangle'), make: triangle },
] as const;

export type BuiltinId = (typeof BUILTINS)[number]['id'];

export function builtinMesh(id: BuiltinId): MeshData {
  const def = BUILTINS.find((b) => b.id === id) ?? BUILTINS[0];
  const geometry = def.make();
  const objText = geometryToObj(geometry, def.id);
  return geometryToMesh(
    geometry,
    { normals: true, uvs: !!geometry.attributes.uv, indices: !!geometry.index },
    {
      name: def.id,
      format: 'builtin',
      fileSize: new TextEncoder().encode(objText).length,
      sourcePreview: textPreview(objText),
      sourceIsBinary: false,
    },
  );
}
