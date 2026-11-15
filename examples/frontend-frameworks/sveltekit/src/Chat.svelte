<script lang="ts">
  import {onMount} from 'svelte';
  import {goto} from '$app/navigation';
  let host: HTMLDivElement;
  onMount(()=>{
    const controller=new AbortController();
    // Keep onMount synchronous so its teardown is registered immediately.
    void import('../../shared/mount-chat').then(({mountChat})=>mountChat(host,{
      framework:'sveltekit',signal:controller.signal,push:href=>goto(href),
    })).catch(error=>{if(!controller.signal.aborted) console.error(error);});
    return ()=>controller.abort();
  });
</script>
<div bind:this={host}></div>
