<?php
declare(strict_types=1);

// TEST FIXTURE ONLY. Known users and unauthenticated fixture controls deliberately
// make authorization behavior reproducible. Never deploy this API publicly.
require __DIR__ . '/contract.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];
$statePath = getenv('FIXTURE_STATE') ?: '/tmp/glirastes-php-runtime-state.json';
$file = fopen($statePath, 'c+');
if ($file === false || !flock($file, LOCK_EX)) { http_response_code(503); exit; }
$stored = stream_get_contents($file);
$state = $stored ? json_decode($stored, true, 512, JSON_THROW_ON_ERROR) : initial_state();
register_shutdown_function(function () use (&$state, $file): void {
    rewind($file); ftruncate($file, 0);
    fwrite($file, json_encode($state, JSON_THROW_ON_ERROR)); fflush($file);
    flock($file, LOCK_UN); fclose($file);
});

function initial_state(): array {
    return [
        'users' => [
            'alice' => ['userId' => 'same-user-id', 'tenantId' => 'tenant-a', 'roles' => ['writer']],
            'bob' => ['userId' => 'same-user-id', 'tenantId' => 'tenant-b', 'roles' => ['writer']],
            'reader-a' => ['userId' => 'reader', 'tenantId' => 'tenant-a', 'roles' => ['reader']],
            'reader-b' => ['userId' => 'reader', 'tenantId' => 'tenant-b', 'roles' => ['reader']],
        ],
        'tasks' => [
            'tenant-a' => ['id' => 'task-a', 'title' => 'Tenant A private task', 'status' => 'open'],
            'tenant-b' => ['id' => 'task-b', 'title' => 'Tenant B private task', 'status' => 'open'],
        ],
        'writes' => ['tenant-a' => 0, 'tenant-b' => 0],
        'lastCredentials' => [],
    ];
}
function respond(int $code, mixed $body): never {
    http_response_code($code); echo json_encode($body, JSON_THROW_ON_ERROR); exit;
}
function input(): array {
    try { $body = json_decode(file_get_contents('php://input'), true, 32, JSON_THROW_ON_ERROR); }
    catch (JsonException) { respond(400, ['error' => 'Invalid JSON']); }
    if (!is_array($body)) respond(400, ['error' => 'Expected an object']);
    return $body;
}
if ($path === '/healthz') respond(200, ['ok' => true]);
if ($path === '/openapi.json') respond(200, fixture_contract());
if ($path === '/fixture/reset' && $method === 'POST') { $state = initial_state(); respond(200, ['ok' => true]); }
if ($path === '/fixture/state') respond(200, $state);
if ($path === '/fixture/login' && $method === 'POST') {
    $name = input()['user'] ?? '';
    if (!isset($state['users'][$name])) respond(400, ['error' => 'Unknown fixture user']);
    setcookie('session', $name, ['path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
    respond(200, $state['users'][$name]);
}
if ($path === '/fixture/revoke' && $method === 'POST') {
    $name = input()['user'] ?? '';
    unset($state['users'][$name]); respond(200, ['ok' => true]);
}
$session = $_COOKIE['session'] ?? '';
$user = $state['users'][$session] ?? null;
if (!$user) respond(401, ['error' => 'Not signed in']);
$state['lastCredentials'] = ['cookie' => $_SERVER['HTTP_COOKIE'] ?? '', 'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? ''];
if ($path === '/api/me' && $method === 'GET') respond(200, $user);
// Runtime pins these to the identity verified at turn start. Reject a session
// whose active workspace/user changed before the later API call. They do not
// grant permission and cannot replace the authenticated session.
if (isset($_SERVER['HTTP_X_GLIRASTES_BUSINESS_TENANT']) || isset($_SERVER['HTTP_X_GLIRASTES_USER_ID'])) {
    if (($_SERVER['HTTP_X_GLIRASTES_BUSINESS_TENANT'] ?? '') !== $user['tenantId']
        || ($_SERVER['HTTP_X_GLIRASTES_USER_ID'] ?? '') !== $user['userId']) {
        respond(403, ['error' => 'Verified session context changed']);
    }
}
if ($path === '/api/tasks' && $method === 'GET') respond(200, ['tasks' => [$state['tasks'][$user['tenantId']]]]);
if (preg_match('#^/api/tasks/([^/]+)$#', $path, $matches) && $method === 'PATCH') {
    if (!in_array('writer', $user['roles'], true)) respond(403, ['error' => 'Write permission required']);
    $task = $state['tasks'][$user['tenantId']];
    if (rawurldecode($matches[1]) !== $task['id']) respond(404, ['error' => 'Task not found']);
    $body = input();
    if (array_keys($body) !== ['status'] || !in_array($body['status'], ['open', 'done'], true)) respond(422, ['error' => 'Invalid task status']);
    $state['tasks'][$user['tenantId']]['status'] = $body['status'];
    $state['writes'][$user['tenantId']]++;
    respond(200, $state['tasks'][$user['tenantId']]);
}
respond(404, ['error' => 'Not found']);
