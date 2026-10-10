/** Pi's renderer resolver contract; do not shadow it with a guessed wrapper API. */
import type {
	ExtensionAPI,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";

export type StockToolRenderers = ToolRenderers;
export type ToolRendererWrapper = ToolRendererResolver;

// Pi 1.1 does not re-export ToolRenderContext. Derive it from the public renderer
// contract so changes to the host's rendering context are still typechecked.
type HostRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export type ToolRenderContext<TState = unknown, TArgs = unknown> =
	Omit<HostRenderContext, "state" | "args"> & { state: TState; args: TArgs };

export function tryRegisterToolRenderer(
	pi: ExtensionAPI,
	wrap: ToolRendererWrapper,
): boolean {
	if (typeof pi.registerToolRenderer !== "function") return false;
	pi.registerToolRenderer(wrap);
	return true;
}
