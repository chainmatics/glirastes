import {sveltekit} from '@sveltejs/kit/vite';
export default {plugins:[sveltekit()],resolve:{dedupe:['react','react-dom']},server:{proxy:{'/api':'http://127.0.0.1:8899'},fs:{allow:['../../..']}}};
