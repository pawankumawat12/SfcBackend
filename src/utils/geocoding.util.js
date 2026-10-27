 async function geocodeAddress({ formatted_address, city, state, pincode }) {
  try {
    const queries = [];

    // 1. Try formatted address + city + state + pincode
    const full = [formatted_address, city, state, pincode, "India"]
      .filter((v) => v && typeof v === "string" && v.trim().length > 0)
      .join(", ");
    if (full) queries.push(full);

    // 2. Try city + pincode (very accurate for city/area level in India)
    if (pincode) {
      const cleanPincode = String(pincode).trim();
      if (city) {
        queries.push(`${cleanPincode}, ${city}, India`);
      }
      queries.push(`${cleanPincode}, India`);
    }

    // 3. Try city + state
    if (city) {
      queries.push(`${city}, ${state || "Rajasthan"}, India`);
    }

    for (const query of queries) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          query
        )}&format=json&limit=1`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500); // 3.5s timeout safety

        const response = await fetch(url, {
          headers: {
            "User-Agent": "SFCBakeryApp/1.0 (contact@sfcbakery.com)",
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.ok) {
          const results = await response.json();
          if (Array.isArray(results) && results.length > 0) {
            const lat = parseFloat(results[0].lat);
            const lon = parseFloat(results[0].lon);

            if (!isNaN(lat) && !isNaN(lon) && (lat !== 0 || lon !== 0)) {
              return {
                latitude: Math.round(lat * 1000000) / 1000000,
                longitude: Math.round(lon * 1000000) / 1000000,
              };
            }
          }
        }
      } catch (subErr) {
        // Continue to next query format
      }
    }
  } catch (error) {
    console.warn("[Geocoding Util] Geocoding resolution warning:", error.message);
  }

  // Fallback to 0 if geocoding cannot resolve
  return { latitude: 0, longitude: 0 };
}

module.exports = {
  geocodeAddress,
};

