// Pizzakartan – Södermalm Application Logic

let map;
let originMarker;
let pizzeriaMarkers = [];
let allPizzerias = [];
let calculatedPizzerias = [];

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
  travelMode: "drive"  // "drive" or "walk"
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

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
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

    if (mode === "walk") {
      // Exakt 14 minuter per km gångväg (faktisk gångsträcka ca 1.3x fågelvägen)
      const walkKm = distanceKm * 1.30;
      travelMinutes = Math.max(1, Math.round(walkKm * 14));
    } else {
      if (durations && durations[i] != null) {
        travelMinutes = Math.max(2, Math.round(durations[i] / 60));
      } else {
        const roadKm = distanceKm * 1.35;
        // 22 km/h inner-city driving average + 2 min buffer
        travelMinutes = Math.max(2, Math.round((roadKm / 22) * 60 + 2));
      }
    }

    // Primary delivery provider
    let primaryProvider = "pickup";
    if (p.delivery.wolt)          primaryProvider = "wolt";
    else if (p.delivery.foodora)  primaryProvider = "foodora";
    else if (p.delivery.own_delivery) primaryProvider = "own";

    return { ...p, travelMinutes, distanceKm: parseFloat(distanceKm.toFixed(1)), primaryProvider };
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

// ─── FILTERING & SORTING ──────────────────────────────────────────────────────

function applyFiltersAndRender() {
  const filtered = calculatedPizzerias.filter(p => {
    if (p.travelMinutes > filters.maxTime) return false;
    if (p.rating < filters.minRating) return false;

    // Kategori-filtrering med sammanslagen Finpizza (craft + trattoria)
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

    // Filtrera bort pizzerior som inte serverar den valda pizzatypen (t.ex. Kebabpizza)
    const pizzaPrice = p.pizzas?.[filters.pizza];
    if (pizzaPrice === undefined || pizzaPrice === null) return false;

    // Prisfilter mot maxpris
    if (pizzaPrice > filters.maxPrice) return false;
    return true;
  });

  // Sort with unknown-price items always last when sorting by price
  filtered.sort((a, b) => {
    if (filters.sortBy === "time") return a.travelMinutes - b.travelMinutes;
    if (filters.sortBy === "rating") return b.rating - a.rating;
    if (filters.sortBy === "reviews") return b.reviews_count - a.reviews_count;
    if (filters.sortBy === "price") {
      const pa = a.pizzas?.[filters.pizza];
      const pb = b.pizzas?.[filters.pizza];
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;   // unknown goes after known
      if (pb == null) return -1;
      return pa - pb;
    }
    return 0;
  });

  renderMarkers(filtered);
  renderPizzeriaList(filtered);
}

// ─── MARKERS ──────────────────────────────────────────────────────────────────

function renderMarkers(pizzerias) {
  pizzeriaMarkers.forEach(m => map.removeLayer(m));
  pizzeriaMarkers = [];

  const modeLabel = filters.travelMode === "walk" ? "gångväg" : "körväg";

  pizzerias.forEach(p => {
    const pinColor = PROVIDER_COLORS[p.primaryProvider] || "#6b7280";
    const isFinpizza = p.category === "craft" || p.category === "trattoria" || p.category === "finpizza";
    const catLabel = isFinpizza ? "Finpizza" : "Kvarterspizzeria";
    const catEmoji = isFinpizza ? "✨" : "🍕";
    const pizzaPrice = p.pizzas?.[filters.pizza];
    const priceText  = pizzaPrice != null ? `${pizzaPrice} kr` : "Pris ej tillgängligt";

    const customIcon = L.divIcon({
      className: "custom-pin-wrapper",
      html: `<div class="custom-pin" style="background:${pinColor};"><div class="custom-pin-inner">🍕</div></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -32]
    });

    const marker = L.marker([p.lat, p.lng], { icon: customIcon }).addTo(map);

    // Delivery badges
    let deliveryBadges = "";
    if (p.delivery.wolt)          deliveryBadges += `<span class="badge badge-wolt">Wolt</span> `;
    if (p.delivery.foodora)       deliveryBadges += `<span class="badge badge-foodora">Foodora</span> `;
    if (p.delivery.own_delivery)  deliveryBadges += `<span class="badge badge-own">Egen utkörning</span> `;
    if (p.delivery.pickup_only)   deliveryBadges += `<span class="badge badge-pickup">Ingen leverans</span> `;
    if (p.delivery.unknown)       deliveryBadges += `<span class="badge badge-unknown">Leverans okänd</span> `;

    // Order buttons
    let orderBtns = "";
    if (p.delivery.wolt) {
      const href = p.wolt_url || `https://wolt.com/sv/swe/stockholm/search?q=${encodeURIComponent(p.name)}`;
      orderBtns += `<a href="${href}" target="_blank" rel="noopener" class="popup-btn popup-btn-wolt">Öppna Wolt</a>`;
    }
    if (p.delivery.foodora) {
      const href = p.foodora_url || `https://www.foodora.se/restaurants?search=${encodeURIComponent(p.name)}`;
      orderBtns += `<a href="${href}" target="_blank" rel="noopener" class="popup-btn popup-btn-foodora">Öppna Foodora</a>`;
    }
    orderBtns += `<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener" class="popup-btn popup-btn-map">Navigera</a>`;

    const popupHtml = `
      <div class="popup-container">
        <div class="popup-title">${p.name}</div>
        <div class="popup-address">${p.address}, ${p.neighborhood}</div>

        <div class="popup-category-info">
          ${catEmoji} <strong>${catLabel}</strong> — ${p.category_desc}
        </div>

        <div class="popup-metrics">
          <span style="color:#b45309;">★ ${p.rating} (${p.reviews_count})</span>
          <span style="color:#0369a1;">${filters.travelMode === "walk" ? "🚶" : "🚗"} ${p.travelMinutes} min ${modeLabel}</span>
        </div>

        <div class="popup-pizza-price">
          <span>${filters.pizza}:</span>
          <span style="${pizzaPrice == null ? "color:#94a3b8;font-style:italic;" : ""}">${priceText}</span>
        </div>

        <div style="margin-bottom:0.5rem;font-size:0.75rem;color:#475569;">
          🕒 ${p.hours?.display || "Öppettider okända"}
        </div>

        <div style="margin-bottom:0.65rem;">${deliveryBadges}</div>
        <div class="popup-buttons">${orderBtns}</div>
      </div>
    `;

    marker.bindPopup(popupHtml);
    marker.pizzeriaId = p.id;
    pizzeriaMarkers.push(marker);
    marker.on("click", () => highlightCard(p.id, false));
  });
}

// ─── LIST CARDS ───────────────────────────────────────────────────────────────

function renderPizzeriaList(pizzerias) {
  const countEl = document.getElementById("resultsCount");
  const listEl  = document.getElementById("pizzeriaList");
  const modeLabel = filters.travelMode === "walk" ? "gångväg" : "körväg";
  const modeIcon  = filters.travelMode === "walk" ? "🚶" : "🚗";

  countEl.textContent = `${pizzerias.length} platser hittade`;

  if (pizzerias.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:2.5rem 1rem;color:#64748b;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">🔍</div>
        <div style="font-weight:700;font-size:1rem;color:#1e293b;">Inga pizzerior matchar dina filter</div>
        <p style="font-size:0.85rem;margin-top:0.35rem;">Prova att öka max restid, sänka minimibetyget eller tillåta fler leverantörer.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = pizzerias.map(p => {
    const isFinpizza = p.category === "craft" || p.category === "trattoria" || p.category === "finpizza";
    const catLabel = isFinpizza ? "Finpizza" : "Kvarterspizzeria";
    const catEmoji = isFinpizza ? "✨" : "🍕";
    const catBadgeClass = isFinpizza ? "badge-finpizza" : "badge-classic";

    const pizzaPrice = p.pizzas?.[filters.pizza];
    const priceDisplay = pizzaPrice != null
      ? `<span class="metric-price">${pizzaPrice} kr</span>`
      : `<span class="metric-price-unknown">Pris ej tillgängligt</span>`;

    let deliveryBadges = "";
    if (p.delivery.wolt)          deliveryBadges += `<span class="badge badge-wolt">Wolt</span>`;
    if (p.delivery.foodora)       deliveryBadges += `<span class="badge badge-foodora">Foodora</span>`;
    if (p.delivery.own_delivery)  deliveryBadges += `<span class="badge badge-own">Egen</span>`;
    if (p.delivery.pickup_only)   deliveryBadges += `<span class="badge badge-pickup">Ingen</span>`;
    if (p.delivery.unknown)       deliveryBadges += `<span class="badge badge-unknown">Leverans okänd</span>`;

    return `
      <div class="pizzeria-card" id="card-${p.id}"
           onclick="selectPizzeria('${p.id}', ${p.lat}, ${p.lng})"
           onmouseenter="hoverPizzeria('${p.id}', ${p.lat}, ${p.lng})">
        <div class="card-top">
          <div class="pizzeria-name">${p.name}</div>
          ${priceDisplay}
        </div>
        <div class="pizzeria-address">${p.address} • ${p.neighborhood}</div>
        <div class="hours-text">🕒 ${p.hours?.display || "Öppettider okända"}</div>
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
  const m = pizzeriaMarkers.find(m => m.pizzeriaId === id);
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

  const m = pizzeriaMarkers.find(m => m.pizzeriaId === id);
  if (m) setTimeout(() => m.openPopup(), 400);
};

function highlightCard(id, shouldScroll = true) {
  document.querySelectorAll(".pizzeria-card").forEach(c => c.classList.remove("selected"));
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.classList.add("selected");
    if (shouldScroll) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

function setupEventListeners() {

  // Travel Mode Toggle (Bil / Gång)
  document.querySelectorAll("#travelModeGroup .mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#travelModeGroup .mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.travelMode = btn.getAttribute("data-mode");

      const isDrive = filters.travelMode === "drive";
      const timeLabel = document.getElementById("timeLabel");
      timeLabel.textContent = isDrive ? "🚗 Max körtid" : "🚶 Max gångtid";

      // Behåller tidsintervallet och vald tid oförändrad!
      recalculateAndRender();
    });
  });

  // Travel Time Slider
  document.getElementById("timeSlider").addEventListener("input", e => {
    filters.maxTime = parseInt(e.target.value);
    document.getElementById("timeVal").textContent = `${filters.maxTime} min`;
    applyFiltersAndRender();
  });

  // Rating Slider
  document.getElementById("ratingSlider").addEventListener("input", e => {
    filters.minRating = parseFloat(e.target.value);
    document.getElementById("ratingVal").textContent = `${filters.minRating.toFixed(1)} ★`;
    applyFiltersAndRender();
  });

  // Price Slider
  document.getElementById("priceSlider").addEventListener("input", e => {
    filters.maxPrice = parseInt(e.target.value);
    document.getElementById("priceVal").textContent = `${filters.maxPrice} kr`;
    applyFiltersAndRender();
  });

  // Pizza Dropdown
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
