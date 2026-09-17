import { Select as BaseSelect } from "@base-ui-components/react/select";
import { ChevronDown } from "lucide-react";
import { useFullscreenContainer } from "@/lib/use-fullscreen-container";
import { ReviewIcon } from "../review-icon";
import "@/styles/controls.css";

export interface SelectOption { value: string; label: string; }

/** Token-styled select with Base UI keyboard, typeahead and nested dismissal. */
export function Select({ label, value, options, onValueChange, disabled, describedBy }: {
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string | undefined;
}) {
  const fullscreen = useFullscreenContainer();
  return <BaseSelect.Root value={value} items={options} disabled={disabled ?? false}
    onValueChange={(next) => { if (next !== null) onValueChange(next); }}>
    <BaseSelect.Trigger className="observer-select" aria-label={label} aria-describedby={describedBy}>
      <BaseSelect.Value className="observer-select-value" />
      <BaseSelect.Icon className="observer-select-chevron"><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /></BaseSelect.Icon>
    </BaseSelect.Trigger>
    <BaseSelect.Portal {...(fullscreen ? { container: fullscreen } : {})}>
      <BaseSelect.Positioner className="observer-select-positioner" sideOffset={5} align="start" alignItemWithTrigger={false} collisionPadding={12}>
        <BaseSelect.Popup className="observer-select-popup" aria-label={label}>
          <BaseSelect.List className="observer-select-list" aria-label={label}>
            {options.map((option) => <BaseSelect.Item className="observer-select-option" key={option.value} value={option.value} data-value={option.value}>
              <BaseSelect.ItemIndicator className="observer-select-check"><ReviewIcon name="check" /></BaseSelect.ItemIndicator>
              <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
            </BaseSelect.Item>)}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>;
}
