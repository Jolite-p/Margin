// ChudsForever front end: joins Wowhead recipe data with the addon's AH scan.
const WH = "https://www.wowhead.com/forever";
const ICON = (name) => `https://wow.zamimg.com/images/wow/icons/medium/${name && name !== "temp" ? name : "inv_misc_questionmark"}.jpg`;
const QUALITY = ["poor", "common", "uncommon", "rare", "epic", "legendary"];
const qColor = (q) => `var(--q-${QUALITY[q] ?? "common"})`;
const PAGE = 100;
const ANIM_ROWS = 20;        // rows that cascade in and count up; the rest render instantly
const ROW_STAGGER = 18;      // ms between rows in the cascade
const COUNT_MS = 500;        // count-up duration
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  recipes: [], items: {}, byProduct: {}, profCounts: {},
  prices: null, realmKey: null, pricesMtime: -1,
  profession: null,
  sort: { key: "profit", dir: -1 },
  shown: PAGE, open: new Set(),
  cascade: 0,                // bumps when the row cascade should replay
  lastCascade: -1,
  shownProfit: new Map(),    // recipe id -> last displayed profit, for count-up
  cardKey: "",
};
const $ = (id) => document.getElementById(id);
const opts = () => ({
  basis: $("basis").value,
  cut: Math.max(0, Number(String($("cut").value).replace(",", ".")) || 0),
  craftMats: $("craftMats").checked,
  onlyProfit: $("onlyProfit").checked,
  showUnpriced: $("showUnpriced").checked,
  q: $("search").value.trim().toLowerCase(),
});

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function money(value, plain = false) {
  if (value == null || !isFinite(value)) return `<span class="money muted">—</span>`;
  const v = Math.round(value), a = Math.abs(v);
  const g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), c = a % 100;
  let out = v < 0 ? `<span class="minus">−</span>` : "";
  if (g) out += `<span>${g.toLocaleString("en-US")}<span class="u ug">g</span></span>`;
  if (s) out += `<span>${s}<span class="u us">s</span></span>`;
  if (c || a === 0) out += `<span>${c}<span class="u uc">c</span></span>`;
  return `<span class="money${plain ? " plain" : ""}">${out}</span>`;
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

// ---------------------------------------------------------------- count-up

const tweens = new WeakMap();
function countUp(el, from, to, delay) {
  const t = tweens.get(el);
  if (t) { cancelAnimationFrame(t.raf); clearTimeout(t.done); }
  if (reduceMotion.matches || document.hidden || from === to) { el.innerHTML = money(to, true); return; }
  const t0 = performance.now();
  const tw = {};
  el.innerHTML = money(from, true);
  const step = (now) => {
    const k = Math.max(0, Math.min(1, (now - t0 - delay) / COUNT_MS));
    el.innerHTML = money(from + (to - from) * (1 - Math.pow(1 - k, 3)), true);
    if (k < 1) tw.raf = requestAnimationFrame(step);
  };
  tw.raf = requestAnimationFrame(step);
  // frames can be paused (background tab); make sure the real number always lands
  tw.done = setTimeout(() => { cancelAnimationFrame(tw.raf); el.innerHTML = money(to, true); }, delay + COUNT_MS + 100);
  tweens.set(el, tw);
}

// ---------------------------------------------------------------- pricing

function realm() { return state.prices?.realms?.[state.realmKey] || null; }

function ahPrice(id, o) {
  const p = realm()?.prices[id];
  if (!p) return null;
  return o.basis === "min" ? p[0] : p[1];
}

function vendorPrice(id) {
  const v = state.prices?.vendor?.[id];
  if (v) return v;
  const it = state.items[id];
  return it && it.vendor && it.buy ? it.buy : null;
}

// Cheapest way to obtain one unit of an item: AH, vendor, or (optionally) crafting it.
function makeBuyResolver(o) {
  const memo = new Map(), visiting = new Set();
  function resolve(id) {
    if (memo.has(id)) return memo.get(id);
    let best = null;
    const ah = ahPrice(id, o), vend = vendorPrice(id);
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
  const row = { r, cost, qty: null, sell: null, fee: 0, profit: null, margin: null, viaVendor: false };
  if (!r.creates) return row;   // enchants and other recipes that don't make an item
  const [pid, yieldN] = r.creates;
  const p = realm()?.prices[pid];
  row.qty = p ? p[2] : realm() ? 0 : null;
  const ah = ahPrice(pid, o);
  const vendorSell = (state.items[pid]?.sell || 0) * yieldN;
  if (ah != null) {
    row.sell = ah * yieldN;
    row.fee = Math.round(row.sell * o.cut / 100);
  }
  if (vendorSell && (row.sell == null || vendorSell > row.sell - row.fee)) {
    row.sell = vendorSell; row.fee = 0; row.viaVendor = true;
  }
  if (row.sell != null && cost.complete) {
    row.profit = row.sell - row.fee - cost.total;
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
};

function render() {
  const o = opts();
  const all = evaluateAll(o);
  renderCards(all.filter((x) => x.profit != null));

  // without a scan nothing has a price, so list every recipe rather than an empty table
  const showUnpriced = o.showUnpriced || !realm();
  let rows = all.filter((x) => (showUnpriced || x.profit != null) &&
    (!state.profession || x.r.profession === state.profession) && matches(x.r, o.q));
  if (o.onlyProfit) rows = rows.filter((x) => x.profit > 0);
  const key = SORT[state.sort.key], dir = state.sort.dir;
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka == null && kb == null) return a.r.profession.localeCompare(b.r.profession) || (a.r.skill ?? 0) - (b.r.skill ?? 0);
    if (ka == null) return 1;
    if (kb == null) return -1;
    return (typeof ka === "string" ? ka.localeCompare(kb) : ka - kb) * dir || (b.profit ?? 0) - (a.profit ?? 0);
  });

  const replay = state.cascade !== state.lastCascade && !reduceMotion.matches;
  state.lastCascade = state.cascade;
  const anim = state.cascade % 2 ? "in-b" : "in-a";

  const html = [];
  const visible = rows.slice(0, state.shown);
  visible.forEach((x, i) => {
    const r = x.r, open = state.open.has(r.id);
    const product = r.creates ? state.items[r.creates[0]] : null;
    const qc = qColor(product ? product.quality : 1);
    const cascade = replay && i < ANIM_ROWS;
    const delay = cascade ? `style="animation-delay:${i * ROW_STAGGER}ms"` : "";
    html.push(`<div class="row${cascade ? " " + anim : ""}${open ? " open" : ""}" data-id="${r.id}" ${delay}>
      <div class="recipe">
        <a class="icon-link" href="${WH}/${r.creates ? "item=" + r.creates[0] : "spell=" + r.id}" target="_blank" rel="noopener" data-tip="recipe:${r.id}" aria-label="${esc(r.name)} on Wowhead"><img class="row-icon" src="${ICON(product?.icon || r.icon)}" alt="" loading="lazy" style="--q:${qc}"></a>
        <span class="recipe-name" style="color:${qc}">${esc(r.name)}${r.creates && r.creates[1] !== 1 ? ` <span class="recipe-meta">×${r.creates[1]}</span>` : ""}</span>
        <span class="recipe-meta">${esc(r.profession)} · <span class="mono">${r.skill ?? "?"}</span></span>
      </div>
      <div class="num cell-mono">${x.qty ?? ""}</div>
      <div class="num cell-sm" title="${x.viaVendor ? "Vendor sell price beats the AH" : ""}">${money(x.sell)}</div>
      <div class="num cell-sm">${money(x.cost.complete ? x.cost.total : null)}</div>
      <div class="num cell-mono muted">${pct(x.margin)}</div>
      <div class="num ${x.profit == null ? "muted" : x.profit > 0 ? "p-pos" : "p-neg"}"><span class="pv" data-i="${i}">${money(x.profit, true)}</span></div>
    </div>`);
    if (open) html.push(detail(x, o));
  });
  $("rows").innerHTML = html.join("") ||
    `<div class="empty">${realm() ? "No priced recipes match these filters in this scan." : "Scan the Auction House in game to see profits."}</div>`;

  // count-up: from 0 when rows (re)mount, from the previous value when a setting changes
  const els = $("rows").querySelectorAll(".pv");
  visible.forEach((x, i) => {
    const prev = state.shownProfit.get(x.r.id);
    if (i < ANIM_ROWS && x.profit != null) {
      const from = replay ? 0 : prev ?? x.profit;
      countUp(els[i], from, x.profit, replay ? i * ROW_STAGGER : 0);
    }
  });
  state.shownProfit = new Map(visible.map((x) => [x.r.id, x.profit]));

  const left = rows.length - visible.length;
  $("more").innerHTML = rows.length
    ? `<span>${visible.length.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} recipes</span>` +
      (left > 0 ? `<button id="moreBtn" type="button">Show ${Math.min(PAGE, left)} more</button>` : "")
    : "";
  if (left > 0) $("moreBtn").onclick = () => { state.shown += PAGE; render(); };

  document.querySelectorAll("#thead button").forEach((b) => {
    const on = b.dataset.sort === state.sort.key;
    b.classList.toggle("on", on);
    b.textContent = b.textContent.replace(/ [↓↑]$/, "") + (on ? (state.sort.dir < 0 ? " ↓" : " ↑") : "");
  });
}

// Top 3 positive-profit recipes, ignoring sidebar filters.
function renderCards(all) {
  const top = all.filter((x) => x.profit > 0).sort((a, b) => b.profit - a.profit).slice(0, 3);
  const key = top.map((x) => x.r.id).join(",") + "|" + state.realmKey;
  const box = $("cards");
  if (!top.length) {
    state.cardKey = key;
    box.innerHTML = `<div class="empty-card">${realm() ? "Nothing is profitable with the current settings." : "No scan yet."}</div>`;
    return;
  }
  const rebuild = key !== state.cardKey;
  if (rebuild) {
    state.cardKey = key;
    box.innerHTML = top.map((x, i) => {
      const it = state.items[x.r.creates[0]] || {};
      return `<div class="card" style="animation-delay:${i * 90}ms">
        ${i === 0 ? `<div class="sheen"></div>` : ""}
        <div class="card-head">
          <a class="icon-link" href="${WH}/item=${x.r.creates[0]}" target="_blank" rel="noopener" data-tip="recipe:${x.r.id}" aria-label="${esc(x.r.name)} on Wowhead"><img class="card-icon" src="${ICON(it.icon)}" alt="" style="--q:${qColor(it.quality)}"></a>
          <a class="card-name" href="${WH}/item=${x.r.creates[0]}" target="_blank" rel="noopener" style="color:${qColor(it.quality)}">${esc(x.r.name)}</a>
        </div>
        <div class="card-profit" data-v></div>
        <div class="card-foot"><span data-f></span><span class="mono" data-m></span></div>
      </div>`;
    }).join("");
  }
  box.querySelectorAll(".card").forEach((card, i) => {
    const x = top[i], el = card.querySelector("[data-v]");
    const prev = rebuild ? 0 : Number(el.dataset.v);
    el.dataset.v = x.profit;
    countUp(el, prev, x.profit, rebuild ? i * 90 : 0);
    card.querySelector("[data-f]").innerHTML = `${esc(x.r.profession)} · <span class="mono">${x.qty}</span> on AH`;
    card.querySelector("[data-m]").textContent = pct(x.margin);
  });
}

function detail(x, o) {
  const lines = x.cost.parts.map(({ id, n, buy }) => {
    const it = state.items[id] || {};
    const via = buy?.recipe ? ` · ${esc(buy.recipe.name)}` : "";
    return `<div class="reagent">
      <a href="${WH}/item=${id}" target="_blank" rel="noopener" data-tip="item:${id}" style="color:${qColor(it.quality)}">
        <img src="${ICON(it.icon)}" alt="" loading="lazy" style="--q:${qColor(it.quality)}">
        <span class="nm">${esc(it.name || "Item " + id)}</span><span class="muted mono">×${n}</span></a>
      <span class="src${buy ? "" : " missing"}" title="${buy ? esc(buy.src + via) : ""}">${buy ? buy.src : "No price"}</span>
      <span class="num">${buy ? money(buy.price) : money(null)}</span>
      <span class="num">${buy ? money(buy.price * n) : ""}</span>
    </div>`;
  }).join("");
  const notes = [];
  if (!x.r.creates) notes.push("This recipe doesn't create an item (e.g. an enchant), so there's nothing to sell.");
  else if (!realm()) notes.push("No scan yet, so reagents only have vendor prices.");
  else if (x.viaVendor) notes.push("Sells for more at a vendor than on the AH, so the vendor price is used.");
  else if (x.sell != null) notes.push(`AH cut ${o.cut}%: ${money(x.fee)}. Deposit not included.`);
  if (x.r.trainingcost) notes.push(`Trainer cost ${money(x.r.trainingcost)}.`);
  return `<div class="detail">${lines}
    <div class="detail-note">${notes.join(" ")} <a href="${WH}/spell=${x.r.id}" target="_blank" rel="noopener">Recipe on Wowhead ↗</a></div>
  </div>`;
}

function renderProfs() {
  const total = Object.values(state.profCounts).reduce((a, b) => a + b, 0);
  const list = [["All", total, null], ...Object.keys(state.profCounts).sort().map((p) => [p, state.profCounts[p], p])];
  const nav = $("profs");
  nav.querySelectorAll(".prof").forEach((b) => b.remove());
  nav.insertAdjacentHTML("beforeend", list.map(([name, n, val]) =>
    `<button type="button" class="prof${state.profession === val ? " on" : ""}" data-prof="${esc(val ?? "")}">${esc(name)}<span class="n">${n.toLocaleString("en-US")}</span></button>`
  ).join(""));
}

function renderScan() {
  const box = $("scan");
  const p = state.prices;
  if (!p || p.error) {
    box.innerHTML = `<div class="scan-head"><span class="dot off"></span>Not connected</div>
      <span class="muted">${esc(p?.error || "Loading…")}</span>`;
    return;
  }
  const realms = Object.entries(p.realms || {}).sort((a, b) => b[1].time - a[1].time);
  if (!realms.length) {
    state.realmKey = null;
    box.innerHTML = `<div class="scan-head"><span class="dot off"></span>No scan found yet</div>
      <span class="muted">In game, open the Auction House, click <b>ChudsForever Scan</b>, then <b>Save</b> or <code>/reload</code>.</span>`;
    return;
  }
  if (!state.realmKey || !p.realms[state.realmKey]) state.realmKey = realms[0][0];
  const r = p.realms[state.realmKey];
  box.innerHTML = `<div class="scan-head"><span class="dot"></span>Scan · ${scanTime(r.time)}</div>
    <span class="muted">${r.auctions.toLocaleString("en-US")} auctions · ${esc(state.realmKey)}</span>
    ${realms.length > 1 ? `<select id="realm" class="select" aria-label="Realm">${realms.map(([k]) =>
      `<option value="${esc(k)}"${k === state.realmKey ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>` : ""}`;
  const sel = $("realm");
  if (sel) sel.onchange = () => { state.realmKey = sel.value; state.cascade++; renderScan(); render(); };
}

function renderTheme() {
  $("theme").textContent = document.documentElement.dataset.theme === "dark" ? "Light mode" : "Dark mode";
}

// ---------------------------------------------------------------- data loading

// On the hosted copy (GitHub Pages) the data are plain files written by publish.bat;
// locally start.bat serves them live from SavedVariables.
const HOSTED = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DATA = HOSTED
  ? { prices: () => `data/prices.json?t=${Date.now()}`, recipes: "data/recipes.json" }
  : { prices: () => "/api/prices", recipes: "/api/recipes" };

async function loadPrices() {
  try {
    const data = await (await fetch(DATA.prices())).json();
    if (data.mtime === state.pricesMtime && !data.error) return;
    state.pricesMtime = data.mtime;
    state.prices = data;
    state.cascade++;   // a new scan remounts the rows
  } catch (e) {
    if (state.prices?.error) return;
    state.prices = { error: HOSTED ? "Couldn't load the prices. Try refreshing." : "Can't reach the ChudsForever server. Is start.bat running?" };
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
  for (const r of state.recipes) {
    state.profCounts[r.profession] = (state.profCounts[r.profession] || 0) + 1;
    if (r.creates) (state.byProduct[r.creates[0]] ||= []).push(r);
  }
  renderProfs();
  await loadPrices();
  setInterval(loadPrices, HOSTED ? 60000 : 5000);
}

// ---------------------------------------------------------------- hover tooltip

const QUALITY_NAME = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary"];

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
  const it = state.items[id] || {};
  let out = "";
  if (p) {
    out += tipLine("AH market", money(p[1])) + tipLine("AH lowest", money(p[0])) +
      tipLine("On AH", `<span class="mono">${p[2]}</span>`);
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
        <div class="tip-line tip-profit ${x.profit > 0 ? "pos" : "neg"}"><span>Profit</span><span>${money(x.profit, true)}</span></div></div>`;
    }
    const url = `${WH}/${pid ? "item=" + pid : "spell=" + r.id}`;
    return tipHeader(it.icon || r.icon, pid ? it.name || r.name : r.name, pid ? it.quality : 1, sub) + body +
      `<div class="tip-foot">Click to open ${url.replace("https://www.", "")}</div>`;
  }
  // a plain item, e.g. a reagent
  const it = state.items[id] || {};
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

function refilter() { state.shown = PAGE; state.cascade++; render(); }

$("rows").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const row = e.target.closest(".row");
  if (!row) return;
  const id = Number(row.dataset.id);
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  render();
});
$("profs").addEventListener("click", (e) => {
  const b = e.target.closest(".prof");
  if (!b) return;
  state.profession = b.dataset.prof || null;
  renderProfs(); refilter();
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
