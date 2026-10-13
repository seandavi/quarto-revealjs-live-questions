/** QR codes as inline SVG, from the bundled qrcode-generator (no CDN). */

import qrcode from "qrcode-generator";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A scalable SVG QR code: dark modules on a light quiet zone, regardless of
 * theme, because many scanners cannot read inverted codes.
 */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const size = n + margin * 2;

  let d = "";
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) d += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.dataset.lpText = text;
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#111");
  svg.append(bg, path);
  return svg;
}
