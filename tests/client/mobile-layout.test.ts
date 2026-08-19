import { expect, test } from "bun:test";

test("mobile search controls keep a stable 320px hierarchy", async () => {
  const css = await Bun.file("src/client/polish.css").text();

  expect(css).toContain("@media(max-width:620px)");
  expect(css).toContain('grid-template-areas:"from" "swap" "to" "submit"');
  expect(css).toContain(".swap-button{grid-area:swap");
  expect(css).toContain('content:"⇅"');
  expect(css).toContain("transform:none!important");
  expect(css).toContain("border-radius:50%");

  expect(css).toContain(".time-step-group{display:contents}");
  expect(css).toContain("grid-template-columns:36px 42px 42px 76px 42px 42px");
  expect(css).toContain("grid-template-columns:34px 37px 37px 68px 37px 37px");
  expect(css).toContain("min-width:0!important;width:auto!important");

  expect(css).toContain(".app-header{display:block;position:relative");
  expect(css).toContain(".service-status{position:absolute;top:5px;right:0");
  expect(css).toContain(".header-actions{display:flex;width:100%;max-width:none");
  expect(css).toContain("@media(max-width:360px)");
});
