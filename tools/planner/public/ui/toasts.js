// Short notices in the bottom right corner: a glyph by kind and the message.
import { h, glyph } from './dom.js';

const GLYPHS = { info: 'info', ok: 'check', warn: 'warning', error: 'warning' };

export function toast(message, kind = 'info', ms = 4500) {
	const root = document.getElementById('toasts');
	const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, glyph(GLYPHS[kind] || 'info'), h('div.msg', message));
	el.addEventListener('click', () => el.remove());
	root.append(el);
	while (root.children.length > 5) root.firstChild.remove();
	setTimeout(() => el.remove(), ms);
	return el;
}
