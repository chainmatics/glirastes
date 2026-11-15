<script lang="ts">
  import Chat from '../Chat.svelte';
  let {children}=$props();
  let mounted=$state(true);
</script>
<h2>SvelteKit reference</h2>
{@render children()}
<p data-testid="highlight-target">Highlight target</p>
<button onclick={()=>mounted=!mounted}>{mounted?'Unmount chat':'Mount chat'}</button>
{#if mounted}<Chat />{/if}
