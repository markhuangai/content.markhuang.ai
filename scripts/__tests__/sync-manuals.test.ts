import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncManuals } from "../sync-manuals.ts";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "manual-sync-test-"));
  await mkdir(join(root, "manuals"), { recursive: true });
  return root;
}

test("syncManuals writes an empty runtime manifest for an empty config", async () => {
  const root = await makeRoot();
  await writeFile(
    join(root, "manuals", "manifest.json"),
    JSON.stringify({ manuals: [] }),
  );

  const manifest = await syncManuals({ rootDir: root });

  assert.deepEqual(manifest, { manuals: [] });
  const output = JSON.parse(
    await readFile(join(root, "dist", "manuals", "manifest.json"), "utf-8"),
  );
  assert.deepEqual(output, { manuals: [] });
});

test("syncManuals compiles public wiki pages, links, and assets", async () => {
  const root = await makeRoot();
  const wiki = await mkdtemp(join(tmpdir(), "manual-wiki-fixture-"));
  await mkdir(join(wiki, "images"), { recursive: true });

  await writeFile(
    join(wiki, "Home.md"),
    [
      "# Home",
      "",
      "Read [[Quick|Quick Start]].",
      "",
      "![Logo](images/logo.png)",
      "",
      "```ts",
      "console.log('manual'); \\",
      "",
      "const config = { enabled: true };",
      "const glob = 'node_modules/**';",
      "```",
      "",
      "```text",
      "first",
      "",
      "second",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(wiki, "Quick Start.md"),
    "# Quick Start\n\nBack to [home](Home.md).\n",
  );
  await writeFile(join(wiki, "_Sidebar.md"), "[[Home]]\n");
  await writeFile(join(wiki, "images", "logo.png"), "fake image");
  await writeFile(
    join(root, "manuals", "manifest.json"),
    JSON.stringify({
      manuals: [
        {
          id: "demo",
          title: "Demo",
          description: "Demo manual",
          repo: "owner/demo",
          sections: [
            {
              title: "Introduction",
              pages: ["Home", "Quick Start"],
            },
          ],
        },
      ],
    }),
  );

  const manifest = await syncManuals({
    rootDir: root,
    cloneWiki: async () => wiki,
    now: () => "2026-05-11T00:00:00.000Z",
  });

  assert.equal(manifest.manuals[0].homeSlug, "home");
  assert.equal("published" in manifest.manuals[0], false);
  assert.deepEqual(
    manifest.manuals[0].pages.map((page) => page.slug),
    ["home", "quick-start"],
  );
  assert.deepEqual(manifest.manuals[0].sections, [
    {
      title: "Introduction",
      pages: [
        { slug: "home", title: "Home", sourcePath: "Home.md" },
        {
          slug: "quick-start",
          title: "Quick Start",
          sourcePath: "Quick Start.md",
        },
      ],
    },
  ]);
  assert.equal(manifest.manuals[0].updatedAt, "2026-05-11T00:00:00.000Z");

  const home = await readFile(
    join(root, "dist", "manuals", "demo", "home.mdx"),
    "utf-8",
  );
  assert.match(home, /\[Quick\]\(\/manuals\/demo\/quick-start\)/);
  assert.match(home, /__MANUAL_ASSET_BASE__\/images\/logo\.png/);
  assert.match(home, /<pre data-language="typescript"/);
  assert.match(home, /<span class="line">&#8203;<\/span>/);
  assert.match(home, /&#92;/);
  assert.match(home, /&#42;&#42;/);
  assert.match(home, /&#123; enabled:/);
  assert.match(home, /&#125;;/);
  assert.ok(
    existsSync(
      join(root, "dist", "manuals", "demo", "assets", "images", "logo.png"),
    ),
  );
  assert.equal(
    existsSync(join(root, "dist", "manuals", "demo", "_Sidebar.mdx")),
    false,
  );
});
