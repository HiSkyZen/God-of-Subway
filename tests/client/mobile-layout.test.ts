import { expect, test } from "bun:test";

test("mobile search controls keep a stable 320px hierarchy", async () => {
  const css = await Bun.file("src/client/polish.css").text();

  expect(css).toContain("@media(max-width:620px)");
  expect(css).toContain('grid-template-areas:"from" "swap" "to" "submit"');
  expect(css).toContain(".swap-button{grid-area:swap");
  expect(css).toContain("transform:rotate(90deg)");

  expect(css).toContain(".time-step-group{display:contents}");
  expect(css).toContain("grid-template-columns:minmax(28px,auto) minmax(30px,auto) minmax(30px,auto) minmax(76px,1fr) minmax(30px,auto) minmax(30px,auto)");
  expect(css).toContain("grid-column:auto!important;grid-row:auto!important;height:40px!important");

  expect(css).toContain(".app-header{display:block;position:relative");
  expect(css).toContain(".service-status{position:absolute;top:5px;right:0");
  expect(css).toContain(".header-actions{display:flex;width:100%;max-width:none");
  expect(css).toContain("@media(max-width:360px)");
});
