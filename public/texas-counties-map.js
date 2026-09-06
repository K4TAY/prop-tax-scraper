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
   * }} [options]
   */
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.options = options;
    this.available = new Set(options.availableSlugs || []);
    this.ready = new Set(options.readySlugs || []);
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

  setAvailability({ availableSlugs = [], readySlugs = [] } = {}) {
    this.available = new Set(availableSlugs);
    this.ready = new Set(readySlugs);
    if (!this.container) return;
    this.container.querySelectorAll(".tx-county").forEach((path) => {
      const slug = path.getAttribute("data-slug");
      path.classList.toggle("available", this.available.has(slug));
      path.classList.toggle("ready", this.ready.has(slug));
    });
  }

  render() {
    const data = this._data;
    if (!data || !this.container) return;
    this.container.innerHTML = "";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", data.viewBox || "0 0 900 840");
    svg.setAttribute("role", "img");
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

  _showTip(e, county) {
    if (!this._tip) return;
    const status = this.ready.has(county.slug)
      ? "scrape ready"
      : this.available.has(county.slug)
        ? "in catalog"
        : "no CAD source yet";
    this._tip.hidden = false;
    this._tip.innerHTML = `<strong>${county.name}</strong><span>${status}</span>`;
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
