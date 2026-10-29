'use strict';
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII=';
// A 2x descriptor requires a twice-wide image; a 1px image reports zero CSS
// naturalWidth at higher device scale factors after density correction.
const pixel2x = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMQdTf9D8IMMAYAMvoGQaV7RfIAAAAASUVORK5CYII=';
const index = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/css/site.css"><script defer src="assets/js/site.js"></script></head><body data-page="index"><h1>ZIP website home</h1><nav><a id="about" href="pages/about.html?from=home#details">About page</a> <a id="same" href="#anchor">Same-page anchor</a> <a id="outside" href="../../outside.html">Outside</a> <a id="external" href="https://blocked.invalid/">External</a> <a id="invented" href="https://blocked.invalid/" data-soduwork-preview-path="site/pages/about.html" data-soduwork-preview-fragment="details">Invented marker</a></nav><img id="responsive" src="assets/images/pixel.png" srcset="assets/images/pixel.png 1x, assets/images/pixel@2x.png 2x"><div class="hero">CSS background image</div><p id="script-state">Awaiting script</p><div style="height:1000px"></div><section id="anchor">Same-page target</section></body></html>';
const about = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../assets/css/site.css"><script defer src="../assets/js/site.js"></script></head><body data-page="about"><h1>ZIP website about</h1><a id="back" href="../index.html#anchor">Back home</a><img id="responsive" src="../assets/images/pixel.png" srcset="../assets/images/pixel.png 1x, ../assets/images/pixel@2x.png 2x"><p id="script-state">Awaiting script</p><div style="height:1000px"></div><section id="details">About details target</section></body></html>';
const definitions = [
  ['site/index.html', 'text/html', index],
  ['site/pages/about.html', 'text/html', about],
  ['site/assets/css/site.css', 'text/css', '@import "./palette.css";body{margin:0;padding:24px;font:18px system-ui;background:rgb(21,71,53);color:white}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:white;padding:8px;display:inline-block}.hero{height:30px;background-image:url("../images/pixel.png")}img{width:32px;height:32px}'],
  ['site/assets/css/palette.css', 'text/css', 'h1{letter-spacing:2px}#script-state{font-weight:700}'],
  ['site/assets/js/site.js', 'text/javascript', 'window.siteFixture=document.body.dataset.page;document.querySelector("#script-state").textContent="Static JS loaded";try{parent.document.body.dataset.siteLeak="yes"}catch(e){window.parentBlocked=true}'],
  ['site/assets/images/pixel.png', 'image/png', pixel, true],
  ['site/assets/images/pixel@2x.png', 'image/png', pixel2x, true],
  ['site/handbook.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Office fixture; must require a user system-open action'],
  ['.DS_Store', 'application/octet-stream', 'metadata'],
  ['__MACOSX/._site', 'application/octet-stream', 'metadata'],
];
module.exports = { definitions, index, about };
