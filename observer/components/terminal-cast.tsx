export type TerminalLine =
  | { kind: "cmd"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "dim"; text: string }
  | { kind: "sum"; text: string; note?: string };

export default function TerminalCast({ lines }: { lines: TerminalLine[] }) {
  return (
    <div className="vterm">
      {lines.map((line, i) => {
        switch (line.kind) {
          case "cmd":
            return (
              <p className="vln vp" key={i}>{line.text}</p>
            );
          case "ok":
            return (
              <p className="vln" key={i}><span className="vok">ok</span>{"  " + line.text}</p>
            );
          case "dim":
            return (
              <p className="vln vdim" key={i}>{line.text}</p>
            );
          case "sum":
            return line.note ? (
              <p className="vln vsum" key={i}>{line.text + " "}<span className="vdim">{line.note}</span></p>
            ) : (
              <p className="vln vsum" key={i}>{line.text}</p>
            );
          default: {
            const exhausted: never = line;
            return exhausted;
          }
        }
      })}
    </div>
  );
}
