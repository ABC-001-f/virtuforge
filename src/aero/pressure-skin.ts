/**
 * Pressure-coloured "skin" for the model in the tunnel.
 *
 * One shared ShaderMaterial replaces every mesh material under the model.
 * Each fragment is mapped into the tunnel-local x/y plane and looks up the
 * pressure texture written by FlowViz (already a blue-white-red colour map),
 * so the model's surface shows the 2D solver's pressure where it touches it.
 * Points outside the tunnel grid render neutral grey. Lighting is a cheap
 * ambient + fixed directional term with a soft rim, enough to read shape.
 */

import {
  Color,
  DataTexture,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { TUNNEL_HEIGHT, TUNNEL_LENGTH } from './tunnel.js';

const VERTEX_SHADER = /* glsl */ `
uniform mat4 uToTunnel;
uniform vec2 uInvTunnelSize;

varying vec2 vTunnelUv;
varying vec3 vWorldNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec4 p = uToTunnel * worldPos;
  vTunnelUv = p.xy * uInvTunnelSize;

  // Models are uniformly scaled, so the upper 3x3 of modelMatrix is fine for normals.
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewNormal = normalize(normalMatrix * normal);

  vec4 mvPos = viewMatrix * worldPos;
  vViewPos = mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uPressure;
uniform float uDecodeSrgb;   // 1 when the texture holds raw sRGB bytes (no hardware decode)
uniform vec3 uNeutral;       // linear grey for points outside the tunnel grid
uniform vec3 uLightDir;      // world-space, normalised, pointing toward the light

varying vec2 vTunnelUv;
varying vec3 vWorldNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

void main() {
  vec3 base = uNeutral;
  if (vTunnelUv.x >= 0.0 && vTunnelUv.x <= 1.0 && vTunnelUv.y >= 0.0 && vTunnelUv.y <= 1.0) {
    vec3 c = texture2D(uPressure, clamp(vTunnelUv, 0.0, 1.0)).rgb;
    base = mix(c, srgbToLinear(c), uDecodeSrgb);
  }

  vec3 n = normalize(vWorldNormal);
  if (!gl_FrontFacing) n = -n;
  float diffuse = max(dot(n, uLightDir), 0.0);

  vec3 vn = normalize(vViewNormal);
  if (!gl_FrontFacing) vn = -vn;
  vec3 viewDir = normalize(-vViewPos);
  float rim = pow(1.0 - clamp(dot(vn, viewDir), 0.0, 1.0), 3.0);

  vec3 color = base * (0.35 + 0.65 * diffuse) + vec3(0.18) * rim;
  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
}
`;

export class PressureSkin {
  private readonly material: ShaderMaterial;
  private readonly texture: DataTexture;
  private readonly originals = new WeakMap<Mesh, Material | Material[]>();
  private readonly scratch = new Matrix4();

  constructor(pressureTexture: DataTexture) {
    this.texture = pressureTexture;
    this.material = new ShaderMaterial({
      uniforms: {
        uPressure: { value: pressureTexture },
        uToTunnel: { value: new Matrix4() },
        uInvTunnelSize: { value: new Vector2(1 / TUNNEL_LENGTH, 1 / TUNNEL_HEIGHT) },
        uDecodeSrgb: { value: pressureTexture.colorSpace === SRGBColorSpace ? 0 : 1 },
        uNeutral: { value: new Color(0.62, 0.63, 0.65).convertSRGBToLinear() },
        uLightDir: { value: new Vector3(0.3, 0.8, 0.55).normalize() },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      toneMapped: false,
    });
  }

  /** Swap every mesh material under `model` for the skin, remembering the originals. */
  apply(model: Object3D): void {
    model.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh || mesh.userData.noSilhouette) return;
      if (!this.originals.has(mesh)) this.originals.set(mesh, mesh.material);
      mesh.material = this.material;
    });
  }

  /** Restore the original materials under `model`. */
  remove(model: Object3D): void {
    model.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const original = this.originals.get(mesh);
      if (original === undefined) return;
      mesh.material = original;
      this.originals.delete(mesh);
    });
  }

  /** Per frame: refresh the world-to-tunnel matrix. No allocation. */
  update(tunnel: Object3D): void {
    const u = this.material.uniforms;
    (u.uToTunnel.value as Matrix4).copy(this.scratch.copy(tunnel.matrixWorld).invert());
    u.uDecodeSrgb.value = this.texture.colorSpace === SRGBColorSpace ? 0 : 1;
  }

  dispose(): void {
    this.material.dispose();
  }
}
