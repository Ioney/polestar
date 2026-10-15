'use strict';
// Client files by FileDataID from wago.tools
// (`/api/casc/<fdid>?download&branch=<product>`), cached under
// <sources>/casc/<product>/<build>/<fdid>.blp. The build is the one
// `/api/builds/latest` names for the product (asked once per process);
// offline, the newest build directory already cached. A cached file is never
// fetched again. Downloads run `concurrency` at a time, each retried 3 times
// with backoff (not on 404).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { threadId } = require('node:worker_threads');
const { compareVersions } = require('../../data/wago');

const LATEST_URL = 'https://wago.tools/api/builds/latest';
const UA = 'polestar-planner';
const fileUrl = (fdid, product) => `https://wago.tools/api/casc/${fdid}?download&branch=${encodeURIComponent(product)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET url -> Buffer; 3 retries (0.5 s, 1 s, 2 s) on network errors and
// non-404 HTTP errors.
async function fetchRetry(url, { fetchImpl = globalThis.fetch, retries = 3, timeout = 120000 } = {}) {
	let last;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt) await sleep(500 * 2 ** (attempt - 1));
		try {
			const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
			if (!res.ok) {
				const err = new Error(`GET ${url}: HTTP ${res.status}`);
				err.status = res.status;
				if (res.status === 404) throw Object.assign(err, { final: true });
				throw err;
			}
			return Buffer.from(await res.arrayBuffer());
		} catch (err) {
			if (err.final) throw err;
			last = err;
		}
	}
	throw last;
}

const latest = new Map(); // fetchImpl -> Promise of the /api/builds/latest JSON

async function latestBuild(product, fetchImpl = globalThis.fetch) {
	if (!latest.has(fetchImpl)) {
		const p = fetchRetry(LATEST_URL, { fetchImpl }).then((b) => JSON.parse(b.toString('utf8')));
		p.catch(() => latest.delete(fetchImpl));
		latest.set(fetchImpl, p);
	}
	const entry = (await latest.get(fetchImpl))[product];
	if (!entry || !entry.version) throw new Error(`${LATEST_URL}: no ${product} build listed`);
	return checkBuild(entry.version, LATEST_URL);
}

// A client build as wago.tools names it ("1.15.7.61582"): the only form let into cache paths.
const BUILD_RE = /^\d+(\.\d+)+$/;

// `build` when it is one, else an Error naming where it came from.
function checkBuild(build, where) {
	if (typeof build !== 'string' || !BUILD_RE.test(build)) throw new Error(`${where}: malformed build "${build}" (want digits and dots, like 1.15.7.61582)`);
	return build;
}

function newestCachedBuild(dir) {
	if (!fs.existsSync(dir)) return null;
	const builds = fs.readdirSync(dir).filter((b) => BUILD_RE.test(b)).sort(compareVersions);
	return builds.length ? builds[builds.length - 1] : null;
}

class Casc {
	constructor({ sourcesDir, product, build, offline = false, concurrency = 8, fetchImpl = globalThis.fetch }) {
		this.product = product;
		this.build = checkBuild(build, 'casc');
		this.offline = offline;
		this.dir = path.join(sourcesDir, 'casc', product, build);
		this.fetchImpl = fetchImpl;
		this.limit = Math.max(1, concurrency);
		this.active = 0;
		this.waiting = [];
		this.pending = new Map(); // fdid -> Promise of the cache path
		this.fetched = 0;
	}

	path(fdid) {
		return path.join(this.dir, `${fdid}.blp`);
	}

	has(fdid) {
		return fs.existsSync(this.path(fdid));
	}

	async slot(fn) {
		if (this.active >= this.limit) await new Promise((r) => this.waiting.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			if (this.waiting.length) this.waiting.shift()();
		}
	}

	// Makes sure fdid is in the cache -> its path.
	ensure(fdid) {
		const file = this.path(fdid);
		if (fs.existsSync(file)) return Promise.resolve(file);
		if (this.offline) return Promise.reject(new Error(`--offline: ${fdid} is not cached (${path.relative(process.cwd(), file)})`));
		if (!this.pending.has(fdid)) {
			const p = this.slot(async () => {
				const body = await fetchRetry(fileUrl(fdid, this.product), { fetchImpl: this.fetchImpl });
				if (!body.length) throw new Error(`${fileUrl(fdid, this.product)}: empty body`);
				fs.mkdirSync(this.dir, { recursive: true });
				// Unique per process, thread and call: several workers may fetch the same file.
				const tmp = `${file}.${process.pid}.${threadId}.${crypto.randomBytes(4).toString('hex')}.tmp`;
				fs.writeFileSync(tmp, body);
				try {
					fs.renameSync(tmp, file);
				} catch (err) {
					// Another fetch put the same file there first: it is the same file.
					fs.rmSync(tmp, { force: true });
					if (!fs.existsSync(file)) throw err;
				}
				this.fetched++;
				return file;
			});
			this.pending.set(fdid, p);
			p.finally(() => this.pending.delete(fdid)).catch(() => {});
		}
		return this.pending.get(fdid);
	}

	// fdid -> Buffer (cached or fetched).
	async get(fdid) {
		return fs.readFileSync(await this.ensure(fdid));
	}
}

// -> Casc for product at `build`, else the latest build wago.tools names, else
// (offline) the newest cached one.
async function openCasc({ sourcesDir, product = 'wow_classic_beta', build, offline = false, concurrency = 8, fetchImpl = globalThis.fetch }) {
	if (!build) {
		if (offline) {
			build = newestCachedBuild(path.join(sourcesDir, 'casc', product));
			if (!build) throw new Error(`--offline: nothing cached under ${path.join(sourcesDir, 'casc', product)}`);
		} else build = await latestBuild(product, fetchImpl);
	}
	return new Casc({ sourcesDir, product, build, offline, concurrency, fetchImpl });
}

module.exports = { openCasc, Casc, fetchRetry, latestBuild, newestCachedBuild, checkBuild, fileUrl, LATEST_URL };
