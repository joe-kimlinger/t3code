import { describe, expect, it } from "vite-plus/test";

import { joinFolderPath, linkedFolderPathMentions } from "./linkedFolderMentions.logic";

describe("linkedFolderPathMentions", () => {
  it("resolves entries to absolute paths labelled by their folder", () => {
    expect(
      linkedFolderPathMentions([
        {
          folder: { path: "/work/api-wt/", name: "api" },
          entries: [
            { path: "src/server.ts", kind: "file" },
            { path: "README.md", kind: "file" },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "/work/api-wt/src/server.ts",
        kind: "file",
        label: "server.ts",
        description: "api/src",
      },
      { path: "/work/api-wt/README.md", kind: "file", label: "README.md", description: "api" },
    ]);
  });

  it("keeps a Windows folder's separator", () => {
    expect(joinFolderPath("C:\\work\\api", "src/server.ts")).toBe("C:\\work\\api\\src\\server.ts");
  });
});
