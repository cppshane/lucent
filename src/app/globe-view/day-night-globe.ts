/**
 * Day/night terminator on the globe mesh — same approach as
 * https://github.com/vasturiano/globe.gl/blob/master/example/day-night-cycle/index.html
 */
import * as THREE from 'three';
import { century, declination, equationOfTime } from 'solar-calculator';

/** Sub-solar point [lng, lat] in degrees (globe.gl / three-globe convention). */
export function sunSubSolarPoint(timestampMs: number): [number, number] {
  const dt = timestampMs;
  const day = new Date(dt);
  day.setUTCHours(0, 0, 0, 0);
  const dayStart = +day;
  const t = century(new Date(dt));
  const longitude = (dayStart - dt) / 864e5 * 360 - 180;
  return [longitude - equationOfTime(t) / 4, declination(t)];
}

const dayNightVertexGlsl = /* glsl */ `
out vec3 vNormal;
out vec2 vUv;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const dayNightFragmentGlsl = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform vec2 sunPosition;
uniform vec2 globeRotation;
/** Limits Blue Marble peaks before mixing so UnrealBloom (full-frame) ignores clouds/snow. */
uniform float globeDayTextureCap;

in vec3 vNormal;
in vec2 vUv;
out vec4 fragColor;

#define PI 3.141592653589793

float toRad(in float a) {
  return a * PI / 180.0;
}

vec3 polar2Cartesian(in vec2 c) {
  float theta = toRad(90.0 - c.x);
  float phi = toRad(90.0 - c.y);
  return vec3(
    sin(phi) * cos(theta),
    cos(phi),
    sin(phi) * sin(theta)
  );
}

void main() {
  float invLon = toRad(globeRotation.x);
  float invLat = -toRad(globeRotation.y);
  mat3 rotX = mat3(
    1, 0, 0,
    0, cos(invLat), -sin(invLat),
    0, sin(invLat), cos(invLat)
  );
  mat3 rotY = mat3(
    cos(invLon), 0, sin(invLon),
    0, 1, 0,
    -sin(invLon), 0, cos(invLon)
  );
  vec3 rotatedSunDirection = rotX * rotY * polar2Cartesian(sunPosition);
  float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
  vec4 dayColor = texture(dayTexture, vUv);
  dayColor.rgb = min(dayColor.rgb, vec3(globeDayTextureCap));
  vec4 nightColor = texture(nightTexture, vUv);
  float blendFactor = smoothstep(-0.1, 0.1, intensity);
  fragColor = mix(nightColor, dayColor, blendFactor);
}
`;

export function createDayNightGlobeMaterial(
  dayTexture: THREE.Texture,
  nightTexture: THREE.Texture,
  globeDayTextureCap = 0.62,
): THREE.ShaderMaterial {
  dayTexture.colorSpace = THREE.SRGBColorSpace;
  nightTexture.colorSpace = THREE.SRGBColorSpace;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      dayTexture: { value: dayTexture },
      nightTexture: { value: nightTexture },
      sunPosition: { value: new THREE.Vector2() },
      globeRotation: { value: new THREE.Vector2() },
      globeDayTextureCap: { value: globeDayTextureCap },
    },
    vertexShader: dayNightVertexGlsl,
    fragmentShader: dayNightFragmentGlsl,
    polygonOffset: true,
    polygonOffsetFactor: 5,
    polygonOffsetUnits: 5,
  });
}
