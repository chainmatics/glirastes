import { createApp } from 'vue';
import { registerNavigationBridge } from 'glirastes/browser';
import { defineGlirastesChatElement } from 'glirastes/embed';
import App from './App.vue';
import { router } from './router';

defineGlirastesChatElement();
// Always mounted: the chat's navigation and filter tools push through the app's router.
registerNavigationBridge({ push: (href) => router.push(href) });
createApp(App).use(router).mount('#app');
