// The top bar: breadcrumb, undo/redo, Library, Edit/Playback, the character
// (race, class, start level), the connection dot, Changes and Compile.
import { h, clear, glyph, dropdown, popover, closePopover } from './dom.js';
import { S } from './state.js';
import { className, raceName, classIcon, raceIcon } from './character.js';

// Race files and the sides each can play, from planner_info.races.
export function raceOptions() {
	const out = [];
	for (const [race, sides] of Object.entries(S.info.races || {})) {
		for (const [faction, r] of Object.entries(sides)) out.push({ race, faction, classes: r.classes || [] });
	}
	return out;
}

export function topbar(root, ctx) {
	const pack = h('span.pack');
	const title = h('b');
	const undo = h('button.btn.icon', { title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: ctx.undo }, glyph('undo'));
	const redo = h('button.btn.icon', { title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: ctx.redo }, glyph('redo'));
	const play = h('button', { onclick: () => ctx.setMode('playback'), title: 'Watch the route play (E)' }, 'Playback');
	const edit = h('button', { onclick: () => ctx.setMode('edit'), title: 'Edit the guide (E)' }, 'Edit');
	const charIcons = h('span.char-icons');
	const charName = h('b');
	const charSub = h('span');
	const charLvl = h('span.lvl');
	const charBtn = h('button.btn.char-btn', { title: 'Character, start level and optional goals' }, charIcons, h('span.who', charName, charSub), charLvl, glyph('chevron-down'));
	const conn = h('span.conn', { title: 'Server connection' });
	const connText = h('span.conn-text', { hidden: true }, 'Offline');
	const chgCount = h('span.count-badge', { hidden: true });
	const changes = h('button.btn.ghost', { title: 'Changed guide files, revert, lint', onclick: ctx.toggleChanges }, glyph('list'), 'Changes', chgCount);
	const compile = h('button.btn.primary', { title: 'Compile the pack into its addon folder', onclick: ctx.compile }, glyph('export'), 'Compile');
	clear(root).append(
		h('div.brand', h('span.emblem', { role: 'img', 'aria-label': 'Polestar' }), 'Planner'),
		h('span.bar-sep'),
		h('button.btn.ghost', { onclick: ctx.openLibrary, title: 'Choose the guide the route starts with' }, glyph('guides'), 'Library'),
		h('div.crumbs', pack, glyph('chevron-right', 'sep'), title),
		undo, redo,
		h('span.spacer'),
		h('div.seg.lg', play, edit),
		h('span.bar-sep'),
		charBtn, conn, connText, changes, compile);

	charBtn.addEventListener('click', () => characterPopover(charBtn, ctx));

	let lastWho = '';
	return {
		update() {
			const g = S.guideById.get(ctx.shownGuideId() || S.start);
			const p = g && S.info.packs.find((x) => x.id === g.pack);
			pack.textContent = p ? p.title || p.id : '';
			title.textContent = g ? g.title : 'No guide';
			title.title = g ? g.id : '';
			edit.classList.toggle('on', S.mode === 'edit');
			play.classList.toggle('on', S.mode === 'playback');
			edit.setAttribute('aria-pressed', String(S.mode === 'edit'));
			play.setAttribute('aria-pressed', String(S.mode === 'playback'));
			const ch = S.character;
			const who = `${ch.race}|${ch.cls}`;
			if (who !== lastWho) {
				lastWho = who;
				clear(charIcons).append(classIcon(ch.cls, 's20'), raceIcon(ch.race, 's20'));
			}
			charName.textContent = `${raceName(ch.race)} ${className(ch.cls)}`;
			charSub.textContent = `${ch.faction}${S.optional ? ' · optional goals' : ''}`;
			charLvl.textContent = S.startLevel ? `Level ${S.startLevel}` : 'Guide level';
			conn.classList.toggle('on', S.connected);
			connText.hidden = !!S.connected;
			conn.title = S.connected ? 'In sync with the planner server' : 'Disconnected: reconnecting…';
			chgCount.hidden = !S.changes.length;
			chgCount.textContent = S.changes.length;
		},
	};
}

function characterPopover(anchor, ctx) {
	const opts = raceOptions();
	const cur = { ...S.character };
	let level = S.startLevel;
	const raceSel = h('select');
	const clsSel = h('select');
	const lvlInp = h('input', { type: 'number', min: 1, max: 80, placeholder: 'the guide\'s', value: level || '' });
	const fill = () => {
		clear(raceSel);
		for (const o of opts) {
			raceSel.append(h('option', { value: `${o.race}|${o.faction}`, selected: o.race === cur.race && o.faction === cur.faction }, `${raceName(o.race)}${opts.filter((x) => x.race === o.race).length > 1 ? ` (${o.faction})` : ''}`));
		}
		const o = opts.find((x) => x.race === cur.race && x.faction === cur.faction) || opts[0];
		clear(clsSel);
		for (const c of o.classes) clsSel.append(h('option', { value: c, selected: c === cur.cls }, className(c)));
		if (!o.classes.includes(cur.cls)) cur.cls = o.classes[0];
		clsSel.value = cur.cls;
	};
	raceSel.addEventListener('change', () => {
		const [race, faction] = raceSel.value.split('|');
		cur.race = race;
		cur.faction = faction;
		fill();
	});
	clsSel.addEventListener('change', () => (cur.cls = clsSel.value));
	// Optional goals never hold a step in the game; played only on request.
	const optional = h('button', { class: `tog${S.optional ? ' on' : ''}`, type: 'button', title: 'Play goals marked optional as required work (else they are skipped)' }, h('span.sw'), 'Play optional goals');
	optional.addEventListener('click', () => optional.classList.toggle('on'));
	const apply = h('button.btn.primary', {
		onclick: () => {
			closePopover();
			const n = Number(lvlInp.value);
			level = lvlInp.value && n >= 1 ? Math.floor(n) : null;
			ctx.setCharacter({ ...cur }, level, optional.classList.contains('on'));
		},
	}, 'Play this character');
	fill();
	popover(h('div',
		h('div.pop-title', 'Character'),
		h('div.form-grid',
			h('label', 'Race'), dropdown(raceSel),
			h('label', 'Class'), dropdown(clsSel),
			h('label', 'Start level'), lvlInp,
			h('label', 'Optional'), h('div', optional)),
		h('div.pop-foot', apply)), anchor, { align: 'right' });
}
