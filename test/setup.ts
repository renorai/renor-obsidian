// Obsidian runs plugins in a browser window; the tests run in Node.
(globalThis as any).window ??= globalThis;
