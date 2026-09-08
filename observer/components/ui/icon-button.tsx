import { Tooltip } from "@base-ui-components/react/tooltip";
import type { ComponentPropsWithRef, ReactNode } from "react";

export function IconButton({ label, hint = label, children, className = "", ...props }: Omit<ComponentPropsWithRef<"button">, "children"> & {
  label: string; hint?: string; children: ReactNode;
}) {
  return <Tooltip.Root disabled={!!props.disabled || (props["aria-haspopup"] === "dialog" && props["aria-expanded"] === true)}
    onOpenChange={(_open, details) => {
      // Dismissing a hint must not also navigate out of the player/monitor.
      if (details.reason === "escape-key") details.event.preventDefault();
    }}>
    <Tooltip.Trigger render={<button {...props} type="button" aria-label={label} className={`icon-button ${className}`} />}>
      {children}
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="bottom" sideOffset={6} className="observer-tooltip-positioner">
      <Tooltip.Popup className="observer-tooltip">{hint}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}
