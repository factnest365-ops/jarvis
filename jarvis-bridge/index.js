#!/usr/bin/env node
/**
 * JARVIS Bridge — local service that enriches the in-page watcher with:
 *   1. /context -> Obscura (deep fetch + platform search) + Agent-Reach (transcribe)
 *   2. /act     -> execute a proposed action:
 *        - download: Obscura streams a file URL to ./downloads
 *        - opencli : shell out to OpenCLI (acts on your logged-in browser)
 *
 * Env:
 *   JARVIS_BRIDGE_PORT   (default 8787)
 *   OBSCURA_BIN          (default /Users/bhavy/obscura)
 *   AGENT_REACH_BIN      (default /Users/bhavy/.agent-reach-venv/bin/agent-reach)
 *   OPENCLI_BIN          (default /Users/bhavy/.local/bin/opencli)
 *   OBSCURA_STEALTH=0    disable stealth mode
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT || 8787)
const OBSCURA = process.env.OBSCURA_BIN || '/Users/bhavy/obscura'
const AGENT_REACH = process.env.AGENT_REACH_BIN || '/Users/bhavy/.agent-reach-venv/bin/agent-reach'
const OPENCLI = process.env.OPENCLI_BIN || '/Users/bhavy/.local/bin/opencli'
const STEALTH = process.env.OBSCURA_STEALTH === '0' ? [] : ['--stealth']
const FETCH_TIMEOUT = Number(process.env.OBSCURA_TIMEOUT || 30)

function run(bin, args, timeoutMs) {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				resolve({ ok: false, error: String(err.message || err), stderr: String(stderr).slice(0, 300) })
				return
			}
			resolve({ ok: true, stdout: stdout || '' })
		})
	})
}

async function obscuraFetch(url, { dump = 'markdown' } = {}) {
	const args = ['fetch', '--dump', dump, '--timeout', String(FETCH_TIMEOUT), '--wait', '5', ...STEALTH, url]
	const r = await run(OBSCURA, args, (FETCH_TIMEOUT + 15) * 1000)
	return r.ok ? r.stdout : ''
}

async function agentReachTranscribe(url) {
	const r = await run(AGENT_REACH, ['transcribe', url], 150000)
	return r.ok ? r.stdout : ''
}

const slug = (t, max = 60) => encodeURIComponent((t || '').replace(/\s+/g, ' ').trim().slice(0, max))
const safeName = (s) => (s || 'download').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)

async function webSignal(topic) {
	const q = slug(topic)
	const targets = [
		`https://www.reddit.com/search/?q=${q}`,
		`https://github.com/search?q=${q}&type=repositories`,
		`https://www.youtube.com/results?search_query=${q}`,
	]
	const out = await Promise.all(
		targets.map(async (u) => {
			const md = await obscuraFetch(u)
			return md ? `## ${u}\n${md.slice(0, 1500)}` : ''
		})
	)
	return out.filter(Boolean).join('\n\n').slice(0, 4500)
}

async function gather({ url, title }) {
	const pageContent = await obscuraFetch(url)
	const topic = title || pageContent.slice(0, 80)
	let transcript = ''
	if (/youtube\.com\/watch|youtu\.be\//.test(url)) {
		transcript = await agentReachTranscribe(url)
	}
	const webSignalText = await webSignal(topic)
	return {
		url,
		title,
		pageContent: pageContent.slice(0, 4000),
		transcript: transcript.slice(0, 3000),
		webSignal: webSignalText,
	}
}

function handleAct(body, res) {
	const { action, url, name, args } = body || {}
	if (action === 'download' && url) {
		try {
			const u = new URL(url)
			const fname = safeName(name || path.basename(u.pathname) || 'download')
			const outDir = path.join(process.cwd(), 'downloads')
			fs.mkdirSync(outDir, { recursive: true })
			const outPath = path.join(outDir, fname)
			const cp = execFile(
				OBSCURA,
				['fetch', '--dump', 'original', '--timeout', String(FETCH_TIMEOUT), '--wait', '3', ...STEALTH, url],
				{ timeout: (FETCH_TIMEOUT + 15) * 1000, maxBuffer: 64 * 1024 * 1024 }
			)
			const ws = fs.createWriteStream(outPath)
			cp.stdout.pipe(ws)
			let done = false
			const finish = (payload) => {
				if (done) return
				done = true
				res.writeHead(payload.status, { 'content-type': 'application/json' })
				res.end(JSON.stringify(payload.body))
			}
			cp.on('close', (code) => finish({ status: 200, body: { ok: true, path: outPath, exitCode: code } }))
			cp.on('error', (e) => finish({ status: 500, body: { ok: false, error: String(e) } }))
			ws.on('error', (e) => finish({ status: 500, body: { ok: false, error: String(e) } }))
			return
		} catch (e) {
			res.writeHead(400, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ ok: false, error: String(e) }))
			return
		}
	}
	if (action === 'opencli' && Array.isArray(args)) {
		run(OPENCLI, args, 120000).then((r) => {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(r))
		})
		return
	}
	res.writeHead(400, { 'content-type': 'application/json' })
	res.end(JSON.stringify({ ok: false, error: 'unknown or incomplete action' }))
}

const server = http.createServer((req, res) => {
	if (req.method === 'POST' && req.url === '/context') {
		let body = ''
		req.on('data', (c) => (body += c))
		req.on('end', async () => {
			try {
				const { url, title } = JSON.parse(body || '{}')
				if (!url) {
					res.writeHead(400, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ error: 'url required' }))
					return
				}
				const result = await gather({ url, title })
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify(result))
			} catch (e) {
				res.writeHead(500, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ error: String(e) }))
			}
		})
		return
	}
	if (req.method === 'POST' && req.url === '/act') {
		let body = ''
		req.on('data', (c) => (body += c))
		req.on('end', () => {
			try {
				handleAct(JSON.parse(body || '{}'), res)
			} catch (e) {
				res.writeHead(500, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ ok: false, error: String(e) }))
			}
		})
		return
	}
	if (req.url === '/health') {
		res.writeHead(200)
		res.end('ok')
		return
	}
	res.writeHead(404)
	res.end('not found')
})

server.listen(PORT, () => console.log(`[jarvis-bridge] listening on http://localhost:${PORT}`))
