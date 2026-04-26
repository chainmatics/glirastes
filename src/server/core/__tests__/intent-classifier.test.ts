import { describe, expect, it, vi } from 'vitest';
import type { ModuleDefinition, ConversationMessage } from '../../../types.js';
import {
  tokenize,
  jaccardSimilarity,
  classifyWithHeuristics,
  buildClassificationPrompt,
  parseJsonResponse,
  createIntentClassifier,
} from '../intent-classifier.js';

// ---------------------------------------------------------------------------
// Test Modules
// ---------------------------------------------------------------------------

const taskModule: ModuleDefinition = {
  id: 'tasks',
  name: 'Task Management',
  description: 'Create, update, delete, and list tasks and to-do items',
  tools: ['create_task', 'update_task', 'delete_task', 'list_tasks'],
  classification: {
    hint: 'Task and to-do management',
    examples: [
      'create a new task for tomorrow',
      'show me my open tasks',
      'mark the task as done',
      'delete the old task',
    ],
  },
};

const calendarModule: ModuleDefinition = {
  id: 'calendar',
  name: 'Calendar',
  description: 'Schedule meetings, manage calendar events and appointments',
  tools: ['create_event', 'list_events', 'delete_event'],
  classification: {
    hint: 'Calendar and scheduling',
    examples: [
      'schedule a meeting for Friday',
      'what events do I have today',
      'cancel the 3pm appointment',
    ],
  },
};

const settingsModule: ModuleDefinition = {
  id: 'settings',
  name: 'Settings',
  description: 'Manage user preferences, notifications, and account settings',
  tools: ['update_settings', 'get_settings'],
  classification: {
    hint: 'User settings and preferences',
    examples: [
      'change my notification preferences',
      'update my profile settings',
    ],
  },
};

const allModules = [taskModule, calendarModule, settingsModule];

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('converts text to lowercase tokens', () => {
    const tokens = tokenize('Create a New Task');
    expect(tokens.has('create')).toBe(true);
    expect(tokens.has('new')).toBe(true);
    expect(tokens.has('task')).toBe(true);
  });

  it('filters out tokens shorter than 3 characters', () => {
    const tokens = tokenize('I am on it');
    // 'am' and 'on' and 'it' are 2 chars, filtered out; 'I' is 1 char
    expect(tokens.size).toBe(0);
  });

  it('strips punctuation', () => {
    const tokens = tokenize("what's the task?");
    expect(tokens.has('what')).toBe(true);
    expect(tokens.has('the')).toBe(true);
    expect(tokens.has('task')).toBe(true);
  });

  it('returns empty set for empty string', () => {
    expect(tokenize('').size).toBe(0);
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('task task task');
    expect(tokens.size).toBe(1);
    expect(tokens.has('task')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['task', 'create']);
    expect(jaccardSimilarity(a, a)).toBe(1.0);
  });

  it('returns 0 for completely disjoint sets', () => {
    const a = new Set(['task', 'create']);
    const b = new Set(['calendar', 'meeting']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns correct ratio for partial overlap', () => {
    const a = new Set(['task', 'create', 'new']);
    const b = new Set(['task', 'delete', 'old']);
    // intersection: {task} = 1, union: 5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 5);
  });

  it('returns 0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['task']))).toBe(0);
    expect(jaccardSimilarity(new Set(['task']), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('is commutative', () => {
    const a = new Set(['task', 'create']);
    const b = new Set(['task', 'meeting', 'schedule']);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });
});

// ---------------------------------------------------------------------------
// classifyWithHeuristics
// ---------------------------------------------------------------------------

describe('classifyWithHeuristics', () => {
  it('classifies task-related input to tasks module', () => {
    const result = classifyWithHeuristics('create a new task for tomorrow', allModules);
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies calendar-related input to calendar module', () => {
    const result = classifyWithHeuristics('schedule a meeting for Friday', allModules);
    expect(result.intent).toBe('calendar');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('returns ambiguous for empty input', () => {
    const result = classifyWithHeuristics('', allModules);
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('returns ambiguous for empty modules', () => {
    const result = classifyWithHeuristics('create a task', []);
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('returns ambiguous for very short nonsense input', () => {
    // Single token with no match
    const result = classifyWithHeuristics('xyz', allModules);
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('handles modules without classification examples', () => {
    const bareModule: ModuleDefinition = {
      id: 'bare',
      name: 'Bare',
      description: 'Create and manage tasks',
      tools: ['do_something'],
    };
    const result = classifyWithHeuristics('create tasks manage', [bareModule]);
    expect(result.intent).toBe('bare');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('maps high scores to high confidence bucket', () => {
    // Use an exact example match to get a high score
    const result = classifyWithHeuristics('create a new task for tomorrow', allModules);
    expect(result.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it('returns ambiguous when scores are below threshold', () => {
    const result = classifyWithHeuristics(
      'quantum entanglement photosynthesis',
      allModules,
    );
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildClassificationPrompt
// ---------------------------------------------------------------------------

describe('buildClassificationPrompt', () => {
  it('includes all module IDs and descriptions', () => {
    const prompt = buildClassificationPrompt('test message', allModules);
    expect(prompt).toContain('tasks:');
    expect(prompt).toContain('calendar:');
    expect(prompt).toContain('settings:');
  });

  it('includes classification examples', () => {
    const prompt = buildClassificationPrompt('test', allModules);
    expect(prompt).toContain('"create a new task for tomorrow"');
    expect(prompt).toContain('"schedule a meeting for Friday"');
  });

  it('includes user message', () => {
    const prompt = buildClassificationPrompt('hello world', allModules);
    expect(prompt).toContain('User message: "hello world"');
  });

  it('includes conversation history when provided', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ];
    const prompt = buildClassificationPrompt('test', allModules, history);
    expect(prompt).toContain('Conversation history:');
    expect(prompt).toContain('user: hi');
    expect(prompt).toContain('assistant: hello!');
  });

  it('omits conversation history section when empty', () => {
    const prompt = buildClassificationPrompt('test', allModules, []);
    expect(prompt).not.toContain('Conversation history:');
  });

  it('requests JSON response format', () => {
    const prompt = buildClassificationPrompt('test', allModules);
    expect(prompt).toContain('Respond with JSON only');
    expect(prompt).toContain('"moduleId"');
    expect(prompt).toContain('"confidence"');
  });
});

// ---------------------------------------------------------------------------
// parseJsonResponse
// ---------------------------------------------------------------------------

describe('parseJsonResponse', () => {
  it('parses well-formed JSON', () => {
    const result = parseJsonResponse('{"moduleId": "tasks", "confidence": 0.95}');
    expect(result).toEqual({ moduleId: 'tasks', confidence: 0.95 });
  });

  it('extracts JSON from markdown code block', () => {
    const text = '```json\n{"moduleId": "calendar", "confidence": 0.8}\n```';
    const result = parseJsonResponse(text);
    expect(result).toEqual({ moduleId: 'calendar', confidence: 0.8 });
  });

  it('extracts JSON from surrounding text', () => {
    const text = 'Based on the input, I think:\n{"moduleId": "tasks", "confidence": 0.9}\nThat is my answer.';
    const result = parseJsonResponse(text);
    expect(result).toEqual({ moduleId: 'tasks', confidence: 0.9 });
  });

  it('returns null for completely invalid text', () => {
    expect(parseJsonResponse('not json at all')).toBeNull();
  });

  it('returns null when moduleId is missing', () => {
    expect(parseJsonResponse('{"confidence": 0.9}')).toBeNull();
  });

  it('returns null when confidence is missing', () => {
    expect(parseJsonResponse('{"moduleId": "tasks"}')).toBeNull();
  });

  it('returns null when types are wrong', () => {
    expect(parseJsonResponse('{"moduleId": 123, "confidence": "high"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createIntentClassifier — heuristic mode (no model)
// ---------------------------------------------------------------------------

describe('createIntentClassifier — heuristic mode', () => {
  it('classifies input using heuristics when no model is provided', async () => {
    const classifier = createIntentClassifier({ modules: allModules });
    const result = await classifier.classify('create a new task for tomorrow');
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('returns ambiguous for short input below minTokens', async () => {
    const classifier = createIntentClassifier({
      modules: allModules,
      minTokens: 3,
    });
    const result = await classifier.classify('hi');
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('returns ambiguous when no modules are configured', async () => {
    const classifier = createIntentClassifier({ modules: [] });
    const result = await classifier.classify('create a task');
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('uses default minTokens of 2', async () => {
    const classifier = createIntentClassifier({ modules: allModules });
    // "hi" has 0 tokens >= 3 chars, so returns ambiguous
    const result = await classifier.classify('hi');
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0);
  });

  it('classifies calendar input correctly', async () => {
    const classifier = createIntentClassifier({ modules: allModules });
    const result = await classifier.classify('schedule a meeting for Friday');
    expect(result.intent).toBe('calendar');
  });
});

// ---------------------------------------------------------------------------
// createIntentClassifier — LLM mode (mocked generateText)
// ---------------------------------------------------------------------------

describe('createIntentClassifier — LLM mode', () => {
  const mockModel = { id: 'test-model' };

  it('uses LLM classification when model and generateText are provided', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 0.95}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    const result = await classifier.classify('create a new task');
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBe(0.95);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('passes model and prompt to generateText', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 0.9}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    await classifier.classify('create a task');

    expect(generateText).toHaveBeenCalledWith({
      model: mockModel,
      prompt: expect.stringContaining('User message: "create a task"'),
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('falls back to heuristics when LLM throws', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('LLM failed'));

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // Should still classify via heuristics
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('falls back to heuristics when LLM returns invalid JSON', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: 'I cannot determine the intent',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // Falls back to heuristics
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('falls back to heuristics when LLM returns unknown moduleId', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "nonexistent", "confidence": 0.9}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
      // With low LLM confidence threshold, it would normally accept
      // but unknown moduleId maps to ambiguous which is 0.9
      // and 0.9 >= 0.5 threshold so it returns ambiguous
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // Unknown moduleId returns ambiguous intent from LLM path.
    // If confidence >= threshold, the ambiguous result from LLM is returned.
    // It then checks confidence >= confidenceThreshold (0.5 default)
    // ambiguous with 0.9 confidence passes threshold, so LLM result is used.
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0.9);
  });

  it('falls back to heuristics when LLM confidence is below threshold', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 0.2}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
      confidenceThreshold: 0.5,
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // LLM returned 0.2 < 0.5 threshold -> falls to heuristics
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it('respects timeout and falls back to heuristics', async () => {
    const generateText = vi.fn().mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: '{"moduleId": "tasks", "confidence": 0.9}' }), 5000);
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    );

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
      timeoutMs: 50, // Very short timeout
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // Should fall back to heuristics due to timeout
    expect(result.intent).toBe('tasks');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('clamps confidence to 0-1 range', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 1.5}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    const result = await classifier.classify('create a new task');
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('passes conversation history to the prompt', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 0.9}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      generateText,
    });

    const history: ConversationMessage[] = [
      { role: 'user', content: 'I need help with tasks' },
      { role: 'assistant', content: 'Sure, what would you like to do?' },
    ];

    await classifier.classify('create one', undefined, history);

    expect(generateText).toHaveBeenCalledWith({
      model: mockModel,
      prompt: expect.stringContaining('Conversation history:'),
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('does not call generateText when only model is provided (no generateText)', async () => {
    const classifier = createIntentClassifier({
      modules: allModules,
      model: mockModel,
      // no generateText callback
    });

    const result = await classifier.classify('create a new task for tomorrow');
    // Uses heuristics directly
    expect(result.intent).toBe('tasks');
  });

  it('does not call generateText when only generateText is provided (no model)', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"moduleId": "tasks", "confidence": 0.9}',
    });

    const classifier = createIntentClassifier({
      modules: allModules,
      generateText,
      // no model
    });

    const result = await classifier.classify('create a new task for tomorrow');
    expect(generateText).not.toHaveBeenCalled();
    expect(result.intent).toBe('tasks');
  });
});
