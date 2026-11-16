// إعدادات Cilyo. بالوضع العادي ما بتحتاج تغيّر إشي هون.
window.CILYO_CONFIG = {
  // إعدادات Firebase. لما تكون null بتنقرأ تلقائيًا من Firebase Hosting.
  // إذا ما اشتغل التلقائي، انسخ هون الـ firebaseConfig من إعدادات مشروعك (Project settings ← Your apps).
  firebase: null,

  // عنوان موقع الألعاب. لما يكون null بيصير: https://<رقم-المشروع>-games.web.app
  gamesOrigin: null,

  // منطقة دوال السيرفر. لازم تطابق اللي بـ functions/index.js و firebase.json
  functionsRegion: 'us-central1',

  // للتجربة المحلية بمحاكي Firebase بس (لما الموقع شغال على localhost)
  emulators: {
    auth: 9099,
    firestore: 8080,
    functions: 5055,
    storage: 9199,
    gamesOrigin: 'http://localhost:5005'
  }
};
