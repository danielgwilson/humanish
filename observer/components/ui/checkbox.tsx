import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { ReviewIcon } from "../review-icon";
import "@/styles/controls.css";

// Render inside a <label> with visible text. Base UI points aria-labelledby at that label,
// which names the checkbox; an aria-label here would be read twice.
export function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <BaseCheckbox.Root
      className="observer-checkbox"
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      <BaseCheckbox.Indicator>
        <ReviewIcon name="check" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
