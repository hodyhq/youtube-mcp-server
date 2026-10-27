#!/usr/bin/env node
/**
 * STDIO transport smoke test.
 *
 * Starts the built server over STDIO, sends an `initialize` and a
 * `tools/list` request, and asserts that:
 *   1. stdout contains ONLY valid JSON-RPC messages (MCP spec requirement —
 *      anything else corrupts the transport, see issue #18)
 *   2. the server responds to initialize
 *   3. tools/list returns a non-empty tool set
 *
 * No YouTube API key is required; the server validates keys lazily.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 10_000;

// Run with every API key removed: the server must still start, because keys are
// validated lazily on the first tool call (issue #31). Case-insensitive, since
// Windows environment variable names are.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^YOUTUBE_API_KEY\d?$/i.test(name))
);

// Run from an empty temp dir holding a harmless .env, so no local .env can restore an
// API key, and so the test fails if dotenv prints to stdout when it loads a file.
const workDir = mkdtempSync(join(tmpdir(), 'yt-mcp-smoke-'));
writeFileSync(join(workDir, '.env'), 'SMOKE_TEST_DOTENV=1\n');
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const proc = spawn('node', [serverPath], {
  cwd: workDir,
  env: { ...env, MCP_TRANSPORT: 'stdio' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
proc.stdout.on('data', (d) => { stdout += d; });
proc.stderr.on('data', (d) => { stderr += d; });

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  },
});

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
}, 1500);

// A server that exits early closes stdin; ignore the write error and report via the checks below.
proc.stdin.on('error', () => {});

setTimeout(() => proc.kill(), TIMEOUT_MS);

// Check once the server has exited: on Windows its temp dir stays locked until then.
proc.on('exit', () => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  const failures = [];
  const lines = stdout.trim().split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      failures.push(`Non-JSON output on stdout (corrupts STDIO transport): ${JSON.stringify(line.slice(0, 120))}`);
    }
  }

  const initResponse = messages.find((m) => m.id === 1);
  if (!initResponse?.result?.serverInfo) {
    failures.push('No valid initialize response received');
  }

  const toolsResponse = messages.find((m) => m.id === 2);
  const toolCount = toolsResponse?.result?.tools?.length ?? 0;
  if (toolCount === 0) {
    failures.push('tools/list returned no tools');
  }

  if (failures.length > 0) {
    console.error('SMOKE TEST FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\n--- server stderr ---\n' + stderr);
    process.exit(1);
  }

  console.log(`SMOKE TEST PASSED: initialize ok (${initResponse.result.serverInfo.name} v${initResponse.result.serverInfo.version}), ${toolCount} tools listed, stdout clean.`);
  process.exit(0);
});
