// Margin front end: joins Wowhead recipe data with the addon's AH scan.
const WH = "https://www.wowhead.com/forever";
const ICON = (name) => `https://wow.zamimg.com/images/wow/icons/medium/${name && name !== "temp" ? name : "inv_misc_questionmark"}.jpg`;
const QUALITY = ["poor", "common", "uncommon", "rare", "epic", "legendary"];
const qColor = (q) => `var(--q-${QUALITY[q] ?? "common"})`;
const PAGE = 100;
const FEW = 3;               // fewer listed than this and one seller sets the price
const STALE_H = 24;          // scans older than this get a warning

const FAV = "__fav";         // the Favorites entry in the profession list
// Modern AH deposit: this share of the item's vendor sell price per auction length (hours).
const DEPOSIT_RATE = { 12: 0.15, 24: 0.3, 48: 0.6 };

function loadSaved(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

const state = {
  recipes: [], items: {}, byProduct: {}, profCounts: {}, ranks: {},
  prices: null, realmKey: null, pricesMtime: -1, history: null,
  profession: null,
  make: new Map(),           // recipe id -> how many to craft, for the shopping list
  favs: new Set(loadSaved("cf-favs", [])),   // starred recipe ids, kept in the visitor's browser
  cfFavs: new Set(),         // the ones starred in /cf (the local site only: the server reads them)
  recipeItems: {},           // recipe id -> [item that teaches it, vendor sells it, its sell price, BoP]
  recipeBuy: {},             // what you've seen recipe items cost at vendors (the local site only)
  levelSrc: "trainer,boe",   // where the leveling path may get recipes from, as in /cf
  view: "recipes",           // or "level", the cheapest leveling path for the chosen profession
  levelMode: "vendor",       // what the leveling path does with leftover results: vendor, de or ah
  sort: { key: "profit", dir: -1 },
  shown: PAGE, open: new Set(),
};
const $ = (id) => document.getElementById(id);
const opts = () => ({
  basis: $("basis").value,
  cut: Math.max(0, Number(String($("cut").value).replace(",", ".")) || 0),
  craftMats: $("craftMats").checked,
  onlyProfit: $("onlyProfit").checked,
  showUnpriced: $("showUnpriced").checked,
  hideFew: $("hideFew").checked,
  trainerOnly: $("trainerOnly").checked,
  marginMode: $("marginMode").value,
  marginPct: Number(String($("marginPct").value).replace(",", ".")),
  deposit: $("deposit").checked ? DEPOSIT_RATE[$("duration").value] : 0,
  q: $("search").value.trim().toLowerCase(),
});
const isFew = (x) => x.qty > 0 && x.qty < FEW && !x.viaVendor;
// Sold on the AH with fewer than MIN_LISTED auctions up: one listing isn't a price, so these
// recipes are left out of the list and the top cards (auctions, or units for older scans).
const MIN_LISTED = 2;
function tooThin(x) {
  if (x.viaVendor || x.sell == null || !x.r.creates) return false;
  const p = realm()?.prices[x.r.creates[0]];
  return !!p && (p[3] ?? p[2]) < MIN_LISTED;
}

// Wowhead source 6 = trainer. Recipes it lists only as drop/vendor/quest are "not trainer";
// many WoW Forever recipes have no source at all, and those count as learnable.
const isTrainer = (r) => !r.source?.length || r.source.includes(6) || !!r.trainingcost;
const isFav = (id) => state.favs.has(id) || state.cfFavs.has(id);
const favCount = () => new Set([...state.favs, ...state.cfFavs]).size;

// What learning a recipe costs, and where (the same as /cf, which also counts ones you know as
// free; the site can't tell which you know): the trainer's fee; for a BoE recipe item, that item
// from the AH or a vendor; a BoP one (or one from a quest, a drop or reputation) you earn
// yourself, so it's free. src is the set of sources allowed. null when it can't be had that way.
const RECIPE_SOURCES = { trainer: "Trainer", boe: "BoE", bop: "BoP" };
function learnCost(r, o, src) {
  if (isTrainer(r)) return src.has("trainer") ? { cost: r.trainingcost || 0, how: "trainer" } : null;
  const ri = state.recipeItems[r.id];
  if (!ri) return src.has("bop") ? { cost: 0, how: "bop" } : null;
  const [item, vendor, sell, bop] = ri;
  if (bop) return src.has("bop") ? { cost: 0, how: "bop", item } : null;
  if (!src.has("boe")) return null;
  let best = ahPrice(item, o), how = "ah";
  if (vendor) {
    // a vendor's price: what you saw it for, else Classic's usual 4x what a vendor pays for it
    const seen = state.recipeBuy[item];
    const each = seen ?? (sell > 0 ? Math.round(sell * 4 * vendorFactor()) : null);
    if (each != null && (best == null || each < best)) { best = each; how = "vendor"; }
  }
  return best == null ? null : { cost: best, how, item };
}

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function money(value) {
  if (value == null || !isFinite(value)) return `<span class="money muted">—</span>`;
  const v = Math.round(value), a = Math.abs(v);
  const g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), c = a % 100;
  let out = v < 0 ? `<span class="minus">−</span>` : "";
  if (g) out += `<span>${g.toLocaleString("en-US")}<span class="u ug">g</span></span>`;
  if (s) out += `<span>${s}<span class="u us">s</span></span>`;
  if (c || a === 0) out += `<span>${c}<span class="u uc">c</span></span>`;
  return `<span class="money">${out}</span>`;
}

const pct = (m) => (m == null ? "" : (m > 0 ? "+" : "") + m + "%");

function scanTime(t) {
  const d = new Date(t * 1000), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

// ---------------------------------------------------------------- pricing

function realm() { return state.prices?.realms?.[state.realmKey] || null; }

function ahPrice(id, o) {
  const p = realm()?.prices[id];
  if (!p) return null;
  return o.basis === "min" ? p[0] : p[1];
}

// Vendor prices are Wowhead's base prices, with the Bartering talent and reputation discounts taken off.
const BARTER = 0.1;
const vendorFactor = () => (1 - ($("barter").checked ? BARTER : 0)) * (1 - Number($("repDiscount").value) / 100);
function vendorPrice(id) {
  const it = state.items[id];
  return it && it.vendor && it.buy ? Math.round(it.buy * vendorFactor()) : null;
}

// Cheapest way to obtain one unit of an item: AH, vendor, or (optionally) crafting it.
function makeBuyResolver(o, scarce = null) {
  const memo = new Map(), visiting = new Set();
  function resolve(id) {
    if (memo.has(id)) return memo.get(id);
    let best = null;
    const ah = scarce?.get(id) ?? ahPrice(id, o), vend = vendorPrice(id);
    if (ah != null) best = { price: ah, src: "AH" };
    if (vend != null && (!best || vend < best.price)) best = { price: vend, src: "Vendor" };
    if (o.craftMats && !visiting.has(id) && state.byProduct[id]) {
      visiting.add(id);
      for (const r of state.byProduct[id]) {
        const c = recipeCost(r, resolve);
        if (c.complete && (!best || c.total / r.creates[1] < best.price)) {
          best = { price: c.total / r.creates[1], src: "Craft", recipe: r };
        }
      }
      visiting.delete(id);
    }
    if (!visiting.size) memo.set(id, best);   // don't cache results cut short by a cycle
    return best;
  }
  return resolve;
}

function recipeCost(r, resolve) {
  let total = 0, complete = true;
  const parts = r.reagents.map(([id, n]) => {
    const b = resolve(id);
    if (!b) complete = false; else total += b.price * n;
    return { id, n, buy: b };
  });
  return { total, complete, parts };
}

// sell = gross sale value, fee = AH cut on it, profit = sell − fee − cost
function evaluate(r, o, resolve) {
  const cost = recipeCost(r, resolve);
  const row = { r, cost, qty: null, sold: null, sell: null, fee: 0, deposit: 0, profit: null, margin: null, viaVendor: false };
  if (!r.creates) return row;   // enchants and other recipes that don't make an item
  const [pid, yieldN] = r.creates;
  const p = realm()?.prices[pid];
  row.qty = p ? p[2] : realm() ? 0 : null;
  row.sold = soldPerDay(pid);
  const ah = ahPrice(pid, o);
  const vendorSell = (state.items[pid]?.sell || 0) * yieldN;
  if (ah != null) {
    row.sell = ah * yieldN;
    row.fee = Math.round(row.sell * o.cut / 100);
    row.deposit = Math.round(vendorSell * o.deposit);
  }
  if (vendorSell && (row.sell == null || vendorSell > row.sell - row.fee - row.deposit)) {
    row.sell = vendorSell; row.fee = 0; row.deposit = 0; row.viaVendor = true;
  }
  if (row.sell != null && cost.complete) {
    row.profit = row.sell - row.fee - row.deposit - cost.total;
    row.margin = cost.total > 0 ? Math.round(row.profit / cost.total * 100) : null;
  }
  return row;
}

function evaluateAll(o) {
  const resolve = makeBuyResolver(o);
  return state.recipes.map((r) => evaluate(r, o, resolve));
}

// ---------------------------------------------------------------- rendering

function matches(r, q) {
  if (!q) return true;
  if (r.name.toLowerCase().includes(q)) return true;
  if (r.creates && (state.items[r.creates[0]]?.name || "").toLowerCase().includes(q)) return true;
  return r.reagents.some(([id]) => (state.items[id]?.name || "").toLowerCase().includes(q));
}

const SORT = {
  profit: (x) => x.profit, name: (x) => x.r.name, margin: (x) => x.margin,
  sell: (x) => x.sell, cost: (x) => (x.cost.complete ? x.cost.total : null), qty: (x) => x.qty,
  sold: (x) => x.sold,
};

function render() {
  const o = opts();
  const all = evaluateAll(o).filter((x) => !tooThin(x) || isFav(x.r.id));
  const top = renderCards(all.filter((x) => x.profit != null));

  // without a scan nothing has a price, so list every recipe rather than an empty table
  const showUnpriced = o.showUnpriced || !realm();
  const inView = state.profession === FAV ? (r) => isFav(r.id)
    : (r) => !state.profession || r.profession === state.profession;
  let rows = all.filter((x) => (showUnpriced || x.profit != null || isFav(x.r.id)) &&
    inView(x.r) && matches(x.r, o.q));
  if (o.onlyProfit) rows = rows.filter((x) => x.profit > 0);
  if (o.trainerOnly) rows = rows.filter((x) => isTrainer(x.r));
  if (o.hideFew) rows = rows.filter((x) => !isFew(x));
  // the Margin filter, as in /cf: at least or at most a percentage (no margin, no match)
  if (o.marginMode !== "any" && $("marginPct").value.trim() !== "" && isFinite(o.marginPct)) {
    rows = rows.filter((x) => x.margin != null && (o.marginMode === "min" ? x.margin >= o.marginPct : x.margin <= o.marginPct));
  }
  writeURL();
  const key = SORT[state.sort.key], dir = state.sort.dir;
  rows.sort((a, b) => {
    const fa = isFav(a.r.id), fb = isFav(b.r.id);
    if (fa !== fb) return fa ? -1 : 1;   // starred recipes stay on top
    const ka = key(a), kb = key(b);
    if (ka == null && kb == null) return a.r.profession.localeCompare(b.r.profession) || (a.r.skill ?? 0) - (b.r.skill ?? 0);
    if (ka == null) return 1;
    if (kb == null) return -1;
    return (typeof ka === "string" ? ka.localeCompare(kb) : ka - kb) * dir || (b.profit ?? 0) - (a.profit ?? 0);
  });
  // ranked by profit, the top three are the cells above, so the table goes on from rank 4
  const rank = new Map(rows.map((x, i) => [x.r.id, i + 1]));
  if (state.sort.key === "profit" && dir < 0 && state.profession !== FAV) {
    const shown = new Set(top.map((x) => x.r.id));
    rows = rows.filter((x) => !shown.has(x.r.id));
  }

  const html = [];
  const visible = rows.slice(0, state.shown);
  visible.forEach((x, i) => {
    const r = x.r, open = state.open.has(r.id);
    const product = r.creates ? state.items[r.creates[0]] : null;
    const qc = qColor(product ? product.quality : 1);
    html.push(`<div class="row${open ? " open" : ""}" data-id="${r.id}">
      <div class="rank">${rank.get(r.id)}</div>
      <div class="recipe">
        <a class="icon-link" href="${WH}/${r.creates ? "item=" + r.creates[0] : "spell=" + r.id}" target="_blank" rel="noopener" data-tip="recipe:${r.id}" aria-label="${esc(r.name)} on Wowhead"><img class="row-icon" src="${ICON(product?.icon || r.icon)}" alt="" loading="lazy" style="--q:${qc}"></a>
        <span class="recipe-name" role="button" tabindex="0" aria-expanded="${open}" style="color:${qc}">${esc(r.name)}</span>
        ${r.creates && r.creates[1] !== 1 ? `<span class="recipe-n">×${r.creates[1]}</span>` : ""}
        <span class="recipe-meta">${esc(r.profession)} · ${r.skill ?? "?"}</span>
      </div>
      <div class="num cell-mono${isFew(x) ? " few" : ""}" title="${isFew(x) ? `Only ${x.qty} listed: one seller sets this price, so it may not hold` : ""}">${x.qty ?? ""}</div>
      <div class="num cell-mono muted">${fmtSold(x.sold)}</div>
      <div class="num cell-sm" title="${x.viaVendor ? "Selling to a vendor pays more than the AH" : ""}">${money(x.sell)}${x.viaVendor && realm() ? `<div class="tag-line">vendor</div>` : ""}</div>
      <div class="num cell-sm muted">${money(x.cost.complete ? x.cost.total : null)}</div>
      <div class="num cell-mono muted">${pct(x.margin)}</div>
      <div class="num ${x.profit == null ? "muted" : x.profit > 0 ? "p-pos" : "p-neg"}">${money(x.profit)}</div>
      <button type="button" class="fav${isFav(r.id) ? " on" : ""}" data-fav="${r.id}" aria-label="${isFav(r.id) ? "Remove from" : "Add to"} favorites" aria-pressed="${isFav(r.id)}">★</button>
    </div>`);
    if (open) html.push(detail(x, o));
  });
  $("rows").innerHTML = html.join("") ||
    `<div class="empty">${state.profession === FAV && !favCount() ? "Star a recipe with ★ to keep it here."
      : realm() ? "No priced recipes match these filters in this scan." : "Scan the Auction House in game to see profits."}</div>`;


  const left = rows.length - visible.length;
  $("more").innerHTML = rows.length
    ? `<span>${visible.length.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} recipes</span>` +
      (left > 0 ? `<button id="moreBtn" type="button">Show ${Math.min(PAGE, left)} more</button>` : "")
    : "";
  if (left > 0) $("moreBtn").onclick = () => { state.shown += PAGE; render(); };

  document.querySelectorAll("#thead button").forEach((b) => {
    const on = b.dataset.sort === state.sort.key;
    b.classList.toggle("on", on);
    b.textContent = b.textContent.replace(/ [▾▴]$/, "") + (on ? (state.sort.dir < 0 ? " ▾" : " ▴") : "");
  });
  renderView(all);
}

// Top 3 positive-profit recipes, ignoring sidebar filters.
function renderCards(all) {
  const top = all.filter((x) => x.profit > 0 && !tooThin(x)).sort((a, b) => b.profit - a.profit).slice(0, 3);
  const box = $("cards");
  if (!top.length) {
    box.innerHTML = `<div class="empty-card">${realm() ? "Nothing is profitable with the current settings." : "No scan yet."}</div>`;
    return top;
  }
  const stat = (label, value, cls = "") => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value${cls}">${value}</span></div>`;
  box.innerHTML = top.map((x, i) => {
    const it = state.items[x.r.creates[0]] || {};
    return `<div class="card">
      <div class="card-head">
        <span class="badge${i === 0 ? " first" : ""}">${i + 1}</span>
        <a class="icon-link" href="${WH}/item=${x.r.creates[0]}" target="_blank" rel="noopener" data-tip="recipe:${x.r.id}" aria-label="${esc(x.r.name)} on Wowhead"><img class="card-icon" src="${ICON(it.icon)}" alt=""></a>
        <div class="card-title">
          <a class="card-name" href="${WH}/item=${x.r.creates[0]}" target="_blank" rel="noopener" style="color:${qColor(it.quality)}">${esc(x.r.name)}</a>
          <span class="card-prof">${esc(x.r.profession)}</span>
        </div>
      </div>
      <div class="card-profit">${money(x.profit)}</div>
      <div class="stats">${stat("On AH", x.qty ?? "—", isFew(x) ? " few" : "")}${stat("Sold/day", fmtSold(x.sold) || "—")}${stat("Margin", pct(x.margin) || "—")}</div>
    </div>`;
  }).join("");
  return top;
}

function detail(x, o) {
  const n = state.make.get(x.r.id) || 1;
  return `<div class="detail" data-detail="${x.r.id}">
    <div class="shop-bar">Make <input class="cut-input" data-make="${x.r.id}" type="text" inputmode="numeric" value="${n}" aria-label="How many to craft">
      <span class="muted">${x.r.creates ? `= <span class="mono">${fmtN(n * x.r.creates[1])}</span> ${esc(state.items[x.r.creates[0]]?.name || "")}` : ""}</span>
      <button type="button" class="copy-btn" data-copy="${x.r.id}">Copy shopping list</button></div>
    <div class="detail-body">${detailBody(x, o, n)}</div>
  </div>`;
}

const fmtN = (v) => (Math.round(v * 10) / 10).toLocaleString("en-US");

// Reagent lines and totals for crafting the recipe n times.
function detailBody(x, o, n) {
  const lines = x.cost.parts.map(({ id, n: per, buy }) => {
    const it = state.items[id] || {};
    const via = buy?.recipe ? ` · ${esc(buy.recipe.name)}` : "";
    return `<div class="reagent">
      <a href="${WH}/item=${id}" target="_blank" rel="noopener" data-tip="item:${id}" style="color:${qColor(it.quality)}">
        <img src="${ICON(it.icon)}" alt="" loading="lazy" style="--q:${qColor(it.quality)}">
        <span class="nm">${esc(it.name || "Item " + id)}</span><span class="muted mono">×${fmtN(per * n)}</span></a>
      <span class="src${buy ? "" : " missing"}" title="${buy ? esc(buy.src + via) : ""}">${buy ? buy.src : "No price"}</span>
      <span class="num">${buy ? money(buy.price) : money(null)}</span>
      <span class="num">${buy ? money(buy.price * per * n) : ""}</span>
    </div>`;
  }).join("");
  let totals = "";
  if (x.cost.complete || x.sell != null) {
    totals = `<div class="totals">
      <span class="muted">Cost${n > 1 ? ` ×${n}` : ""}</span><span class="num">${money(x.cost.complete ? x.cost.total * n : null)}</span>
      ${x.sell != null ? `<span class="muted">Sells for${n > 1 ? ` ×${n}` : ""}${x.fee ? `, after ${o.cut}% AH cut` : ""}${x.deposit ? " and deposit" : ""}</span><span class="num">${money((x.sell - x.fee - x.deposit) * n)}</span>` : ""}
      ${x.profit != null ? `<span class="muted">Profit</span><span class="num ${x.profit > 0 ? "p-pos" : "p-neg"}">${money(x.profit * n)}</span>` : ""}
    </div>`;
  }
  const trend = x.r.creates ? trendHTML(x.r.creates[0], 160) : "";
  const notes = [];
  if (!x.r.creates) notes.push("This recipe doesn't create an item (e.g. an enchant), so there's nothing to sell.");
  else if (!realm()) notes.push("No scan yet, so reagents only have vendor prices.");
  else if (x.viaVendor) notes.push("Sells for more at a vendor than on the AH, so the vendor price is used.");
  else if (x.deposit) notes.push(`Deposit ${money(x.deposit)} per craft is counted as lost; you get it back if it sells.`);
  else if (x.sell != null) notes.push("AH deposit not included.");
  if (x.sold != null) notes.push(`Sells about ${fmtSold(x.sold)} a day (estimated from your scans).`);
  if (isFew(x)) notes.push(`<span class="few">Only ${x.qty} listed, so this price may not hold.</span>`);
  if (x.r.trainingcost) notes.push(`Trainer cost ${money(x.r.trainingcost)}.`);
  return `${lines}${totals}
    ${trend ? `<div class="trend"><span class="muted">Price, last 14 days</span>${trend}</div>` : ""}
    <div class="detail-note">${notes.join(" ")} <a href="${WH}/spell=${x.r.id}" target="_blank" rel="noopener">Recipe on Wowhead ↗</a></div>`;
}

function shoppingText(x, n) {
  const name = (id) => state.items[id]?.name || "Item " + id;
  const out = [`${x.r.name} ×${n}`];
  for (const { id, n: per, buy } of x.cost.parts) {
    out.push(`${fmtN(per * n)}× ${name(id)}${buy ? ` (${buy.src}, ${plainMoney(buy.price * per * n)})` : ""}`);
  }
  if (x.cost.complete) out.push(`Total: ${plainMoney(x.cost.total * n)}`);
  return out.join("\n");
}

function plainMoney(v) {
  const a = Math.round(Math.abs(v)), g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), c = a % 100;
  return (v < 0 ? "-" : "") + [g && `${g}g`, s && `${s}s`, (c || !a) && `${c}c`].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- price history

// history.json: { realm: { t: [scan times], p: { itemId: [market price per scan, 0 = not listed] } } }
function series(id, days = 14) {
  const h = state.history?.[state.realmKey];
  const arr = h?.p[id];
  if (!arr) return [];
  const since = h.t[h.t.length - 1] - days * 86400;
  return h.t.map((t, i) => [t, arr[i]]).filter(([t, v]) => v > 0 && t >= since);
}

// Units sold per day over the last week: listings that vanished between scans before they
// could have expired, divided by the hours those scans covered. null until there's a pair of scans.
function soldPerDay(id, days = 7) {
  const h = state.history?.[state.realmKey];
  if (!h?.g) return null;
  const since = h.t[h.t.length - 1] - days * 86400, arr = h.s?.[id];
  let hours = 0, units = 0;
  h.t.forEach((t, i) => {
    if (t < since || !h.g[i]) return;
    hours += h.g[i];
    units += arr?.[i] || 0;
  });
  return hours >= 1 ? units / hours * 24 : null;
}
const fmtSold = (v) => (v == null ? "" : v === 0 ? "0" : v < 1 ? "<1" : v < 10 ? fmtN(v) : Math.round(v).toLocaleString("en-US"));

// Current market price against the average of the earlier scans in the last 7 days.
function weekChange(id) {
  const pts = series(id, 7);
  if (pts.length < 2) return null;
  const now = pts[pts.length - 1][1];
  const before = pts.slice(0, -1).reduce((a, [, v]) => a + v, 0) / (pts.length - 1);
  return Math.round((now - before) / before * 100);
}

function trendHTML(id, w = 120) {
  const pts = series(id);
  if (pts.length < 2) return "";
  const h = 26, t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const vs = pts.map(([, v]) => v), lo = Math.min(...vs), hi = Math.max(...vs);
  const xy = pts.map(([t, v]) => [
    ((t - t0) / (t1 - t0 || 1)) * w,
    hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4),
  ]);
  const last = xy[xy.length - 1];
  const ch = weekChange(id);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5"/></svg>` +
    (ch == null ? "" : `<span class="mono ${ch > 0 ? "up" : ch < 0 ? "down" : "muted"}" title="Now vs. the average of the past 7 days">${pct(ch) || "0%"} 7d</span>`);
}

// ---------------------------------------------------------------- leveling path

// Chance a craft gives a skill point: orange always, yellow and green fall off linearly to grey.
function skillChance(r, s) {
  const [, yellow, , grey] = r.colors;
  if (s >= grey) return 0;
  return s < yellow ? 1 : (grey - s) / (grey - yellow);
}

// Classic disenchanting, as expected units per disenchant. Uncommon rows by highest item level:
// [dust, dust qty, essence, essence qty, shard]; armor gives 75% dust / 20% essence / 5% shard,
// weapons swap dust and essence.
// Greens: [up to item level, [dust id, lo, hi], [essence id, lo, hi], [shard id, chance] | null, essence chance]
// (weapons swap the dust and essence chances). The addon's Core.lua has the same table.
const GREEN_DE = [
  [15, [10940, 1, 2], [10938, 1, 2], null, 0.20],
  [20, [10940, 2, 3], [10939, 1, 2], [10978, 0.05], 0.20],
  [25, [10940, 4, 6], [10998, 1, 2], [10978, 0.10], 0.15],
  [30, [11083, 1, 2], [11082, 1, 2], [11084, 0.05], 0.20],
  [35, [11083, 2, 5], [11134, 1, 2], [11138, 0.05], 0.20],
  [40, [11137, 1, 2], [11135, 1, 2], [11139, 0.05], 0.20],
  [45, [11137, 2, 5], [11174, 1, 2], [11177, 0.05], 0.20],
  [50, [11176, 1, 2], [11175, 1, 2], [11178, 0.05], 0.20],
  [55, [11176, 2, 5], [16202, 1, 2], [14343, 0.05], 0.20],
  [60, [16204, 1, 2], [16203, 1, 2], [14344, 0.05], 0.20],
  [Infinity, [16204, 2, 5], [16203, 2, 3], [14344, 0.05], 0.20],
];
// blues: one shard (the top bracket has a small chance at a Nexus Crystal)
const BLUE_DE = [[25, 10978], [30, 11084], [35, 11138], [40, 11139], [45, 11177], [50, 11178], [55, 14343], [Infinity, 14344]];
// purples: [up to item level, id, lo, hi]
const PURPLE_DE = [[45, 11177, 2, 4], [50, 11178, 2, 4], [55, 14343, 2, 4], [60, 20725, 1, 1], [Infinity, 20725, 1, 2]];

// [[material id, expected units], ...] from disenchanting one item, or null if it can't be.
function deMats(id) {
  const it = state.items[id];
  if (!it?.de || !it.ilvl || it.ilvl < 5 || it.quality < 2) return null;
  const row = (t) => t.find((x) => it.ilvl <= x[0]);
  if (it.quality === 2) {
    const [, dust, ess, shard, essP] = row(GREEN_DE);
    const sp = shard ? shard[1] : 0;
    let pd = 1 - sp - essP, pe = essP;
    if (it.de === "weapon") [pd, pe] = [pe, pd];
    return [[dust[0], pd * (dust[1] + dust[2]) / 2], [ess[0], pe * (ess[1] + ess[2]) / 2], ...(shard ? [[shard[0], sp]] : [])];
  }
  if (it.quality === 3) {
    const r = row(BLUE_DE);
    return r[0] === Infinity ? [[r[1], 0.995], [20725, 0.005]] : [[r[1], 1]];
  }
  if (it.ilvl < 40) return null;
  const [, mat, lo, hi] = row(PURPLE_DE);
  return [[mat, (lo + hi) / 2]];
}

// What one unit of a leftover result is worth: vendored, disenchanted or sold on the AH.
// Disenchanting or the AH never count for less than the vendor price, which is always there.
const RESULT_MODES = { vendor: "Vendor them", de: "Disenchant them", ah: "Sell them on the AH" };
// On the AH, a result only counts at its AH price when there's a real market for it: at least
// AH_MIN_AUCTIONS listed (units, for scans from before the addon counted auctions), and a price
// no more than AH_MAX_MARKUP times what it costs to make, since more is usually one odd listing.
const AH_MIN_AUCTIONS = 4, AH_MAX_MARKUP = 10;
function ahTrusted(id, value, unitCost) {
  const p = realm()?.prices[id];
  if (!p || (p[3] ?? p[2]) < AH_MIN_AUCTIONS) return false;
  return !(unitCost > 0 && value > unitCost * AH_MAX_MARKUP);
}

function resultValue(id, o, mode, unitCost = 0) {
  const vend = state.items[id]?.sell || 0;
  const net = (v) => v * (1 - o.cut / 100);
  if (mode === "ah") {
    const p = ahPrice(id, o);
    return p != null && ahTrusted(id, net(p), unitCost) ? Math.max(vend, net(p)) : vend;
  }
  if (mode === "de") {
    const mats = deMats(id);
    if (mats) return Math.max(vend, net(mats.reduce((a, [m, q]) => a + (ahPrice(m, o) ?? 0) * q, 0)));
  }
  return vend;
}

// For each skill point from..to-1, the learnable recipe with the lowest expected cost per point:
// material cost minus what the result is worth, divided by the skill-up chance. A result that a
// later step needs as a reagent is worth what it would otherwise cost to get. Which results are
// needed depends on the path, so it's worked out a few times, each time with what the one before
// needed (the first never counts on reuse, so the best can only get better).
//
// Recipes are picked by price per unit, but the AH only has so many of anything. So once a path is
// worked out, materials it needs more of than are listed get a scarcity price (what's listed at
// its real price, the rest at SCARCE_PENALTY times the dearest listing) and it's all worked out
// again, so recipes that lean on them lose out where something else will do. Paths are ranked the
// same way, so one that needs materials nobody is selling can't win on a made-up price.
const MIN_CHANCE = 0.1, SCARCE_PENALTY = 10, SCARCE_ROUNDS = 4;
function levelPath(prof, from, to, o, mode, src) {
  const real = makeBuyResolver(o), scarce = new Map();
  let best = null;
  for (let round = 0; round < SCARCE_ROUNDS; round++) {
    const resolve = round ? makeBuyResolver(o, scarce) : real;
    let roundBest = null;
    for (const plan of reusePasses(prof, from, to, o, mode, resolve, real, src)) {
      if (!roundBest || plan.score < roundBest.score) roundBest = plan;
    }
    if (!best || roundBest.score < best.score) best = roundBest;
    let changed = false;
    for (const [id, short] of roundBest.short) {
      const price = scarcePrice(id, roundBest.bought.get(id), short, o);
      if (price > (scarce.get(id) || 0)) { scarce.set(id, price); changed = true; }
    }
    if (!changed) break;
  }
  best.resolve = real;
  // the trainer ranks the range needs: Apprentice to start, then one each time it passes a cap
  const ranks = state.ranks[prof] || [];
  best.rankUps = ranks.filter((k, i) => (i === 0 ? from <= 1 : from <= ranks[i - 1].cap && to > ranks[i - 1].cap))
    .map((k) => ({ ...k, at: ranks[ranks.indexOf(k) - 1]?.cap ?? from }));
  const rankFees = best.rankUps.reduce((a, k) => a + k.cost, 0);
  best.fees += rankFees; best.net += rankFees;
  return best;
}

// What one unit of id effectively costs when n are needed and short of them aren't listed.
function scarcePrice(id, n, short, o) {
  const steps = ladderOf(id, ahPrice(id, o) ?? 0);
  const top = steps.length ? steps[steps.length - 2] : 0;
  let left = n - short, cost = 0;
  for (let i = 0; i < steps.length && left > 0; i += 2) {
    const t = Math.min(steps[i + 1], left);
    cost += t * steps[i]; left -= t;
  }
  return (cost + short * top * SCARCE_PENALTY) / n;
}

function* reusePasses(prof, from, to, o, mode, resolve, real, src) {
  const caps = new Set((state.ranks[prof] || []).map((k) => k.cap));   // a new step starts after each
  const cands = state.recipes.filter((r) => r.profession === prof && r.colors && (!o.trainerOnly || isTrainer(r)))
    .map((r) => {
      const pid = r.creates?.[0];
      const yieldN = r.creates?.[1] || 0, cost = recipeCost(r, resolve);
      const learn = learnCost(r, o, src);   // null: not from an allowed source
      if (!cost.complete || !learn) return null;
      const unitCost = recipeCost(r, real).total / yieldN;
      // learning it is paid once: per skill point over the part of the range it can cover
      const span = Math.max(1, Math.min(to, r.colors[3]) - Math.max(from, r.skill ?? 0));
      return { r, pid, yieldN, cost, value: pid ? resultValue(pid, o, mode, unitCost) : 0,
        learn: learn.cost, learnHow: learn.how, learnItem: learn.item, learnPer: learn.cost / span };
    })
    .filter(Boolean);

  let demand = new Map();
  for (let pass = 0; pass < 6; pass++) {
    const made = new Map(), steps = [];
    for (let s = from; s < to; s++) {
      // When results can be worth more than they cost (disenchanting, the AH), a recipe that rarely
      // gives a point looks great per point because it's mostly crafted for profit; skip those below
      // MIN_CHANCE unless nothing else is left.
      let best = null, bestPer = Infinity, low = null, lowPer = Infinity;
      for (const c of cands) {
        if ((c.r.skill ?? 0) > s) continue;
        const p = skillChance(c.r, s);
        if (p <= 0) continue;
        let unit = c.value;
        if (c.pid && (demand.get(c.pid) || 0) > (made.get(c.pid) || 0)) unit = Math.max(unit, resolve(c.pid)?.price ?? 0);
        const per = (c.cost.total - unit * c.yieldN) / p + c.learnPer;
        if (mode !== "vendor" && p < MIN_CHANCE) { if (per < lowPer) { low = c; lowPer = per; } }
        else if (per < bestPer) { best = c; bestPer = per; }
      }
      best ??= low;
      const crafts = best ? 1 / skillChance(best.r, s) : 0;
      if (best?.pid) made.set(best.pid, (made.get(best.pid) || 0) + crafts * best.yieldN);
      const last = steps[steps.length - 1];
      if (last && last.c === best && !caps.has(s)) { last.to = s + 1; last.crafts += crafts; }
      else steps.push({ from: s, to: s + 1, c: best, crafts });
    }
    // a bought recipe was charged its price spread over every point it could give; charge it
    // over the points it actually got, so the next pass can drop one that only covers a few
    const used = new Map();
    for (const st of steps) if (st.c?.learn > 0) used.set(st.c, (used.get(st.c) || 0) + st.to - st.from);
    let raised = false;
    for (const [c, pts] of used) {
      const per = c.learn / pts;
      if (per > c.learnPer * 1.01) { c.learnPer = per; raised = true; }
    }
    const next = new Map();
    for (const st of steps) {
      if (st.c) for (const [id, n] of st.c.r.reagents) next.set(id, (next.get(id) || 0) + n * Math.ceil(st.crafts));
    }
    yield walkPath(steps, o, mode, resolve);
    const settled = next.size === demand.size && [...next].every(([k, v]) => demand.get(k) === v);
    demand = next;
    if (settled && !raised) break;
  }
}

// The AH's price steps for an item, cheapest first, as [price, count, price, count, ...]. Items
// without steps (all at about one price, or a scan from before the addon saved them) are one step
// at the usual price.
function ladderOf(id, price) {
  const d = realm()?.depth?.[id];
  if (d) return d;
  const p = realm()?.prices[id];
  return p ? [price, p[2]] : [];
}

// Buys in bulk: each call costs the next n units, carrying on up the AH listings from where earlier
// calls stopped. A unit never costs more than the vendor sells it for, and units beyond what the AH
// has are priced at its last step and counted in short. Reagents that are cheaper to craft one at
// a time are bought either way, as their own reagents or straight off the AH, whichever the AH can
// actually supply and then whichever costs less: cheap Light Leather crafted up into Thick Leather
// is no use when the path needs 60,000 of it.
function makeBulkBuyer(resolve, o) {
  let bought = new Map(), short = new Map();
  const shortSum = () => [...short.values()].reduce((a, b) => a + b, 0);
  function fromAH(id, n, price) {
    const steps = ladderOf(id, price), cap = vendorPrice(id) ?? Infinity;
    let skip = bought.get(id) || 0, left = n, cost = 0;
    bought.set(id, skip + n);
    for (let i = 0; i < steps.length && left > 0; i += 2) {
      let c = steps[i + 1];
      if (skip >= c) { skip -= c; continue; }
      c -= skip; skip = 0;
      const t = Math.min(c, left);
      cost += t * Math.min(steps[i], cap); left -= t;
    }
    if (left > 0 && cap < Infinity) cost += left * cap;   // the vendor has the rest
    else if (left > 0) {
      short.set(id, (short.get(id) || 0) + left);
      cost += left * (steps.length ? steps[steps.length - 2] : price);
    }
    return cost;
  }
  // runs one way of buying on a copy of the books, to compare before committing to it
  function attempt(fn) {
    const saved = [bought, short];
    bought = new Map(bought); short = new Map(short);
    const before = shortSum(), cost = fn();
    const out = { cost, short: shortSum() - before, books: [bought, short] };
    [bought, short] = saved;
    return out;
  }
  function take(id, n) {
    const b = resolve(id);
    if (!b || n <= 0) return 0;
    if (b.src === "Vendor") return b.price * n;
    if (b.src !== "Craft") return fromAH(id, n, ahPrice(id, o) ?? b.price);
    const r = b.recipe;
    const craft = attempt(() => r.reagents.reduce((a, [rid, per]) => a + take(rid, (per * n) / r.creates[1]), 0));
    const p = realm()?.prices[id];
    const ah = p ? attempt(() => fromAH(id, n, p[1])) : null;
    // if the AH can't cover it either way, show the shortfall in the item itself, not its raw materials
    const pick = !ah ? craft : craft.short > 0 ? ah : ah.short > 0 ? craft : ah.cost < craft.cost ? ah : craft;
    [bought, short] = pick.books;
    return pick.cost;
  }
  // what the shortfalls would cost at the scarcity price, so paths that need them rank lower
  function penalty() {
    let sum = 0;
    for (const [id, n] of short) {
      const steps = ladderOf(id, ahPrice(id, o) ?? 0);
      sum += n * (steps.length ? steps[steps.length - 2] : 0) * (SCARCE_PENALTY - 1);
    }
    return sum;
  }
  return { take, penalty, get short() { return short; }, get bought() { return bought; } };
}

// Goes through the steps in order with a stock of what you've crafted: later steps use it before
// buying, and whatever is left at the end is vendored, disenchanted or sold.
function walkPath(steps, o, mode, resolve) {
  const stock = new Map(), madeBy = new Map(), bulk = makeBulkBuyer(resolve, o);
  let buy = 0, crafts = 0;
  const fees = new Map(), recipes = [];
  for (const st of steps) {
    if (!st.c) continue;
    const n = st.n = Math.ceil(st.crafts);
    crafts += n;
    // (once per recipe item: two versions of a recipe can share one)
    if (st.c.learn > 0) fees.set(st.c.learnItem || st.c.r.id, st.c.learn);
    // a BoE recipe to buy: on the shopping list with the reagents
    if (st.c.learnItem && (st.c.learnHow === "ah" || st.c.learnHow === "vendor") && !recipes.some((x) => x.item === st.c.learnItem)) {
      recipes.push({ r: st.c.r, item: st.c.learnItem, cost: st.c.learn, how: st.c.learnHow });
    }
    st.buy = 0; st.fromStock = []; st.toBuy = [];
    for (const { id, n: per, buy: b } of st.c.cost.parts) {
      const need = per * n, have = stock.get(id) || 0, use = Math.min(have, need);
      if (use > 0) { stock.set(id, have - use); st.fromStock.push([id, use]); }
      if (need - use > 0) {
        const cost = bulk.take(id, need - use);
        st.toBuy.push([id, need - use, b, cost]); st.buy += cost;
      }
    }
    buy += st.buy;
    if (st.c.pid) {
      st.made = n * st.c.yieldN;
      stock.set(st.c.pid, (stock.get(st.c.pid) || 0) + st.made);
      (madeBy.get(st.c.pid) || madeBy.set(st.c.pid, []).get(st.c.pid)).push(st);
    }
  }
  // what each step's results end up as: used by a later step, or left over
  let back = 0;
  for (const [id, list] of madeBy) {
    let left = stock.get(id) || 0;
    const c = list[0].c;
    back += left * resultValue(id, o, mode, c.cost.total / c.yieldN);
    for (const st of [...list].reverse()) {   // the last crafts are the ones left over
      const spare = Math.min(left, st.made);
      st.leftover = spare; st.used = st.made - spare; left -= spare;
    }
  }
  const feeSum = [...fees.values()].reduce((a, b) => a + b, 0);
  const net = buy + feeSum - back;
  return { steps, buy, back, crafts, fees: feeSum, net, recipes, score: net + bulk.penalty(), short: bulk.short, bought: bulk.bought };
}

// The search picks step by step, so more sources can now and then come out dearer: try leaving
// each one out too, and keep the cheapest (a plan that leaves skill ranges without a recipe isn't
// cheaper, it's unfinished). As /cf does; plans are kept until something they depend on changes.
const planCache = new Map();
function bestPlan(prof, from, to, o, mode, src) {
  const key = [prof, from, to, mode, src.join(","), JSON.stringify(o), state.realmKey, state.pricesMtime, vendorFactor()].join("|");
  if (planCache.has(key)) return planCache.get(key);
  let plan = levelPath(prof, from, to, o, mode, new Set(src));
  const gaps = (p) => p.steps.filter((st) => !st.c).length;
  if (src.length > 1) {
    for (const s of src) {
      const alt = bestPlan(prof, from, to, o, mode, src.filter((x) => x !== s));
      if (gaps(alt) < gaps(plan) || (gaps(alt) === gaps(plan) && alt.score < plan.score)) plan = alt;
    }
  }
  if (planCache.size > 40) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

function renderLevel() {
  const prof = state.profession;
  const box = $("level");
  if (!box.querySelector("#levelBody")) {
    box.innerHTML = `<div class="level-intro">The cheapest recipe to craft at each skill level, using the prices from the scan.
      Yellow and green recipes count the extra crafts you need when a skill-up doesn't happen. Materials are bought
      through the AH listings cheapest first, so buying a lot costs what it really would. What you craft is
      used by later steps when they need it; the rest is handled the way you pick below.
      Uses your filters (trainer recipes only, craft reagents, pricing). Shows when to train each rank.</div>
      <div class="level-controls">
        <label class="cut">Skill <input id="lvFrom" class="cut-input skill-input" type="text" inputmode="numeric" aria-label="From skill"></label>
        <label class="cut">to <input id="lvTo" class="cut-input skill-input" type="text" inputmode="numeric" aria-label="To skill"></label>
        <label class="cut">Leftover results
          <select id="lvMode" class="select">${Object.entries(RESULT_MODES).map(([k, v]) =>
            `<option value="${k}"${k === state.levelMode ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <span class="cut" title="Trainer: for their fee. BoE: recipe items bought on the AH or from a vendor, priced in. BoP: drops, quests and reputation you get yourself, counted free. The plan uses the cheapest mix of what you allow.">Recipes from
          ${Object.entries(RECIPE_SOURCES).map(([k, v]) =>
            `<label class="check"><input type="checkbox" data-src="${k}"${state.levelSrc.split(",").includes(k) ? " checked" : ""}>${v}</label>`).join("")}</span>
        <button type="button" class="copy-btn" id="levelCopy">Copy shopping list</button>
      </div>
      <div id="levelBody"></div>`;
  }
  const ranks = state.ranks[prof] || [];
  const max = ranks.length ? ranks[ranks.length - 1].cap
    : Math.max(...state.recipes.filter((r) => r.profession === prof && r.colors).map((r) => r.colors[3]));
  if (box.dataset.prof !== prof) {
    box.dataset.prof = prof;
    $("lvFrom").value = 1;
    $("lvTo").value = max;
  }
  const from = Math.max(1, Number($("lvFrom").value) || 1);
  const to = Math.min(max, Number($("lvTo").value) || max);
  const o = opts(), mode = state.levelMode;
  const src = Object.keys(RECIPE_SOURCES).filter((k) => state.levelSrc.split(",").includes(k));
  const plan = from < to && src.length ? bestPlan(prof, from, to, o, mode, src) : null;
  state.levelPlan = plan;
  if (!plan) { $("levelBody").innerHTML = `<div class="level-intro">${src.length ? "Pick a skill range above." : "Pick at least one place recipes can come from."}</div>`; return; }

  const name = (id) => esc(state.items[id]?.name || "Item " + id);
  const rankRow = (k) => `<div class="step rank"><span class="mono">${k.at}</span>
    <span>${{ trainer: "Train", book: "Learn", quest: "Get" }[k.how || "trainer"]} <b>${k.rank}</b>${k.how === "book" ? " from a book"
      : k.how === "quest" ? " from its quest" : ""}${k.rank === "Apprentice" ? "" : ` (from skill ${k.skill}) to go past ${k.at}`}</span>
    <span></span><span></span><span class="num">${money(k.cost)}</span></div>`;
  const rows = plan.steps.map((st) => {
    const ranksHere = plan.rankUps.filter((k) => k.at === st.from).map(rankRow).join("");
    return ranksHere + stepRow(st);
  }).join("");
  function stepRow(st) {
    const range = `<span class="mono">${st.from}–${st.to}</span>`;
    if (!st.c) return `<div class="step gap">${range}<span>No priced recipe gives skill-ups here</span><span></span><span></span><span></span></div>`;
    const r = st.c.r;
    const it = r.creates ? state.items[r.creates[0]] : null;
    const qc = qColor(it ? it.quality : 1);
    const notes = [];
    if (st.used > 0) notes.push(`<span class="mono">${fmtN(st.used)}</span> used by later steps`);
    for (const [id, n] of st.fromStock) notes.push(`uses <span class="mono">${fmtN(n)}</span> ${name(id)} you made`);
    if (st.c.learnHow === "ah" || st.c.learnHow === "vendor") notes.push(`buy the recipe ${st.c.learnHow === "ah" ? "on the AH" : "from a vendor"} for ${money(st.c.learn)}`);
    else if (st.c.learnHow === "bop") notes.push("recipe from a drop, quest or reputation");
    return `<div class="step">${range}
      <span class="step-craft"><span class="recipe-name"><a class="icon-link" href="${WH}/spell=${r.id}" target="_blank" rel="noopener" data-tip="recipe:${r.id}"><img class="row-icon" src="${ICON(it?.icon || r.icon)}" alt="" loading="lazy" style="--q:${qc}"></a>
        <span style="color:${qc}">${esc(r.name)}</span></span>
        ${notes.length ? `<span class="step-note">${notes.join(" · ")}</span>` : ""}</span>
      <span class="num mono">×${st.n}</span>
      <span class="num">${money(recipeCost(r, plan.resolve).total)}</span>
      <span class="num">${money(st.buy)}</span></div>`;
  }
  const gaps = plan.steps.some((st) => !st.c);
  // the summary, as in /cf: a row of facts, the cost or profit with its breakdown on hover
  const HOW = { vendor: "vendoring", de: "disenchanting", ah: "selling on the AH" };
  const fact = (label, value, attrs = "") => `<div class="fact"${attrs}><span class="fact-label">${label}</span><span class="fact-value">${value}</span></div>`;
  const used = Object.entries(RECIPE_SOURCES).filter(([k]) => src.includes(k)).map(([, v]) => v).join(", ");
  $("levelBody").innerHTML = `
    <div class="facts">
      ${fact("Profession", `${esc(prof)} ${from}–${to}`)}
      ${fact("Crafts", `<span class="mono">${plan.crafts.toLocaleString("en-US")}</span>`)}
      ${fact(`${plan.net < 0 ? "Profit" : "Cost"}, ${HOW[mode]}`, (plan.net < 0 ? "+" : "") + money(Math.abs(plan.net)), ` data-tip="plan:0"`)}
      ${fact("Recipes from", used)}
    </div>
    ${mode === "ah" ? `<div class="level-intro">Counts leftovers as sold at the scan price, after the AH cut. Items with fewer than ${AH_MIN_AUCTIONS} auctions up,
      or priced over ${AH_MAX_MARKUP}× what they cost to make, only count what a vendor pays. These are listings, not sales,
      and a long path can flood the AH, so check On AH and Sold/day in the recipe list first.</div>` : ""}
    ${plan.short.size ? `<div class="level-intro"><span class="stale-text">Not enough on the AH:</span> ${[...plan.short].map(([id, n]) =>
      `${name(id)} (${fmtN(n)} more than listed)`).join(", ")}. The path already avoids these where another
      recipe will do; what's left is priced at the most expensive listing, so the totals are an estimate
      until more get posted.</div>` : ""}
    ${gaps ? `<div class="stale-text">${realm() ? "Some skill ranges have no recipe with a full price in this scan." : "There's no scan yet, so only recipes made from vendor reagents have a price."}</div>` : ""}
    <div class="step head"><span>Skill</span><span>Craft</span><span class="num">Times</span><span class="num">Each</span><span class="num">To buy</span></div>
    ${rows}`;
}

function levelShoppingText() {
  const need = new Map();
  for (const st of state.levelPlan?.steps || []) {
    for (const [id, n, b, cost] of st.toBuy || []) {
      const e = need.get(id) || { n: 0, cost: 0, craft: b?.src === "Craft" };
      e.n += n; e.cost += cost;
      need.set(id, e);
    }
  }
  const lines = [...need].sort((a, b) => b[1].cost - a[1].cost)
    .map(([id, e]) => `${fmtN(e.n)}× ${state.items[id]?.name || "Item " + id}${e.craft ? " (craft)" : ""}, ${plainMoney(e.cost)}`);
  const recipes = (state.levelPlan?.recipes || []).map((x) =>
    `1× ${state.items[x.item]?.name || "Recipe " + x.item} (${x.how === "ah" ? "AH" : "vendor"}), ${plainMoney(x.cost)}`);
  return [`${state.profession} ${$("lvFrom").value}–${$("lvTo").value}`, ...lines, ...recipes,
    `Total: ${plainMoney((state.levelPlan?.buy || 0) + (state.levelPlan?.recipes || []).reduce((a, x) => a + x.cost, 0))}`].join("\n");
}

function renderView(all) {
  const canLevel = state.profession && state.profession !== FAV;
  if (!canLevel && state.view === "level") state.view = "recipes";
  document.querySelectorAll("#viewTabs button").forEach((b) => {
    const on = b.dataset.view === state.view;
    b.hidden = b.dataset.view === "level" && !canLevel;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  });
  $("viewTabs").hidden = false;
  document.querySelector(".top").hidden = state.view !== "recipes";   // the top 3 belong to the recipe list, as in /cf
  $("level").hidden = state.view !== "level";
  $("cooldowns").hidden = state.view !== "cooldowns";
  $("table").hidden = state.view !== "recipes";
  if (state.view === "level") renderLevel();
  if (state.view === "cooldowns") renderCooldowns(all);
}

// ---------------------------------------------------------------- cooldowns

const fmtCooldown = (h) => {
  const [n, unit] = h >= 22 ? [Math.round((h / 24) * 10) / 10, "day"] : [Math.round(h), "hour"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};

// Recipes you can only craft every so often, by what they make per day if crafted every time the
// cooldown is up. In classic, Alchemy's transmutes share one cooldown, so the best one is marked.
function renderCooldowns(all) {
  const rows = all.filter((x) => x.r.cooldown && (!state.profession || state.profession === FAV || x.r.profession === state.profession))
    .map((x) => ({ x, perDay: x.profit == null ? null : (x.profit * 24) / x.r.cooldown }))
    .sort((a, b) => (b.perDay ?? -Infinity) - (a.perDay ?? -Infinity));
  if (!rows.length) {
    $("cooldowns").innerHTML = `<div class="level-intro">No recipes with a cooldown${state.profession && state.profession !== FAV ? " in " + esc(state.profession) : ""}.</div>`;
    return;
  }
  const best = new Map();   // profession -> its best transmute, the one worth the shared cooldown
  for (const { x } of rows) if (/^Transmute/.test(x.r.name) && x.profit != null && !best.has(x.r.profession)) best.set(x.r.profession, x.r.id);
  $("cooldowns").innerHTML = `<div class="level-intro">Recipes with a cooldown, ranked by profit per day if you craft them every time
      the cooldown is up, using the same pricing as the recipe list. In classic, transmutes share one cooldown, so the best one
      is marked; Wowhead doesn't say whether that still holds for Forever's 1-hour transmutes.</div>
    <div class="step head cd"><span>Cooldown</span><span>Craft</span><span class="num">On AH</span><span class="num">Profit each</span><span class="num">Per day</span></div>
    ${rows.map(({ x, perDay }) => {
      const r = x.r, it = r.creates ? state.items[r.creates[0]] : null, qc = qColor(it ? it.quality : 1);
      const pm = (v) => (v == null ? `<span class="muted">—</span>` : `<span class="${v >= 0 ? "p-pos" : "p-neg"}">${money(v)}</span>`);
      const shared = /^Transmute/.test(r.name) ? (best.get(r.profession) === r.id ? " · best transmute" : " · shares the transmute cooldown") : "";
      return `<div class="step cd"><span class="mono">${fmtCooldown(r.cooldown)}</span>
        <span class="step-craft"><span class="recipe-name"><a class="icon-link" href="${WH}/spell=${r.id}" target="_blank" rel="noopener" data-tip="recipe:${r.id}"><img class="row-icon" src="${ICON(it?.icon || r.icon)}" alt="" loading="lazy" style="--q:${qc}"></a>
          <span style="color:${qc}">${esc(r.name)}</span></span>
          <span class="step-note">${esc(r.profession)} · ${r.skill ?? "?"}${shared}</span></span>
        <span class="num mono">${x.qty ?? ""}</span>
        <span class="num">${pm(x.profit)}</span>
        <span class="num">${pm(perDay)}</span></div>`;
    }).join("")}`;
}

function renderProfs() {
  const total = Object.values(state.profCounts).reduce((a, b) => a + b, 0);
  const list = [["All", total, null], ...Object.keys(state.profCounts).sort().map((p) => [p, state.profCounts[p], p])];
  if (favCount() || state.profession === FAV) list.splice(1, 0, ["★ Favorites", favCount(), FAV]);
  const nav = $("profs");
  nav.querySelectorAll(".prof").forEach((b) => b.remove());
  nav.insertAdjacentHTML("beforeend", list.map(([name, n, val]) =>
    `<button type="button" class="prof${state.profession === val ? " on" : ""}" data-prof="${esc(val ?? "")}"><span class="mark"></span>${esc(name)}<span class="n">${n.toLocaleString("en-US")}</span></button>`
  ).join(""));
}

function renderScan() {
  const box = $("scan");
  const p = state.prices;
  $("realmBox").innerHTML = "";
  if (!p || p.error) {
    box.innerHTML = `<div class="scan-head"><span class="dot off"></span>Not connected</div>
      <span class="muted">${esc(p?.error || "Loading…")}</span>`;
    return;
  }
  const realms = Object.entries(p.realms || {}).sort((a, b) => b[1].time - a[1].time);
  if (!realms.length) {
    state.realmKey = null;
    // visitors of the hosted site can't scan for it, so they only get the status
    box.innerHTML = HOSTED ? `<div class="scan-head"><span class="dot off"></span>No scans yet</div>`
      : `<div class="scan-head"><span class="dot off"></span>No scan found yet</div>
      <span class="muted">In game, open the Auction House, click <b>Margin Scan</b>, then <b>Save</b> or <code>/reload</code>.</span>`;
    return;
  }
  if (!state.realmKey || !p.realms[state.realmKey]) state.realmKey = realms[0][0];
  const r = p.realms[state.realmKey];
  const ageH = (Date.now() / 1000 - r.time) / 3600;
  const age = ageH < 48 ? `${Math.floor(ageH)} hours` : `${Math.floor(ageH / 24)} days`;
  box.innerHTML = `<div class="scan-head"><span class="dot${ageH > STALE_H ? " stale" : ""}"></span>${scanTime(r.time)}
      <span class="faint">/</span><span class="gold">${r.auctions.toLocaleString("en-US")}</span><span class="muted">auctions</span></div>
    ${ageH > STALE_H ? `<span class="stale-text">Prices are ${age} old and may have changed.</span>` : ""}`;
  // the realm reads like a button; with one realm there is nothing to pick
  $("realmBox").innerHTML = `<label class="realm${realms.length > 1 ? "" : " one"}"><span class="realm-label">Realm</span>
    <span class="realm-name">${esc(state.realmKey)}</span>${realms.length > 1 ? `<span class="realm-caret">▾</span>
    <select id="realm" aria-label="Realm">${realms.map(([k]) =>
      `<option value="${esc(k)}"${k === state.realmKey ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>` : ""}</label>`;
  const sel = $("realm");
  if (sel) sel.onchange = () => { state.realmKey = sel.value; renderScan(); render(); };
}

// ---------------------------------------------------------------- shareable links

// The address mirrors the view (profession, search, sort, filters) so it can be sent to someone.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const FLAGS = { only: "onlyProfit", unpriced: "showUnpriced", few: "hideFew", trainer: "trainerOnly" };

function readURL() {
  const u = new URLSearchParams(location.search);
  const prof = u.get("prof");
  if (prof) state.profession = prof === "favorites" ? FAV : Object.keys(state.profCounts).find((p) => slug(p) === slug(prof)) || null;
  if (["level", "cooldowns"].includes(u.get("view"))) state.view = u.get("view");
  if (RESULT_MODES[u.get("results")]) state.levelMode = u.get("results");
  if (u.get("src") != null) state.levelSrc = u.get("src").split(",").filter((k) => RECIPE_SOURCES[k]).join(",");
  if (DEPOSIT_RATE[u.get("deposit")]) { $("deposit").checked = true; $("duration").value = u.get("deposit"); $("duration").hidden = false; }
  if (u.get("q")) $("search").value = u.get("q");
  const sort = u.get("sort");
  if (sort && SORT[sort.replace(/^-/, "")]) state.sort = { key: sort.replace(/^-/, ""), dir: sort.startsWith("-") ? -1 : 1 };
  if (u.get("basis") === "min") $("basis").value = "min";
  if (u.get("cut") != null) $("cut").value = u.get("cut");
  if (u.get("craft") === "0") $("craftMats").checked = false;
  for (const [k, id] of Object.entries(FLAGS)) if (u.get(k) === "1") $(id).checked = true;
  const m = /^(min|max)(-?[0-9.]+)$/.exec(u.get("margin") || "");
  if (m) { $("marginMode").value = m[1]; $("marginPct").value = m[2]; $("marginLimit").hidden = false; }
}

function writeURL() {
  const u = new URLSearchParams();
  if (state.profession) u.set("prof", state.profession === FAV ? "favorites" : slug(state.profession));
  if (state.view === "level" && state.profession && state.profession !== FAV) u.set("view", "level");
  if (state.view === "cooldowns") u.set("view", state.view);
  if (state.levelMode !== "vendor") u.set("results", state.levelMode);
  if (state.levelSrc !== "trainer,boe") u.set("src", state.levelSrc);
  if ($("deposit").checked) u.set("deposit", $("duration").value);
  const q = $("search").value.trim();
  if (q) u.set("q", q);
  if (state.sort.key !== "profit" || state.sort.dir !== -1) u.set("sort", (state.sort.dir < 0 ? "-" : "") + state.sort.key);
  if ($("basis").value !== "market") u.set("basis", $("basis").value);
  if ($("cut").value !== "5") u.set("cut", $("cut").value);
  if (!$("craftMats").checked) u.set("craft", "0");
  for (const [k, id] of Object.entries(FLAGS)) if ($(id).checked) u.set(k, "1");
  if ($("marginMode").value !== "any" && $("marginPct").value.trim()) u.set("margin", $("marginMode").value + $("marginPct").value.replace(",", "."));
  const next = u.toString() ? `?${u}` : location.pathname;
  if (next !== location.search && !(next === location.pathname && !location.search)) history.replaceState(null, "", next);
}

function renderTheme() {
  $("theme").textContent = document.documentElement.dataset.theme === "dark" ? "Light mode" : "Dark mode";
}

// ---------------------------------------------------------------- data loading

// On the hosted copy (GitHub Pages) the data are plain files written by publish.bat;
// locally start.bat serves them live from SavedVariables.
const HOSTED = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DATA = HOSTED
  ? { prices: () => `data/prices.json?t=${Date.now()}`, history: () => `data/history.json?t=${Date.now()}`, recipes: "data/recipes.json?v=a9e40a9047" }
  : { prices: () => "/api/prices", history: () => "/api/history", recipes: "/api/recipes" };

async function loadPrices() {
  try {
    const data = await (await fetch(DATA.prices())).json();
    if (data.mtime === state.pricesMtime && !data.error) return;
    state.pricesMtime = data.mtime;
    state.prices = data;
    // the local server adds your /cf stars and the recipe prices you've seen
    state.cfFavs = new Set(data.mine?.favs || []);
    state.recipeBuy = data.mine?.recipeBuy || {};
    renderProfs();
    // the history gains a point with each new scan; without it the trend lines just stay hidden
    try { state.history = await (await fetch(DATA.history())).json(); } catch (e) { state.history = null; }
  } catch (e) {
    if (state.prices?.error) return;
    state.prices = { error: HOSTED ? "Couldn't load the prices. Try refreshing." : "Can't reach the Margin server. Is start.bat running?" };
    state.pricesMtime = -1;
  }
  renderScan();
  render();
}

async function init() {
  renderTheme();
  const data = await (await fetch(DATA.recipes)).json();
  if (data.error) { state.prices = { error: data.error }; renderScan(); return; }
  state.recipes = data.recipes;
  state.items = data.items;
  state.ranks = data.ranks || {};
  state.recipeItems = data.recipeItems || {};
  for (const r of state.recipes) {
    state.profCounts[r.profession] = (state.profCounts[r.profession] || 0) + 1;
    if (r.creates) (state.byProduct[r.creates[0]] ||= []).push(r);
  }
  const disc = loadSaved("cf-discounts", {});
  $("barter").checked = !!disc.barter;
  if (disc.rep) $("repDiscount").value = disc.rep;
  readURL();
  renderProfs();
  await loadPrices();
  setInterval(loadPrices, HOSTED ? 60000 : 5000);
}

// ---------------------------------------------------------------- hover tooltip

const QUALITY_NAME = QUALITY.map((q) => q[0].toUpperCase() + q.slice(1));

function tipLine(label, value) {
  return `<div class="tip-line"><span>${label}</span><span>${value}</span></div>`;
}

function tipReagents(parts) {
  return parts.map(({ id, n, buy }) => {
    const it = state.items[id] || {};
    return `<div class="tip-reagent">
      <img src="${ICON(it.icon)}" alt="" style="--q:${qColor(it.quality)}">
      <span class="tip-rname" style="color:${qColor(it.quality)}">${esc(it.name || "Item " + id)}</span>
      <span class="mono muted">×${n}</span>
      <span class="tip-rcost">${buy ? money(buy.price * n) : `<span class="neg-text">no price</span>`}</span>
    </div>`;
  }).join("");
}

function tipPrices(id, extra = "") {
  const p = realm()?.prices[id];
  const it = state.items[id] || state.prices?.items?.[id] || {};
  let out = "";
  if (p) {
    out += tipLine("AH market", money(p[1])) + tipLine("AH lowest", money(p[0])) +
      tipLine("On AH", p[2] < FEW ? `<span class="few"><span class="mono">${p[2]}</span> · few listed</span>` : `<span class="mono">${p[2]}</span>`);
    const sold = soldPerDay(id);
    if (sold != null) out += tipLine("Sold/day", `<span class="mono">~${fmtSold(sold)}</span>`);
    const trend = trendHTML(id, 90);
    if (trend) out += tipLine("14 days", `<span class="trend">${trend}</span>`);
  } else if (realm()) {
    out += tipLine("AH", `<span class="muted">not listed in this scan</span>`);
  }
  const vend = vendorPrice(id);
  if (vend) out += tipLine("Vendor buy", money(vend));
  if (it.sell) out += tipLine("Vendor sell", money(it.sell));
  return out + extra;
}

function tipHeader(icon, name, quality, sub) {
  return `<div class="tip-head">
    <img src="${ICON(icon)}" alt="" style="--q:${qColor(quality)}">
    <div><div class="tip-name" style="color:${qColor(quality)}">${esc(name)}</div><div class="tip-sub">${sub}</div></div>
  </div>`;
}

function tipHTML(kind, id) {
  const plan = state.levelPlan;
  if (kind === "plan") {
    if (!plan) return "";
    const back = { vendor: "Vendored back", de: "Disenchanted back", ah: "Sold on the AH" }[state.levelMode];
    return `<div class="tip-sec">${tipLine("Materials", money(-plan.buy))}
      ${tipLine(plan.recipes.length ? "Trainers & recipes" : "Trainers", money(-plan.fees))}
      ${tipLine(back, money(plan.back))}</div>`;
  }
  const o = opts();
  const resolve = makeBuyResolver(o);
  if (kind === "recipe") {
    const r = state.recipes.find((x) => x.id === id);
    if (!r) return "";
    const x = evaluate(r, o, resolve);
    const pid = r.creates?.[0];
    const it = pid ? state.items[pid] || {} : {};
    const sub = `${pid ? QUALITY_NAME[it.quality ?? 1] + " · " : ""}${esc(r.profession)} · <span class="mono">${r.skill ?? "?"}</span>` +
      (r.creates && r.creates[1] !== 1 ? ` · makes <span class="mono">${r.creates[1]}</span>` : "");
    let body = pid ? `<div class="tip-sec">${tipPrices(pid)}</div>` : "";
    body += `<div class="tip-sec"><div class="tip-label">Reagents</div>${tipReagents(x.cost.parts)}
      ${tipLine("Total cost", x.cost.complete ? money(x.cost.total) : `<span class="neg-text">incomplete</span>`)}</div>`;
    if (x.profit != null) {
      body += `<div class="tip-sec">${tipLine("Sells for", money(x.sell) + (x.viaVendor ? ` <span class="muted">vendor</span>` : ""))}
        ${x.fee ? tipLine(`AH cut ${o.cut}%`, money(-x.fee)) : ""}
        ${x.deposit ? tipLine("Deposit", money(-x.deposit)) : ""}
        <div class="tip-line tip-profit ${x.profit > 0 ? "pos" : "neg"}"><span>Profit</span><span>${money(x.profit)}</span></div></div>`;
    }
    const url = `${WH}/${pid ? "item=" + pid : "spell=" + r.id}`;
    return tipHeader(it.icon || r.icon, pid ? it.name || r.name : r.name, pid ? it.quality : 1, sub) + body +
      `<div class="tip-foot">Click to open ${url.replace("https://www.", "")}</div>`;
  }
  // a plain item, e.g. a reagent, or anything else on the AH
  const it = state.items[id] || state.prices?.items?.[id] || {};
  const best = resolve(id);
  const how = best ? { AH: "Auction House", Vendor: "Vendor", Craft: "Craft it" }[best.src] : null;
  let body = `<div class="tip-sec">${tipPrices(id, best ? tipLine("Cheapest", `${how} · ${money(best.price)}`) : "")}</div>`;
  const recipe = best?.recipe || state.byProduct[id]?.[0];
  if (recipe) {
    const c = recipeCost(recipe, resolve);
    body += `<div class="tip-sec"><div class="tip-label">Crafted by ${esc(recipe.name)} · ${esc(recipe.profession)} <span class="mono">${recipe.skill ?? "?"}</span></div>
      ${tipReagents(c.parts)}</div>`;
  }
  const sub = QUALITY_NAME[it.quality ?? 1] + (it.vendor ? " · sold by vendors" : "");
  return tipHeader(it.icon, it.name || "Item " + id, it.quality, sub) + body +
    `<div class="tip-foot">Click to open wowhead.com/forever/item=${id}</div>`;
}

const tip = document.createElement("div");
tip.className = "tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.appendChild(tip);
let tipFor = null;

function placeTip(e) {
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  tip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
}

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) return;
  if (el !== tipFor) {
    const [kind, id] = el.dataset.tip.split(":");
    tip.innerHTML = tipHTML(kind, Number(id));
    tipFor = el;
  }
  tip.hidden = false;
  placeTip(e);
});
document.addEventListener("mousemove", (e) => { if (!tip.hidden) placeTip(e); });
document.addEventListener("mouseout", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el && !el.contains(e.relatedTarget)) { tip.hidden = true; tipFor = null; }
});
addEventListener("scroll", () => { tip.hidden = true; tipFor = null; }, { passive: true });

// ---------------------------------------------------------------- events

function refilter() { state.shown = PAGE; render(); }

function copyText(btn, text, label) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = label; }, 1500);
  }, () => { btn.textContent = "Couldn't copy"; });
}

$("rows").addEventListener("click", (e) => {
  const fav = e.target.closest("[data-fav]");
  if (fav) {
    const id = Number(fav.dataset.fav);
    if (state.cfFavs.has(id)) return;   // starred in /cf: unstar it there
    state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
    save("cf-favs", [...state.favs]);
    renderProfs(); render();
    return;
  }
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    const r = state.recipes.find((x) => x.id === Number(copy.dataset.copy));
    const o = opts();
    const text = shoppingText(evaluate(r, o, makeBuyResolver(o)), state.make.get(r.id) || 1);
    copyText(copy, text, "Copy shopping list");
    return;
  }
  if (e.target.closest("a, input, .shop-bar")) return;
  const row = e.target.closest(".row");
  if (!row) return;
  const id = Number(row.dataset.id);
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  render();
});
// the recipe name is the row's keyboard toggle; the rows redraw, so focus goes back to it
$("rows").addEventListener("keydown", (e) => {
  if ((e.key !== "Enter" && e.key !== " ") || !e.target.matches(".row .recipe-name")) return;
  e.preventDefault();
  const id = Number(e.target.closest(".row").dataset.id);
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  render();
  $("rows").querySelector(`.row[data-id="${id}"] .recipe-name`)?.focus();
});
$("profs").addEventListener("click", (e) => {
  const b = e.target.closest(".prof");
  if (!b) return;
  state.profession = b.dataset.prof || null;
  renderProfs(); refilter();
});
// the shopping list redraws in place so the Make box keeps focus while typing
$("rows").addEventListener("input", (e) => {
  const inp = e.target.closest("[data-make]");
  if (!inp) return;
  inp.value = inp.value.replace(/[^0-9]/g, "").slice(0, 4);
  const id = Number(inp.dataset.make), n = Math.max(1, Number(inp.value) || 1);
  state.make.set(id, n);
  const r = state.recipes.find((x) => x.id === id), o = opts();
  const x = evaluate(r, o, makeBuyResolver(o));
  const box = inp.closest(".detail");
  box.querySelector(".detail-body").innerHTML = detailBody(x, o, n);
  if (r.creates) box.querySelector(".shop-bar .muted").innerHTML =
    `= <span class="mono">${fmtN(n * r.creates[1])}</span> ${esc(state.items[r.creates[0]]?.name || "")}`;
});
$("hideFew").addEventListener("change", refilter);
$("trainerOnly").addEventListener("change", refilter);
$("deposit").addEventListener("change", () => { $("duration").hidden = !$("deposit").checked; render(); });
for (const id of ["barter", "repDiscount"]) $(id).addEventListener("change", () => {
  save("cf-discounts", { barter: $("barter").checked, rep: $("repDiscount").value });
  render();
});
$("duration").addEventListener("change", render);
$("marginMode").addEventListener("change", () => { $("marginLimit").hidden = $("marginMode").value === "any"; refilter(); });
$("marginPct").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^0-9.,-]/g, "").slice(0, 5);
  refilter();
});
$("viewTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b || b.dataset.view === state.view) return;
  state.view = b.dataset.view;
  render();
});
$("level").addEventListener("input", (e) => {
  if (!e.target.matches("#lvFrom, #lvTo")) return;
  e.target.value = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
  renderLevel();
});
$("level").addEventListener("change", (e) => {
  if (e.target.matches("[data-src]")) {
    state.levelSrc = [...$("level").querySelectorAll("[data-src]")].filter((c) => c.checked).map((c) => c.dataset.src).join(",");
    writeURL();
    return renderLevel();
  }
  if (e.target.id !== "lvMode") return;
  state.levelMode = e.target.value;
  writeURL();
  renderLevel();
});
$("level").addEventListener("click", (e) => {
  const b = e.target.closest("#levelCopy");
  if (b) copyText(b, levelShoppingText(), "Copy shopping list");
});
$("thead").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const k = b.dataset.sort;
  state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
  render();
});
$("search").addEventListener("input", refilter);
$("onlyProfit").addEventListener("change", refilter);
$("showUnpriced").addEventListener("change", refilter);
for (const id of ["basis", "craftMats"]) $(id).addEventListener("change", render);
$("cut").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^0-9.,]/g, "");
  render();
});
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("cf-theme", next); } catch (e) {}
  renderTheme();
});

init();
