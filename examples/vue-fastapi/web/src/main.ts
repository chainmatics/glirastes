import { createApp } from 'vue';
import { registerNavigationBridge } from 'glirastes/browser';
import { defineGlirastesChatElement } from 'glirastes/embed';
import App from './App.vue';
import { router } from './router';
import { pageLanguage } from './chat-config';

// The page's language decides the chat's built-in texts and, sent with each request, the runtime's.
document.documentElement.lang = pageLanguage();
defineGlirastesChatElement();
// Always mounted: the chat's navigation and filter tools push through the app's router.
registerNavigationBridge({ push: (href) => router.push(href) });
createApp(App).use(router).mount('#app');
