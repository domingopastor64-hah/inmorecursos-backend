import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";

app.get("/", (_req, res) => {
  res.send("Backend InmoRecursos funcionando correctamente");
});

async function getJson(nombre, url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${nombre} no ha devuelto JSON válido. Código HTTP: ${response.status}. Respuesta: ${text.slice(0, 180)}`
    );
  }
}

async function geocode(direccion) {
  // Preferente: Geoapify si hay API key
  if (GEOAPIFY_KEY) {
    const url =
      `https://api.geoapify.com/v1/geocode/search` +
      `?text=${encodeURIComponent(direccion)}` +
      `&limit=1` +
      `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

    const data = await getJson("Geoapify Geocoding", url);

    const f = data.features?.[0];
    if (!f) throw new Error("Dirección no encontrada en Geoapify.");

    return {
      lat: Number(f.properties.lat),
      lon: Number(f.properties.lon),
      display_name: f.properties.formatted || direccion
    };
  }

  // Alternativa: Nominatim
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json` +
    `&limit=1` +
    `&q=${encodeURIComponent(direccion)}`;

  const data = await getJson("Nominatim", url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "InmoRecursos/1.0"
    }
  });

  if (!Array.isArray(data) || !data.length) {
    throw new Error("Dirección no encontrada en Nominatim.");
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    display_name: data[0].display_name || direccion
  };
}

app.post("/analizar-entorno", async (req, res) => {
  try {
    const direccion = req.body.direccion;
    const radio = Number(req.body.radio || 1000);

    if (!direccion) {
      return res.status(400).json({
        ok: false,
        error: "Debe indicar una dirección."
      });
    }

    const geo = await geocode(direccion);
    const { lat, lon } = geo;

    const airUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=pm2_5,pm10,european_aqi,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen` +
      `&timezone=auto` +
      `&domains=cams_europe`;

    const airData = await getJson("Open-Meteo Air Quality", airUrl);
    const current = airData.current || {};

    const uvUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=uv_index` +
      `&timezone=auto`;

    const uvData = await getJson("Open-Meteo UV", uvUrl);
    const uvCurrent = uvData.current || {};

    let servicios = [];
    let serviciosResumen = {
      supermercados: 0,
      farmacias: 0,
      colegios: 0,
      hospitales: 0,
      restaurantes: 0,
      parques: 0,
      transporte: 0
    };

    if (GEOAPIFY_KEY) {
      const categories = [
        "commercial.supermarket",
        "healthcare.pharmacy",
        "education.school",
        "healthcare.hospital",
        "catering.restaurant",
        "leisure.park",
        "public_transport"
      ].join(",");

      const servicesUrl =
        `https://api.geoapify.com/v2/places` +
        `?categories=${encodeURIComponent(categories)}` +
        `&filter=${encodeURIComponent(`circle:${lon},${lat},${radio}`)}` +
        `&bias=${encodeURIComponent(`proximity:${lon},${lat}`)}` +
        `&limit=30` +
        `&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;

      const servData = await getJson("Geoapify Places", servicesUrl);
      const features = Array.isArray(servData.features) ? servData.features : [];

      servicios = features.map((f) => {
        const p = f.properties || {};
        const categorias = Array.isArray(p.categories) ? p.categories : [];

        if (categorias.includes("commercial.supermarket")) serviciosResumen.supermercados++;
        if (categorias.includes("healthcare.pharmacy")) serviciosResumen.farmacias++;
        if (categorias.includes("education.school")) serviciosResumen.colegios++;
        if (categorias.includes("healthcare.hospital")) serviciosResumen.hospitales++;
        if (categorias.includes("catering.restaurant")) serviciosResumen.restaurantes++;
        if (categorias.includes("leisure.park")) serviciosResumen.parques++;
        if (categorias.includes("public_transport")) serviciosResumen.transporte++;

        return {
          nombre: p.name || p.address_line1 || "Servicio sin nombre",
          direccion_1: p.address_line1 || "",
          direccion_2: p.address_line2 || "",
          categorias
        };
      });
    }

    return res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: geo.display_name,
      coordenadas: { lat, lon },
      radio_consultado_m: radio,
      aire: {
        pm2_5: current.pm2_5 ?? null,
        pm10: current.pm10 ?? null,
        aqi_europeo: current.european_aqi ?? null,
        uv: uvCurrent.uv_index ?? null
      },
      polen: {
        alder: current.alder_pollen ?? null,
        birch: current.birch_pollen ?? null,
        grass: current.grass_pollen ?? null,
        mugwort: current.mugwort_pollen ?? null,
        olive: current.olive_pollen ?? null,
        ragweed: current.ragweed_pollen ?? null
      },
      servicios_resumen: serviciosResumen,
      servicios
    });

  } catch (error) {
    console.error("Error:", error);

    return res.status(500).json({
      ok: false,
      error: "Error interno del servidor.",
      detalle: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
