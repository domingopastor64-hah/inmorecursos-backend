import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";

// 🔵 Comprobación rápida
app.get("/", (req, res) => {
  res.send("Backend InmoRecursos funcionando correctamente");
});

// 🔵 Función segura para obtener JSON
async function getJson(nombre, url) {
  const response = await fetch(url);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${nombre} no ha devuelto JSON válido. Código ${response.status}.`
    );
  }
}

// 🔵 Geocodificación SOLO España
async function geocode(direccion) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY en Render");
  }

  const url =
    `https://api.geoapify.com/v1/geocode/search` +
    `?text=${encodeURIComponent(direccion)}` +
    `&filter=countrycode:es` +
    `&bias=countrycode:es` +
    `&limit=1` +
    `&apiKey=${GEOAPIFY_KEY}`;

  const data = await getJson("Geoapify Geocoding", url);

  const f = data.features?.[0];
  if (!f) throw new Error("Dirección no encontrada en España.");

  return {
    lat: Number(f.properties.lat),
    lon: Number(f.properties.lon),
    display_name: f.properties.formatted || direccion
  };
}

// 🔵 Endpoint principal
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

    // 🔵 Calidad del aire
    const airUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=pm2_5,pm10,european_aqi,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen` +
      `&timezone=auto` +
      `&domains=cams_europe`;

    const airData = await getJson("Open-Meteo Air", airUrl);
    const current = airData.current || {};

    // 🔵 UV
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=uv_index` +
      `&timezone=auto`;

    const uvData = await getJson("Open-Meteo UV", uvUrl);
    const uvCurrent = uvData.current || {};

    // 🔵 Servicios cercanos
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
      `&apiKey=${GEOAPIFY_KEY}`;

    const servData = await getJson("Geoapify Places", servicesUrl);
    const features = Array.isArray(servData.features) ? servData.features : [];

    let resumen = {
      supermercados: 0,
      farmacias: 0,
      colegios: 0,
      hospitales: 0,
      restaurantes: 0,
      parques: 0,
      transporte: 0
    };

    const servicios = features.map(f => {
      const p = f.properties || {};
      const cat = p.categories || [];

      if (cat.includes("commercial.supermarket")) resumen.supermercados++;
      if (cat.includes("healthcare.pharmacy")) resumen.farmacias++;
      if (cat.includes("education.school")) resumen.colegios++;
      if (cat.includes("healthcare.hospital")) resumen.hospitales++;
      if (cat.includes("catering.restaurant")) resumen.restaurantes++;
      if (cat.includes("leisure.park")) resumen.parques++;
      if (cat.includes("public_transport")) resumen.transporte++;

      return {
        nombre: p.name || "Servicio",
        direccion: p.address_line1 || ""
      };
    });

    // 🔵 RESPUESTA FINAL
    res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: geo.display_name,
      coordenadas: { lat, lon },
      aire: {
        pm2_5: current.pm2_5,
        pm10: current.pm10,
        aqi: current.european_aqi,
        uv: uvCurrent.uv_index
      },
      polen: {
        grass: current.grass_pollen,
        olive: current.olive_pollen
      },
      servicios_resumen: resumen,
      servicios
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Error interno del servidor",
      detalle: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
