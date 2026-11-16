'use strict';
// نوع المحتوى حسب امتداد الملف. اللي مش معروف بينبعت كملف عام.
const TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  glsl: 'text/plain; charset=utf-8',
  vert: 'text/plain; charset=utf-8',
  frag: 'text/plain; charset=utf-8',
  atlas: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8'
};

function contentTypeFor(path) {
  const name = String(path).split('/').pop();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return TYPES[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream';
}

module.exports = { contentTypeFor };
