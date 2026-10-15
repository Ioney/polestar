'use strict';
// `planner mcp`: the planner's commands as an MCP server on stdio
// (newline-delimited JSON-RPC 2.0, tools only). It proxies to the planner
// answering on 127.0.0.1:<port>, so an agent's edits show live in the open
// page; when none answers it starts one in-process (`start`) and says so on
// stderr. stdout carries the protocol only. Messages end at \n only (a
// trailing \r is dropped): U+2028/U+2029 are text inside a JSON string.

const { version } = require('../../package.json');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROBE_MS = 1500;

// The planner's command list at base, or null when nothing (or not a planner) answers.
async function probe(base) {
	try {
		const res = await fetch(`${base}api/commands`, { signal: AbortSignal.timeout(PROBE_MS) });
		if (!res.ok) return null;
		const list = await res.json();
		return Array.isArray(list) && list.some((c) => c && c.name === 'planner_info') ? list : null;
	} catch {
		return null;
	}
}

// opts: { port, start: async (port) -> { url, close }, input, output, log }
// -> a promise resolving when input ends (the in-process planner closed).
async function runMcp({ port = 8078, start, input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
	let base = `http://127.0.0.1:${port}/`;
	let local = null;
	let list = await probe(base);
	if (list) log(`polestar planner mcp: using the planner at ${base}`);

	async function startLocal() {
		local = await start(port);
		base = local.url;
		list = await probe(base);
		log(`polestar planner mcp: started the planner at ${base} (open it in a browser to watch)`);
	}
	if (!list) await startLocal();

	async function call(name, args) {
		const post = () =>
			fetch(`${base}api/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args: args || {} }) }).then((r) => r.json());
		try {
			return await post();
		} catch (err) {
			// The planner we proxied to went away: run one here and retry once.
			if (local) throw err;
			log(`polestar planner mcp: the planner at ${base} stopped answering (${err.message})`);
			await startLocal();
			return post();
		}
	}

	const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
	const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
	const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

	async function handle(msg) {
		if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
			if (msg && msg.id !== undefined) fail(msg.id, -32600, 'invalid request');
			return;
		}
		const { id, method, params = {} } = msg;
		const notification = id === undefined || id === null;
		if (method.startsWith('notifications/')) return;
		try {
			let result;
			if (method === 'initialize') {
				const asked = params && params.protocolVersion;
				result = {
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'polestar-planner', version },
					instructions: 'Polestar route planner: read and edit .guide leveling guides (edits are written to the files at once), play a route as a timeline, look up quests/NPCs/spawns. Start with planner_info and guides_list; guide_get gives the hash every edit needs.',
				};
			} else if (method === 'ping') result = {};
			else if (method === 'tools/list') {
				result = { tools: list.map((c) => ({ name: c.name, description: c.description, inputSchema: c.input })) };
			} else if (method === 'tools/call') {
				const name = params && params.name;
				if (!list.some((c) => c.name === name)) {
					if (!notification) fail(id, -32602, `unknown tool "${name}"`);
					return;
				}
				const r = await call(name, params.arguments);
				if (r && r.ok) {
					const value = r.result === undefined ? null : r.result;
					result = { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }], structuredContent: value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value } };
				} else {
					result = { content: [{ type: 'text', text: (r && r.error) || 'the planner answered nothing' }], isError: true };
				}
			} else {
				if (!notification) fail(id, -32601, `method not found: ${method}`);
				return;
			}
			if (!notification) reply(id, result);
		} catch (err) {
			if (!notification) fail(id, -32603, String((err && err.message) || err));
		}
	}

	let queue = Promise.resolve();
	const onLine = (raw) => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
			return;
		}
		const batch = Array.isArray(msg) ? msg : [msg];
		queue = queue.then(() => batch.reduce((p, m) => p.then(() => handle(m)), Promise.resolve()));
	};
	input.setEncoding('utf8');
	let buf = '';
	input.on('data', (chunk) => {
		buf += chunk;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			onLine(line);
		}
	});
	await new Promise((resolve) => {
		input.once('end', resolve);
		input.once('close', resolve);
	});
	if (buf) onLine(buf);
	await queue;
	if (local) await local.close();
}

module.exports = { runMcp, probe, PROTOCOLS };
