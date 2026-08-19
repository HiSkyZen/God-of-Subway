import { expect, test } from "bun:test";

test("mobile search controls keep a stable 320px hierarchy", async () => {
  const css = await Bun.file("src/client/polish.css").text();

  expect(css).toContain("@media(max-width:620px)");
  expect(css).toContain('grid-template-areas:"from" "swap" "to" "submit"');
  expect(css).toContain(".station-control{min-height:106px");
  expect(css).toContain("border-radius:24px");
  expect(css).toContain(".station-control>span{margin-bottom:7px");
  expect(css).toContain("font-size:28px!important");
  expect(css).toContain(".swap-button{grid-area:swap");
  expect(css).toContain("width:54px;height:54px");
  expect(css).toContain(".swap-button::before{content:none!important}");
  expect(css).toContain("transform:none!important");
  expect(css).toContain("border-radius:50%");

  expect(css).toContain(".time-step-group{display:contents}");
  expect(css).toContain("grid-template-columns:.72fr .9fr .9fr 1.55fr .9fr .9fr");
  expect(css).toContain("justify-content:stretch");
  expect(css).toContain("overflow:hidden");
  expect(css).toContain("min-width:0!important;width:100%!important");
  expect(css).not.toContain("grid-template-columns:36px 42px 42px 76px 42px 42px");

  expect(css).toContain(".app-header{display:block;position:relative");
  expect(css).toContain(".service-status{position:absolute;top:5px;right:0");
  expect(css).toContain(".header-actions{display:flex;width:100%;max-width:none");
  expect(css).toContain("@media(max-width:360px)");
  expect(css).toContain("@media(max-width:330px)");
});
