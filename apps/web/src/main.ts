import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');

// PWA：先注销旧注册再注册（webview 对 SW 更新检查有 24h 节流，避免旧缓存锁死新构建）
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.getRegistrations()
    .then(rs => Promise.all(rs.map(r => r.unregister())))
    .then(() => navigator.serviceWorker.register('/sw.js'))
    .catch(() => { /* 离线能力降级不阻塞 */ });
}
