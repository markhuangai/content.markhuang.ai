/**
 * Compile MDX articles by pre-highlighting fenced code blocks with shiki.
 *
 * Usage:
 *   npm run compile                              # compile all published articles
 *   npm run compile:changed -- slug1 slug2       # compile only specified slugs
 *
 * Output:
 *   dist/manifest.json        — flat array of published article metadata
 *   dist/articles/{slug}.mdx  — MDX with shiki-highlighted code blocks
 *
 * The frontend (r2-content.ts) fetches these from R2 at ISR time.
 */

import { access, readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { fileURLToPath } from "url";

// Same languages as the old frontend rehypeShikiPlugin
const LANGS: BundledLanguage[] = [
  "go",
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "sh",
  "json",
  "yaml",
  "toml",
  "sql",
  "markdown",
  "css",
  "html",
  "rust",
  "dockerfile",
  "text",
];

export interface ManifestEntry {
  slug: string;
  title: string;
  description: string;
  date: string;
  category: string;
  categoryLabel?: string;
  tags: string[];
  published: boolean;
  image?: string | null;
  readTime: string;
  featured: boolean;
  excludeFromFeatured?: boolean;
}

export interface ManifestFile {
  articles: ManifestEntry[];
}

// Match fenced code blocks: ```lang meta\n...\n```
// Captures: [1] language, [2] meta (optional), [3] code body
const CODE_BLOCK_RE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gm;

/**
 * Replace fenced code blocks with shiki-highlighted HTML.
 * Mermaid blocks are left untouched (frontend renders them client-side).
 */
function highlightCodeBlocks(mdx: string, highlighter: Highlighter): string {
  return mdx.replace(CODE_BLOCK_RE, (_match, lang: string, meta: string, code: string) => {
    // Mermaid blocks are rendered client-side — leave as fenced code
    if (lang === "mermaid") {
      return _match;
    }

    const trimmedMeta = meta.trim();
    const isPlayground = trimmedMeta.includes("playground");

    // Fall back to "text" for unsupported languages
    const effectiveLang = LANGS.includes(lang as BundledLanguage) ? lang : "text";

    // Remove trailing newline from code (shiki adds its own)
    const trimmedCode = code.replace(/\n$/, "");

    const html = highlighter.codeToHtml(trimmedCode, {
      lang: effectiveLang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });

    // Inject data-language and optional data-playground into the <pre> tag
    // shiki outputs: <pre class="shiki ..." ...>
    let result = escapeMdxJsxText(html).replace(
      /^<pre /,
      `<pre data-language="${effectiveLang}"${isPlayground ? ' data-playground="true"' : ""} `,
    );

    // Inject data-meta if there was meta text (e.g. "playground")
    if (trimmedMeta) {
      result = result.replace(/^<pre /, `<pre data-meta="${escapeAttr(trimmedMeta)}" `);
    }

    return result;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMdxJsxText(html: string): string {
  return html
    .replace(
      /<span class="line"><span(?: [^>]*)?><\/span><\/span>/g,
      '<span class="line">&#8203;</span>',
    )
    .replace(/<span class="line"><\/span>/g, '<span class="line">&#8203;</span>')
    .replace(/\\/g, "&#92;")
    .replace(/\*/g, "&#42;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");
}

export function getChangedSlugsMissingFromManifest(
  manifestFile: ManifestFile,
  changedSlugs: Set<string> | null,
): string[] {
  if (!changedSlugs) {
    return [];
  }

  const manifestSlugs = new Set(manifestFile.articles.map((article) => article.slug));
  return [...changedSlugs].filter((slug) => !manifestSlugs.has(slug)).sort();
}

export async function findMissingPublishedArticleFiles(
  blogDir: string,
  published: ManifestEntry[],
): Promise<string[]> {
  const missing: string[] = [];

  for (const article of published) {
    const mdxPath = join(blogDir, article.category, `${article.slug}.mdx`);
    try {
      await access(mdxPath);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        missing.push(`${article.category}/${article.slug}.mdx`);
        continue;
      }
      throw err;
    }
  }

  return missing;
}

async function main() {
  const rootDir = resolve(import.meta.dirname, "..");
  const blogDir = join(rootDir, "blog");
  const distDir = join(rootDir, "dist");

  // Parse arguments
  const args = process.argv.slice(2);
  const changedIdx = args.indexOf("--changed");
  const changedSlugs = changedIdx >= 0 ? new Set(args.slice(changedIdx + 1)) : null;

  // Read source manifest
  const manifestFile: ManifestFile = JSON.parse(
    await readFile(join(blogDir, "manifest.json"), "utf-8"),
  );
  const published = manifestFile.articles.filter((a) => a.published);

  const missingChangedSlugs = getChangedSlugsMissingFromManifest(manifestFile, changedSlugs);
  if (missingChangedSlugs.length > 0) {
    throw new Error(
      `Changed article files are missing from blog/manifest.json: ${missingChangedSlugs.join(", ")}`,
    );
  }

  const missingFiles = await findMissingPublishedArticleFiles(blogDir, published);
  if (missingFiles.length > 0) {
    throw new Error(
      `Published manifest entries are missing article files:\n${missingFiles
        .map((file) => `  - blog/${file}`)
        .join("\n")}`,
    );
  }

  // Determine which articles to compile
  const toCompile = changedSlugs
    ? published.filter((a) => changedSlugs.has(a.slug))
    : published;

  if (toCompile.length === 0) {
    console.log("No articles to compile");
    // Still write manifest even if no articles changed
    await mkdir(join(distDir, "articles"), { recursive: true });
    await writeFile(join(distDir, "manifest.json"), JSON.stringify(published, null, 2));
    console.log(`Wrote manifest with ${published.length} entries`);
    return;
  }

  // Initialize shiki
  console.log("Initializing shiki highlighter...");
  const highlighter = await createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: LANGS,
  });

  // Create output directories
  await mkdir(join(distDir, "articles"), { recursive: true });

  // Compile articles
  let compiled = 0;
  const errors: string[] = [];

  for (const article of toCompile) {
    const mdxPath = join(blogDir, article.category, `${article.slug}.mdx`);
    const outPath = join(distDir, "articles", `${article.slug}.mdx`);

    try {
      const raw = await readFile(mdxPath, "utf-8");
      const highlighted = highlightCodeBlocks(raw, highlighter);
      await writeFile(outPath, highlighted);
      compiled++;
      console.log(`  ✓ ${article.category}/${article.slug}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${article.slug}: ${msg}`);
      console.error(`  ✗ ${article.category}/${article.slug}: ${msg}`);
    }
  }

  // Always write the full manifest (all published articles)
  await writeFile(join(distDir, "manifest.json"), JSON.stringify(published, null, 2));

  highlighter.dispose();

  console.log(`\nCompiled ${compiled}/${toCompile.length} articles`);
  console.log(`Manifest: ${published.length} published entries`);

  if (errors.length > 0) {
    console.error(`\nErrors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
