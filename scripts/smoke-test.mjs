#!/usr/bin/env node
/**
 * STDIO transport smoke test.
 *
 * Starts each built entry point (dist/index.js and the published bin, dist/cli.js)
 * over STDIO with no YouTube API key, sends `initialize`, `tools/list` and one
 * API-backed `tools/call`, and asserts that:
 *   1. stdout contains ONLY valid JSON-RPC messages (an MCP spec requirement:
 *      anything else corrupts the transport, see issue #18)
 *   2. the server responds to initialize
 *   3. tools/list returns a non-empty tool set
 *   4. the API-backed call fails with the missing-key error, proving the run was keyless
 *
 * No YouTube API key is required; the server validates keys lazily (issue #31).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 10_000;
const ENTRY_POINTS = ['dist/index.js', 'dist/cli.js'];

// Remove every API key, and any dotenv setting that could load one from another file.
// Case-insensitive, since Windows environment variable names are.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(YOUTUBE_API_KEY\d?|DOTENV_CONFIG_.*)$/i.test(name)
  )
);

function runSmoke(entry) {
  return new Promise((resolve) => {
    // Run from an empty temp dir holding a harmless .env, so no local .env can restore an
    // API key, and so the test fails if dotenv prints to stdout when it loads a file.
    const workDir = mkdtempSync(join(tmpdir(), 'yt-mcp-smoke-'));
    writeFileSync(join(workDir, '.env'), 'SMOKE_TEST_DOTENV=1\n');
    const serverPath = fileURLToPath(new URL(`../${entry}`, import.meta.url));

    const proc = spawn('node', [serverPath], {
      cwd: workDir,
      env: { ...env, MCP_TRANSPORT: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    // A server that exits early closes stdin; ignore the write error and report via the checks below.
    proc.stdin.on('error', () => {});

    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');

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
      send({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'videos_getVideo', arguments: { videoId: 'hwP7WQkmECE' } },
      });
    }, 1500);

    setTimeout(() => proc.kill(), TIMEOUT_MS);

    // Check once stdout and stderr have closed, so no final output is missed. On Windows
    // the temp dir also stays locked until the server has exited.
    proc.on('close', () => {
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

      const callText = messages.find((m) => m.id === 3)?.result?.content?.[0]?.text ?? '';
      const callIsError = messages.find((m) => m.id === 3)?.result?.isError === true;
      if (!callIsError || !/API key/i.test(callText)) {
        failures.push(`API-backed tool did not report the missing key (was a key still present?): ${JSON.stringify(callText.slice(0, 120))}`);
      }

      const summary = initResponse?.result?.serverInfo
        ? `initialize ok (${initResponse.result.serverInfo.name} v${initResponse.result.serverInfo.version}), ${toolCount} tools listed, keyless call rejected, stdout clean.`
        : '';
      resolve({ failures, stderr, summary });
    });
  });
}

let failed = false;
for (const entry of ENTRY_POINTS) {
  const { failures, stderr, summary } = await runSmoke(entry);
  if (failures.length > 0) {
    failed = true;
    console.error(`SMOKE TEST FAILED (${entry}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\n--- server stderr ---\n' + stderr);
  } else {
    console.log(`SMOKE TEST PASSED (${entry}): ${summary}`);
  }
}

process.exit(failed ? 1 : 0);
