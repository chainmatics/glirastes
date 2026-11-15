<script setup lang="ts">
const host=ref<HTMLDivElement>();
const router=useRouter();
const controller=new AbortController();
onMounted(()=>{
  void import('../../../shared/mount-chat').then(({mountChat})=>mountChat(host.value!,{
    framework:'nuxt',signal:controller.signal,push:href=>router.push(href),
  })).catch(error=>{if(!controller.signal.aborted) console.error(error);});
});
onBeforeUnmount(()=>controller.abort());
</script>
<template><div ref="host"></div></template>
