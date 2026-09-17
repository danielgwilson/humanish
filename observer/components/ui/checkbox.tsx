import { Checkbox as BaseCheckbox } from "@base-ui-components/react/checkbox";
import { ReviewIcon } from "../review-icon";
import "@/styles/controls.css";

export function Checkbox({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <BaseCheckbox.Root className="observer-checkbox" aria-label={label} checked={checked} onCheckedChange={onCheckedChange}>
    <BaseCheckbox.Indicator><ReviewIcon name="check" /></BaseCheckbox.Indicator>
  </BaseCheckbox.Root>;
}
