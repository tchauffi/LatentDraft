import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateField, type Extension, type Range } from "@codemirror/state";
import type { ProposedEdit } from "./api";

/**
 * Inline agent suggestions (from the Claude Design "LaTeX Editor" mock): a
 * pending edit is shown *in the editor* at the spot it applies to — the text
 * it would replace gets a red tint, and a purple-bordered card underneath
 * shows the replacement lines with Accept / Reject buttons. Kept in sync with
 * the chat pane's diff cards: both views act on the same edit ids.
 */

export interface SuggestionCallbacks {
  onAccept: (edit: ProposedEdit) => void;
  onReject: (edit: ProposedEdit) => void;
}

/**
 * Locate the unique occurrence of old_string. Returns null for whole-document
 * edits (empty old_string), missing text, or ambiguous matches — those cases
 * stay chat-card-only.
 */
export function locateSuggestion(
  doc: string,
  oldStr: string,
): { from: number; to: number } | null {
  if (oldStr.length === 0) return null;
  const first = doc.indexOf(oldStr);
  if (first === -1) return null;
  if (doc.indexOf(oldStr, first + oldStr.length) !== -1) return null;
  return { from: first, to: first + oldStr.length };
}

class SuggestionCardWidget extends WidgetType {
  constructor(
    private readonly edit: ProposedEdit,
    private readonly cb: SuggestionCallbacks,
  ) {
    super();
  }

  override eq(other: SuggestionCardWidget): boolean {
    return other.edit.id === this.edit.id && other.edit.new_string === this.edit.new_string;
  }

  override toDOM(): HTMLElement {
    const card = document.createElement("div");
    card.className = "cm-suggest-card";

    const head = document.createElement("div");
    head.className = "cm-suggest-head";
    const newLines = this.edit.new_string.split("\n");
    head.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 16 16" fill="var(--accent)"><path d="M8 0l1.6 4.9L14.5 6l-4.9 1.6L8 12.5 6.4 7.6 1.5 6l4.9-1.1z"/></svg>` +
      `<span class="cm-suggest-title">Agent suggests an edit</span>` +
      `<span class="cm-suggest-dot">·</span>` +
      `<span class="cm-suggest-sub"></span>`;
    head.querySelector(".cm-suggest-sub")!.textContent = this.edit.explanation
      ? this.edit.explanation
      : `${newLines.length} line${newLines.length === 1 ? "" : "s"}`;
    card.appendChild(head);

    const diff = document.createElement("div");
    diff.className = "cm-suggest-diff";
    for (const line of newLines) {
      const row = document.createElement("div");
      row.className = "cm-suggest-row";
      const sign = document.createElement("span");
      sign.className = "cm-suggest-sign";
      sign.textContent = "+";
      const code = document.createElement("span");
      code.className = "cm-suggest-code";
      code.textContent = line || " ";
      row.append(sign, code);
      diff.appendChild(row);
    }
    card.appendChild(diff);

    const actions = document.createElement("div");
    actions.className = "cm-suggest-actions";
    const accept = document.createElement("button");
    accept.className = "cm-suggest-accept";
    accept.textContent = "Accept";
    accept.onclick = (e) => {
      e.preventDefault();
      this.cb.onAccept(this.edit);
    };
    const reject = document.createElement("button");
    reject.className = "cm-suggest-reject";
    reject.textContent = "Reject";
    reject.onclick = (e) => {
      e.preventDefault();
      this.cb.onReject(this.edit);
    };
    actions.append(accept, reject);
    card.appendChild(actions);

    return card;
  }

  // Let clicks reach the buttons instead of being handled by the editor.
  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(
  doc: string,
  suggestions: ProposedEdit[],
  cb: SuggestionCallbacks,
  lineAt: (pos: number) => { from: number; to: number },
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const claimed: { from: number; to: number }[] = [];

  for (const edit of suggestions) {
    const loc = locateSuggestion(doc, edit.old_string);
    if (!loc) continue;
    // Two suggestions over the same text would produce overlapping block
    // widgets; show the first and leave the rest to the chat cards.
    if (claimed.some((c) => loc.from < c.to && c.from < loc.to)) continue;
    claimed.push(loc);

    // Red-tint every line the old text touches.
    let pos = lineAt(loc.from).from;
    while (pos <= loc.to) {
      const line = lineAt(pos);
      ranges.push(Decoration.line({ class: "cm-suggest-old" }).range(line.from));
      if (line.to >= doc.length) break;
      pos = line.to + 1;
    }

    // The card sits right below the affected lines.
    const anchor = lineAt(loc.to).to;
    ranges.push(
      Decoration.widget({
        widget: new SuggestionCardWidget(edit, cb),
        block: true,
        side: 1,
      }).range(anchor),
    );
  }

  return Decoration.set(
    ranges.sort((a, b) => a.from - b.from || (a.value.spec.block ? 1 : -1)),
    true,
  );
}

/**
 * Build the extension for a fixed list of pending suggestions. The caller
 * recreates it whenever the list changes (react-codemirror reconfigures);
 * in between, decorations map along with user edits.
 */
export function inlineSuggestions(
  suggestions: ProposedEdit[],
  cb: SuggestionCallbacks,
): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state.doc.toString(), suggestions, cb, (pos) => {
        const l = state.doc.lineAt(pos);
        return { from: l.from, to: l.to };
      });
    },
    update(deco, tr) {
      return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field];
}
