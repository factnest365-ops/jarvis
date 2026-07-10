import type { ContextGatherer, GatheredContext } from './types'

/**
 * Talks to the local JARVIS Bridge (jarvis-bridge/index.js), which wires
 * Obscura + Agent-Reach to produce internet-aware context for the watcher.
 */
export class LocalBridgeGatherer implements ContextGatherer {
	constructor(private readonly baseUrl: string) {}

	async gather(url: string, title?: string): Promise<GatheredContext | null> {
		try {
			const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/context`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url, title }),
				signal: AbortSignal.timeout(60000),
			})
			if (!res.ok) return null
			return (await res.json()) as GatheredContext
		} catch {
			return null
		}
	}
}
