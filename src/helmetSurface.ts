import * as THREE from 'three';

const detailTileSize = 256;
const detailTileMeters = 3.2;
const strideMeters = 1.3;
export const helmetFrameInterval = 1000 / 30;
export type HelmetSurfaceData = { elevationM: number; imageryM: number | null };

function sampleNoise(x: number, y: number, period: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const sx = smoothEdge(x - ix);
  const sy = smoothEdge(y - iy);
  const top = THREE.MathUtils.lerp(hash(ix, iy, period, seed), hash(ix + 1, iy, period, seed), sx);
  const bottom = THREE.MathUtils.lerp(hash(ix, iy + 1, period, seed), hash(ix + 1, iy + 1, period, seed), sx);
  return THREE.MathUtils.lerp(top, bottom, sy);
}

function smoothEdge(t: number) {
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number, period: number, seed: number) {
  const column = (x + period) % period;
  const row = (y + period) % period;
  let value = Math.imul(column + seed, 1597334677) ^ Math.imul(row + seed, 3812015801);
  value = Math.imul(value ^ value >>> 16, 2246822507);
  return ((value ^ value >>> 13) >>> 0) / 4294967295;
}

function gravel(x: number, y: number, count: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let height = 0;
  for (let row = iy - 1; row <= iy + 1; row++) {
    for (let col = ix - 1; col <= ix + 1; col++) {
      const size = hash(col, row, count, seed);
      if (size < 0.27) continue;
      const dx = x - col - hash(col, row, count, seed + 24);
      const dy = y - row - hash(col, row, count, seed + 69);
      const angle = hash(col, row, count, seed + 167) * Math.PI;
      const a = dx * Math.cos(angle) + dy * Math.sin(angle);
      const b = dy * Math.cos(angle) - dx * Math.sin(angle);
      const radius = 0.14 + size * 0.29;
      const edge = 1 - Math.min(1, Math.hypot(a, b * 1.55) / radius);
      height = Math.max(height, smoothEdge(edge) * size);
    }
  }
  return height;
}

let packedDetail: Uint8Array | undefined;

function makeDetailPixels() {
  const size = detailTileSize;
  const heights = new Float32Array(size * size);
  const tones = new Uint8Array(size * size);
  const rock = new Uint8Array(size * size);
  const step = detailTileMeters / size;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const u = col / size;
      const v = row / size;
      const index = row * size + col;
      const silt = sampleNoise(u * 19, v * 19, 19, 102);
      const grain = sampleNoise(u * 101, v * 101, 101, 232);
      const pebbles = gravel(u * 19, v * 19, 19, 41);
      const fragments = gravel(u * 7, v * 7, 7, 125) * sampleNoise(u * 7, v * 7, 7, 438);
      heights[index] = silt * 0.014 + grain * 0.004 + pebbles * 0.048 + fragments * 0.18;
      tones[index] = Math.round(255 * (0.52 * silt + 0.35 * grain + 0.13 * sampleNoise(u * 5, v * 5, 5, 324)));
      rock[index] = Math.round(255 * Math.min(1, pebbles + 1.6 * fragments));
    }
  }
  const pixels = new Uint8Array(size * size * 4);
  const heightAt = (col: number, row: number) => heights[((row + size) % size) * size + (col + size) % size];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      const eastSlope = (heightAt(col + 1, row) - heightAt(col - 1, row)) / (2 * step);
      const southSlope = (heightAt(col, row + 1) - heightAt(col, row - 1)) / (2 * step);
      pixels[index * 4] = Math.round(127.5 + THREE.MathUtils.clamp(eastSlope, -1, 1) * 127.5);
      pixels[index * 4 + 1] = Math.round(127.5 + THREE.MathUtils.clamp(southSlope, -1, 1) * 127.5);
      pixels[index * 4 + 2] = tones[index];
      pixels[index * 4 + 3] = rock[index];
    }
  }
  return pixels;
}

export function helmetSurfaceDetail(anisotropy: number) {
  const texture = new THREE.DataTexture(packedDetail ??= makeDetailPixels(), detailTileSize, detailTileSize);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

export function helmetOpticalMaterial(detail: THREE.DataTexture, metersPerUnit: number) {
  const material = new THREE.MeshStandardMaterial({ color: '#ad805c', roughness: 0.96, dithering: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceDetail = { value: detail };
    shader.uniforms.metersPerUnit = { value: metersPerUnit };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      varying vec2 surfacePosition;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      surfacePosition = (modelMatrix * vec4(position, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 surfacePosition;
      uniform sampler2D surfaceDetail;
      uniform float metersPerUnit;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      vec2 meters = surfacePosition * metersPerUnit;
      vec2 oblique = mat2(0.8, 0.6, -0.6, 0.8) * meters;
      vec4 variation = texture2D(surfaceDetail, oblique / 13.8 + vec2(0.24, 0.83));
      vec4 grit = texture2D(surfaceDetail, meters / ${detailTileMeters.toFixed(1)});
      vec4 gravel = texture2D(surfaceDetail, oblique / 4.6 + vec2(0.36, 0.09));
      gravel.rg = mat2(0.8, -0.6, 0.6, 0.8) * (gravel.rg - 0.5) + 0.5;
      vec4 micro = mix(grit, gravel, smoothstep(0.38, 0.66, variation.b));
      float detailWeight = 1.0 - smoothstep(4.0, 25.0, length(vViewPosition) * metersPerUnit);
      float rockAmount = smoothstep(0.13, 0.67, micro.a) * mix(0.47, 1.0, variation.b);
      vec3 groundTone = vec3(1.13, 0.92, 0.72);
      vec3 rockTone = vec3(0.63, 0.65, 0.66);
      vec3 detailColor = mix(groundTone, rockTone, rockAmount) * mix(0.7, 1.36, micro.b);
      diffuseColor.rgb *= mix(vec3(1.0), detailColor, detailWeight);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec2 slopes = micro.rg * 2.0 - 1.0;
      vec3 slopeInView = mat3(viewMatrix) * vec3(slopes.x, 0.0, slopes.y);
      normal = normalize(normal - slopeInView * detailWeight * (0.72 + rockAmount * 0.65));`);
  };
  return material;
}

export function helmetSky(far: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      daylight: { value: 1 },
      sunDirection: { value: new THREE.Vector3(0, 1, 0) },
      dustColor: { value: new THREE.Color('#ae7c61') },
    },
    vertexShader: `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 skyDirection;
      uniform float daylight;
      uniform vec3 sunDirection;
      uniform vec3 dustColor;
      void main() {
        vec3 direction = normalize(skyDirection);
        float height = smoothstep(0.0, 0.67, direction.y);
        vec3 zenith = mix(vec3(0.012, 0.015, 0.027), vec3(0.15, 0.10, 0.105), daylight);
        float sunAmount = max(0.0, dot(direction, sunDirection));
        vec3 sky = mix(dustColor, zenith, height);
        sky += (0.13 * pow(sunAmount, 10.0) + 0.48 * pow(sunAmount, 950.0)) * daylight * vec3(1.0, 0.72, 0.49);
        gl_FragColor = vec4(sky, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(far * 0.8, 24, 12), material);
  sky.renderOrder = -1;
  return sky;
}

export function helmetStep(distanceM: number, walking: boolean) {
  if (!walking) return { height: 0, roll: 0 };
  const phase = distanceM / strideMeters * Math.PI * 2;
  const fadeIn = Math.min(1, distanceM / 0.65);
  return { height: Math.cos(phase * 2) * 0.022 * fadeIn, roll: Math.sin(phase) * 0.007 * fadeIn };
}
