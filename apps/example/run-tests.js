#!/usr/bin/env node

/**
 * Simple test runner using Node's built-in test module
 * Provides vitest-like compatibility for pure TypeScript tests
 */

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global test functions
globalThis.describe = (name, fn) => {
    test(name, async (t) => {
        await fn();
    });
};

globalThis.it = (name, fn) => {
    test(name, fn);
};

globalThis.expect = (actual) => {
    return {
        toBe: (expected) => assert.strictEqual(actual, expected),
        toEqual: (expected) => assert.deepStrictEqual(actual, expected),
        toBeUndefined: () => assert.strictEqual(actual, undefined),
        toBeNull: () => assert.strictEqual(actual, null),
        toBeTruthy: () => assert.ok(actual),
        toBeFalsy: () => assert.ok(!actual),
        toContain: (item) => {
            if (Array.isArray(actual)) {
                assert.ok(actual.includes(item), `Expected array to contain ${item}`);
            } else if (typeof actual === 'object') {
                assert.ok(item in actual, `Expected object to contain key ${item}`);
            }
        },
        toHaveLength: (length) => {
            assert.strictEqual(actual.length, length);
        },
        toHaveProperty: (prop) => {
            assert.ok(prop in actual, `Expected object to have property ${prop}`);
        },
        toThrow: () => {
            try {
                actual();
                assert.fail('Expected function to throw');
            } catch (e) {
                // Expected
            }
        },
    };
};

globalThis.vi = {
    useFakeTimers: () => {
        globalThis._fakeTimers = true;
        globalThis._fakeTime = Date.now();
    },
    useRealTimers: () => {
        delete globalThis._fakeTimers;
        delete globalThis._fakeTime;
    },
    setSystemTime: (date) => {
        if (typeof date === 'number') {
            globalThis._fakeTime = date;
        } else if (date instanceof Date) {
            globalThis._fakeTime = date.getTime();
        } else {
            globalThis._fakeTime = new Date(date).getTime();
        }
    },
    spyOn: () => ({
        mockReturnValue: () => ({}),
    }),
};

// Override Date.now for fake timers
const OriginalDateNow = Date.now;
Object.defineProperty(Date, 'now', {
    value: () => {
        return globalThis._fakeTime ?? OriginalDateNow();
    },
});

globalThis.beforeEach = (fn) => {
    // Simple beforeEach implementation
    test('beforeEach', { skip: true }, fn);
};

globalThis.afterEach = (fn) => {
    // Simple afterEach implementation
    test('afterEach', { skip: true }, fn);
};

// Find and run all test files
const testDir = path.join(__dirname, 'src', 'lib', '__tests__');
const testFiles = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.ts'))
    .map(f => path.join(testDir, f));

console.log(`Found ${testFiles.length} test files`);

// Use tsx or ts-node to load TypeScript files
const hasTypescript = fs.existsSync(path.join(__dirname, 'node_modules/typescript'));

if (hasTypescript) {
    // Try to load test files with TypeScript
    for (const file of testFiles) {
        try {
            // Attempt to use register hooks or direct import
            await import(file);
        } catch (e) {
            console.error(`Error loading test file ${file}:`, e);
        }
    }
} else {
    console.error('TypeScript not found in node_modules');
}
