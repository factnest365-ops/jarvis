/**
 * JARVIS Watcher — proactive browser agent.
 *
 * Observes the user's real interactions on the page (clicks, typing, form
 * submits, navigation) and asks the LLM whether JARVIS should interrupt
 * with a correction, warning, or nudge. Emits an `intervention` event when
 * the model decides to speak.
 *
 * Framework-agnostic: runs in a content script or any DOM context.
 */
import { LLM, type Tool } from '@page-agent/llms'
import * as z from 'zod/v4'

import SYSTEM_PROMPT from './prompts/jarvis_system.md?raw'

export type Severity = 'info' | 'warn' | 'critical'

export interface Intervention {
	intervene: boolean
	severity: Severity
	reason: string
	message: string
	suggestion: string
}

export interface WatcherConfig {
	baseURL: string
	model: string
	apiKey?: string
	transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown> | undefined
	disableNamedToolChoice?: boolean
}

export interface WatcherOptions {
	/** User's brand voice / guardrails. Enforced strictly by the model. */
	rules?: string
	/** Minimum ms between LLM checks (avoid spamming). */
	debounceMs?: number
	/** Max recent actions kept in context. */
	maxContextActions?: number
	/** Called on every intervention. */
	onIntervention?: (i: Intervention) => void
}

const interventionTool: Tool<Intervention, Intervention> = {
	description:
		'Decide whether JARVIS should interrupt the user right now based on their recent actions.',
	inputSchema: z.object({
		intervene: z.boolean(),
		severity: z.enum(['info', 'warn', 'critical']),
		reason: z.string(),
		message: z.string(),
		suggestion: z.string(),
	}),
	execute: async (input) => input,
}

function describeElement(el: EventTarget | null): string {
	if (!el || !(el instanceof Element)) return 'unknown element'
	const tag = el.tagName.toLowerCase()
	const id = el.id ? `#${el.id}` : ''
	const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 1).join('.')
	const text = ((el.textContent || '').trim() || '').slice(0, 40)
	const aria = el.getAttribute('aria-label') || ''
	const name =
		el.getAttribute('name') || el.getAttribute('placeholder') || aria || text || ''
	return `${tag}${id}${cls}${name ? ` "${name}"` : ''}`
}

export class JarvisWatcher extends EventTarget {
	#llm: LLM
	#rules: string
	#debounceMs: number
	#maxActions: number
	#actions: string[] = []
	#dirty = false
	#busy = false
	#lastCall = 0
	#abort = new AbortController()
	#onIntervention?: (i: Intervention) => void
	#handlers: Array<[string, EventListenerOrEventListenerObject]> = []

	constructor(config: WatcherConfig, options: WatcherOptions = {}) {
		super()
		this.#llm = new LLM(config)
		this.#rules = options.rules ?? ''
		this.#debounceMs = options.debounceMs ?? 8000
		this.#maxActions = options.maxContextActions ?? 8
		this.#onIntervention = options.onIntervention
	}

	start(): void {
		const rec = (desc: string) => this.#record(desc)

		const onClick = (e: Event) => rec(`Clicked ${describeElement(e.target)}`)
		const onInput = (e: Event) => {
			const el = e.target as HTMLInputElement
			if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
				const kind = el.type === 'password' ? 'secret' : `${el.value.length} chars`
				rec(`Typed into ${describeElement(el)} (${kind})`)
			} else if (el && el.tagName === 'SELECT') {
				rec(`Selected "${el.value}" in ${describeElement(el)}`)
			}
		}
		const onSubmit = () => rec(`Submitted a form on ${location.hostname}`)
		const onNav = () => rec(`Navigated to ${location.href}`)

		document.addEventListener('click', onClick, true)
		document.addEventListener('input', onInput, true)
		document.addEventListener('change', onInput, true)
		document.addEventListener('submit', onSubmit, true)
		window.addEventListener('popstate', onNav)
		window.addEventListener('hashchange', onNav)

		// Wrap history API so SPA navigations are captured
		const wrap = (type: 'pushState' | 'replaceState') => {
			const orig = history[type]
			history[type] = new Proxy(orig, {
				apply: (target, thisArg, argArray) => {
					const r = Reflect.apply(target, thisArg, argArray)
					onNav()
					return r
				},
			})
		}
		wrap('pushState')
		wrap('replaceState')

		this.#handlers = [
			['click', onClick],
			['input', onInput],
			['change', onInput],
			['submit', onSubmit],
			['popstate', onNav],
			['hashchange', onNav],
		]
	}

	stop(): void {
		for (const [type, fn] of this.#handlers) {
			if (type === 'click' || type === 'input' || type === 'change' || type === 'submit') {
				document.removeEventListener(type, fn as EventListener, true)
			} else {
				window.removeEventListener(type, fn as EventListener)
			}
		}
		this.#handlers = []
		this.#abort.abort()
	}

	#record(desc: string): void {
		const stamp = new Date().toLocaleTimeString()
		this.#actions.push(`[${stamp}] ${desc}`)
		if (this.#actions.length > this.#maxActions) this.#actions.shift()
		this.#dirty = true
		this.#schedule()
	}

	#schedule(): void {
		if (this.#busy) return
		const wait = Math.max(0, this.#debounceMs - (Date.now() - this.#lastCall))
		setTimeout(() => void this.#check(), wait)
	}

	async #check(): Promise<void> {
		if (this.#busy || !this.#dirty) return
		this.#busy = true
		this.#dirty = false
		this.#lastCall = Date.now()
		try {
			const decision = await this.#decide()
			if (decision.intervene) {
				const evt = new CustomEvent<Intervention>('intervention', { detail: decision })
				this.dispatchEvent(evt)
				this.#onIntervention?.(decision)
			}
		} catch (err) {
			console.warn('[JARVIS] intervention check failed:', err)
		} finally {
			this.#busy = false
		}
	}

	async #decide(): Promise<Intervention> {
		const rules = this.#rules.trim()
			? this.#rules.trim()
			: 'No specific rules provided. Use good judgment.'

		const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
			.map((h) => h.textContent?.trim())
			.filter(Boolean)
			.slice(0, 5)
			.join(' | ')

		const userCtx =
			`Current page: ${document.title} (${location.href})\n` +
			`Page context: ${headings || '(no headings)'}\n\n` +
			`Recent user actions (most recent last):\n` +
			(this.#actions.length ? this.#actions.map((a) => `- ${a}`).join('\n') : '- (none yet)')

		const system = SYSTEM_PROMPT.replace('{{RULES}}', rules)
		const messages = [
			{ role: 'system' as const, content: system },
			{ role: 'user' as const, content: userCtx },
		]

		const res = await this.#llm.invoke(messages, { intervention: interventionTool }, this.#abort.signal, {
			toolChoiceName: 'intervention',
		})
		return res.toolResult as Intervention
	}
}
