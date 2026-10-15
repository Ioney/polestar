// The planner server's API: commands (POST /api/cmd), their list
// (GET /api/commands), the event stream (SSE /api/events, reconnected with
// backoff) and the view report (POST /api/view, throttled).

export class ApiError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code || null;
	}
}

export async function cmd(name, args = {}) {
	let res;
	try {
		res = await fetch('/api/cmd', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, args }),
		});
	} catch (e) {
		throw new ApiError(`${name}: the planner server is not reachable`, 'offline');
	}
	let body;
	try {
		body = await res.json();
	} catch (e) {
		throw new ApiError(`${name}: HTTP ${res.status}`, 'http');
	}
	if (!body.ok) {
		const err = body.error;
		const message = typeof err === 'string' ? err : (err && err.message) || `${name} failed`;
		throw new ApiError(message, body.code || (err && err.code) || null);
	}
	return body.result;
}

export async function commands() {
	const res = await fetch('/api/commands');
	if (!res.ok) throw new ApiError(`GET /api/commands: HTTP ${res.status}`, 'http');
	const body = await res.json();
	return Array.isArray(body) ? body : body.commands || body.result || [];
}

const EVENTS = ['hello', 'changed', 'diagnostics', 'routing', 'focus', 'seek', 'play'];

// handlers: { status(connected), hello(d), changed(d), ... }. EventSource
// retries by itself while the server is down; a stream it gave up on is
// reopened here with a growing delay.
export function events(handlers) {
	let es = null;
	let delay = 500;
	let timer = null;
	const open = () => {
		timer = null;
		es = new EventSource('/api/events');
		es.onopen = () => {
			delay = 500;
			handlers.status && handlers.status(true);
		};
		es.onerror = () => {
			handlers.status && handlers.status(false);
			if (es.readyState === EventSource.CLOSED) {
				es.close();
				if (!timer) timer = setTimeout(open, delay);
				delay = Math.min(delay * 2, 10000);
			}
		};
		for (const name of EVENTS) {
			es.addEventListener(name, (ev) => {
				if (!handlers[name]) return;
				let data = null;
				try {
					data = ev.data ? JSON.parse(ev.data) : null;
				} catch (e) {
					return;
				}
				handlers[name](data || {});
			});
		}
	};
	open();
	return () => {
		clearTimeout(timer);
		if (es) es.close();
	};
}

// The page reports what it shows at most every 500 ms (the last report wins).
let viewTimer = null;
let viewLast = 0;
let viewPending = null;
function sendView() {
	viewTimer = null;
	viewLast = performance.now();
	const body = viewPending;
	viewPending = null;
	fetch('/api/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
export function reportView(state) {
	viewPending = state;
	if (viewTimer) return;
	const wait = Math.max(0, 500 - (performance.now() - viewLast));
	viewTimer = setTimeout(sendView, wait);
}
