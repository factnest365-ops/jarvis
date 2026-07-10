export interface GatheredContext {
	url: string
	title?: string
	/** Deep page content (Obscura markdown dump). */
	pageContent?: string
	/** Video transcript (Agent-Reach, YouTube only). */
	transcript?: string
	/** Web signal scraped from Reddit / GitHub / YouTube search. */
	webSignal?: string
}

export interface ContextGatherer {
	gather(url: string, title?: string): Promise<GatheredContext | null>
}
