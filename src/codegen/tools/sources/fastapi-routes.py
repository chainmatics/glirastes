"""Count the HTTP routes a FastAPI app declares, from syntax only.

Run as ``python3 -I fastapi-routes.py <app-dir>``. The app is never imported
or run: every ``.py`` file below the directory is parsed with ``ast`` and one
JSON object is printed. The generator compares the count with the OpenAPI
export, so a stale export or a hidden route cannot pass silently.
"""
import ast
import json
import os
import sys

DECORATOR_METHODS = {
    'get': 'GET', 'put': 'PUT', 'post': 'POST', 'delete': 'DELETE',
    'options': 'OPTIONS', 'head': 'HEAD', 'patch': 'PATCH', 'trace': 'TRACE',
}
CONSTRUCTORS = {'FastAPI', 'APIRouter'}
SKIPPED_DIRECTORIES = {'__pycache__', '.venv', 'venv', 'env', 'node_modules', 'site-packages', '.git', 'tests'}
FILE_LIMIT = 1024 * 1024


def is_test_file(name):
    return name.startswith('test_') or name.endswith('_test.py') or name == 'conftest.py'


def constant_false(node):
    return isinstance(node, ast.Constant) and node.value is False


def keyword(call, name):
    for item in call.keywords:
        if item.arg == name:
            return item.value
    return None


class FileCounter:
    def __init__(self, relative):
        self.relative = relative
        self.fastapi_modules = set()
        self.constructors = {}
        self.receivers = {}
        self.routes = []
        self.problems = []

    def where(self, node):
        return '%s:%d' % (self.relative, node.lineno)

    def read_imports(self, tree):
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == 'fastapi':
                for alias in node.names:
                    if alias.name in CONSTRUCTORS:
                        self.constructors[alias.asname or alias.name] = alias.name
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == 'fastapi':
                        self.fastapi_modules.add(alias.asname or alias.name)

    def constructor_of(self, value):
        if not isinstance(value, ast.Call):
            return None
        func = value.func
        if isinstance(func, ast.Name) and func.id in self.constructors:
            return self.constructors[func.id]
        if (isinstance(func, ast.Attribute) and func.attr in CONSTRUCTORS
                and isinstance(func.value, ast.Name) and func.value.id in self.fastapi_modules):
            return func.attr
        return None

    def read_receivers(self, tree):
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.Assign):
                targets, value = node.targets, node.value
            elif isinstance(node, ast.AnnAssign) and node.value is not None:
                targets, value = [node.target], node.value
            else:
                continue
            if self.constructor_of(value) is None:
                continue
            hidden = keyword(value, 'include_in_schema')
            for target in targets:
                if isinstance(target, ast.Name):
                    self.receivers[target.id] = constant_false(hidden)

    def methods_of(self, call, default):
        value = keyword(call, 'methods')
        if value is None:
            return default
        if isinstance(value, (ast.List, ast.Tuple, ast.Set)) and all(
                isinstance(item, ast.Constant) and isinstance(item.value, str) for item in value.elts):
            return sorted({item.value.upper() for item in value.elts})
        self.problems.append('%s computes the methods of a route; write them as a literal list.' % self.where(call))
        return None

    def add_route(self, call, receiver, methods):
        if methods is None:
            return
        hidden = keyword(call, 'include_in_schema')
        if hidden is not None and not isinstance(hidden, ast.Constant):
            self.problems.append('%s computes include_in_schema; write True or False.' % self.where(call))
            return
        self.routes.append({
            'file': self.relative,
            'line': call.lineno,
            'methods': methods,
            'hidden': constant_false(hidden) or self.receivers[receiver],
        })

    def read_routes(self, tree):
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            target = node.func.value
            if not isinstance(target, ast.Name) or target.id not in self.receivers:
                continue
            name = node.func.attr
            if name in DECORATOR_METHODS:
                self.add_route(node, target.id, [DECORATOR_METHODS[name]])
            elif name in ('api_route', 'add_api_route'):
                self.add_route(node, target.id, self.methods_of(node, ['GET']))

    def read_hidden_routers(self, tree):
        """``include_router(router, include_in_schema=False)`` hides every route of a router of this file."""
        for node in ast.walk(tree):
            if (not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute)
                    or node.func.attr != 'include_router'):
                continue
            router = node.args[0] if node.args else keyword(node, 'router')
            if constant_false(keyword(node, 'include_in_schema')) and isinstance(router, ast.Name) \
                    and router.id in self.receivers:
                self.receivers[router.id] = True

    def count(self, tree):
        self.read_imports(tree)
        if not self.constructors and not self.fastapi_modules:
            return
        self.read_receivers(tree)
        self.read_hidden_routers(tree)
        self.read_routes(tree)


def main(root):
    routes = []
    problems = []
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(name for name in subdirectories if name not in SKIPPED_DIRECTORIES)
        for name in sorted(files):
            if not name.endswith('.py') or is_test_file(name):
                continue
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            if os.path.getsize(path) > FILE_LIMIT:
                problems.append('%s is larger than 1 MiB; split it or move it out of the FastAPI source directory.' % relative)
                continue
            with open(path, encoding='utf-8') as handle:
                text = handle.read()
            try:
                tree = ast.parse(text, filename=relative)
            except SyntaxError as error:
                problems.append('%s:%s is not valid Python: %s.' % (relative, error.lineno, error.msg))
                continue
            counter = FileCounter(relative)
            counter.count(tree)
            routes.extend(counter.routes)
            problems.extend(counter.problems)
    routes.sort(key=lambda route: (route['file'], route['line']))
    json.dump({'routes': routes, 'problems': problems}, sys.stdout, sort_keys=True)
    sys.stdout.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.stderr.write('usage: python3 -I fastapi-routes.py <app-dir>\n')
        sys.exit(2)
    main(sys.argv[1])
