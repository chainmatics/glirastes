<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import { chatConfig } from './chat-config';
</script>

<template>
  <nav aria-label="Main">
    <RouterLink to="/overview">Overview</RouterLink>
    <RouterLink to="/tasks">Tasks</RouterLink>
  </nav>
  <main><RouterView /></main>
  <glirastes-chat endpoint="/api/chat" theme="light" :config.prop="chatConfig"></glirastes-chat>
</template>

<style>
glirastes-chat {
  --glirastes-chat-primary: #2f5bd3;
}
</style>
