// WebMCP: registers every planner command as a page tool when the browser
// offers navigator.modelContext (or document.modelContext); silent without it.
import { cmd } from '../api.js';

export function registerWebMcp(commands) {
	const mc = (typeof navigator !== 'undefined' && navigator.modelContext) || (typeof document !== 'undefined' && document.modelContext) || null;
	if (!mc || typeof mc.registerTool !== 'function') return 0;
	let n = 0;
	for (const c of commands) {
		try {
			mc.registerTool({
				name: c.name,
				description: c.description,
				inputSchema: c.input || { type: 'object', properties: {} },
				annotations: { readOnlyHint: !c.mutates },
				async execute(args) {
					const result = await cmd(c.name, args || {});
					return { content: [{ type: 'text', text: JSON.stringify(result) }] };
				},
			});
			n++;
		} catch (e) {
			console.warn(`WebMCP: ${c.name} not registered: ${e.message}`);
		}
	}
	return n;
}
