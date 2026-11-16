// بيجهّز ملف .firebaserc: بيربط المستودع بمشروعك على Firebase وبيحدد الموقعين.
// الاستخدام:
//   node scripts/setup.mjs <رقم-المشروع> [اسم-موقع-الألعاب]
// اسم موقع الألعاب الافتراضي: <رقم-المشروع>-games
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [projectId, gamesSiteArg] = process.argv.slice(2);
if (!projectId || !/^[a-z0-9-]{4,40}$/.test(projectId)) {
  console.error('اكتب رقم مشروع Firebase (Project ID)، مثلًا:\n  node scripts/setup.mjs cilyo-12345');
  process.exit(1);
}
const gamesSite = gamesSiteArg || `${projectId}-games`;
const rc = {
  projects: { default: projectId },
  targets: {
    [projectId]: {
      hosting: {
        app: [projectId],
        games: [gamesSite]
      }
    }
  }
};
const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.firebaserc');
writeFileSync(file, JSON.stringify(rc, null, 2) + '\n');
console.log(`تم. المشروع: ${projectId}`);
console.log(`موقع المنصة:  https://${projectId}.web.app`);
console.log(`موقع الألعاب: https://${gamesSite}.web.app`);
if (gamesSiteArg) {
  console.log(`\nلأنك اخترت اسم مختلف لموقع الألعاب، حط عنوانه بملف public/config.js:`);
  console.log(`  gamesOrigin: 'https://${gamesSite}.web.app'`);
}
