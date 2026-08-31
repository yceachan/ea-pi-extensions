import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWslBrowserTool } from "../src/tool.ts";

/**
 * Register only the lifecycle tool. Browser/controller resources are created
 * lazily from a tool call, never while Pi is loading extensions.
 */
export default function piWslBrowserExtension(pi: ExtensionAPI): void {
	const runtime = registerWslBrowserTool(pi);

	pi.on("session_start", (_event, ctx) => {
		runtime.sessionStart(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => runtime.agentSettled(ctx));
	pi.on("session_shutdown", (_event, ctx) => runtime.sessionShutdown(ctx));
}
