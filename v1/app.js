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
  pizza: "Capricciosa",
  maxPrice: 200,
  sortBy: "time"
};

// Colors for providers
const PROVIDER_COLORS = {
  wolt: "#009de0",
  foodora: "#d70f64",
  own: "#10b981",
  pickup: "#6b7280"
};

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  setupEventListeners();
  await loadPizzerias();
  await updateDrivingTimesAndRender();
});

// Initialize Leaflet Map
function initMap() {
  map = L.map("map", {
    zoomControl: true
  }).setView([59.314, 18.070], 14);

  // Clean, modern map tiles (CartoDB Positron)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  // Setup draggable origin marker
  createOriginMarker(currentOrigin.lat, currentOrigin.lng);

  // Map click to move origin
  map.on("click", (e) => {
    updateOriginPosition(e.latlng.lat, e.latlng.lng, "Vald punkt på kartan");
  });
}

// Create or update origin marker
function createOriginMarker(lat, lng) {
  if (originMarker) {
    map.removeLayer(originMarker);
  }

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

  originMarker = L.marker([lat, lng], {
    icon: originIcon,
    draggable: true,
    zIndexOffset: 1000
  }).addTo(map);

  originMarker.bindPopup(`
    <div style="font-weight: bold; padding: 4px;">
      📍 Din startposition<br>
      <span style="font-size: 11px; font-weight: normal; color: #64748b;">Körtid räknas härifrån. Dra mig för att ändra!</span>
    </div>
  `);

  originMarker.on("dragend", async (event) => {
    const position = event.target.getLatLng();
    await updateOriginPosition(position.lat, position.lng, null);
  });
}

async function updateOriginPosition(lat, lng, addressLabel) {
  currentOrigin.lat = lat;
  currentOrigin.lng = lng;
  originMarker.setLatLng([lat, lng]);

  if (addressLabel) {
    currentOrigin.address = addressLabel;
    document.getElementById("addressInput").value = addressLabel;
  } else {
    // Reverse geocode optionally
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`);
      if (res.ok) {
        const data = await res.json();
        const road = data.address?.road || "";
        const houseNum = data.address?.house_number || "";
        const name = road ? `${road} ${houseNum}`.trim() : "Vald plats";
        currentOrigin.address = name;
        document.getElementById("addressInput").value = name;
      }
    } catch {
      currentOrigin.address = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      document.getElementById("addressInput").value = currentOrigin.address;
    }
  }

  await updateDrivingTimesAndRender();
}

// Load pizzeria JSON
async function loadPizzerias() {
  try {
    const res = await fetch("pizzerias.json");
    allPizzerias = await res.json();
  } catch (err) {
    console.error("Kunde inte läsa pizzerias.json", err);
  }
}

// Calculate driving times for all pizzerias using OSRM Table API with fallback
async function updateDrivingTimesAndRender() {
  const originCoord = `${currentOrigin.lng},${currentOrigin.lat}`;
  
  // Format coordinate pairs for OSRM table
  const destCoords = allPizzerias.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${originCoord};${destCoords}?sources=0`;

  let durations = null;

  try {
    // Attempt real OSRM driving duration query (with 3s timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.durations && data.durations[0]) {
        durations = data.durations[0].slice(1); // skip origin itself
      }
    }
  } catch (e) {
    console.warn("OSRM query offline or timed out, using Stockholm city speed model fallback:", e.message);
  }

  calculatedPizzerias = allPizzerias.map((p, index) => {
    let driveMinutes;
    let distanceKm = calculateHaversineKm(currentOrigin.lat, currentOrigin.lng, p.lat, p.lng);

    if (durations && durations[index] !== null && durations[index] !== undefined) {
      // OSRM returns seconds, convert to minutes
      driveMinutes = Math.max(2, Math.round(durations[index] / 60));
    } else {
      // High-fidelity fallback city driving model:
      // Inner-city road network detour factor ~1.35, avg speed 22 km/h + 2 min intersection/light buffer
      const roadDistanceKm = distanceKm * 1.35;
      const travelHours = roadDistanceKm / 22;
      driveMinutes = Math.max(2, Math.round(travelHours * 60 + 2));
    }

    // Determine primary provider
    let primaryProvider = "pickup";
    if (p.delivery.wolt) primaryProvider = "wolt";
    else if (p.delivery.foodora) primaryProvider = "foodora";
    else if (p.delivery.own_delivery) primaryProvider = "own";

    return {
      ...p,
      driveMinutes,
      distanceKm: parseFloat(distanceKm.toFixed(1)),
      primaryProvider
    };
  });

  applyFiltersAndRender();
}

// Haversine formula
function calculateHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Filter and render list + markers
function applyFiltersAndRender() {
  const filtered = calculatedPizzerias.filter(p => {
    // 1. Time filter
    if (p.driveMinutes > filters.maxTime) return false;

    // 2. Rating filter
    if (p.rating < filters.minRating) return false;

    // 3. Provider filter
    if (filters.provider === "wolt" && !p.delivery.wolt) return false;
    if (filters.provider === "foodora" && !p.delivery.foodora) return false;
    if (filters.provider === "own" && !p.delivery.own_delivery) return false;
    if (filters.provider === "pickup" && !p.delivery.pickup_only) return false;

    // 4. Pizza price filter
    const pizzaPrice = p.pizzas[filters.pizza] || p.pizzas["Capricciosa"] || 0;
    if (pizzaPrice > filters.maxPrice) return false;

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (filters.sortBy === "time") return a.driveMinutes - b.driveMinutes;
    if (filters.sortBy === "rating") return b.rating - a.rating;
    if (filters.sortBy === "price") {
      const priceA = a.pizzas[filters.pizza] || 999;
      const priceB = b.pizzas[filters.pizza] || 999;
      return priceA - priceB;
    }
    if (filters.sortBy === "reviews") return b.reviews_count - a.reviews_count;
    return 0;
  });

  renderMarkers(filtered);
  renderPizzeriaList(filtered);
}

// Render Leaflet markers
function renderMarkers(pizzerias) {
  // Clear old markers
  pizzeriaMarkers.forEach(m => map.removeLayer(m));
  pizzeriaMarkers = [];

  pizzerias.forEach(p => {
    let pinColor = PROVIDER_COLORS[p.primaryProvider] || "#6b7280";

    const customIcon = L.divIcon({
      className: "custom-pin-wrapper",
      html: `
        <div class="custom-pin" style="background: ${pinColor};">
          <div class="custom-pin-inner">🍕</div>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -32]
    });

    const marker = L.marker([p.lat, p.lng], { icon: customIcon }).addTo(map);

    // Build popup content
    const pizzaPrice = p.pizzas[filters.pizza] ? `${p.pizzas[filters.pizza]} kr` : "Finns ej";

    let deliveryBadgesHtml = "";
    if (p.delivery.wolt) deliveryBadgesHtml += `<span class="badge badge-wolt">Wolt</span> `;
    if (p.delivery.foodora) deliveryBadgesHtml += `<span class="badge badge-foodora">Foodora</span> `;
    if (p.delivery.own_delivery) deliveryBadgesHtml += `<span class="badge badge-own">Egen utkörning</span> `;
    if (p.delivery.pickup_only) deliveryBadgesHtml += `<span class="badge badge-pickup">Endast avhämtning</span> `;

    let orderButtonsHtml = "";
    if (p.delivery.wolt) {
      const woltHref = p.wolt_url ? p.wolt_url : `https://wolt.com/sv/swe/stockholm/search?q=${encodeURIComponent(p.name)}`;
      orderButtonsHtml += `<a href="${woltHref}" target="_blank" rel="noopener" class="popup-btn popup-btn-wolt">Öppna Wolt</a>`;
    }
    if (p.delivery.foodora) {
      const foodoraHref = p.foodora_url ? p.foodora_url : `https://www.foodora.se/restaurants?search=${encodeURIComponent(p.name)}`;
      orderButtonsHtml += `<a href="${foodoraHref}" target="_blank" rel="noopener" class="popup-btn popup-btn-foodora">Öppna Foodora</a>`;
    }
    orderButtonsHtml += `<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener" class="popup-btn popup-btn-map">Navigera</a>`;

    const popupHtml = `
      <div class="popup-container">
        <div class="popup-title">${p.name}</div>
        <div class="popup-address">${p.address}, ${p.neighborhood}</div>
        
        <div class="popup-metrics">
          <span style="color:#b45309;">★ ${p.rating} (${p.reviews_count})</span>
          <span style="color:#0369a1;">🚗 ${p.driveMinutes} min (${p.distanceKm} km)</span>
        </div>

        <div class="popup-pizza-price">
          <span>${filters.pizza}:</span>
          <span>${pizzaPrice}</span>
        </div>

        <div style="margin-bottom: 0.6rem;">
          ${deliveryBadgesHtml}
        </div>

        <div class="popup-buttons">
          ${orderButtonsHtml}
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml);
    marker.pizzeriaId = p.id;
    pizzeriaMarkers.push(marker);

    marker.on("click", () => {
      highlightCard(p.id);
    });
  });
}

// Render cards list in sidebar
function renderPizzeriaList(pizzerias) {
  const countEl = document.getElementById("resultsCount");
  const listEl = document.getElementById("pizzeriaList");

  countEl.textContent = `${pizzerias.length} pizzerior hittade`;

  if (pizzerias.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 2.5rem 1rem; color: #64748b;">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🔍</div>
        <div style="font-weight: 700; font-size: 1rem; color: #1e293b;">Inga pizzerior matchar dina filter</div>
        <p style="font-size: 0.85rem; margin-top: 0.35rem;">Prova att öka max körtid, sänka minimibetyget eller tillåta fler leverantörer.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = pizzerias.map(p => {
    const pizzaPrice = p.pizzas[filters.pizza] ? `${p.pizzas[filters.pizza]} kr` : "–";

    let deliveryBadges = "";
    if (p.delivery.wolt) deliveryBadges += `<span class="badge badge-wolt">Wolt</span>`;
    if (p.delivery.foodora) deliveryBadges += `<span class="badge badge-foodora">Foodora</span>`;
    if (p.delivery.own_delivery) deliveryBadges += `<span class="badge badge-own">Egen utkörning</span>`;
    if (p.delivery.pickup_only) deliveryBadges += `<span class="badge badge-pickup">Endast avhämtning</span>`;

    return `
      <div class="pizzeria-card" id="card-${p.id}" onclick="selectPizzeria('${p.id}', ${p.lat}, ${p.lng})" onmouseenter="hoverPizzeria('${p.id}', ${p.lat}, ${p.lng})">
        <div class="card-top">
          <div class="pizzeria-name">${p.name}</div>
          <div class="metric-price">${pizzaPrice}</div>
        </div>
        <div class="pizzeria-address">${p.address} • ${p.neighborhood}</div>
        <div class="badges-row">
          ${deliveryBadges}
        </div>
        <div class="card-metrics">
          <div class="metric-item metric-rating">
            <span>★ ${p.rating}</span>
            <span style="font-weight:normal; color:#64748b; font-size:0.75rem;">(${p.reviews_count})</span>
          </div>
          <div class="metric-item metric-time">
            <span>🚗 ${p.driveMinutes} min</span>
            <span style="font-weight:normal; color:#64748b; font-size:0.75rem;">(${p.distanceKm} km)</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// Hover pizzeria from list (opens popup on map on mouseover)
window.hoverPizzeria = function(id, lat, lng) {
  highlightCard(id, false);
  const targetMarker = pizzeriaMarkers.find(m => m.pizzeriaId === id);
  if (targetMarker) {
    targetMarker.openPopup();
    if (!map.getBounds().contains([lat, lng])) {
      map.panTo([lat, lng], { animate: true, duration: 0.4 });
    }
  }
};

// Select pizzeria from card click
window.selectPizzeria = function(id, lat, lng) {
  highlightCard(id, true);
  map.flyTo([lat, lng], 16, { duration: 0.8 });

  // On mobile, collapse the drawer so the map and popup are visible
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
  }

  const targetMarker = pizzeriaMarkers.find(m => m.pizzeriaId === id);
  if (targetMarker) {
    setTimeout(() => {
      targetMarker.openPopup();
    }, 400);
  }
};

function highlightCard(id, shouldScroll = true) {
  document.querySelectorAll(".pizzeria-card").forEach(c => c.classList.remove("selected"));
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.classList.add("selected");
    if (shouldScroll) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

// Setup event listeners
function setupEventListeners() {
  // Driving time slider
  const timeSlider = document.getElementById("timeSlider");
  const timeVal = document.getElementById("timeVal");
  timeSlider.addEventListener("input", (e) => {
    filters.maxTime = parseInt(e.target.value);
    timeVal.textContent = `${filters.maxTime} min`;
    applyFiltersAndRender();
  });

  // Rating slider
  const ratingSlider = document.getElementById("ratingSlider");
  const ratingVal = document.getElementById("ratingVal");
  ratingSlider.addEventListener("input", (e) => {
    filters.minRating = parseFloat(e.target.value);
    ratingVal.textContent = `${filters.minRating.toFixed(1)} ★`;
    applyFiltersAndRender();
  });

  // Price slider
  const priceSlider = document.getElementById("priceSlider");
  const priceVal = document.getElementById("priceVal");
  priceSlider.addEventListener("input", (e) => {
    filters.maxPrice = parseInt(e.target.value);
    priceVal.textContent = `${filters.maxPrice} kr`;
    applyFiltersAndRender();
  });

  // Pizza dropdown
  const pizzaSelect = document.getElementById("pizzaSelect");
  pizzaSelect.addEventListener("change", (e) => {
    filters.pizza = e.target.value;
    applyFiltersAndRender();
  });

  // Sort dropdown
  const sortSelect = document.getElementById("sortSelect");
  sortSelect.addEventListener("change", (e) => {
    filters.sortBy = e.target.value;
    applyFiltersAndRender();
  });

  // Delivery pills
  const deliveryPills = document.querySelectorAll("#deliveryPills .pill-btn");
  deliveryPills.forEach(btn => {
    btn.addEventListener("click", () => {
      deliveryPills.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filters.provider = btn.getAttribute("data-provider");
      applyFiltersAndRender();
    });
  });

  // Search Address button & Enter key
  const searchBtn = document.getElementById("searchAddressBtn");
  const addressInput = document.getElementById("addressInput");

  const executeGeocoding = async () => {
    const query = addressInput.value.trim();
    if (!query) return;

    searchBtn.style.opacity = "0.5";
    try {
      // Nominatim search within Stockholm region
      const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ", Stockholm")}&limit=1`;
      const res = await fetch(searchUrl);
      if (res.ok) {
        const results = await res.json();
        if (results && results.length > 0) {
          const lat = parseFloat(results[0].lat);
          const lon = parseFloat(results[0].lon);
          await updateOriginPosition(lat, lon, query);
          map.flyTo([lat, lon], 15);
        } else {
          alert(`Kunde inte hitta adressen "${query}". Försök med t.ex. "Hornsgatan 50" eller klicka direkt på kartan.`);
        }
      }
    } catch (e) {
      console.error("Geocoding failed:", e);
    } finally {
      searchBtn.style.opacity = "1";
    }
  };

  searchBtn.addEventListener("click", executeGeocoding);
  addressInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      executeGeocoding();
    }
  });

  // Mobile drawer toggle
  const mobileHandle = document.getElementById("mobileHandle");
  const sidebar = document.getElementById("sidebar");
  const sidebarHeader = document.querySelector(".sidebar-header");

  const toggleMobileDrawer = () => {
    sidebar.classList.toggle("open");
  };

  if (mobileHandle) mobileHandle.addEventListener("click", toggleMobileDrawer);
  if (sidebarHeader && window.innerWidth <= 768) {
    sidebarHeader.addEventListener("click", toggleMobileDrawer);
  }
}
