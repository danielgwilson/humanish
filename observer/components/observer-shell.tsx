import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import type { HistoryIndex } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import type { LibraryLayout } from "@/lib/use-library-layout";
import { Sidebar, type StudyLibrary } from "./sidebar";
import { Topbar } from "./topbar";
import { Drawer } from "./ui/drawer";

/**
 * The frame around every study view: the skip link, the top bar, the study library as a static
 * sidebar or a phone drawer, and the main column (`children`). Monitoring hides the static
 * sidebar. A pick in the drawer closes it.
 */
export function ObserverShell({
  layout,
  data,
  history,
  library,
  updating,
  monitoring,
  onRuns,
  onSkip,
  reviewControl,
  status,
  children,
}: {
  /** From useLibraryLayout, which the page calls before it has data. */
  layout: LibraryLayout;
  data: ObserverData;
  history: HistoryIndex | null;
  library: StudyLibrary | undefined;
  updating: boolean;
  monitoring: boolean;
  /** Shows the participants grid of this study. */
  onRuns: () => void;
  /** Moves focus to the evidence, past the top bar and the library. */
  onSkip: () => void;
  reviewControl: ReactNode;
  status: ReactNode;
  children: ReactNode;
}) {
  const studyLabel = library?.entries.find((entry) => entry.runId === data.run.runId)?.title;
  return (
    <Tooltip.Provider delay={350}>
      <div className={`observer-shell${monitoring ? " monitoring" : ""}`}>
        <a
          className="skip-observer"
          href="#observer-content"
          onClick={(event) => {
            event.preventDefault();
            onSkip();
          }}
        >
          Skip to evidence
        </a>
        <Topbar
          data={data}
          onLibrary={layout.toggle}
          sideOpen={layout.phone ? layout.drawerOpen : layout.sideOpen}
          reviewControl={reviewControl}
          {...(studyLabel ? { studyLabel } : {})}
          status={status}
        />
        <div className="frame">
          {!layout.phone && !monitoring ? (
            <Sidebar
              collapsed={!layout.sideOpen}
              data={data}
              history={history}
              onRuns={onRuns}
              updating={updating}
              {...(library ? { library } : {})}
            />
          ) : null}
          <Drawer
            open={layout.drawerOpen}
            onOpenChange={layout.setDrawerOpen}
            label="Study library"
          >
            <Sidebar
              data={data}
              history={history}
              onRuns={() => {
                onRuns();
                layout.setDrawerOpen(false);
              }}
              updating={updating}
              {...(library
                ? {
                    library: {
                      ...library,
                      onSelect: (id: string) => {
                        library.onSelect(id);
                        layout.setDrawerOpen(false);
                      },
                    },
                  }
                : {})}
            />
          </Drawer>
          <div className="main">{children}</div>
        </div>
      </div>
    </Tooltip.Provider>
  );
}
