import { Popover as BasePopover } from "@base-ui-components/react/popover";
import { IconButton } from "./icon-button";
import { ReviewIcon } from "../review-icon";
import type { ReactNode } from "react";

// Second Base UI primitive (D6): an anchored panel with outside-press and Escape
// dismissal, focus handling, and portal stacking supplied by Base UI. Styling is
// humanish tokens only. At phone width the same popup presents as a bottom sheet
// via the .pop-panel media override in globals.css. Both layouts provide an
// explicit close control; neither implies unsupported drag-to-dismiss behavior.
export function Popover({
  trigger,
  triggerClassName,
  label,
  children,
  open,
  onOpenChange,
  title = label
}: {
  trigger: ReactNode;
  triggerClassName: string;
  label: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
}) {
  return (
    <BasePopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <BasePopover.Trigger render={<IconButton label={label} hint={title} className={triggerClassName}>{trigger}</IconButton>}>
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner className="observer-popover-positioner" sideOffset={8} align="end">
          <BasePopover.Popup className="pop-panel" aria-label={label}>
            <div className="popover-heading"><BasePopover.Title>{title}</BasePopover.Title>
              <BasePopover.Close render={<IconButton label={`Close ${title.toLowerCase()}`}><ReviewIcon name="close" /></IconButton>} />
            </div>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
