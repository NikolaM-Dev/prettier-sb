import { describe, it, expect } from "vitest";
import path from "node:path";

import { formatFile } from "../__shared__/lib";

describe("Frontmatter formatting", () => {
  it("matchs snapshot", async () => {
    const file = path.join(__dirname);
    const output = await formatFile(file );

    expect(output).toMatchSnapshot();
  });
});

