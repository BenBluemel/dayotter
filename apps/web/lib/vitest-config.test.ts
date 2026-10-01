import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import config from "../vitest.config";

it("maps the application @ alias to the absolute web root", () => {
  // Vite can normalize trailing slashes; assert the declared alias too so an
  // application import passing cannot conceal an incorrectly configured key.
  expect(config.resolve?.alias).toMatchObject({
    "@": fileURLToPath(new URL("../", import.meta.url)),
  });
});
