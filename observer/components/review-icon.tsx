import {
  Activity,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Grid2X2,
  Info,
  Maximize,
  MessageSquarePlus,
  Minimize,
  Moon,
  PanelLeft,
  Pause,
  Pin,
  Play,
  SlidersHorizontal,
  StepBack,
  StepForward,
  Sun,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

const icons = {
  activity: Activity,
  bookmark: Bookmark,
  check: Check,
  previous: ChevronLeft,
  next: ChevronRight,
  compare: Columns2,
  grid: Grid2X2,
  info: Info,
  fullscreen: Maximize,
  "exit-fullscreen": Minimize,
  moon: Moon,
  note: MessageSquarePlus,
  library: PanelLeft,
  pause: Pause,
  pin: Pin,
  play: Play,
  options: SlidersHorizontal,
  "previous-frame": StepBack,
  "next-frame": StepForward,
  speaker: Volume2,
  "speaker-off": VolumeX,
  sun: Sun,
  close: X,
};
export function ReviewIcon({ name, className }: { name: keyof typeof icons; className?: string }) {
  const Icon = icons[name];
  return (
    <Icon size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" className={className} />
  );
}
