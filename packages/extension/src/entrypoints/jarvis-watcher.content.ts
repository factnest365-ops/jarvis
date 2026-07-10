import { JarvisWatcher, type Intervention } from '@/jarvis'

const DEBUG = '[JARVIS]'

export default defineContentScript({
	matches: ['<all_urls>'],
	runAt: 'document_idle',

	main() {
		console.debug(`${DEBUG} content script loaded on ${location.href}`)

		chrome.storage.local.get(['llmConfig', 'jarvisProactive', 'jarvisRules', 'jarvisBridgeUrl']).then((res) => {
			const cfg = res.llmConfig as
				| { baseURL?: string; model?: string; apiKey?: string; transformRequestBody?: any; disableNamedToolChoice?: boolean }
				| undefined

			if (!res.jarvisProactive || !cfg?.baseURL || !cfg?.model) {
				console.debug(`${DEBUG} proactive mode off or LLM not configured — skipping.`)
				return
			}

			const bridgeUrl = res.jarvisBridgeUrl as string | undefined
			const watcher = new JarvisWatcher(
				{
					baseURL: cfg.baseURL,
					model: cfg.model,
					apiKey: cfg.apiKey,
					transformRequestBody: cfg.transformRequestBody,
					disableNamedToolChoice: cfg.disableNamedToolChoice,
				},
				{
					rules: (res.jarvisRules as string) || '',
					bridgeUrl,
				}
			)

			watcher.addEventListener('intervention', (e) => {
				const detail = (e as CustomEvent<Intervention>).detail
				showBubble(detail, watcher, bridgeUrl)
			})

			watcher.start()
			console.debug(`${DEBUG} watching.`)
		})
	},
})

const SEVERITY_COLOR: Record<string, string> = {
	info: '#3b82f6',
	warn: '#f59e0b',
	critical: '#ef4444',
}

function showBubble(i: Intervention, watcher?: JarvisWatcher, bridgeUrl?: string): void {
	const root = document.getElementById('jarvis-bubble-root')
		|| (() => {
			const el = document.createElement('div')
			el.id = 'jarvis-bubble-root'
			el.style.cssText =
				'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end;font-family:system-ui,sans-serif;'
			document.body.appendChild(el)
			return el
		})()

	const color = SEVERITY_COLOR[i.severity] || SEVERITY_COLOR.info

	const card = document.createElement('div')
	card.style.cssText =
		`max-width:320px;background:#0b0b0f;color:#fff;border:1px solid ${color};` +
		`border-left:4px solid ${color};border-radius:12px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.4);` +
		`font-size:13px;line-height:1.4;animation:jarvisIn .2s ease-out;`
	card.innerHTML =
		`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:700;letter-spacing:.5px;">` +
		`<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>` +
		`JARVIS <span style="font-weight:400;color:#9ca3af;text-transform:uppercase;font-size:10px;">${i.severity}</span></div>` +
		`<div style="margin-bottom:4px;">${escapeHtml(i.message)}</div>` +
		(i.suggestion ? `<div style="color:#9ca3af;font-size:12px;">→ ${escapeHtml(i.suggestion)}</div>` : '') +
		`<button aria-label="Dismiss" style="position:absolute;top:6px;right:8px;background:none;border:none;color:#6b7280;cursor:pointer;font-size:14px;">×</button>`

	const close = () => card.remove()
	card.querySelector('button')?.addEventListener('click', close)

	if (i.action) {
		const act = i.action
		const btn = document.createElement('button')
		btn.textContent = act.label || 'Do it'
		btn.style.cssText =
			'margin-top:8px;background:#0b0b0f;color:#fff;border:1px solid ' + color +
			';border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;'
		btn.addEventListener('click', async () => {
			btn.disabled = true
			btn.textContent = 'Working…'
			try {
				if (act.type === 'draft' && watcher && act.prompt) {
					const text = await watcher.draft(act.prompt)
					card.innerHTML =
						`<div style="margin-bottom:6px;white-space:pre-wrap;">${escapeHtml(text)}</div>` +
						`<button id="jarvis-copy" style="background:${color};color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">Copy</button>`
					card.querySelector('#jarvis-copy')?.addEventListener('click', () => {
						navigator.clipboard.writeText(text)
						card.querySelector('#jarvis-copy')!.textContent = 'Copied ✓'
					})
				} else if ((act.type === 'download' || act.type === 'opencli') && bridgeUrl) {
					const r = await fetch(bridgeUrl.replace(/\/$/, '') + '/act', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: act.type, url: act.url, args: act.args }),
					})
					const j = (await r.json()) as { ok?: boolean; path?: string }
					btn.textContent = j.path ? 'Saved ✓' : j.ok ? 'Done ✓' : 'Failed'
				} else {
					btn.textContent = 'No bridge'
				}
			} catch {
				btn.textContent = 'Error'
			}
		})
		card.appendChild(btn)
	}

	root.appendChild(card)
	setTimeout(close, 15000)

	// Voice for higher-severity interruptions
	if (i.severity !== 'info' && 'speechSynthesis' in window) {
		try {
			const u = new SpeechSynthesisUtterance(`JARVIS. ${i.message}`)
			u.rate = 1.05
			u.pitch = 0.9
			window.speechSynthesis.cancel()
			window.speechSynthesis.speak(u)
		} catch {
			/* noop */
		}
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	)
}
