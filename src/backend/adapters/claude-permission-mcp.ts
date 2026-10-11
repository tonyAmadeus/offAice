import { connect } from 'node:net';
import { createInterface } from 'node:readline';

// This is a stdio MCP server; stdout is reserved exclusively for protocol frames.
const permissionTool = {
  name: 'permission_prompt', description: 'Ask the AIROOM owner to approve a pending Claude Code operation.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};
const questionTool = {
  name: 'ask_user', description: 'Ask the AIROOM owner a question and wait for their answer. Use when native AskUserQuestion is unavailable.',
  inputSchema: { type: 'object', properties: { question: { type: 'string' }, questions: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false },
};
function respond(id: unknown, result: unknown): void { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function error(id: unknown, code: number, message: string): void { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }
function hostRequest(kind: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const pipe = process.env.AIROOM_PERMISSION_PIPE, secret = process.env.AIROOM_PERMISSION_SECRET;
    if (!pipe || !secret) { reject(new Error('AIROOM 审批连接未配置。')); return; }
    const socket = connect(pipe);
    let buffer = '', answered = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('审批等待超时，请重新提出请求。')); }, 30 * 60 * 1000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ secret, kind, payload }) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(new Error('审批响应过大。')); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)); answered = true; clearTimeout(timer);
        if (response.error) reject(new Error(response.error)); else resolve(response.result);
      } catch (cause) { reject(cause); }
      socket.end();
    });
    socket.once('error', cause => { clearTimeout(timer); reject(cause); });
    socket.once('close', () => { clearTimeout(timer); if (!answered) reject(new Error('AIROOM 审批连接已关闭。')); });
  });
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line: string) => {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === 'initialize') respond(message.id, { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'airoom-permissions', version: '0.1.0' } });
  else if (message.method === 'ping') respond(message.id, {});
  else if (message.method === 'tools/list') respond(message.id, { tools: [permissionTool, questionTool] });
  else if (message.method === 'tools/call' && ['permission_prompt', 'ask_user'].includes(message.params?.name)) {
    const kind = message.params.name === 'permission_prompt' ? 'permission' : 'question';
    hostRequest(kind, message.params.arguments ?? {})
      .then(result => respond(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }] }), cause => {
        // Permission transport failures always deny rather than approve by default.
        if (kind === 'permission') respond(message.id, { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: cause instanceof Error ? cause.message : String(cause) }) }] });
        else respond(message.id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], isError: true });
      });
  } else error(message.id, -32601, 'Unsupported MCP method or tool.');
});
lines.once('close', () => process.exit(0));
