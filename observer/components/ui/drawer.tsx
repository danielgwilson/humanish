import { Dialog } from "@base-ui-components/react/dialog";
import type { ReactNode } from "react";

// The first Base UI primitive in the tree (D6: adopt on first need — the need is the
// mobile run-library drawer). Base UI supplies what a hand-rolled panel silently
// lacks: focus trap, Escape, backdrop dismissal, and scroll lock. Styling is ours,
// via humanish tokens (.drawer-backdrop / .drawer-pop in globals.css); vendored
// shadcn-style so it can be promoted to the @humanish registry once the site or a
// second surface consumes it.
export function Drawer({
  open,
  onOpenChange,
  label,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="drawer-backdrop" />
        <Dialog.Popup className="drawer-pop" aria-label={label}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
