import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { docsSource } from "@/lib/docs-source";
import { Ish } from "@/components/wordmark";
import ThemeToggle from "@/components/theme-toggle";

export default function DocumentationLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <div className="humanish-docs">
        <DocsLayout
          tree={docsSource.pageTree}
          nav={{ title: <span className="wm">human<Ish /></span>, url: "/" }}
          githubUrl="https://github.com/danielgwilson/humanish"
          links={[
            { text: "Docs", url: "/docs", active: "nested-url" },
            { text: "Known limits", url: "/failure-modes" },
            { type: "custom", secondary: true, children: <ThemeToggle /> }
          ]}
          themeSwitch={{ enabled: false }}
          sidebar={{ collapsible: false }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
