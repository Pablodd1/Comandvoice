import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '..', 'public', 'voicelayer');

const jsIn = path.join(dir, 'voicelayer.js');
const jsOut = path.join(dir, 'voicelayer.min.js');
const cssIn = path.join(dir, 'voicelayer.css');
const cssOut = path.join(dir, 'voicelayer.min.css');

const jsSrc = fs.readFileSync(jsIn, 'utf8');
const cssSrc = fs.readFileSync(cssIn, 'utf8');

const jsRes = await esbuild.transform(jsSrc, {
  loader: 'js',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  banner: '/* VoiceLayer v0.7.0 — Universal Spatial, Inventory & Behavioral Voice Layer */'
});
fs.writeFileSync(jsOut, jsRes.code, 'utf8');

const cssRes = await esbuild.transform(cssSrc, {
  loader: 'css',
  minify: true,
  legalComments: 'none'
});
fs.writeFileSync(cssOut, cssRes.code, 'utf8');

const kb = (b) => (b / 1024).toFixed(1) + ' KB';
const jsGz = zlib.gzipSync(Buffer.from(jsRes.code)).length;
const cssGz = zlib.gzipSync(Buffer.from(cssRes.code)).length;

console.log('[VoiceLayer Build]');
console.log(`  voicelayer.js     ${kb(Buffer.byteLength(jsSrc))} -> voicelayer.min.js  ${kb(Buffer.byteLength(jsRes.code))} (gzip: ${kb(jsGz)})`);
console.log(`  voicelayer.css    ${kb(Buffer.byteLength(cssSrc))} -> voicelayer.min.css ${kb(Buffer.byteLength(cssRes.code))} (gzip: ${kb(cssGz)})`);
