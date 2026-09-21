/**
*	auto-compact.ts
*
*	OpenCode plugin — fixed-percentage compaction trigger.
*	Fires opencode's native compaction at target_percent of the context
*	window. The summarizer model is opencode's own decision, configured via
*	"agent.compaction.model" in opencode.jsonc (falls back to the session
*	model when unset).
*
*	Install: cp auto-compact.ts ~/.config/opencode/plugins/auto-compact.ts
*	Config:  ~/.config/opencode/auto-compact.jsonc
*	Log:     ~/.config/opencode/auto-compact.log
*
*	@example ~/.config/opencode/auto-compact.jsonc
*	{
*		"enabled": true,                // master switch
*		"target_percent": 30,           // compact when context usage reaches this %
*		"log_level": "info"             // "silent" | "error" | "info" | "debug"
*	}
*
*	@name auto-compact
*	@version 0.1.7
*	@author Alejandro Carraretto
*	@assistant DeepSeek-Flash
*	@license AGPL-3.0
*/

import type { Plugin, PluginInput } from "@opencode-ai/plugin" ;
import { appendFileSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "auto-compact.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "auto-compact.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

const CONFIG : Config =
{
	enabled        : true,
	target_percent : 30,
	log_level      : "info",
};

// Compaction guard — frozen value, not a user knob
const COOLDOWN_MS = 300_000 ;   // min gap after a compaction finishes (loop-breaker for lazy models)

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled        : boolean ;
	target_percent : number ;
	log_level      : "silent" | "error" | "info" | "debug" ;
}

interface ModelRef
{
	providerID : string ;
	modelID    : string ;
}

interface Usage extends ModelRef
{
	tokens : number ;
}

interface SessionState
{
	usage?        : Usage ;
	inProgress    : boolean ;
	lastCompactAt : number ;
}

interface MessageInfo
{
	role?       : string ;
	id?         : string ;
	sessionID?  : string ;
	summary?    : boolean ;
	providerID? : string ;
	modelID?    : string ;
	tokens?     :
	{
		input?     : number ;
		output?    : number ;
		reasoning? : number ;
		cache?     : { read? : number; write? : number } ;
	} ;
}

interface ProviderEntry
{
	id     : string ;
	models : Record<string, { limit? : { context? : number } }> ;
}

// ─── Global Helpers ──────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// Load config from ~/.config/opencode/auto-compact.jsonc, fall back to defaults
function loadConfig() : Config
{
	let file : Partial<Config> = {} ;
	let loaded = false ;

	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as Partial<Config> ;
		loaded = true ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	Object.assign( CONFIG, file ) ;

	log( LOG_LEVEL.INFO, loaded ? "Config loaded" : "Config loaded (defaults)" ) ;

	return CONFIG ;
}

// Append timestamped entry to ~/.config/opencode/auto-compact.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ timestamp() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── AutoCompact ───────────────────────────────────────────────────────────

// Controller class: holds all plugin state and logic.
class AutoCompact
{
	private config : Config ;
	private client : PluginInput[ "client" ] ;
	private sessions : Map<string, SessionState> = new Map() ;
	private loggedSummaries : Set<string> = new Set() ;
	private providers : ProviderEntry[] | null = null ;

	// Initialize: store config + client, no side effects
	constructor( config : Config, client : PluginInput[ "client" ] )
	{
		this.config = config ;
		this.client = client ;
	}

	// ── Internal helpers ───────────────────────────────────────────────

	// Provider catalog, fetched once and cached (null on failure, retried next call)
	protected async providerList() : Promise<ProviderEntry[] | null>
	{
		if ( this.providers ) return this.providers ;

		try
		{
			const res = await this.client.provider.list() ;
			this.providers = ( res?.data?.all ?? [] ) as ProviderEntry[] ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `provider.list failed: ${ ( err as Error ).message }` ) ;
			return null ;
		}

		return this.providers ;
	}

	// Known model entry from the catalog; null when the model is unknown
	protected async findModel( ref : ModelRef ) : Promise<{ context : number } | null>
	{
		const providers = await this.providerList() ;
		const provider  = providers?.find( p => p.id === ref.providerID ) ;
		const model     = provider?.models?.[ ref.modelID ] ;

		if ( ! model ) return null ;

		return { context : model.limit?.context ?? 0 } ;
	}

	// Sum every token counter reported by the provider for one assistant message
	protected totalTokens( info : MessageInfo ) : number
	{
		const t = info.tokens ;
		if ( ! t ) return 0 ;

		return ( t.input ?? 0 ) + ( t.output ?? 0 ) + ( t.reasoning ?? 0 )
			+ ( t.cache?.read ?? 0 ) + ( t.cache?.write ?? 0 ) ;
	}

	// Force native compaction (summarize) on demand.
	// The caller must have claimed state.inProgress; it is always released here.
	protected async compact( sessionID : string, state : SessionState, percent : number ) : Promise<void>
	{
		const usage = state.usage ;
		if ( ! usage )
		{
			state.inProgress = false ;
			return ;
		}

		try
		{
			try
			{
				// ignored: UI-only notice, NOT sent to model
				await this.client.session.prompt( {
					path : { id : sessionID } ,
					body : {
						noReply : true ,
						parts : [
							{
								type : "text" ,
								text : `▣ auto-compact: ${ percent.toFixed( 1 ) }% ≥ ${ this.config.target_percent }% — compacting` ,
								ignored : true ,
							} ,
						] ,
					} ,
				} ) ;
			}
			catch ( err )
			{
				log( LOG_LEVEL.ERROR, `notice failed: ${ ( err as Error ).message }` ) ;
			}

			// The body model is only a fallback: opencode resolves the real
			// summarizer from its own "compaction" agent configuration.
			const res = await this.client.session.summarize( {
				path : { id : sessionID } ,
				body : { providerID : usage.providerID, modelID : usage.modelID } ,
			} ) ;

			if ( res?.error )
			{
				log( LOG_LEVEL.ERROR, `summarize rejected: ${ JSON.stringify( res.error ) }` ) ;
				return ;
			}

			log( LOG_LEVEL.INFO,
				`Compaction triggered | session: ${ sessionID } | tokens: ${ usage.tokens }` ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `compact failed: ${ ( err as Error ).message }` ) ;
		}
		finally
		{
			// Cooldown starts when compaction finishes, not when it starts: a slow
			// summarize must not consume the whole window before it is set.
			state.lastCompactAt = Date.now() ;
			state.inProgress = false ;
		}
	}

	// Evaluate the threshold on an idle session and compact when reached.
	// One compaction in flight per session: the claim is synchronous, and
	// compact() is its only releaser (finally) — no event may release it.
	protected async evaluate( sessionID : string ) : Promise<void>
	{
		const state = this.sessions.get( sessionID ) ;
		if ( ! state?.usage ) return ;

		if ( state.inProgress ) return ;

		if ( Date.now() - state.lastCompactAt < COOLDOWN_MS ) return ;

		const model = await this.findModel( state.usage ) ;
		if ( ! model?.context ) return ;

		const percent = ( state.usage.tokens / model.context ) * 100 ;
		if ( percent < this.config.target_percent ) return ;

		// Re-check after the awaits: another idle event may have claimed the session
		if ( state.inProgress ) return ;

		state.inProgress = true ;

		log( LOG_LEVEL.INFO,
			`Threshold reached | session: ${ sessionID } | ${ percent.toFixed( 1 ) }% >= ${ this.config.target_percent }%` ) ;

		await this.compact( sessionID, state, percent ) ;
	}

	// Cache usage from assistant messages; log the summarizer model on summary messages
	protected onMessage( info : MessageInfo | undefined ) : void
	{
		if ( ! info || info.role !== "assistant" ) return ;

		if ( info.summary )
		{
			const id = info.id ?? "" ;

			if ( ! id || ! this.loggedSummaries.has( id ) )
			{
				if ( id ) this.loggedSummaries.add( id ) ;

				log( LOG_LEVEL.INFO, `Summary generated | model: ${ info.providerID }/${ info.modelID }` ) ;
			}

			return ;
		}

		if ( ! info.tokens || ! info.sessionID ) return ;

		const state = this.sessions.get( info.sessionID ) ?? { inProgress : false, lastCompactAt : 0 } ;

		state.usage = {
			tokens     : this.totalTokens( info ) ,
			providerID : info.providerID ?? "" ,
			modelID    : info.modelID ?? "" ,
		} ;

		this.sessions.set( info.sessionID, state ) ;
	}

	// ── Public hooks ──────────────────────────────────────────────────────

	// Route plugin events: usage tracking and idle evaluation
	public async handleEvent( event : { type : string; properties? : Record<string, any> } ) : Promise<void>
	{
		try
		{
			if ( event.type === "message.updated" )
			{
				this.onMessage( event.properties?.info ) ;
				return ;
			}

			if ( event.type === "session.idle" )
			{
				await this.evaluate( event.properties?.sessionID ) ;
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `event ${ event.type }: ${ ( err as Error ).message }` ) ;
		}
	}

	// Cleanup: clear all state
	public dispose() : void
	{
		this.sessions.clear() ;
		this.loggedSummaries.clear() ;
		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, build AutoCompact, register hooks
export default ( async ( ctx : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const ac = new AutoCompact( opts, ctx.client ) ;

	log( LOG_LEVEL.INFO, "Initialized" ) ;

	return {
		event : async ( { event } ) =>
		{
			await ac.handleEvent( event as { type : string; properties? : Record<string, any> } ) ;
		},

		// Cleanup: clear all state
		dispose : async () =>
		{
			ac.dispose() ;
		},
	} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
