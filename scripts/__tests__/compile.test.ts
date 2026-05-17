import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findMissingPublishedArticleFiles,
  getChangedSlugsMissingFromManifest,
  type ManifestEntry,
} from "../compile.ts";

function article(slug: string): ManifestEntry {
  return {
    slug,
    title: slug,
    description: slug,
    date: "2026-05-17",
    category: "ai-llms",
    tags: [],
    published: true,
    readTime: "1 min read",
    featured: false,
  };
}

test("getChangedSlugsMissingFromManifest reports changed files absent from manifest", () => {
  const missing = getChangedSlugsMissingFromManifest(
    { articles: [article("present")] },
    new Set(["missing", "present"]),
  );

  assert.deepEqual(missing, ["missing"]);
});

test("findMissingPublishedArticleFiles reports published entries without MDX files", async () => {
  const root = await mkdtemp(join(tmpdir(), "compile-test-"));
  const blogDir = join(root, "blog");
  await mkdir(join(blogDir, "ai-llms"), { recursive: true });
  await writeFile(join(blogDir, "ai-llms", "present.mdx"), "# Present\n");

  const missing = await findMissingPublishedArticleFiles(blogDir, [
    article("present"),
    article("missing"),
  ]);

  assert.deepEqual(missing, ["ai-llms/missing.mdx"]);
});
