// `node --import ./use-floor-pg.mjs …`: every import of `pg` (and `pg/…`)
// resolves to the copy installed in this folder, whoever imports it. The built
// SDK keeps its own location, so its `import … from "pg"` is the one under test.
import { register } from 'node:module';

register('./floor-pg-hooks.mjs', import.meta.url, {
  data: { parentURL: new URL('./package.json', import.meta.url).href },
});
