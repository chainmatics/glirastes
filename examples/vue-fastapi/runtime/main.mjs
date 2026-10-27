import { createChatRuntime } from './chat.mjs';
import { chatModel } from './model.mjs';

// API_ORIGIN: the FastAPI app, e.g. http://127.0.0.1:8000. TENANT_ID: the tenant of this deployment.
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:8000';
const runtime = createChatRuntime({ apiOrigin: () => apiOrigin, model: chatModel, tenantId: process.env.TENANT_ID ?? '' });
runtime.server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1');
