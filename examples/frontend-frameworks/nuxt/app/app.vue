<script setup lang="ts">const mounted=ref(true);</script>
<template>
  <h2>Nuxt reference</h2><NuxtPage />
  <p data-testid="highlight-target">Highlight target</p>
  <button @click="mounted=!mounted">{{mounted?'Unmount chat':'Mount chat'}}</button>
  <ClientOnly><Chat v-if="mounted" /></ClientOnly>
</template>
