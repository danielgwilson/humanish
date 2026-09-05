import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { docsSource } from "@/lib/docs-source";
import { getMDXComponents } from "@/components/docs/mdx";

type Props = { params: Promise<{ slug?: string[] }> };

export default async function DocumentationPage({ params }: Props) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();
  const Content = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody><Content components={getMDXComponents()} /></DocsBody>
      <a className="docs-edit" href={`https://github.com/danielgwilson/humanish/blob/main/site/content/docs/${page.path}`}>
        Edit this page on GitHub
      </a>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = docsSource.getPage((await params).slug);
  if (!page) notFound();
  const title = `${page.data.title} · Humanish docs`;
  const description = page.data.description;
  const url = `https://humanish.dev${page.url}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url },
    twitter: { title, description }
  };
}
