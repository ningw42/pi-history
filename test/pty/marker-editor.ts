import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class MarkerEditor extends CustomEditor {
	override handleInput(data: string): void {
		if (matchesKey(data, "ctrl+t")) this.insertTextAtCursor("[marker]");
		else super.handleInput(data);
	}

	override render(width: number): string[] {
		return [...super.render(width), "marker editor"];
	}
}

export default function markerEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keys) => new MarkerEditor(tui, theme, keys));
	});
}
