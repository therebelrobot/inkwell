import { useEffect, useState } from "react";

/**
 * A row of ink symbols that floats just above the iPad's on-screen keyboard.
 * The software keyboard buries -> { } [ ] ~ # | behind two layers; ink uses
 * them on almost every line. Hidden when a hardware keyboard is in use
 * (no on-screen keyboard means the visual viewport isn't shrunk).
 */

interface SymbolBarProps {
  visible: boolean;
  onInsert: (text: string, cursorOffsetFromInsertStart?: number) => void;
}

const INK_SYMBOLS: { label: string; text: string; cursorOffset?: number; description: string }[] = [
  { label: "->", text: "-> ", description: "Divert" },
  { label: "*", text: "* ", description: "Choice" },
  { label: "+", text: "+ ", description: "Sticky choice" },
  { label: "-", text: "- ", description: "Gather" },
  { label: "[ ]", text: "[]", cursorOffset: 1, description: "Choice-only text" },
  { label: "{ }", text: "{}", cursorOffset: 1, description: "Logic or condition" },
  { label: "|", text: "|", description: "Alternative separator" },
  { label: "~", text: "~ ", description: "Logic line" },
  { label: "#", text: "#", description: "Tag" },
  { label: "===", text: "===  ===\n", cursorOffset: 4, description: "New knot" },
  { label: "=", text: "= ", description: "New stitch" },
  { label: "<>", text: "<>", description: "Glue" },
  { label: "->->", text: "->->", description: "Return from tunnel" },
  { label: "( )", text: "()", cursorOffset: 1, description: "Label" },
  { label: "\"", text: "\"", description: "Straight quote" },
];

export function SymbolBar({ visible, onInsert }: SymbolBarProps) {
  const [keyboardInsetPixels, setKeyboardInsetPixels] = useState(0);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;
    const updateInset = () => {
      setKeyboardInsetPixels(Math.max(0, window.innerHeight - (visualViewport.height + visualViewport.offsetTop)));
    };
    updateInset();
    visualViewport.addEventListener("resize", updateInset);
    visualViewport.addEventListener("scroll", updateInset);
    return () => {
      visualViewport.removeEventListener("resize", updateInset);
      visualViewport.removeEventListener("scroll", updateInset);
    };
  }, []);

  const softwareKeyboardIsOpen = keyboardInsetPixels > 80;
  if (!visible || !softwareKeyboardIsOpen) return null;

  return (
    <div className="symbol-bar" style={{ bottom: `${keyboardInsetPixels}px` }} role="toolbar" aria-label="Insert ink symbol">
      {INK_SYMBOLS.map((inkSymbol) => (
        <button
          key={inkSymbol.label}
          type="button"
          title={inkSymbol.description}
          aria-label={inkSymbol.description}
          // pointerdown + preventDefault keeps focus (and the keyboard) in the editor.
          onPointerDown={(pointerEvent) => {
            pointerEvent.preventDefault();
            onInsert(inkSymbol.text, inkSymbol.cursorOffset);
          }}
        >
          {inkSymbol.label}
        </button>
      ))}
    </div>
  );
}
