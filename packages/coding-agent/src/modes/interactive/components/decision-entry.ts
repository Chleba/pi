import type { Component } from "@earendil-works/pi-tui";
import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { DecisionEntry } from "../../../core/session-manager.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a decision log entry with collapsed/expanded state.
 * Shows the agent's plan, expected outcome, actual result, and outcome status.
 * Inspired by the Schema harness's immutable Timeline.
 */
export class DecisionEntryComponent extends Box implements Component {
	private expanded = false;
	private entry: DecisionEntry;
	private markdownTheme: MarkdownTheme;

	constructor(entry: DecisionEntry, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.entry = entry;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.updateDisplay();
		}
	}

	invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const outcomeLabel = this.entry.outcome ? ` [${this.entry.outcome}]` : " [pending]";
		const label = theme.fg("warning", `\x1b[1m[decision]${outcomeLabel}\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const lines: string[] = [];

			lines.push(`**${this.entry.label}**`);
			lines.push("");
			lines.push(`**Plan:** ${this.entry.plan.slice(0, 500)}`);

			if (this.entry.expected !== this.entry.plan) {
				lines.push(`**Expected:** ${this.entry.expected.slice(0, 500)}`);
			}

			if (this.entry.actual) {
				lines.push(`**Actual:** ${this.entry.actual.slice(0, 500)}`);
			}

			if (this.entry.revision) {
				lines.push("");
				lines.push(`**Revision:**`);
				lines.push(this.entry.revision.slice(0, 1000));
			}

			this.addChild(
				new Markdown(lines.join("\n"), 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const planPreview = this.entry.plan.slice(0, 80);
			this.addChild(
				new Text(
					theme.fg("customMessageText", planPreview) +
						" (" +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
