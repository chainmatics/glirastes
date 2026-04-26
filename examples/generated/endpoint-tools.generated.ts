/* eslint-disable */
/**
 * AUTO-GENERATED FILE.
 * Generated from OpenAPI + x-ai metadata.
 */

import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

export const generatedEndpointTools = [
  defineEndpointTool({
    id: 'tasks.convertToPersonal',
    toolName: 'convert_to_personal_task',
    description: 'Converts a group task into a personal task.',
    method: 'POST',
    path: '/api/tasks/:id/convert-to-personal',
    inputSchema: z.object({
      id: z.string().uuid()
    }),
    allowedRoles: [
  "gruppenleiter",
  "admin"
],
    needsApproval: true,
    uiActionOnSuccess: {
    "type": "task-updated",
    "taskId": "$id"
},
  })
] as const;
