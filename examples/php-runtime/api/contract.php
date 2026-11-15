<?php
declare(strict_types=1);

// The API and export share this source. CI regenerates openapi.json from it.
function fixture_contract(): array {
    $task = ['type' => 'object', 'additionalProperties' => false,
        'properties' => ['id' => ['type' => 'string'], 'title' => ['type' => 'string'], 'status' => ['type' => 'string', 'enum' => ['open', 'done']]],
        'required' => ['id', 'title', 'status']];
    $json = fn(array $schema): array => ['application/json' => ['schema' => $schema]];
    return [
        'openapi' => '3.1.0',
        'info' => ['title' => 'Glirastes PHP runtime reference', 'version' => '1.0.0'],
        'security' => [['SessionCookie' => []]],
        'components' => ['securitySchemes' => ['SessionCookie' => ['type' => 'apiKey', 'in' => 'cookie', 'name' => 'session']]],
        'paths' => [
            '/api/tasks' => ['get' => ['operationId' => 'listTasks', 'summary' => 'List tasks in the current workspace',
                'responses' => ['200' => ['description' => 'Visible tasks', 'content' => $json(['type' => 'object', 'additionalProperties' => false,
                    'properties' => ['tasks' => ['type' => 'array', 'items' => $task]], 'required' => ['tasks']])]]]],
            '/api/tasks/{id}' => ['patch' => ['operationId' => 'updateTask', 'summary' => 'Change the status of a task',
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'requestBody' => ['required' => true, 'content' => $json(['type' => 'object', 'additionalProperties' => false,
                    'properties' => ['status' => ['type' => 'string', 'enum' => ['open', 'done']]], 'required' => ['status']])],
                'responses' => ['200' => ['description' => 'Updated task', 'content' => $json($task)]]]],
        ],
    ];
}
