/**
 * Sync configured public GitHub wikis into R2-ready manual content.
 *
 * Source:
 *   manuals/manifest.json
 *
 * Output:
 *   dist/manuals/manifest.json
 *   dist/manuals/{manualId}/{pageSlug}.mdx
 *   dist/manuals/{manualId}/assets/{assetPath}
 */

import { execFile as execFileCallback } from "child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

const execFile = promisify(execFileCallback);

const MANUAL_ASSET_BASE = "__MANUAL_ASSET_BASE__";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown"]);

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

const CODE_BLOCK_RE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gm;
const LANG_ALIASES: Record<string, BundledLanguage> = {
  js: "javascript",
  md: "markdown",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

export interface ManualConfig {
  id: string;
  title: string;
  description: string;
  repo: string;
  wikiUrl?: string;
  home?: string;
  order?: string[];
  tags?: string[];
}

interface ManualsSourceManifest {
  manuals: ManualConfig[];
}

export interface RuntimeManualPage {
  slug: string;
  title: string;
  sourcePath: string;
}

export interface RuntimeManual {
  id: string;
  title: string;
  description: string;
  repo: string;
  wikiUrl: string;
  homeSlug: string;
  tags: string[];
  updatedAt: string;
  pages: RuntimeManualPage[];
}

export interface RuntimeManualsManifest {
  manuals: RuntimeManual[];
}

interface PageDraft extends RuntimeManualPage {
  sourceFile: string;
  raw: string;
}

export interface SyncManualsOptions {
  rootDir: string;
  cloneWiki?: (manual: ManualConfig, tempDir: string) => Promise<string>;
  now?: () => string;
}

export async function syncManuals(options: SyncManualsOptions): Promise<RuntimeManualsManifest> {
  const rootDir = resolve(options.rootDir);
  const sourceManifest = await readSourceManifest(rootDir);
  const outputDir = join(rootDir, "dist", "manuals");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  if (sourceManifest.manuals.length === 0) {
    const manifest = { manuals: [] };
    await writeRuntimeManifest(outputDir, manifest);
    return manifest;
  }

  const highlighter = await createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: LANGS,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "manual-wikis-"));
  const cloneWiki = options.cloneWiki ?? clonePublicWiki;
  const manuals: RuntimeManual[] = [];

  try {
    for (const manual of sourceManifest.manuals) {
      validateManual(manual);
      const wikiDir = await cloneWiki(manual, tempDir);
      const runtimeManual = await syncManual(manual, wikiDir, outputDir, highlighter, options.now);
      manuals.push(runtimeManual);
      console.log(`  synced ${manual.id}: ${runtimeManual.pages.length} pages`);
    }
  } finally {
    highlighter.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }

  const manifest = { manuals };
  await writeRuntimeManifest(outputDir, manifest);
  return manifest;
}

async function readSourceManifest(rootDir: string): Promise<ManualsSourceManifest> {
  const manifestPath = join(rootDir, "manuals", "manifest.json");
  const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as ManualsSourceManifest;
  if (!Array.isArray(parsed.manuals)) {
    throw new Error("manuals/manifest.json must contain a manuals array");
  }
  return parsed;
}

async function writeRuntimeManifest(
  outputDir: string,
  manifest: RuntimeManualsManifest,
): Promise<void> {
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function validateManual(manual: ManualConfig): void {
  if (!SLUG_RE.test(manual.id)) {
    throw new Error(`manual id must be a URL-safe slug: ${manual.id}`);
  }
  if (!manual.title?.trim()) {
    throw new Error(`manual ${manual.id} is missing title`);
  }
  if (!manual.description?.trim()) {
    throw new Error(`manual ${manual.id} is missing description`);
  }
  if (!REPO_RE.test(manual.repo)) {
    throw new Error(`manual ${manual.id} repo must be owner/repo`);
  }
}

async function clonePublicWiki(manual: ManualConfig, tempDir: string): Promise<string> {
  const targetDir = join(tempDir, manual.id);
  const wikiGitUrl = `https://github.com/${manual.repo}.wiki.git`;
  try {
    await execFile("git", ["clone", "--depth", "1", wikiGitUrl, targetDir], {
      timeout: 60_000,
    });
    return targetDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to clone configured wiki ${wikiGitUrl}: ${msg}`);
  }
}

async function syncManual(
  manual: ManualConfig,
  wikiDir: string,
  outputDir: string,
  highlighter: Highlighter,
  now?: () => string,
): Promise<RuntimeManual> {
  const wikiFiles = await walkFiles(wikiDir);
  const markdownFiles = wikiFiles.filter(isManualPage);
  if (markdownFiles.length === 0) {
    throw new Error(`manual ${manual.id} wiki has no Markdown pages`);
  }

  const drafts = await loadPageDrafts(wikiDir, markdownFiles);
  const pageLookup = buildPageLookup(drafts);
  const orderedDrafts = orderPages(drafts, manual.order);
  const homeSlug = resolvePageRef(manual.home ?? "Home", pageLookup) ?? orderedDrafts[0]?.slug;

  if (!homeSlug) {
    throw new Error(`manual ${manual.id} has no home page`);
  }

  const manualOutputDir = join(outputDir, manual.id);
  await mkdir(manualOutputDir, { recursive: true });

  for (const assetFile of wikiFiles.filter((file) => !isMarkdownFile(file))) {
    await copyAsset(wikiDir, assetFile, manualOutputDir);
  }

  for (const page of orderedDrafts) {
    const rewritten = rewriteWikiContent(page.raw, manual.id, page.sourcePath, pageLookup);
    const highlighted = highlightCodeBlocks(rewritten, highlighter);
    await writeFile(join(manualOutputDir, `${page.slug}.mdx`), highlighted);
  }

  return {
    id: manual.id,
    title: manual.title,
    description: manual.description,
    repo: manual.repo,
    wikiUrl: manual.wikiUrl ?? `https://github.com/${manual.repo}/wiki`,
    homeSlug,
    tags: manual.tags ?? [],
    updatedAt: now ? now() : await getLastCommitDate(wikiDir),
    pages: orderedDrafts.map(({ slug, title, sourcePath }) => ({ slug, title, sourcePath })),
  };
}

async function loadPageDrafts(wikiDir: string, markdownFiles: string[]): Promise<PageDraft[]> {
  const drafts: PageDraft[] = [];
  const seenSlugs = new Set<string>();

  for (const sourceFile of markdownFiles) {
    const sourcePath = toPosix(relative(wikiDir, sourceFile));
    const nameWithoutExt = stripMarkdownExt(sourcePath);
    const slug = slugify(nameWithoutExt);
    if (seenSlugs.has(slug)) {
      throw new Error(`duplicate manual page slug ${slug}`);
    }
    seenSlugs.add(slug);

    const raw = await readFile(sourceFile, "utf-8");
    drafts.push({
      slug,
      title: extractTitle(raw) ?? titleFromPath(nameWithoutExt),
      sourcePath,
      sourceFile,
      raw,
    });
  }

  return drafts;
}

function buildPageLookup(pages: PageDraft[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const page of pages) {
    const keys = new Set([
      page.slug,
      slugify(stripMarkdownExt(page.sourcePath)),
      slugify(basename(stripMarkdownExt(page.sourcePath))),
      slugify(page.title),
    ]);
    for (const key of keys) {
      lookup.set(key, page.slug);
    }
  }
  return lookup;
}

function orderPages(pages: PageDraft[], order: string[] | undefined): PageDraft[] {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const ordered: PageDraft[] = [];
  const used = new Set<string>();

  for (const entry of order ?? []) {
    const slug = slugify(entry);
    const page = bySlug.get(slug);
    if (page && !used.has(page.slug)) {
      ordered.push(page);
      used.add(page.slug);
    }
  }

  const remaining = pages
    .filter((page) => !used.has(page.slug))
    .sort((a, b) => a.title.localeCompare(b.title));

  return [...ordered, ...remaining];
}

function rewriteWikiContent(
  content: string,
  manualId: string,
  sourcePath: string,
  pageLookup: Map<string, string>,
): string {
  const withWikiLinks = content.replace(/\[\[([^\]]+)\]\]/g, (_match, body: string) => {
    const parts = body.split("|").map((part) => part.trim());
    const label = parts.length > 1 ? parts[0] : parts[0];
    const target = parts.length > 1 ? parts[1] : parts[0];
    const href = manualHref(manualId, target, pageLookup);
    return href ? `[${label}](${href})` : label;
  });

  const withMarkdownLinks = withWikiLinks.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (match, bang: string, label: string, target: string) => {
      if (isExternalOrAnchor(target)) return match;

      if (bang) {
        const assetPath = normalizeRelativeAssetPath(target, sourcePath);
        return assetPath ? `![${label}](${MANUAL_ASSET_BASE}/${encodePath(assetPath)})` : match;
      }

      const href = manualHref(manualId, target, pageLookup);
      return href ? `[${label}](${href})` : match;
    },
  );

  return withMarkdownLinks.replace(
    /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (match, prefix: string, src: string, suffix: string) => {
      if (isExternalOrAnchor(src)) return match;
      const assetPath = normalizeRelativeAssetPath(src, sourcePath);
      return assetPath ? `${prefix}${MANUAL_ASSET_BASE}/${encodePath(assetPath)}${suffix}` : match;
    },
  );
}

function manualHref(
  manualId: string,
  rawTarget: string,
  pageLookup: Map<string, string>,
): string | null {
  const { path, hash } = splitHash(rawTarget);
  const slug = resolvePageRef(path, pageLookup);
  return slug ? `/manuals/${manualId}/${slug}${hash}` : null;
}

function resolvePageRef(rawRef: string, pageLookup: Map<string, string>): string | null {
  const { path } = splitHash(rawRef);
  const normalized = path
    .replace(/^\.?\//, "")
    .replace(/\\/g, "/")
    .replace(/^wiki\//, "");
  const withoutExt = stripMarkdownExt(decodeURIComponentSafe(normalized));
  return pageLookup.get(slugify(withoutExt)) ?? null;
}

function normalizeRelativeAssetPath(rawRef: string, sourcePath: string): string | null {
  const { path } = splitHash(rawRef);
  const cleanPath = path.split("?")[0] ?? path;
  const sourceDir = dirname(toPosix(sourcePath));
  const rel = sourceDir === "." ? cleanPath : posix.join(sourceDir, cleanPath);
  const normalized = posix.normalize(rel).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  return normalized;
}

function splitHash(rawRef: string): { path: string; hash: string } {
  const hashIndex = rawRef.indexOf("#");
  if (hashIndex < 0) return { path: rawRef, hash: "" };
  return {
    path: rawRef.slice(0, hashIndex),
    hash: rawRef.slice(hashIndex),
  };
}

function highlightCodeBlocks(mdx: string, highlighter: Highlighter): string {
  return mdx.replace(CODE_BLOCK_RE, (_match, lang: string, meta: string, code: string) => {
    if (lang === "mermaid") return _match;

    const trimmedMeta = meta.trim();
    const isPlayground = trimmedMeta.includes("playground");
    const normalizedLang = LANG_ALIASES[lang] ?? lang;
    const effectiveLang = LANGS.includes(normalizedLang as BundledLanguage)
      ? normalizedLang
      : "text";
    const trimmedCode = code.replace(/\n$/, "");

    const html = highlighter.codeToHtml(trimmedCode, {
      lang: effectiveLang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });

    let result = html.replace(
      /^<pre /,
      `<pre data-language="${effectiveLang}"${isPlayground ? ' data-playground="true"' : ""} `,
    );
    if (trimmedMeta) {
      result = result.replace(/^<pre /, `<pre data-meta="${escapeAttr(trimmedMeta)}" `);
    }
    return result;
  });
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function copyAsset(wikiDir: string, assetFile: string, manualOutputDir: string): Promise<void> {
  const rel = toPosix(relative(wikiDir, assetFile));
  if (rel.startsWith(".git/")) return;

  const outputPath = join(manualOutputDir, "assets", rel);
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(assetFile, outputPath);
}

async function getLastCommitDate(wikiDir: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", wikiDir, "log", "-1", "--format=%cI"], {
      timeout: 10_000,
    });
    const date = stdout.trim();
    if (date) return date;
  } catch {
    // Test fixtures and non-git source directories fall back to wall clock time.
  }
  return new Date().toISOString();
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === ".git" || entry === ".DS_Store" || entry.startsWith(".")) continue;
    const fullPath = join(root, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else if (info.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function isManualPage(file: string): boolean {
  return isMarkdownFile(file) && !basename(file).startsWith("_");
}

function isMarkdownFile(file: string): boolean {
  return MARKDOWN_EXTS.has(extname(file).toLowerCase());
}

function stripMarkdownExt(file: string): string {
  return MARKDOWN_EXTS.has(extname(file).toLowerCase()) ? file.slice(0, -extname(file).length) : file;
}

function extractTitle(raw: string): string | null {
  const match = raw.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[#*_`]/g, "").trim() : null;
}

function titleFromPath(path: string): string {
  return basename(path)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value: string): string {
  const slug = decodeURIComponentSafe(value)
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "page";
}

function isExternalOrAnchor(target: string): boolean {
  return (
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function main(): Promise<void> {
  const rootDir = resolve(import.meta.dirname, "..");
  console.log("Syncing manual wikis...");
  const manifest = await syncManuals({ rootDir });
  console.log(`Synced ${manifest.manuals.length} manuals`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
