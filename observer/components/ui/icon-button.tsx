import { Tooltip } from "@base-ui-components/react/tooltip";
import { useId, useState, type ComponentPropsWithRef, type ReactNode } from "react";

export function IconButton({ label, hint = label, children, className = "", ...props }: Omit<ComponentPropsWithRef<"button">, "children"> & {
  label: string; hint?: string; children: ReactNode;
}) {
  const hintId = useId();
  const [hintOpen, setHintOpen] = useState(false);
  return <Tooltip.Root disabled={!!props.disabled || (props["aria-haspopup"] === "dialog" && props["aria-expanded"] === true)}
    onOpenChange={(open, details) => {
      setHintOpen(open);
      // Dismissing a hint must not also navigate out of the player/monitor.
      if (details.reason === "escape-key") details.event.preventDefault();
    }}>
    <Tooltip.Trigger render={<button {...props} type="button" aria-label={label} aria-describedby={[props["aria-describedby"], hintOpen ? hintId : null].filter(Boolean).join(" ") || undefined} className={`icon-button ${className}`} />}>
      {children}
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="bottom" sideOffset={6} className="observer-tooltip-positioner">
      <Tooltip.Popup id={hintId} className="observer-tooltip" role="tooltip">{hint}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}
