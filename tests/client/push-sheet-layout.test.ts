import { expect, test } from "bun:test";

test("push and install sheets have a complete responsive layout", async () => {
  const css = await Bun.file("src/client/polish.css").text();

  expect(css).toContain(".sheet-backdrop{position:fixed;inset:0");
  expect(css).toContain(".push-sheet{width:min(100%,380px)");
  expect(css).toContain(".push-icon .bell-icon");
  expect(css).toContain(".push-sheet .secondary-button");
  expect(css).toContain(".push-sheet .error-copy");
  expect(css).toContain(".sheet-backdrop{align-items:flex-end;padding:0");
  expect(css).toContain("env(safe-area-inset-bottom)");
  expect(css).toContain("border-radius:22px 22px 0 0");
});
