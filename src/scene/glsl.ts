/** Shared GLSL snippets: noise, procedural lithology, data-texture sampling. */

export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
// anti-aliased noise: fades an octave out once it is smaller than a pixel
float aaNoise(vec3 p, float freq, float fw){
  float k = 1.0 - smoothstep(0.25, 0.9, fw * freq);
  return k > 0.001 ? snoise(p * freq) * k : 0.0;
}
float fbm4(vec3 p, float fw){
  float a=0.5, s=0.0, f=1.0;
  for(int i=0;i<4;i++){ s+=a*aaNoise(p,f,fw); f*=2.03; a*=0.5; }
  return s;
}
vec3 hash33(vec3 p){
  p=fract(p*vec3(0.1031,0.1030,0.0973)); p+=dot(p,p.yxz+33.33);
  return fract((p.xxy+p.yxx)*p.zyx);
}
// Worley F1 distance
float worley(vec3 p){
  vec3 i=floor(p); vec3 f=fract(p); float d=8.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 o=hash33(i+g);
    vec3 r=g+o-f; d=min(d,dot(r,r));
  }
  return sqrt(d);
}
// Worley F1 distance + random id of the nearest feature point
vec2 worleyId(vec3 p){
  vec3 i=floor(p); vec3 f=fract(p); float d=8.0; float id=0.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 o=hash33(i+g);
    vec3 r=g+o-f; float dd=dot(r,r);
    if(dd<d){ d=dd; id=hash33(i+g+17.31).x; }
  }
  return vec2(sqrt(d), id);
}
`;

/**
 * Procedural lithology. litho ids match LITHO_INDEX in stratigraphy.ts.
 * p = world position (m), strat = stratigraphic depth below the unit's top (m),
 * fw = world-space footprint of one pixel (m) used to band-limit detail.
 */
export const ROCK = /* glsl */ `
vec3 rockColor(float litho, vec3 base, vec3 p, float strat, float fw, out float rough, out float h){
  int L = int(litho + 0.5);
  float n1 = fbm4(p * 0.08, fw);
  float n2 = aaNoise(p, 0.9, fw);
  float grain = aaNoise(p, 7.0, fw);
  float warp = n1 * 2.2;
  vec3 col = base;
  rough = 0.92; h = 0.0;
  float bandAA = 1.0 - smoothstep(0.3, 1.5, fw * 6.0);
  // regional-scale tone variation and metre-scale bedding sets, visible from far away
  float regional = fbm4(p * 0.0035, fw * 0.0035);
  float farAA = 1.0 - smoothstep(0.4, 2.5, fw / 6.0);
  float beds = sin((strat + regional * 30.0) * 6.2832 / 11.0) * farAA;
  float beds2 = sin((strat * 1.37 + regional * 12.0) * 6.2832 / 3.7) * (1.0 - smoothstep(0.3, 2.0, fw / 1.5));
  col *= 1.0 + 0.16 * regional + 0.06 * beds + 0.04 * beds2;
  if (L == 0) { // water
    rough = 0.1;
  } else if (L == 2) { // sandstone: laminae + cross-sets + grain speckle
    float lam = sin((strat + warp) * 6.2832 / 0.55) * bandAA;
    float xset = sin((strat * 1.7 + p.x * 0.25 + p.z * 0.15 + warp) * 6.2832 / 0.9) * 0.5 * bandAA;
    col *= 0.9 + 0.06 * lam + 0.04 * xset + 0.12 * grain;
    col = mix(col, col * vec3(1.08, 0.98, 0.84), smoothstep(-0.2, 0.6, n1));
    h = grain * 0.5 + lam * 0.2;
    rough = 0.96;
  } else if (L == 1) { // soft claystone
    float lam = sin((strat + warp * 0.6) * 6.2832 / 0.35) * bandAA;
    col *= 0.9 + 0.04 * lam + 0.08 * n2 + 0.04 * grain;
    h = n2 * 0.25 + lam * 0.08;
    rough = 0.88;
  } else if (L == 3) { // chalk: stylolites + flint nodules
    float sty = smoothstep(0.93, 1.0, sin((strat + n1 * 3.0 + aaNoise(p, 0.6, fw) * 0.5) * 6.2832 / 2.4)) * bandAA;
    float flint = smoothstep(0.62, 0.72, aaNoise(p + 13.0, 0.35, fw)) * step(0.55, fract(strat / 6.0));
    col *= 0.93 + 0.07 * n2 + 0.03 * grain;
    col = mix(col, vec3(0.32, 0.3, 0.27), sty * 0.75);
    col = mix(col, vec3(0.11, 0.11, 0.12), flint * 0.85);
    h = n2 * 0.3 - sty * 0.8 + flint * 0.6;
    rough = 0.78;
  } else if (L == 4) { // marl: rhythmic chalk / marl couplets
    float cyc = smoothstep(-0.3, 0.3, sin((strat + warp * 0.5) * 6.2832 / 1.6)) * bandAA;
    col = mix(col * 0.8, col * 1.15, cyc);
    col *= 0.94 + 0.06 * n2;
    h = cyc * 0.3 + n2 * 0.2;
    rough = 0.85;
  } else if (L == 5) { // organic black shale: fissile, slight sheen
    float lam = sin((strat + warp * 0.3) * 6.2832 / 0.12) * (1.0 - smoothstep(0.1, 0.6, fw * 12.0));
    col *= 0.85 + 0.12 * lam + 0.1 * n2;
    h = lam * 0.3;
    rough = 0.55;
  } else if (L == 6) { // silty shale
    float lam = sin((strat + warp * 0.5) * 6.2832 / 0.25) * bandAA;
    col *= 0.9 + 0.06 * lam + 0.07 * n2 + 0.05 * grain;
    h = lam * 0.2 + grain * 0.2;
    rough = 0.82;
  } else if (L == 7) { // heterolithic delta plain: sand/mud alternations + coal streaks
    float alt = smoothstep(-0.2, 0.2, sin((strat + warp) * 6.2832 / 1.1)) * bandAA;
    col = mix(col * 0.72, col * 1.25, alt);
    float coal = smoothstep(0.985, 1.0, sin((strat + n1) * 6.2832 / 7.0)) * bandAA;
    col = mix(col, vec3(0.05, 0.05, 0.05), coal);
    col *= 0.94 + 0.08 * grain;
    h = alt * 0.3 + grain * 0.2;
    rough = mix(0.9, 0.45, coal);
  } else { // red beds with reduction spots
    float spot = smoothstep(0.7, 0.75, aaNoise(p + 7.0, 1.3, fw));
    float lam = sin((strat + warp) * 6.2832 / 0.8) * bandAA;
    col *= 0.9 + 0.06 * lam + 0.08 * n2;
    col = mix(col, vec3(0.45, 0.52, 0.42), spot * 0.8);
    h = n2 * 0.2 + lam * 0.15;
    rough = 0.9;
  }
  return col;
}

vec3 perturbNormalH(vec3 surf_pos, vec3 surf_norm, float hgt, float strength){
  vec3 sx = dFdx(surf_pos); vec3 sy = dFdy(surf_pos);
  vec3 r1 = cross(sy, surf_norm); vec3 r2 = cross(surf_norm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(hgt), dFdy(hgt)) * strength;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  vec3 r = abs(det) * surf_norm - grad;
  // never normalise a zero vector (NaN) at grazing angles or sub-pixel footprints
  return dot(r, r) > 1e-20 ? normalize(r) : surf_norm;
}
`;

/** Samples the per-well data textures (0.5 m MD spacing packed into a 2D texture). */
export const DATA_TEX = /* glsl */ `
uniform sampler2D uDataA; // log10 Rdeep, log10 Rshallow, GR, caliper(in)
uniform sampler2D uDataB; // Sw, PHIE, Vsh, formation index
uniform sampler2D uDataC; // pay flag, RHOB, NPHI, ROP (m/h)
uniform sampler2D uLut;
uniform float uDataStep;
uniform float uDataMd0;
uniform float uDataCount;
uniform float uDataWidth;
vec4 fetchData(sampler2D tex, float md){
  float f = clamp((md - uDataMd0) / uDataStep, 0.0, uDataCount - 1.001);
  float i0 = floor(f); float t = f - i0;
  ivec2 c0 = ivec2(int(mod(i0, uDataWidth)), int(i0 / uDataWidth));
  float i1 = i0 + 1.0;
  ivec2 c1 = ivec2(int(mod(i1, uDataWidth)), int(i1 / uDataWidth));
  vec4 a = texelFetch(tex, c0, 0); vec4 b = texelFetch(tex, c1, 0);
  // do not interpolate across missing-data sentinels
  vec4 r = mix(a, b, t);
  r = mix(r, a, step(b.x, -900.0) * step(-900.0, a.x));
  return r;
}
vec4 fetchNearest(sampler2D tex, float md){
  float f = clamp((md - uDataMd0) / uDataStep + 0.5, 0.0, uDataCount - 1.0);
  float i0 = floor(f);
  return texelFetch(tex, ivec2(int(mod(i0, uDataWidth)), int(i0 / uDataWidth)), 0);
}
vec3 lutColor(float t){ return texture2D(uLut, vec2(clamp(t, 0.002, 0.998), 0.5)).rgb; }
// drilling-speed palette (slow = deep violet, fast = pale yellow), log scale 1–100 m/h
vec3 ropColor(float rop){
  float t = clamp(log(max(rop, 0.01)) / log(10.0) * 0.5, 0.0, 1.0);
  vec3 a = vec3(0.13, 0.04, 0.32); vec3 b = vec3(0.72, 0.16, 0.42); vec3 c = vec3(0.98, 0.55, 0.2); vec3 d = vec3(0.99, 0.95, 0.62);
  return t < 0.33 ? mix(a, b, t / 0.33) : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33) : mix(c, d, (t - 0.66) / 0.34);
}
`;
