let map;
let originMarker;
let markersMap = new Map(); // id -> L.marker
let allPizzerias = [];
let calculatedPizzerias = [];
let activePopupPizzeriaId = null;

// Default origin: Medborgarplatsen, Södermalm
let currentOrigin = {
  lat: 59.3148,
  lng: 18.0733,
  address: "Medborgarplatsen, Stockholm"
};

// Filter state
const filters = {
  maxTime: 15,
  minRating: 4.0,
  provider: "all",
  category: "all",
  pizza: "Capricciosa",
  maxPrice: 200,
  sortBy: "time",
  travelMode: "walk", // "walk" (default) or "drive"
  diningMode: "pickup", // "pickup" (default base), "dine_in", or "delivery"
  pizzaMode: "standard", // "standard" or "custom"
  selectedIngredients: ["Tomatsås", "Ost", "Basilika"] // Default vid bygg-läge (Margherita)
};

// Colors for providers
const PROVIDER_COLORS = {
  wolt:    "#009de0",
  foodora: "#d70f64",
  own:     "#10b981",
  pickup:  "#6b7280"
};

// Category emoji / label lookup
const CATEGORY_META = {
  classic:   { emoji: "🍕", label: "Kvarterspizzeria" },
  finpizza:  { emoji: "✨", label: "Finpizza" },
  craft:     { emoji: "✨", label: "Finpizza" },
  trattoria: { emoji: "✨", label: "Finpizza" }
};

// ─── GRUNDPIZZOR & INGREDIENSER ──────────────────────────────────────────────

const BASE_PIZZAS = {
  "Margherita": ["Tomatsås", "Ost", "Basilika"],
  "Vesuvio": ["Tomatsås", "Ost", "Skinka"],
  "Capricciosa": ["Tomatsås", "Ost", "Skinka", "Champinjoner"],
  "Quattro Stagioni": ["Tomatsås", "Ost", "Skinka", "Champinjoner", "Räkor", "Kronärtskocka"],
  "Kebabpizza": ["Tomatsås", "Ost", "Kebabkött", "Feferoni", "Kebabsås"]
};

const ALL_INGREDIENTS = [
  { name: "Tomatsås", emoji: "🍅" },
  { name: "Ost", emoji: "🧀" },
  { name: "Skinka", emoji: "🥓" },
  { name: "Champinjoner", emoji: "🍄" },
  { name: "Räkor", emoji: "🦐" },
  { name: "Kronärtskocka", emoji: "🥬" },
  { name: "Kebabkött", emoji: "🥩" },
  { name: "Feferoni", emoji: "🌶️" },
  { name: "Kebabsås", emoji: "🥣" },
  { name: "Basilika", emoji: "🌿" }
];

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  initIngredientPills();
  setupEventListeners();
  await loadPizzerias();
  await recalculateAndRender();
});

// ─── MAP INIT ────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([59.314, 18.070], 14);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  createOriginMarker(currentOrigin.lat, currentOrigin.lng);

  map.on("click", (e) => {
    updateOriginPosition(e.latlng.lat, e.latlng.lng, "Vald punkt på kartan");
  });

  map.on("popupclose", (e) => {
    // Om det var en pizzeriapopup som stängdes av användaren, nollställ aktiv popup
    if (e.popup && e.popup._source && e.popup._source.pizzeriaId === activePopupPizzeriaId) {
      activePopupPizzeriaId = null;
    }
  });
}

function createOriginMarker(lat, lng) {
  if (originMarker) map.removeLayer(originMarker);

  const originIcon = L.divIcon({
    className: "origin-pin-container",
    html: `
      <div class="origin-pin-wrapper">
        <div class="origin-pulse"></div>
        <div class="origin-pin">📍</div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  originMarker = L.marker([lat, lng], { icon: originIcon, draggable: true, zIndexOffset: 1000 }).addTo(map);
  originMarker.bindPopup(`
    <div style="font-weight:bold;padding:4px;">
      📍 Din startposition<br>
      <span style="font-size:11px;font-weight:normal;color:#64748b;">Restid räknas härifrån. Dra mig för att ändra!</span>
    </div>
  `);

  originMarker.on("dragend", async (e) => {
    const p = e.target.getLatLng();
    await updateOriginPosition(p.lat, p.lng, null);
  });
}

// ─── ORIGIN POSITION ─────────────────────────────────────────────────────────

async function updateOriginPosition(lat, lng, addressLabel) {
  currentOrigin.lat = lat;
  currentOrigin.lng = lng;
  originMarker.setLatLng([lat, lng]);

  if (addressLabel) {
    currentOrigin.address = addressLabel;
    document.getElementById("addressInput").value = addressLabel;
  } else {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`);
      if (res.ok) {
        const data = await res.json();
        const road = data.address?.road || "";
        const num  = data.address?.house_number || "";
        const name = road ? `${road} ${num}`.trim() : "Vald plats";
        currentOrigin.address = name;
        document.getElementById("addressInput").value = name;
      }
    } catch {
      currentOrigin.address = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      document.getElementById("addressInput").value = currentOrigin.address;
    }
  }
  await recalculateAndRender();
}

// ─── DATA LOADING ─────────────────────────────────────────────────────────────

async function loadPizzerias() {
  try {
    const res = await fetch("pizzerias.json");
    allPizzerias = await res.json();
  } catch (err) {
    console.error("Kunde inte läsa pizzerias.json", err);
  }
}

// ─── TRAVEL TIME CALCULATION ──────────────────────────────────────────────────

async function recalculateAndRender() {
  const mode = filters.travelMode;
  let durations = null;

  // Använd endast OSRM vid körväg (bil)
  if (mode === "drive") {
    const originCoord = `${currentOrigin.lng},${currentOrigin.lat}`;
    const destCoords  = allPizzerias.map(p => `${p.lng},${p.lat}`).join(";");
    const url = `https://router.project-osrm.org/table/v1/driving/${originCoord};${destCoords}?sources=0`;

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json();
        if (data.durations?.[0]) durations = data.durations[0].slice(1);
      }
    } catch (e) {
      console.warn("OSRM unavailable – using city speed model fallback:", e.message);
    }
  }

  calculatedPizzerias = allPizzerias.map((p, i) => {
    const distanceKm = calculateHaversineKm(currentOrigin.lat, currentOrigin.lng, p.lat, p.lng);
    let travelMinutes;

    // Beräkna alltid bilkörtid (används för leveranspåslag och körfilter)
    let drivingMinutes;
    if (durations && durations[i] != null) {
      drivingMinutes = Math.max(2, Math.round(durations[i] / 60));
    } else {
      const roadKm = distanceKm * 1.35;
      drivingMinutes = Math.max(2, Math.round((roadKm / 22) * 60 + 2));
    }

    if (mode === "walk") {
      // Exakt 14 minuter per km gångväg (faktisk gångsträcka ca 1.3x fågelvägen)
      const walkKm = distanceKm * 1.30;
      travelMinutes = Math.max(1, Math.round(walkKm * 14));
    } else {
      travelMinutes = drivingMinutes;
    }

    // Primary delivery provider
    let primaryProvider = "pickup";
    if (p.delivery.wolt)          primaryProvider = "wolt";
    else if (p.delivery.foodora)  primaryProvider = "foodora";
    else if (p.delivery.own_delivery) primaryProvider = "own";

    return { ...p, travelMinutes, drivingMinutes, distanceKm: parseFloat(distanceKm.toFixed(1)), primaryProvider };
  });

  applyFiltersAndRender();
}

function calculateHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── BYGG PIZZA: MATCHNING & PRISBERÄKNING ───────────────────────────────────

function findBestPizzaMatch(selectedIngredients) {
  const selectedSet = new Set(selectedIngredients);
  let bestMatch = null;
  let bestScore = -1;
  let bestExtras = [];

  for (const [pizzaName, baseIngs] of Object.entries(BASE_PIZZAS)) {
    const baseSet = new Set(baseIngs);

    // Hur många ingredienser i grundpizzan ingår i kundens val?
    let overlap = 0;
    for (const ing of baseIngs) {
      if (selectedSet.has(ing)) overlap++;
    }

    // Extra ingredienser som kunden valt men som INTE finns i grundpizzan
    const extras = selectedIngredients.filter(ing => !baseSet.has(ing));

    // Poäng: prioritera täckning och minst antal saknade ingredienser från basen
    const missingFromBase = baseIngs.length - overlap;
    const score = overlap * 10 - missingFromBase * 2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = pizzaName;
      bestExtras = extras;
    }
  }

  // Om kunden valt ingredienser och det finns extra, eller om det är en perfekt match
  const isExactBase = bestExtras.length === 0 && selectedIngredients.length === BASE_PIZZAS[bestMatch].length;
  const isSpecial = bestExtras.length > 0;

  return {
    basePizza: bestMatch,
    isExactBase,
    isSpecial,
    extraIngredients: bestExtras,
    extraCost: bestExtras.length * 10
  };
}

function calculateCustomBasePrice(pizzeria, matchInfo) {
  const basePrice = pizzeria.pizzas?.[matchInfo.basePizza];
  if (basePrice == null) return null;
  return basePrice + matchInfo.extraCost;
}

// ─── PRISJUSTERING FÖR ÄTA PÅ PLATS / LEVERANS ────────────────────────────────

function getAdjustedPriceNumber(basePrice, pizzeria) {
  if (basePrice == null) return null;
  const isFinpizza = pizzeria.category === "craft" || pizzeria.category === "trattoria" || pizzeria.category === "finpizza";

  let price = basePrice;
  if (filters.diningMode === "dine_in") {
    // Äta inne: +15 kr för kvarterspizzeria, +25 kr för finpizza
    price = basePrice + (isFinpizza ? 25 : 15);
  } else if (filters.diningMode === "delivery") {
    // Leverans (Wolt/Foodora): 30% till 50% ökning baserat på körtid 5-15 min, avrundat till närmaste 5 kr
    const driveMin = pizzeria.drivingMinutes || 8;
    let factor = 0.30;
    if (driveMin <= 5) {
      factor = 0.30;
    } else if (driveMin >= 15) {
      factor = 0.50;
    } else {
      factor = 0.30 + ((driveMin - 5) / 10) * 0.20;
    }
    price = Math.round((basePrice * (1 + factor)) / 5) * 5;
  }

  return price;
}

function formatAdjustedPrice(basePrice, pizzeria) {
  const rounded = getAdjustedPriceNumber(basePrice, pizzeria);
  if (rounded == null) return "Pris ej tillgängligt";
  return filters.diningMode === "delivery" ? `~${rounded} kr` : `${rounded} kr`;
}

function getThreePrices(basePrice, pizzeria) {
  if (basePrice == null) return null;
  const isFinpizza = pizzeria.category === "craft" || pizzeria.category === "trattoria" || pizzeria.category === "finpizza";

  // 1. Avhämtning (grundpris, exakt baspris)
  const pickupPrice = basePrice;

  // 2. Äta inne (+15 kr kvarter, +25 kr finpizza, fast påslag)
  const dineInPrice = basePrice + (isFinpizza ? 25 : 15);

  // 3. Levererat (30% till 50% baserat på körtid 5-15 min, avrundat till närmaste 5 kr)
  let deliveryPrice = null;
  const hasDelivery = pizzeria.delivery && (pizzeria.delivery.wolt || pizzeria.delivery.foodora || pizzeria.delivery.own_delivery || !pizzeria.delivery.pickup_only);
  if (hasDelivery) {
    const driveMin = pizzeria.drivingMinutes || 8;
    let factor = 0.30;
    if (driveMin <= 5) factor = 0.30;
    else if (driveMin >= 15) factor = 0.50;
    else factor = 0.30 + ((driveMin - 5) / 10) * 0.20;
    deliveryPrice = Math.round((basePrice * (1 + factor)) / 5) * 5;
  }

  return {
    pickup: pickupPrice,
    dineIn: dineInPrice,
    delivery: deliveryPrice
  };
}

// ─── FILTERING & SORTING ──────────────────────────────────────────────────────

function applyFiltersAndRender() {
  const isCustom = filters.pizzaMode === "custom";
  const matchInfo = isCustom ? findBestPizzaMatch(filters.selectedIngredients) : null;

  // Uppdatera sammanfattningsrutan för byggläge
  if (isCustom) {
    updateBuildSummaryBox(matchInfo);
  }

  // Kontrollera om vald pizza/byggval kan erbjudas av pizzerian
  const canPizzeriaOffer = (p) => {
    if (isCustom) {
      // Måste ha alla valda ingredienser
      const availableSet = new Set(p.available_ingredients || []);
      const hasAllIngredients = filters.selectedIngredients.every(ing => availableSet.has(ing));
      if (!hasAllIngredients) return false;

      // Om det är en specialpizza (faller utanför ren grundpizza), måste stället erbjuda specialpizza
      if (matchInfo.isSpecial && !p.custom_pizza) {
        return false;
      }

      // Måste ha pris på grundpizzan
      if (p.pizzas?.[matchInfo.basePizza] == null) return false;

      // Prisfilter (med påslag för äta inne / leverans, avrundat)
      const rawBase = calculateCustomBasePrice(p, matchInfo);
      const adjustedPrice = getAdjustedPriceNumber(rawBase, p);
      if (adjustedPrice != null && adjustedPrice > filters.maxPrice) return false;

      return true;
    } else {
      // Standardläge
      const rawBase = p.pizzas?.[filters.pizza];
      if (rawBase == null) return false;
      const adjustedPrice = getAdjustedPriceNumber(rawBase, p);
      if (adjustedPrice != null && adjustedPrice > filters.maxPrice) return false;
      return true;
    }
  };

  // Filtrera baserat på användarens nuvarande filter
  const filtered = calculatedPizzerias.filter(p => {
    if (p.travelMinutes > filters.maxTime) return false;
    if (p.rating < filters.minRating) return false;

    // Kategori-filter
    if (filters.category !== "all") {
      if (filters.category === "finpizza") {
        if (p.category !== "craft" && p.category !== "trattoria" && p.category !== "finpizza") return false;
      } else if (p.category !== filters.category) {
        return false;
      }
    }

    if (filters.provider === "wolt"    && !p.delivery.wolt)          return false;
    if (filters.provider === "foodora" && !p.delivery.foodora)        return false;
    if (filters.provider === "own"     && !p.delivery.own_delivery)   return false;
    if (filters.provider === "pickup"  && !p.delivery.pickup_only)    return false;

    return canPizzeriaOffer(p);
  });

  // Beräkna om fler ställen erbjuder pizzan inom 30 min (bil eller gång) men filtrerats bort av snäva inställningar
  const filteredIds = new Set(filtered.map(p => p.id));
  const availableWithin30Min = calculatedPizzerias.filter(p => {
    if (filteredIds.has(p.id)) return false;
    // Kolla om den klarar pizzerians pizzautbud
    if (!canPizzeriaOffer(p)) return false;
    // p.travelMinutes är redan exakt uträknad för nuvarande startpunkt och valt färdsätt
    return p.travelMinutes <= 30;
  });

  // Visa bara notisen om användaren har valt ett snävare tidsintervall (< 30 min) eller har andra filter som begränsar
  if (availableWithin30Min.length > 0) {
    renderNoticeBanner(availableWithin30Min.length);
  } else {
    renderNoticeBanner(0);
  }

  // Sortering
  filtered.sort((a, b) => {
    if (filters.sortBy === "time") return a.travelMinutes - b.travelMinutes;
    if (filters.sortBy === "rating") return b.rating - a.rating;
    if (filters.sortBy === "reviews") return b.reviews_count - a.reviews_count;
    if (filters.sortBy === "price") {
      const rawA = isCustom ? calculateCustomBasePrice(a, matchInfo) : a.pizzas?.[filters.pizza];
      const rawB = isCustom ? calculateCustomBasePrice(b, matchInfo) : b.pizzas?.[filters.pizza];
      const pa = getAdjustedPriceNumber(rawA, a);
      const pb = getAdjustedPriceNumber(rawB, b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    }
    return 0;
  });

  renderMarkers(filtered, matchInfo);
  renderPizzeriaList(filtered, matchInfo);
}

// ─── NOTICE BANNER ────────────────────────────────────────────────────────────

function renderNoticeBanner(extraCount) {
  const container = document.getElementById("noticeBannerContainer");
  if (!container) return;

  if (extraCount > 0) {
    const isDrive = filters.travelMode === "drive";
    const modeText = isDrive ? "bilväg" : "gångväg";

    container.innerHTML = `
      <div class="notice-banner">
        <div class="notice-banner-text">
          <span>💡</span>
          <span><strong>${extraCount} st till</strong> erbjuder detta inom 30 min ${modeText}</span>
        </div>
        <button class="notice-banner-btn" id="expandFiltersBtn">Visa alla</button>
      </div>
    `;

    document.getElementById("expandFiltersBtn")?.addEventListener("click", () => {
      // Öka restid till 30 min och sänk betyg till minsta för att visa alla
      const sldr = document.getElementById("timeSlider");
      sldr.value = 30;
      filters.maxTime = 30;
      document.getElementById("timeVal").textContent = "max 30 min";

      const rSldr = document.getElementById("ratingSlider");
      rSldr.value = 3.5;
      filters.minRating = 3.5;
      document.getElementById("ratingVal").textContent = "3.5 ★";

      applyFiltersAndRender();
    });
  } else {
    container.innerHTML = "";
  }
}

// ─── MARKERS ──────────────────────────────────────────────────────────────────

function renderMarkers(pizzerias, matchInfo) {
  const modeLabel = filters.travelMode === "walk" ? "gångväg" : "körväg";
  const isCustom = filters.pizzaMode === "custom";

  const newPizzeriaMap = new Map();
  pizzerias.forEach(p => newPizzeriaMap.set(p.id, p));

  // 1. Dölj/ta bort markörer för pizzerior som inte längre finns i filtrerat resultat
  for (const [id, marker] of markersMap.entries()) {
    if (!newPizzeriaMap.has(id)) {
      if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
      if (activePopupPizzeriaId === id) {
        activePopupPizzeriaId = null;
      }
    }
  }

  // 2. För alla pizzerior i resultatet, skapa eller uppdatera markör och popup
  pizzerias.forEach(p => {
    const pinColor = PROVIDER_COLORS[p.primaryProvider] || "#6b7280";
    const isFinpizza = p.category === "craft" || p.category === "trattoria" || p.category === "finpizza";
    const catLabel = isFinpizza ? "Finpizza" : "Kvarterspizzeria";
    const catEmoji = isFinpizza ? "✨" : "🍕";

    let pizzaNameLabel = filters.pizza;
    let basePrice = p.pizzas?.[filters.pizza];

    if (isCustom && matchInfo) {
      basePrice = calculateCustomBasePrice(p, matchInfo);
      pizzaNameLabel = matchInfo.isSpecial ? `Specialpizza (${matchInfo.basePizza})` : matchInfo.basePizza;
    }
    const currentPriceText = basePrice != null ? formatAdjustedPrice(basePrice, p) : "Pris ej tillgängligt";

    let orderBtns = "";
    if (p.delivery.wolt) {
      const href = p.wolt_url || `https://wolt.com/sv/swe/stockholm/search?q=${encodeURIComponent(p.name)}`;
      orderBtns += `<a href="${href}" target="_blank" rel="noopener" class="popup-btn popup-btn-wolt">Wolt</a>`;
    }
    if (p.delivery.foodora) {
      const href = p.foodora_url || `https://www.foodora.se/restaurants?search=${encodeURIComponent(p.name)}`;
      orderBtns += `<a href="${href}" target="_blank" rel="noopener" class="popup-btn popup-btn-foodora">Foodora</a>`;
    }
    orderBtns += `<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener" class="popup-btn popup-btn-map">Karta</a>`;

    const phoneHtml = p.phone ? `<div class="popup-phone">📞 <a href="tel:${p.phone.replace(/[\s-]/g, '')}" class="phone-link">${p.phone}</a></div>` : "";

    const popupHtml = `
      <div class="popup-container compact">
        <div class="popup-header-row">
          <div class="popup-title">${p.name}</div>
          <span class="popup-category-pill">${catEmoji} ${catLabel}</span>
        </div>
        <div class="popup-address">${p.address}, ${p.neighborhood}</div>

        <div class="popup-metrics-compact">
          <span class="popup-metric-rating">★ ${p.rating} <span style="font-weight:normal;color:#64748b;font-size:0.72rem;">(${p.reviews_count})</span></span>
          <span class="popup-metric-time">${filters.travelMode === "walk" ? "🚶" : "🚗"} ${p.travelMinutes} min</span>
          <span class="popup-metric-price">${currentPriceText}</span>
        </div>

        <div class="popup-footer-row">
          <div class="popup-hours">🕒 ${p.hours?.display || "Öppettider okända"}</div>
          ${phoneHtml}
        </div>

        <div class="popup-buttons">${orderBtns}</div>
      </div>
    `;

    let marker = markersMap.get(p.id);

    if (!marker) {
      // Skapa ny markör en enda gång
      const customIcon = L.divIcon({
        className: "custom-pin-wrapper",
        html: `<div class="custom-pin" style="background:${pinColor};"><div class="custom-pin-inner">🍕</div></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 34],
        popupAnchor: [0, -32]
      });

      marker = L.marker([p.lat, p.lng], { icon: customIcon });
      marker.pizzeriaId = p.id;
      marker.bindPopup(popupHtml);

      marker.on("popupopen", () => {
        activePopupPizzeriaId = p.id;
      });

      marker.on("click", () => {
        activePopupPizzeriaId = p.id;
        highlightCard(p.id, true);
      });

      markersMap.set(p.id, marker);
    } else {
      // Uppdatera befintlig markörs popup-innehåll sömlöst utan flimmer
      marker.setPopupContent(popupHtml);
    }

    // Se till att markören är synlig på kartan
    if (!map.hasLayer(marker)) {
      marker.addTo(map);
    }
  });

  // Om den öppna popupen är öppen, se till att den är uppdaterad och öppen
  if (activePopupPizzeriaId && markersMap.has(activePopupPizzeriaId)) {
    const activeMarker = markersMap.get(activePopupPizzeriaId);
    if (!activeMarker.isPopupOpen()) {
      activeMarker.openPopup();
    }
  }
}

// ─── LIST CARDS ───────────────────────────────────────────────────────────────

function renderPizzeriaList(pizzerias, matchInfo) {
  const countEl = document.getElementById("resultsCount");
  const listEl  = document.getElementById("pizzeriaList");
  const modeLabel = filters.travelMode === "walk" ? "gångväg" : "körväg";
  const modeIcon  = filters.travelMode === "walk" ? "🚶" : "🚗";
  const isCustom  = filters.pizzaMode === "custom";

  countEl.textContent = `${pizzerias.length} platser hittade`;

  // Uppdatera flikens resultatbadge och snabbknappar
  const badgeEl = document.getElementById("resultsBadge");
  if (badgeEl) {
    const prevCount = badgeEl.textContent;
    badgeEl.textContent = pizzerias.length;
    if (prevCount !== String(pizzerias.length)) {
      badgeEl.classList.remove("pulsing");
      void badgeEl.offsetWidth; // Force reflow
      badgeEl.classList.add("pulsing");
    }
  }

  document.querySelectorAll(".quick-count").forEach(el => {
    el.textContent = pizzerias.length;
  });

  if (pizzerias.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:2.5rem 1rem;color:#64748b;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">🔍</div>
        <div style="font-weight:700;font-size:1rem;color:#1e293b;">Inga pizzerior matchar dina val</div>
        <p style="font-size:0.85rem;margin-top:0.35rem;">
          ${isCustom 
            ? "Vissa ställen saknar dina valda ingredienser eller erbjuder inte specialpizza. Prova att ta bort någon ingrediens eller öka parametrarna." 
            : "Prova att öka max restid, sänka minimibetyget eller tillåta fler leverantörer."}
        </p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = pizzerias.map(p => {
    const isFinpizza = p.category === "craft" || p.category === "trattoria" || p.category === "finpizza";
    const catLabel = isFinpizza ? "Finpizza" : "Kvarterspizzeria";
    const catEmoji = isFinpizza ? "✨" : "🍕";
    const catBadgeClass = isFinpizza ? "badge-finpizza" : "badge-classic";

    let basePrice = p.pizzas?.[filters.pizza];
    let priceSubtitle = "";

    if (isCustom && matchInfo) {
      basePrice = calculateCustomBasePrice(p, matchInfo);
      if (matchInfo.isSpecial) {
        priceSubtitle += `<div style="font-size:0.7rem;color:#ea580c;text-align:right;">Special (+${matchInfo.extraCost} kr)</div>`;
      }
    }

    if (filters.diningMode === "dine_in") {
      const extraDineIn = (p.category === "craft" || p.category === "trattoria" || p.category === "finpizza") ? "+25 kr" : "+15 kr";
      priceSubtitle += `<div style="font-size:0.68rem;color:#0284c7;text-align:right;">Äta inne (${extraDineIn})</div>`;
    } else if (filters.diningMode === "delivery") {
      const driveMin = p.drivingMinutes || 8;
      let pct = 30;
      if (driveMin <= 5) pct = 30;
      else if (driveMin >= 15) pct = 50;
      else pct = Math.round(30 + ((driveMin - 5) / 10) * 20);
      priceSubtitle += `<div style="font-size:0.68rem;color:#d97706;text-align:right;">Leverans (+${pct}%)</div>`;
    }

    const prices = getThreePrices(basePrice, p);
    let priceRowsHtml = "";

    if (!prices) {
      priceRowsHtml = `<div class="card-price-unknown">Pris ej tillgängligt</div>`;
    } else {
      const activeMode = filters.diningMode;
      priceRowsHtml = `
        <div class="card-prices-grid">
          <div class="card-price-pill ${activeMode === "pickup" ? "active" : ""}">
            <span class="card-price-pill-lbl">🥡 Avhämtning</span>
            <span class="card-price-pill-val">${prices.pickup} kr</span>
          </div>
          <div class="card-price-pill ${activeMode === "dine_in" ? "active" : ""}">
            <span class="card-price-pill-lbl">🍽️ Äta inne</span>
            <span class="card-price-pill-val">${prices.dineIn} kr</span>
          </div>
          <div class="card-price-pill ${activeMode === "delivery" ? "active" : ""}">
            <span class="card-price-pill-lbl">🛵 Levererat</span>
            <span class="card-price-pill-val">${prices.delivery != null ? `~${prices.delivery} kr` : '<span class="price-na">Ej lev.</span>'}</span>
          </div>
        </div>
      `;
    }

    const currentPriceBadge = basePrice != null
      ? `<div class="card-current-price"><span class="metric-price">${formatAdjustedPrice(basePrice, p)}</span>${priceSubtitle}</div>`
      : `<span class="metric-price-unknown">Pris saknas</span>`;

    let deliveryBadges = "";
    if (p.delivery.wolt)          deliveryBadges += `<span class="badge badge-wolt">Wolt</span>`;
    if (p.delivery.foodora)       deliveryBadges += `<span class="badge badge-foodora">Foodora</span>`;
    if (p.delivery.own_delivery)  deliveryBadges += `<span class="badge badge-own">Egen</span>`;
    if (p.delivery.pickup_only)   deliveryBadges += `<span class="badge badge-pickup">Ingen leverans</span>`;
    if (p.delivery.unknown)       deliveryBadges += `<span class="badge badge-unknown">Leverans okänd</span>`;

    const phoneHtml = p.phone ? `<div class="phone-text">📞 <a href="tel:${p.phone.replace(/[\s-]/g, '')}" class="phone-link" onclick="event.stopPropagation()">${p.phone}</a></div>` : "";

    return `
      <div class="pizzeria-card" id="card-${p.id}"
           onclick="selectPizzeria('${p.id}', ${p.lat}, ${p.lng})"
           onmouseenter="hoverPizzeria('${p.id}', ${p.lat}, ${p.lng})">
        <div class="card-top">
          <div class="pizzeria-name">${p.name}</div>
          ${currentPriceBadge}
        </div>
        <div class="pizzeria-address">${p.address} • ${p.neighborhood}</div>

        <div class="card-category-desc">
          ${catEmoji} <strong>${catLabel}</strong> — ${p.category_desc}
        </div>

        ${priceRowsHtml}

        <div class="hours-text">🕒 ${p.hours?.display || "Öppettider okända"}</div>
        ${phoneHtml}
        <div class="badges-row">
          <span class="badge ${catBadgeClass}">${catEmoji} ${catLabel}</span>
          ${deliveryBadges}
        </div>
        <div class="card-metrics">
          <div class="metric-item metric-rating">
            <span>★ ${p.rating}</span>
            <span style="font-weight:normal;color:#64748b;font-size:0.75rem;">(${p.reviews_count})</span>
          </div>
          <div class="metric-item metric-time">
            <span>${modeIcon} ${p.travelMinutes} min</span>
            <span style="font-weight:normal;color:#64748b;font-size:0.75rem;">(${p.distanceKm} km)</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ─── CARD INTERACTION ─────────────────────────────────────────────────────────

window.hoverPizzeria = function(id, lat, lng) {
  highlightCard(id, false);
  const m = markersMap.get(id);
  if (m) {
    m.openPopup();
    if (!map.getBounds().contains([lat, lng])) {
      map.panTo([lat, lng], { animate: true, duration: 0.4 });
    }
  }
};

window.selectPizzeria = function(id, lat, lng) {
  highlightCard(id, true);
  map.flyTo([lat, lng], 16, { duration: 0.8 });

  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
  }

  const m = markersMap.get(id);
  if (m) setTimeout(() => m.openPopup(), 400);
};

function highlightCard(id, shouldScroll = true) {
  // Om användaren klickar på en nål på kartan och inte står i resultatfliken, byt till resultat
  const resultsTab = document.getElementById("stepViewResults");
  if (resultsTab && !resultsTab.classList.contains("active")) {
    document.querySelectorAll("#stepsNav .step-btn").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-step") === "results");
    });
    document.getElementById("stepViewPizza")?.classList.remove("active");
    document.getElementById("stepViewSettings")?.classList.remove("active");
    resultsTab.classList.add("active");
  }

  document.querySelectorAll(".pizzeria-card").forEach(c => c.classList.remove("selected"));
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.classList.add("selected");
    if (shouldScroll) {
      setTimeout(() => {
        const container = document.getElementById("pizzeriaList");
        if (container) {
          const cardRect = card.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const relativeCardTop = cardRect.top - containerRect.top + container.scrollTop;
          const targetScrollTop = relativeCardTop - (container.clientHeight / 2) + (card.clientHeight / 2);
          const startScrollTop = container.scrollTop;
          const distance = targetScrollTop - startScrollTop;
          const duration = 350;
          const startTime = performance.now();

          // Mjuk inbromsande cubic bezier
          const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

          const stepScroll = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            container.scrollTop = startScrollTop + distance * easeOutCubic(progress);
            if (progress < 1) {
              requestAnimationFrame(stepScroll);
            }
          };

          requestAnimationFrame(stepScroll);
        }
      }, 30);
    }
  }
}

// ─── INGREDIENT PILLS SETUP ───────────────────────────────────────────────────

function initIngredientPills() {
  const container = document.getElementById("ingredientPills");
  if (!container) return;

  container.innerHTML = ALL_INGREDIENTS.map(ing => {
    const isSelected = filters.selectedIngredients.includes(ing.name);
    return `
      <button class="ingredient-pill ${isSelected ? "selected" : ""}" data-ingredient="${ing.name}">
        <span>${ing.emoji}</span>
        <span>${ing.name}</span>
      </button>
    `;
  }).join("");

  container.querySelectorAll(".ingredient-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const ingName = btn.getAttribute("data-ingredient");
      if (filters.selectedIngredients.includes(ingName)) {
        // Ta inte bort om det bara finns 1 ingrediens kvar
        if (filters.selectedIngredients.length > 1) {
          filters.selectedIngredients = filters.selectedIngredients.filter(x => x !== ingName);
          btn.classList.remove("selected");
        }
      } else {
        filters.selectedIngredients.push(ingName);
        btn.classList.add("selected");
      }
      applyFiltersAndRender();
    });
  });
}

function updateBuildSummaryBox(matchInfo) {
  const titleEl = document.getElementById("matchedPizzaName");
  const badgeEl = document.getElementById("matchedBadge");
  const detailsEl = document.getElementById("matchedPizzaDetails");

  if (!titleEl || !badgeEl || !detailsEl) return;

  if (matchInfo.isExactBase) {
    titleEl.textContent = `🍕 ${matchInfo.basePizza}`;
    badgeEl.textContent = "Exakt grundmatch";
    badgeEl.className = "build-match-badge";
    detailsEl.textContent = `Valda ingredienser: ${filters.selectedIngredients.join(", ")}`;
  } else if (!matchInfo.isSpecial) {
    titleEl.textContent = `🍕 ${matchInfo.basePizza} (mindre ingredienser)`;
    badgeEl.textContent = "Grundmatch";
    badgeEl.className = "build-match-badge";
    detailsEl.textContent = `Bästa bas: ${matchInfo.basePizza}. Valda: ${filters.selectedIngredients.join(", ")}`;
  } else {
    titleEl.textContent = `✨ Specialpizza (Bas: ${matchInfo.basePizza})`;
    badgeEl.textContent = `Special (+${matchInfo.extraCost} kr)`;
    badgeEl.className = "build-match-badge special";
    detailsEl.textContent = `Extra ingredienser (+10 kr/st): ${matchInfo.extraIngredients.join(", ")}`;
  }
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

function setupEventListeners() {

  // ─── 3-STEGS HUVUDFLIKAR NAVIGERING ──────────────────────────────────────────
  const switchStep = (stepName) => {
    document.querySelectorAll("#stepsNav .step-btn").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-step") === stepName);
    });

    document.getElementById("stepViewPizza")?.classList.toggle("active", stepName === "pizza");
    document.getElementById("stepViewSettings")?.classList.toggle("active", stepName === "settings");
    document.getElementById("stepViewResults")?.classList.toggle("active", stepName === "results");
  };

  document.querySelectorAll("#stepsNav .step-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      switchStep(btn.getAttribute("data-step"));
    });
  });

  // Knappar i flik 1 & 2
  document.getElementById("toSettingsBtn")?.addEventListener("click", () => switchStep("settings"));
  document.getElementById("directToResultsBtn1")?.addEventListener("click", () => switchStep("results"));
  document.getElementById("backToPizzaBtn")?.addEventListener("click", () => switchStep("pizza"));
  document.getElementById("toResultsBtn")?.addEventListener("click", () => switchStep("results"));

  // Mode Tabs: Standard vs Bygg egen pizza
  document.querySelectorAll("#pizzaModeGroup .mode-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pizzaModeGroup .mode-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.pizzaMode = btn.getAttribute("data-mode");

      const standardSec = document.getElementById("standardPizzaSection");
      const customSec = document.getElementById("customPizzaSection");

      if (filters.pizzaMode === "standard") {
        standardSec.style.display = "block";
        customSec.style.display = "none";
        filters.maxPrice = parseInt(document.getElementById("priceSlider").value);
      } else {
        standardSec.style.display = "none";
        customSec.style.display = "block";
        filters.maxPrice = parseInt(document.getElementById("customPriceSlider").value);
      }

      applyFiltersAndRender();
    });
  });

  // Dining Mode Toggle (Avhämtning, Äta inne, Leverans)
  document.querySelectorAll("#diningModeGroup .mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#diningModeGroup .mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.diningMode = btn.getAttribute("data-dining");

      const hintEl = document.getElementById("diningModeHint");
      if (hintEl) {
        if (filters.diningMode === "pickup") {
          hintEl.textContent = "Baspris gäller vid avhämtning.";
        } else if (filters.diningMode === "dine_in") {
          hintEl.textContent = "Äta inne: +15 kr (kvarter) / +25 kr (finpizza).";
        } else if (filters.diningMode === "delivery") {
          hintEl.textContent = "Leverans (Wolt/Foodora): +30% till +50% baserat på köravstånd (5–15 min bil), avrundat till närmaste 5 kr.";
        }
      }

      applyFiltersAndRender();
    });
  });

  // Travel Mode Toggle (Gångtid / Körtid piller)
  document.querySelectorAll("#travelModeGroup .pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#travelModeGroup .pill-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.travelMode = btn.getAttribute("data-mode");

      const isDrive = filters.travelMode === "drive";
      const timeLabel = document.getElementById("timeLabel");
      if (timeLabel) timeLabel.textContent = isDrive ? "🚗 Körtid" : "🚶 Gångtid";

      recalculateAndRender();
    });
  });

  // Travel Time Slider
  document.getElementById("timeSlider").addEventListener("input", e => {
    filters.maxTime = parseInt(e.target.value);
    document.getElementById("timeVal").textContent = `max ${filters.maxTime} min`;
    applyFiltersAndRender();
  });

  // Rating Slider
  document.getElementById("ratingSlider").addEventListener("input", e => {
    filters.minRating = parseFloat(e.target.value);
    document.getElementById("ratingVal").textContent = `${filters.minRating.toFixed(1)} ★`;
    applyFiltersAndRender();
  });

  // Standard Price Slider
  document.getElementById("priceSlider").addEventListener("input", e => {
    filters.maxPrice = parseInt(e.target.value);
    document.getElementById("priceVal").textContent = `${filters.maxPrice} kr`;
    applyFiltersAndRender();
  });

  // Custom Price Slider
  document.getElementById("customPriceSlider").addEventListener("input", e => {
    filters.maxPrice = parseInt(e.target.value);
    document.getElementById("customPriceVal").textContent = `${filters.maxPrice} kr max`;
    applyFiltersAndRender();
  });

  // Pizza Dropdown (Standard)
  document.getElementById("pizzaSelect").addEventListener("change", e => {
    filters.pizza = e.target.value;
    applyFiltersAndRender();
  });

  // Sort Dropdown
  document.getElementById("sortSelect").addEventListener("change", e => {
    filters.sortBy = e.target.value;
    applyFiltersAndRender();
  });

  // Category Pills
  document.querySelectorAll("#categoryPills .pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#categoryPills .pill-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.category = btn.getAttribute("data-category");
      applyFiltersAndRender();
    });
  });

  // Delivery Pills
  document.querySelectorAll("#deliveryPills .pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#deliveryPills .pill-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.provider = btn.getAttribute("data-provider");
      applyFiltersAndRender();
    });
  });

  // Address Search
  const searchBtn   = document.getElementById("searchAddressBtn");
  const addressInput = document.getElementById("addressInput");

  const executeGeocoding = async () => {
    const query = addressInput.value.trim();
    if (!query) return;
    searchBtn.style.opacity = "0.5";
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ", Stockholm")}&limit=1`);
      if (res.ok) {
        const results = await res.json();
        if (results?.length > 0) {
          const lat = parseFloat(results[0].lat);
          const lon = parseFloat(results[0].lon);
          await updateOriginPosition(lat, lon, query);
          map.flyTo([lat, lon], 15);
        } else {
          alert(`Kunde inte hitta "${query}". Försök med en gatuadress eller klicka direkt på kartan.`);
        }
      }
    } catch (e) {
      console.error("Geocoding failed:", e);
    } finally {
      searchBtn.style.opacity = "1";
    }
  };

  searchBtn.addEventListener("click", executeGeocoding);
  addressInput.addEventListener("keydown", e => { if (e.key === "Enter") executeGeocoding(); });

  // Mobile Drawer Toggle
  const mobileHandle  = document.getElementById("mobileHandle");
  const sidebar       = document.getElementById("sidebar");
  const sidebarHeader = document.querySelector(".sidebar-header");

  const toggleDrawer = () => sidebar.classList.toggle("open");

  if (mobileHandle) mobileHandle.addEventListener("click", toggleDrawer);
  if (sidebarHeader && window.innerWidth <= 768) sidebarHeader.addEventListener("click", toggleDrawer);
}
