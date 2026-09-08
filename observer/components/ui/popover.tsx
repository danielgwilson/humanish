import { Popover as BasePopover } from "@base-ui-components/react/popover";
import type { ReactNode } from "react";

// Second Base UI primitive (D6): an anchored panel with outside-press and Escape
// dismissal, focus handling, and portal stacking supplied by Base UI. Styling is
// humanish tokens only. At phone width the same popup presents as a bottom sheet
// (the Frame.io iOS grammar: secondary controls live in a grabber-handled sheet)
// via the .pop-panel media override in globals.css — one component, two postures.
export function Popover({
  trigger,
  triggerClassName,
  label,
  children,
  open,
  onOpenChange
}: {
  trigger: ReactNode;
  triggerClassName: string;
  label: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <BasePopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <BasePopover.Trigger className={triggerClassName} aria-label={label}>
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner className="observer-popover-positioner" sideOffset={8} align="end">
          <BasePopover.Popup className="pop-panel" aria-label={label}>
            <span className="pop-grabber" aria-hidden="true" />
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
