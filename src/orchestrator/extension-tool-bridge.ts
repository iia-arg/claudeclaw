/**
 * Bridge between extension-declared MCP tools (running in orchestrator process)
 * and the agent-runner stdio MCP server (running in a sandbox/container child).
 *
 * Flow:
 * 1. On orchestrator startup, write per-group `extension-tools.json` manifest
 *    listing all tool names + descriptions + JSON schemas. agent-runner reads
 *    this file at boot and dynamically registers each tool with its MCP server.
 * 2. When agent invokes a tool, the MCP handler in agent-runner writes a
 *    request file `<DATA_DIR>/ipc/_tool-requests/<requestId>.json` containing
 *    {requestId, tool, args, groupFolder, chatJid, isMain} and polls
 *    `_tool-responses/<requestId>.json` for the result.
 * 3. Orchestrator polls `_tool-requests/`, dispatches each request to the
 *    correct extension's `handler(args, ctx)`, writes the result (or error)
 *    to `_tool-responses/<requestId>.json`, removes the request.
 *
 * Why a shared dir instead of per-group: simpler watcher; single setInterval
 * regardless of group count; tool calls naturally include their group context
 * inside the request payload.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  ExtensionTool,
  ExtensionToolContext,
  getExtensionTools,
} from './extensions.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

const TOOL_REQUESTS_DIR = path.join(DATA_DIR, 'ipc', '_tool-requests');
const TOOL_RESPONSES_DIR = path.join(DATA_DIR, 'ipc', '_tool-responses');
const POLL_INTERVAL_MS = 200;

interface ToolRequest {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

/**
 * Build a JSON-safe manifest entry for one tool. Strips the `handler`
 * function (not serializable) and keeps only the descriptor fields.
 */
function toManifestEntry(tool: ExtensionTool): {
  name: string;
  description: string;
  inputSchema: ExtensionTool['inputSchema'];
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * Write the extension-tools manifest into a group's IPC directory.
 * Called from each runtime runner just before spawning the agent so the
 * file is fresh (handles extension hot-reload, etc).
 */
export function writeExtensionToolsManifest(groupFolder: string): void {
  const tools = getExtensionTools();
  const groupIpc = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpc, { recursive: true });
  const manifestPath = path.join(groupIpc, 'extension-tools.json');
  const manifest = tools.map(toManifestEntry);
  // Atomic write: temp + rename
  const tmp = `${manifestPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath);
}

function lookupTool(name: string): ExtensionTool | undefined {
  return getExtensionTools().find((t) => t.name === name);
}

async function processRequest(filename: string): Promise<void> {
  const reqPath = path.join(TOOL_REQUESTS_DIR, filename);
  let req: ToolRequest;
  try {
    const raw = fs.readFileSync(reqPath, 'utf-8');
    req = JSON.parse(raw) as ToolRequest;
  } catch (err) {
    logger.warn(
      { filename, err: String(err) },
      'extension-tool-bridge: failed to read/parse request',
    );
    // Remove malformed file so it doesn't loop forever
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* ignore */
    }
    return;
  }

  const respPath = path.join(TOOL_RESPONSES_DIR, `${req.requestId}.json`);
  fs.mkdirSync(TOOL_RESPONSES_DIR, { recursive: true });

  const writeResponse = (payload: object): void => {
    const tmp = `${respPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, respPath);
  };

  const tool = lookupTool(req.tool);
  if (!tool) {
    writeResponse({
      ok: false,
      error: `Unknown extension tool: ${req.tool}`,
    });
    fs.unlinkSync(reqPath);
    return;
  }

  const ctx: ExtensionToolContext = {
    groupFolder: req.groupFolder,
    chatJid: req.chatJid,
    isMain: req.isMain,
  };

  try {
    const result = await tool.handler(req.args, ctx);
    writeResponse({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tool: req.tool, requestId: req.requestId, err: message },
      'extension tool handler threw',
    );
    writeResponse({ ok: false, error: message });
  } finally {
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* ignore */
    }
  }
}

let bridgeStarted = false;
let pollTimer: NodeJS.Timeout | null = null;

/**
 * Start the orchestrator-side polling loop. Idempotent.
 * Called once from message-loop.main().
 */
export function startExtensionToolBridge(): void {
  if (bridgeStarted) return;
  bridgeStarted = true;

  fs.mkdirSync(TOOL_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(TOOL_RESPONSES_DIR, { recursive: true });

  const poll = async (): Promise<void> => {
    try {
      const files = fs
        .readdirSync(TOOL_REQUESTS_DIR)
        .filter((f) => f.endsWith('.json'));
      // Sequential: extension handlers may share state; cheap to serialize.
      for (const f of files) {
        await processRequest(f);
      }
    } catch (err) {
      logger.warn(
        { err: String(err) },
        'extension-tool-bridge: poll loop error',
      );
    }
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  logger.info(
    { tools: getExtensionTools().map((t) => t.name) },
    'extension-tool-bridge: started',
  );
}

/** @internal — for tests */
export function _stopExtensionToolBridgeForTests(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  bridgeStarted = false;
}
