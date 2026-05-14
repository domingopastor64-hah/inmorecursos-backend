import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import xml2js from "xml2js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

function ok(res, data) {
  res.json({
    ok: true,
    consulta_realizada: new Date().toISOString(),
    ...data
  });
}

function fail(res, fuente, error) {
  res.json({
    ok: false,
    consulta_realizada: new Date().toISOString(),
    fuente,
    error: error?.message || String(error)
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function geocodeDireccion(direccion) {
  const url = "https://nominatim.openstreetmap.org/search";

  const r = await axios.get(url, {
    timeout: 15000,
    params: {
      q: direccion,
      format: "json",
      addressdetails: 1,
      limit: 1,
      countrycodes: "es"
    },
    headers: {
      "User-Agent": "InmoRecursos-PuntosDeControl/1.0 contacto@inmorecursos.com"
    }
  });

  const item = r.data?.[0];

  if (!item) {
    throw new Error("No se pudo geocodificar la dirección");
  }

  return {
    lat: Number(item.lat),
    lon: Number(item.lon),
    direccion_localizada: item.display_name,
    municipio:
      item.address?.city ||
      item.address?.town ||
      item.address?.village ||
      item.address?.municipality ||
      "",
    provincia:
      item.address?.county ||
      item.address?.province ||
      "",
    comunidad:
      item.address?.state ||
      ""
  };
}

async function getOpenMeteo(lat, lon) {
  const [air, weather] = await Promise.all([
    axios.get("https://air-quality-api.open-meteo.com/v1/air-quality", {
      timeout: 15000,
      params: {
        latitude: lat,
        longitude: lon,
        hourly: "pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi",
        timezone: "Europe/Madrid"
      }
    }),
    axios.get("https://api.open-meteo.com/v1/forecast", {
      timeout: 15000,
      params: {
        latitude: lat,
        longitude: lon,
        current: "temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index",
        timezone: "Europe/Madrid"
      }
    })
  ]);

  const h = air.data?.hourly || {};
  const idx = 0;
  const c = weather.data?.current || {};

  return {
    aire: {
      pm10: num(h.pm10?.[idx]),
      pm2_5: num(h.pm2_5?.[idx]),
      no2: num(h.nitrogen_dioxide?.[idx]),
      ozono: num(h.ozone?.[idx]),
      aqi_europeo: num(h.european_aqi?.[idx])
    },
    meteo: {
      temperatura: num(c.temperature_2m),
      humedad_relativa: num(c.relative_humidity_2m),
      viento: num(c.wind_speed_10m),
      uv_index: num(c.uv_index)
    },
    fuente: "Open-Meteo"
  };
}

function scoreAire(aire) {
  let score = 100;

  if (aire.pm2_5 !== null) score -= aire.pm2_5 > 25 ? 28 : aire.pm2_5 > 10 ? 12 : 0;
  if (aire.pm10 !== null) score -= aire.pm10 > 40 ? 20 : aire.pm10 > 20 ? 8 : 0;
  if (aire.no2 !== null) score -= aire.no2 > 40 ? 20 : aire.no2 > 20 ? 8 : 0;
  if (aire.ozono !== null) score -= aire.ozono > 120 ? 14 : aire.ozono > 100 ? 6 : 0;
  if (aire.aqi_europeo !== null) score -= aire.aqi_europeo > 50 ? 20 : aire.aqi_europeo > 20 ? 8 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

app.get("/", (_, res) => {
  ok(res, {
    servicio: "InmoRecursos · Backend mínimo funcional",
    endpoints: [
      "/health",
      "/api/geocode?direccion=",
      "/api/entorno?direccion=",
      "/api/openmeteo?lat=&lon=",
      "/api/catastro?rc="
    ]
  });
});

app.get("/health", (_, res) => {
  ok(res, {
    estado: "activo",
    version: "fase-1-entorno-catastro"
  });
});

app.get("/api/geocode", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      throw new Error("Falta el parámetro direccion");
    }

    const geo = await geocodeDireccion(direccion);

    ok(res, {
      fuente: "Nominatim / OpenStreetMap",
      geocoding: geo
    });

  } catch (error) {
    fail(res, "Nominatim / OpenStreetMap", error);
  }
});

app.get("/api/openmeteo", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Faltan coordenadas válidas: lat y lon");
    }

    const data = await getOpenMeteo(lat, lon);

    ok(res, {
      fuente: "Open-Meteo",
      ...data,
      lectura_entorno: {
        puntuacion_aire: scoreAire(data.aire)
      }
    });

  } catch (error) {
    fail(res, "Open-Meteo", error);
  }
});

app.get("/api/entorno", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      throw new Error("Falta el parámetro direccion");
    }

    const geo = await geocodeDireccion(direccion);
    const data = await getOpenMeteo(geo.lat, geo.lon);

    const puntuacionAire = scoreAire(data.aire);

    ok(res, {
      fuente: "Nominatim + Open-Meteo",
      direccion_solicitada: direccion,
      ...geo,
      aire: data.aire,
      meteo: data.meteo,
      lectura_entorno: {
        puntuacion_aire: puntuacionAire,
        lectura:
          puntuacionAire >= 70
            ? "Entorno ambiental favorable"
            : puntuacionAire >= 45
              ? "Entorno ambiental funcional"
              : "Entorno ambiental condicionante"
      }
    });

  } catch (error) {
    fail(res, "Entorno", error);
  }
});

app.get("/api/catastro", async (req, res) => {
  try {
    const rc = req.query.rc;

    if (!rc) {
      throw new Error("Falta la referencia catastral");
    }

    const url =
      "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC";

    let response;

    try {
      response = await axios.get(url, {
        timeout: 20000,
        params: {
          Provincia: "",
          Municipio: "",
          RC: rc
        }
      });
    } catch {
      response = await axios.get(url, {
        timeout: 20000,
        params: {
          RefCat: rc
        }
      });
    }

    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true
    });

    const parsed = await parser.parseStringPromise(response.data);

    ok(res, {
      fuente: "Dirección General del Catastro",
      referencia_catastral: rc,
      catastro: parsed
    });

  } catch (error) {
    fail(res, "Dirección General del Catastro", error);
  }
});

app.listen(PORT, () => {
  console.log(`InmoRecursos backend mínimo activo en puerto ${PORT}`);
});
