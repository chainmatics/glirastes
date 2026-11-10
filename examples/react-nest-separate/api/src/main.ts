import { createApi } from './app.js';
import { chatModel } from './chat/chat.model.js';

const port = Number(process.env.PORT ?? 4000);
const app = await createApi({
  model: chatModel,
  apiOrigin: () => `http://127.0.0.1:${port}`,
  tenantId: process.env.GLIRASTES_TENANT_ID ?? '019fb007-0000-7000-8000-000000000002',
});
app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
await app.listen(port);
