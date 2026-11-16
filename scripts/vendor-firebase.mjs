// بينسخ مكتبات Firebase للمتصفح لمجلد public/vendor/firebase، عشان الموقع ما يعتمد على موقع خارجي.
// الاستخدام (لما بدك تحدّث نسخة المكتبة):
//   npm install --no-save firebase@<النسخة>
//   node scripts/vendor-firebase.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pkgPath = process.argv[2] || dirname(require.resolve('firebase/package.json'));
const version = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')).version;
const out = join(root, 'public', 'vendor', 'firebase');
mkdirSync(out, { recursive: true });

const parts = ['app', 'auth', 'firestore', 'storage', 'functions'];
const cdn = `https://www.gstatic.com/firebasejs/${version}/`;
for (const part of parts) {
  const name = `firebase-${part}.js`;
  let code = readFileSync(join(pkgPath, name), 'utf8');
  // الملفات بتستورد بعضها من موقع gstatic. بنحوّلها لمسارات محلية.
  code = code.split(cdn).join('./');
  code = code.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  if (code.includes('gstatic.com/firebasejs/')) throw new Error(`${name}: ضل فيه استيراد من gstatic`);
  writeFileSync(join(out, name), code);
  console.log('نسخ', name);
}
writeFileSync(
  join(out, 'README.txt'),
  `Firebase JavaScript SDK ${version}\nhttps://github.com/firebase/firebase-js-sdk\nLicense: Apache-2.0 (the notice is at the top of each file)\nCopied by scripts/vendor-firebase.mjs. Do not edit by hand.\n`
);
console.log(`تم: Firebase ${version}`);
