/**
 * Interactive Texas counties SVG map (vanilla JS).
 * Loads /geo/texas-counties.json and paints available counties from a Set of slugs.
 */
class TexasCountiesMap {
  /**
   * @param {string} containerId
   * @param {{
   *   onCountyClick?: (county: {name:string,slug:string,fips:string}) => void,
   *   availableSlugs?: Iterable<string>,
   *   readySlugs?: Iterable<string>,
   *   importedSlugs?: Iterable<string>,
   *   statsBySlug?: Record<string, {
   *     propertyCount?: number,
   *     uniqueParcelCount?: number,
   *     nullParcelIdCount?: number,
   *     unassignedCount?: number,
   *     neighborhoodCount?: number,
   *     pendingCsvCount?: number,
   *     importComplete?: boolean,
   *   }>,
   * }} [options]
   */
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.options = options;
    this.available = new Set(options.availableSlugs || []);
    this.ready = new Set(options.readySlugs || []);
    this.imported = new Set(options.importedSlugs || []);
    this.statsBySlug = options.statsBySlug || {};
    this._tip = null;
    this._data = null;
  }

  async load(url = "/geo/texas-counties.json") {
    if (!this.container) throw new Error(`Missing #${this.container?.id || "container"}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}`);
    this._data = await res.json();
    this.render();
    return this;
  }

  setAvailability({
    availableSlugs = [],
    readySlugs = [],
    importedSlugs = [],
    statsBySlug,
  } = {}) {
    this.available = new Set(availableSlugs);
    this.ready = new Set(readySlugs);
    this.imported = new Set(importedSlugs);
    if (statsBySlug) this.statsBySlug = statsBySlug;
    if (!this.container) return;
    this.container.querySelectorAll(".tx-county").forEach((path) => {
      const slug = path.getAttribute("data-slug");
      path.classList.toggle("available", this.available.has(slug));
      path.classList.toggle("ready", this.ready.has(slug));
      path.classList.toggle("imported", this.imported.has(slug));
    });
  }

  render() {
    const data = this._data;
    if (!data || !this.container) return;
    this.container.innerHTML = "";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", data.viewBox || "0 0 900 840");
    // Avoid role="img" — browsers/OS may show a large native image preview on hover.
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Texas counties map");
    svg.classList.add("tx-counties-svg");

    const tip = document.createElement("div");
    tip.className = "tx-map-tip";
    tip.hidden = true;
    this._tip = tip;

    for (const county of data.counties || []) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", county.path);
      path.setAttribute("data-slug", county.slug);
      path.setAttribute("data-name", county.name);
      path.setAttribute("data-fips", county.fips);
      path.classList.add("tx-county");
      if (this.available.has(county.slug)) path.classList.add("available");
      if (this.ready.has(county.slug)) path.classList.add("ready");
      if (this.imported.has(county.slug)) path.classList.add("imported");

      path.addEventListener("mouseenter", (e) => this._showTip(e, county));
      path.addEventListener("mousemove", (e) => this._moveTip(e));
      path.addEventListener("mouseleave", () => this._hideTip());
      path.addEventListener("click", () => {
        if (!this.available.has(county.slug)) return;
        this.options.onCountyClick?.(county);
      });

      svg.appendChild(path);
    }

    this.container.appendChild(svg);
    this.container.appendChild(tip);
  }

  _fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    return v.toLocaleString("en-US");
  }

  _statusLabel(slug) {
    if (this.imported.has(slug)) return "fully imported";
    if (this.ready.has(slug)) return "scrape ready";
    if (this.available.has(slug)) return "in catalog";
    return "no CAD source yet";
  }

  _statsLines(slug) {
    // Counties with no CAD source: tip is name + status only (no empty import stats).
    if (!this.available.has(slug)) return [];
    const s = this.statsBySlug[slug];
    if (!s) return ["No import data"];
    const props = Number(s.propertyCount) || 0;
    const unique = Number(s.uniqueParcelCount) || 0;
    const hoods = Number(s.neighborhoodCount) || 0;
    const pending = Number(s.pendingCsvCount) || 0;
    const unassigned = Number(s.unassignedCount) || 0;
    const lines = [
      `${this._fmt(unique)} unique parcels · ${this._fmt(props)} records · ${this._fmt(hoods)} neighborhoods`,
    ];
    if (unassigned > 0) {
      lines.push(`${this._fmt(unassigned)} unassigned`);
    } else if (props > 0) {
      lines.push("missing unassigned bucket");
    }
    if (pending > 0) lines.push(`${this._fmt(pending)} CSV${pending === 1 ? "" : "s"} pending import`);
    return lines;
  }

  _showTip(e, county) {
    if (!this._tip) return;
    this._tip.hidden = false;
    const stats = this._statsLines(county.slug)
      .map((line) => `<span>${line}</span>`)
      .join("");
    this._tip.innerHTML = `<strong>${county.name}</strong><span>${this._statusLabel(county.slug)}</span>${stats}`;
    this._moveTip(e);
  }

  _moveTip(e) {
    if (!this._tip || this._tip.hidden) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left + 12;
    const y = e.clientY - rect.top + 12;
    this._tip.style.left = `${x}px`;
    this._tip.style.top = `${y}px`;
  }

  _hideTip() {
    if (this._tip) this._tip.hidden = true;
  }
}

window.TexasCountiesMap = TexasCountiesMap;
