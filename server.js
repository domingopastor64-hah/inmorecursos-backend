import express from "express";
import cors from "cors";
import axios from "axios";
import * as XLSX from "xlsx";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 30000,
  headers: { "User-Agent": "InmoRecursos-Punto-Control/1.0" }
});

function ok(data = {}) {
  return { status: "OK", timestamp: new Date().toISOString(), ...data };
}

function fail(message, extra = {}) {
  return { status: "ERROR", timestamp: new Date().toISOString(), mensaje: message, ...extra };
}

function cleanText(v = "") {
  return String(v)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === "" || String(v).toLowerCase() === "nr") return null;
  const raw = String(v).trim();

  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(raw)) return Number(raw.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(,\d{3})*\.\d+$/.test(raw)) return Number(raw.replace(/,/g, ""));
  if (/^\d+,\d+$/.test(raw)) return Number(raw.replace(",", "."));

  const n = Number(raw.replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
}

function semaforoMenor(valor, verdeMax, naranjaMax) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return { color: "gris", nivel: "No disponible" };
  if (n <= verdeMax) return { color: "verde", nivel: "Óptimo" };
  if (n <= naranjaMax) return { color: "naranja", nivel: "Precaución" };
  return { color: "rojo", nivel: "Negativo" };
}

function semaforoMayor(valor, verdeMin, naranjaMin) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return { color: "gris", nivel: "No disponible" };
  if (n > verdeMin) return { color: "verde", nivel: "Favorable" };
  if (n >= naranjaMin) return { color: "naranja", nivel: "Precaución" };
  return { color: "rojo", nivel: "Negativo" };
}

function scoreColor(color) {
  if (color === "verde") return 100;
  if (color === "naranja") return 60;
  if (color === "rojo") return 20;
  return null;
}

function normalizarTipoBCE(v) {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 20 ? n / 100 : n;
}

async function ineTablaJson(tabla, nult = 1) {
  const url = `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${tabla}`;
  const response = await http.get(url, { params: { nult } });
  return response.data;
}

function elegirSerie(rows, patrones = [], excluidos = []) {
  if (!Array.isArray(rows)) return null;

  return rows.find(r => {
    const nombre = cleanText(r.Nombre || "");
    const incluye = patrones.every(p => nombre.includes(cleanText(p)));
    const excluye = excluidos.some(p => nombre.includes(cleanText(p)));
    return incluye && !excluye;
  }) || null;
}

function getLastDato(serie) {
  if (!serie?.Data?.length) return null;
  return serie.Data[0];
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json(ok({
    estado: "Servidor activo",
    endpoints: [
      "/api/geo?direccion=Plasencia, Cáceres, España",
      "/api/entorno?direccion=Plasencia, Cáceres, España",
      "/api/servicios?direccion=Plasencia, Cáceres, España&radio=1000",
      "/api/mivau/valor-tasado?municipio=Plasencia",
      "/api/ine/renta?municipio=Plasencia",
      "/api/bce/tipos",
      "/api/ine/ipc",
      "/api/ine/pib",
      "/api/ine/paro?ambito=ccaa&nombre=Extremadura",
      "/api/ine/paro?ambito=provincia&nombre=Cáceres",
      "/api/ine/salarios",
      "/api/contexto-economico",
      "/api/macro-decision"
    ]
  }));
});

/* =========================================================
   GEO · PHOTON
========================================================= */

async function geocodePhoton(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  const queries = [
    q,
    `${q}, España`,
    `${q}, Spain`
  ];

  for (const search of queries) {
    try {
      const response = await http.get("https://photon.komoot.io/api/", {
        params: {
          q: search,
          limit: 10
        }
      });

      const features = response.data?.features || [];

      const item =
        features.find(f => f.properties?.countrycode === "ES") ||
        features.find(f => cleanText(f.properties?.country || "").includes("spain")) ||
        features[0];

      if (!item) continue;

      const [lon, lat] = item.geometry.coordinates;

      return {
        lat,
        lon,
        nombre: item.properties?.name || search,
        municipio:
          item.properties?.city ||
          item.properties?.town ||
          item.properties?.village ||
          item.properties?.county ||
          item.properties?.name ||
          null,
        provincia: item.properties?.county || null,
        comunidad: item.properties?.state || null,
        pais: item.properties?.country || null,
        country_code: item.properties?.countrycode || null,
        fuente: "Photon · OpenStreetMap"
      };
    } catch {
      continue;
    }
  }

  return null;
}

app.get("/api/geo", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || req.query.municipio || "").trim();

    if (!direccion) {
      return res.json(ok({
        fuente: "Photon",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse dirección o municipio."
      }));
    }

    const geo = await geocodePhoton(direccion);

    if (!geo) {
      return res.json(ok({
        fuente: "Photon",
        estado_dato: "NO_DISPONIBLE",
        direccion_solicitada: direccion,
        aviso: "No se pudo geocodificar."
      }));
    }

    res.json(ok({
      fuente: "Photon · OpenStreetMap",
      estado_dato: "OK",
      direccion_solicitada: direccion,
      geocoding: geo
    }));
  } catch (e) {
    res.json(ok({
      fuente: "Photon",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo geocodificar.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   ENTORNO · PHOTON + OPEN-METEO
========================================================= */

app.get("/api/entorno", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || req.query.municipio || "").trim();

    if (!direccion) {
      return res.json(ok({
        fuente: "Photon + Open-Meteo",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse dirección o municipio."
      }));
    }

    const geo = await geocodePhoton(direccion);

    if (!geo) {
      return res.json(ok({
        fuente: "Photon",
        estado_dato: "NO_DISPONIBLE",
        direccion_solicitada: direccion,
        aviso: "No se pudo geocodificar."
      }));
    }

    const lat = geo.lat;
    const lon = geo.lon;

    const airResponse = await http.get("https://air-quality-api.open-meteo.com/v1/air-quality", {
      params: {
        latitude: lat,
        longitude: lon,
        current: "pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi",
        timezone: "auto"
      }
    });

    const weatherResponse = await http.get("https://api.open-meteo.com/v1/forecast", {
      params: {
        latitude: lat,
        longitude: lon,
        current: "temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index",
        timezone: "auto"
      }
    });

    const air = airResponse.data?.current || {};
    const meteo = weatherResponse.data?.current || {};

    const pm10 = toNumber(air.pm10);
    const pm25 = toNumber(air.pm2_5);
    const no2 = toNumber(air.nitrogen_dioxide);
    const ozono = toNumber(air.ozone);
    const aqi = toNumber(air.european_aqi);
    const uvi = toNumber(meteo.uv_index);

    let puntuacion = 100;
    if (pm10 !== null) puntuacion -= Math.max(0, pm10 - 20) * 0.8;
    if (pm25 !== null) puntuacion -= Math.max(0, pm25 - 10) * 1.2;
    if (no2 !== null) puntuacion -= Math.max(0, no2 - 20) * 0.9;
    if (ozono !== null) puntuacion -= Math.max(0, ozono - 100) * 0.25;
    if (aqi !== null) puntuacion -= Math.max(0, aqi - 50) * 0.7;
    puntuacion = Math.max(0, Math.min(100, Math.round(puntuacion)));

    res.json(ok({
      fuente: "Photon + Open-Meteo Air Quality",
      estado_dato: "OK",
      direccion_solicitada: direccion,
      geocoding: geo,
      aire: {
        pm10,
        pm25,
        no2,
        ozono,
        aqi_europeo: aqi
      },
      meteo: {
        temperatura: toNumber(meteo.temperature_2m),
        humedad: toNumber(meteo.relative_humidity_2m),
        viento: toNumber(meteo.wind_speed_10m),
        uvi
      },
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura:
          puntuacion >= 70
            ? "Entorno ambiental favorable."
            : puntuacion >= 45
            ? "Entorno ambiental aceptable con precauciones."
            : "Entorno ambiental sensible o desfavorable."
      },
      aviso: "Datos obtenidos desde Photon y Open-Meteo. No sustituye mediciones oficiales locales de estaciones concretas."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "Photon + Open-Meteo",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener entorno ambiental.",
      detalle: e.message
    }));
  }
});

app.get("/api/openmeteo", async (req, res) => {
  req.url = req.url.replace("/api/openmeteo", "/api/entorno");
  app._router.handle(req, res);
});

/* =========================================================
   SERVICIOS · PHOTON + OVERPASS
========================================================= */

function overpassQuery(lat, lon, radius = 1000) {
  return `
[out:json][timeout:25];
(
  node["shop"="supermarket"](around:${radius},${lat},${lon});
  way["shop"="supermarket"](around:${radius},${lat},${lon});

  node["amenity"="pharmacy"](around:${radius},${lat},${lon});
  way["amenity"="pharmacy"](around:${radius},${lat},${lon});

  node["amenity"="school"](around:${radius},${lat},${lon});
  way["amenity"="school"](around:${radius},${lat},${lon});

  node["amenity"="hospital"](around:${radius},${lat},${lon});
  way["amenity"="hospital"](around:${radius},${lat},${lon});

  node["amenity"="clinic"](around:${radius},${lat},${lon});
  way["amenity"="clinic"](around:${radius},${lat},${lon});

  node["leisure"="park"](around:${radius},${lat},${lon});
  way["leisure"="park"](around:${radius},${lat},${lon});

  node["amenity"="bank"](around:${radius},${lat},${lon});
  way["amenity"="bank"](around:${radius},${lat},${lon});

  node["amenity"="fuel"](around:${radius},${lat},${lon});
  way["amenity"="fuel"](around:${radius},${lat},${lon});

  node["highway"="bus_stop"](around:${radius},${lat},${lon});
  node["railway"="station"](around:${radius},${lat},${lon});
);
out center tags;
`;
}

function clasificarServicio(tags = {}) {
  if (tags.shop === "supermarket") return "supermercados";
  if (tags.amenity === "pharmacy") return "farmacias";
  if (tags.amenity === "school") return "colegios";
  if (tags.amenity === "hospital" || tags.amenity === "clinic") return "salud";
  if (tags.leisure === "park") return "zonas_verdes";
  if (tags.amenity === "bank") return "bancos";
  if (tags.amenity === "fuel") return "gasolineras";
  if (tags.highway === "bus_stop" || tags.railway === "station") return "transporte";
  return "otros";
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

app.get("/api/servicios", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || req.query.municipio || "").trim();
    const radius = Number(req.query.radio || 1000);

    if (!direccion) {
      return res.json(ok({
        fuente: "Photon + Overpass",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse dirección o municipio."
      }));
    }

    const geo = await geocodePhoton(direccion);

    if (!geo) {
      return res.json(ok({
        fuente: "Photon",
        estado_dato: "NO_DISPONIBLE",
        direccion_solicitada: direccion,
        aviso: "No se pudo geocodificar."
      }));
    }

    const query = overpassQuery(geo.lat, geo.lon, radius);

    const overpass = await http.post(
      "https://overpass-api.de/api/interpreter",
      query,
      { headers: { "Content-Type": "text/plain" } }
    );

    const elements = overpass.data?.elements || [];

    const servicios = elements.map(e => {
      const lat = e.lat || e.center?.lat;
      const lon = e.lon || e.center?.lon;

      return {
        tipo: clasificarServicio(e.tags),
        nombre: e.tags?.name || "Sin nombre",
        lat,
        lon,
        distancia_m: lat && lon ? distanciaMetros(geo.lat, geo.lon, lat, lon) : null,
        tags: e.tags || {}
      };
    }).filter(x => x.lat && x.lon);

    const resumen = {
      supermercados: servicios.filter(x => x.tipo === "supermercados").length,
      farmacias: servicios.filter(x => x.tipo === "farmacias").length,
      colegios: servicios.filter(x => x.tipo === "colegios").length,
      salud: servicios.filter(x => x.tipo === "salud").length,
      zonas_verdes: servicios.filter(x => x.tipo === "zonas_verdes").length,
      bancos: servicios.filter(x => x.tipo === "bancos").length,
      gasolineras: servicios.filter(x => x.tipo === "gasolineras").length,
      transporte: servicios.filter(x => x.tipo === "transporte").length
    };

    const puntuacion = Math.min(100,
      resumen.supermercados * 12 +
      resumen.farmacias * 10 +
      resumen.colegios * 10 +
      resumen.salud * 10 +
      resumen.zonas_verdes * 8 +
      resumen.transporte * 8 +
      resumen.bancos * 4 +
      resumen.gasolineras * 3
    );

    res.json(ok({
      fuente: "Photon + Overpass API · OpenStreetMap",
      estado_dato: "OK",
      direccion_solicitada: direccion,
      radio_metros: radius,
      geocoding: geo,
      resumen,
      puntuacion_servicios: puntuacion,
      lectura:
        puntuacion >= 70
          ? "Entorno con buena dotación de servicios cercanos."
          : puntuacion >= 40
          ? "Entorno con dotación media de servicios."
          : "Entorno con baja dotación de servicios próximos.",
      servicios: servicios
        .sort((a, b) => (a.distancia_m || 99999) - (b.distancia_m || 99999))
        .slice(0, 80),
      aviso: "Datos obtenidos desde OpenStreetMap mediante Overpass. La calidad depende del mantenimiento comunitario de OSM."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "Photon + Overpass",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudieron obtener servicios cercanos.",
      detalle: e.message
    }));
  }
});
/* =========================================================
   MIVAU · VALOR TASADO
========================================================= */

app.get("/api/mivau/valor-tasado", async (req, res) => {
  try {
    const municipio = String(req.query.municipio || "").trim();

    if (!municipio) {
      return res.json(ok({
        fuente: "MIVAU · Valor tasado vivienda",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse municipio."
      }));
    }

    const baseUrl = "https://apps.fomento.gob.es/boletinonline2/";
    const portada = await http.get(`${baseUrl}?nivel=2&orden=35000000`, {
      responseType: "text"
    });

    const html = String(portada.data);

    const enlaces = [...html.matchAll(/sedal\/35\d+\.XLS/gi)]
      .map(m => m[0])
      .filter((v, i, arr) => arr.indexOf(v) === i);

    const archivos = enlaces.length
      ? enlaces
      : [
          "sedal/35101000.XLS",
          "sedal/35101500.XLS",
          "sedal/35102000.XLS",
          "sedal/35102500.XLS",
          "sedal/35103000.XLS",
          "sedal/35103500.XLS"
        ];

    const target = cleanText(municipio);
    const serie = [];

    for (const archivo of archivos) {
      try {
        const xls = await http.get(baseUrl + archivo, { responseType: "arraybuffer" });
        const workbook = XLSX.read(xls.data, { type: "buffer" });

        for (const sheetName of workbook.SheetNames) {
          const periodoMatch = sheetName.match(/T([1-4])A?(\d{4})/i);
          if (!periodoMatch) continue;

          const trimestre = Number(periodoMatch[1]);
          const anyo = Number(periodoMatch[2]);

          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            header: 1,
            raw: false,
            defval: null
          });

          for (const row of rows) {
            const nombre = cleanText(row?.[2] || row?.[1] || row?.[0] || "");
            if (nombre !== target) continue;

            const nums = row.map(toNumber);

            let valorNueva = nums[3];
            let valorUsada = nums[4];
            let valorTotal = nums[5];

            let tasNueva = nums[7];
            let tasUsada = nums[8];
            let tasTotal = nums[9];

            if (valorTotal === null && valorUsada === null && valorNueva === null) {
              valorTotal = nums.find(n => n !== null && n > 300 && n < 6000);
            }

            if (tasTotal === null && tasUsada === null && tasNueva === null) {
              tasTotal = [...nums].reverse().find(n => n !== null && n >= 1 && n < 10000);
            }

            if (valorNueva !== null || valorUsada !== null || valorTotal !== null) {
              serie.push({
                municipio,
                periodo: `T${trimestre} ${anyo}`,
                anyo,
                trimestre,
                valor_tasado_nueva: valorNueva,
                valor_tasado_usada: valorUsada,
                valor_tasado_total: valorTotal || valorUsada || valorNueva,
                tasaciones_nueva: tasNueva,
                tasaciones_usada: tasUsada,
                tasaciones_total: tasTotal || tasUsada || tasNueva
              });
            }
          }
        }
      } catch {}
    }

    serie.sort((a, b) => (a.anyo - b.anyo) || (a.trimestre - b.trimestre));

    if (!serie.length) {
      return res.json(ok({
        fuente: "MIVAU · Valor tasado vivienda",
        estado_dato: "NO_DISPONIBLE",
        municipio_buscado: municipio,
        aviso: "No se encontró dato municipal en los XLS localizados."
      }));
    }

    const ultimo = serie[serie.length - 1];

    res.json(ok({
      fuente: "MIVAU · Valor tasado vivienda · municipios",
      estado_dato: "OK",
      municipio_buscado: municipio,
      ultimo_periodo: ultimo.periodo,
      ultimo,
      serie_historica_ultimos_8: serie.slice(-8),
      aviso: "Dato extraído del XLS oficial MIVAU. Usar como referencia oficial de valor tasado, no como precio exacto de cierre."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "MIVAU · Valor tasado vivienda",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener MIVAU.",
      detalle: e.message
    }));
  }
});

app.get("/api/mivau", async (req, res) => {
  req.url = req.url.replace("/api/mivau", "/api/mivau/valor-tasado");
  app._router.handle(req, res);
});

/* =========================================================
   INE · RENTA MUNICIPAL
========================================================= */

app.get("/api/ine/renta", async (req, res) => {
  try {
    const municipio = String(req.query.municipio || "").trim();

    if (!municipio) {
      return res.json(ok({
        fuente: "INE · Renta municipal",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse municipio."
      }));
    }

    const xlsUrl = "https://www.ine.es/jaxiT3/files/t/es/xlsx/30935.xlsx";
    const xls = await http.get(xlsUrl, { responseType: "arraybuffer" });
    const workbook = XLSX.read(xls.data, { type: "buffer" });

    const target = cleanText(municipio);
    let fila = null;

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: ""
      });

      for (const row of rows) {
        const first = String(row[0] || "");
        const limpio = cleanText(first).replace(/^\d+\s+/, "").trim();

        if (limpio === target) {
          fila = row;
          break;
        }
      }

      if (fila) break;
    }

    if (!fila) {
      return res.json(ok({
        fuente: "INE XLS · Tabla 30935",
        estado_dato: "NO_DISPONIBLE",
        municipio_buscado: municipio,
        aviso: "No se localizó fila municipal exacta."
      }));
    }

    res.json(ok({
      fuente: "INE XLS · Tabla 30935",
      estado_dato: "OK",
      municipio_buscado: municipio,
      fila_municipal: fila[0],
      renta: {
        renta_media_persona: toNumber(fila[1]),
        renta_media_hogar: toNumber(fila[10]),
        renta_media_unidad_consumo: toNumber(fila[19]),
        mediana_unidad_consumo: toNumber(fila[28]),
        renta_mediana_hogar: toNumber(fila[37])
      },
      aviso: "Dato extraído de tabla INE 30935 mediante coincidencia exacta municipal."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Renta municipal",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener renta municipal.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   BCE · TIPOS
========================================================= */

async function ecbCsv(seriesKey) {
  const url = `https://data-api.ecb.europa.eu/service/data/FM/${seriesKey}`;

  const response = await http.get(url, {
    params: { lastNObservations: 1, format: "csvdata" },
    responseType: "text"
  });

  const lines = String(response.data).split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");

  const obj = {};
  header.forEach((h, i) => obj[h] = last[i]);
  return obj;
}

app.get("/api/bce/tipos", async (req, res) => {
  try {
    const main = await ecbCsv("B.U2.EUR.4F.KR.MRR_FR.LEV");
    const deposit = await ecbCsv("B.U2.EUR.4F.KR.DFR.LEV");
    const marginal = await ecbCsv("B.U2.EUR.4F.KR.MLFR.LEV");

    const operaciones = normalizarTipoBCE(main.OBS_VALUE);
    const deposito = normalizarTipoBCE(deposit.OBS_VALUE);
    const marginalCredito = normalizarTipoBCE(marginal.OBS_VALUE);

    res.json(ok({
      fuente: "ECB Data Portal · Official interest rates",
      estado_dato: "OK",
      tipos: {
        operaciones_principales: {
          valor: operaciones,
          fecha: main.TIME_PERIOD,
          semaforo: semaforoMenor(operaciones, 2, 4)
        },
        facilidad_deposito: {
          valor: deposito,
          fecha: deposit.TIME_PERIOD,
          semaforo: semaforoMenor(deposito, 2, 4)
        },
        facilidad_marginal_credito: {
          valor: marginalCredito,
          fecha: marginal.TIME_PERIOD,
          semaforo: semaforoMenor(marginalCredito, 2.5, 4.5)
        }
      },
      aviso: "Tipos oficiales del BCE. No equivalen directamente al tipo hipotecario ofrecido al cliente."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "ECB Data Portal",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener tipos BCE.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · IPC
========================================================= */

app.get("/api/ine/ipc", async (req, res) => {
  try {
    const tabla = process.env.INE_IPC_TABLA || "50902";
    const rows = await ineTablaJson(tabla, 1);

    const candidato =
      elegirSerie(rows, ["nacional", "indice general", "variacion anual"]) ||
      elegirSerie(rows, ["indice general", "variacion anual"]);

    if (!candidato) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso: "No se localizó IPC nacional en variación anual."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato?.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      semaforo: semaforoMenor(valor, 2, 4),
      aviso: "Dato IPC obtenido desde INE como variación anual nacional."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · IPC",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener IPC.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · PIB
========================================================= */

app.get("/api/ine/pib", async (req, res) => {
  try {
    const tabla = process.env.INE_PIB_TABLA || "67295";
    const rows = await ineTablaJson(tabla, 2);

    const candidato =
      elegirSerie(rows, ["producto interior bruto", "precios de mercado", "valor"]) ||
      elegirSerie(rows, ["producto interior bruto", "valor"]);

    if (!candidato || !candidato.Data || candidato.Data.length < 2) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso: "No se localizaron dos valores consecutivos de PIB."
      }));
    }

    const actual = candidato.Data[0];
    const anterior = candidato.Data[1];

    const valorActual = toNumber(actual.Valor);
    const valorAnterior = toNumber(anterior.Valor);

    const variacionAnual =
      valorActual !== null && valorAnterior
        ? ((valorActual - valorAnterior) / valorAnterior) * 100
        : null;

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: variacionAnual === null ? "NO_DISPONIBLE" : "OK",
      indicador: candidato.Nombre,
      fecha_actual: actual.Anyo,
      periodo_actual: actual.FK_Periodo,
      fecha_anterior: anterior.Anyo,
      periodo_anterior: anterior.FK_Periodo,
      valor_absoluto_actual: valorActual,
      valor_absoluto_anterior: valorAnterior,
      variacion_anual: variacionAnual,
      valor: variacionAnual,
      semaforo: variacionAnual === null ? { color: "gris", nivel: "No disponible" } : semaforoMayor(variacionAnual, 2, 0),
      interpretacion:
        variacionAnual === null
          ? "No se puede calcular la variación anual del PIB."
          : variacionAnual > 2
          ? "Economía expansiva."
          : variacionAnual >= 0
          ? "Crecimiento moderado."
          : "Entorno de desaceleración o contracción.",
      aviso: "PIB calculado como variación anual desde valores absolutos consecutivos."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · PIB",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener PIB.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · PARO
========================================================= */

app.get("/api/ine/paro", async (req, res) => {
  try {
    const ambito = String(req.query.ambito || "ccaa").toLowerCase();
    const nombre = String(req.query.nombre || "").trim();

    const tabla =
      ambito === "provincia"
        ? process.env.INE_PARO_PROVINCIA_TABLA || "3996"
        : process.env.INE_PARO_CCAA_TABLA || "4247";

    const rows = await ineTablaJson(tabla, 1);
    const target = cleanText(nombre);

    const candidato =
      rows.find(r => {
        const serie = cleanText(r.Nombre || "");
        return (!target || serie.includes(target)) && serie.includes("tasa de paro");
      }) ||
      rows.find(r => cleanText(r.Nombre || "").includes("tasa de paro"));

    if (!candidato) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        ambito,
        territorio: nombre,
        aviso: "No se localizó tasa de paro."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato?.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      ambito,
      territorio: nombre || null,
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      semaforo: semaforoMenor(valor, 8, 14),
      interpretacion:
        valor < 8
          ? "Entorno laboral sólido."
          : valor <= 14
          ? "Mercado laboral sensible."
          : "Entorno laboral tensionado.",
      aviso: "Dato de tasa de paro obtenido desde INE."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Paro",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener paro.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · SALARIOS
========================================================= */

app.get("/api/ine/salarios", async (req, res) => {
  try {
    const tabla = process.env.INE_SALARIOS_TABLA || "10882";
    const rows = await ineTablaJson(tabla, 1);

    const candidato =
      elegirSerie(rows, ["salario medio bruto", "ambos sexos", "espana"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio bruto", "ambos sexos"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio", "ambos sexos", "espana"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio", "ambos sexos"], ["mujeres", "hombres"]);

    if (!candidato) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso: "No se localizó salario medio bruto de ambos sexos. No se usa dato de hombres ni mujeres para evitar sesgo."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato?.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      aviso: "Dato salarial obtenido desde INE priorizando salario medio bruto, ambos sexos y España."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Salarios",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener salario medio.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   CIS · ICC
========================================================= */

app.get("/api/cis/icc", async (req, res) => {
  res.json(ok({
    fuente: "CIS · Índice de Confianza del Consumidor",
    estado_dato: "NO_DISPONIBLE",
    valor: null,
    semaforo: null,
    aviso: "CIS ICC no se usa hasta disponer de URL estable de datos estructurados."
  }));
});

/* =========================================================
   CONTEXTO ECONÓMICO
========================================================= */

app.get("/api/contexto-economico", async (req, res) => {
  try {
    const host = `${req.protocol}://${req.get("host")}`;

    const [bce, ipc, pib, paroCcaa, paroProvincia, salarios, cis] =
      await Promise.allSettled([
        http.get(`${host}/api/bce/tipos`),
        http.get(`${host}/api/ine/ipc`),
        http.get(`${host}/api/ine/pib`),
        http.get(`${host}/api/ine/paro?ambito=ccaa&nombre=Extremadura`),
        http.get(`${host}/api/ine/paro?ambito=provincia&nombre=Cáceres`),
        http.get(`${host}/api/ine/salarios`),
        http.get(`${host}/api/cis/icc`)
      ]);

    res.json(ok({
      fuente: "Contexto económico agrupado",
      estado_dato: "OK",
      bce: bce.status === "fulfilled" ? bce.value.data : null,
      ipc: ipc.status === "fulfilled" ? ipc.value.data : null,
      pib: pib.status === "fulfilled" ? pib.value.data : null,
      paro_ccaa: paroCcaa.status === "fulfilled" ? paroCcaa.value.data : null,
      paro_provincia: paroProvincia.status === "fulfilled" ? paroProvincia.value.data : null,
      salarios: salarios.status === "fulfilled" ? salarios.value.data : null,
      cis: cis.status === "fulfilled" ? cis.value.data : null,
      aviso: "Sólo deben interpretarse datos con estado_dato OK."
    }));
  } catch (e) {
    res.json(fail("No se pudo generar contexto económico.", { detalle: e.message }));
  }
});
/* =========================================================
   MACRODECISIÓN
========================================================= */

app.get("/api/macro-decision", async (req, res) => {
  try {
    const host = `${req.protocol}://${req.get("host")}`;
    const contextoResponse = await http.get(`${host}/api/contexto-economico`);
    const c = contextoResponse.data;

    const indicadores = [];

    function sumar(nombre, endpoint, color) {
      if (!endpoint || endpoint.estado_dato !== "OK") return;
      if (!color || color === "gris") return;

      const score = scoreColor(color);
      if (score === null) return;

      indicadores.push({ nombre, color, score });
    }

    sumar("BCE", c.bce, c.bce?.tipos?.operaciones_principales?.semaforo?.color);
    sumar("IPC", c.ipc, c.ipc?.semaforo?.color);
    sumar("PIB variación anual", c.pib, c.pib?.semaforo?.color);
    sumar("Paro CCAA", c.paro_ccaa, c.paro_ccaa?.semaforo?.color);
    sumar("Paro provincia", c.paro_provincia, c.paro_provincia?.semaforo?.color);

    const final =
      indicadores.length > 0
        ? Math.round(indicadores.reduce((acc, item) => acc + item.score, 0) / indicadores.length)
        : null;

    let color = "gris";
    let nivel = "Sin datos";
    let interpretacion = "No existen suficientes datos macroeconómicos para emitir una lectura fiable.";

    if (final !== null) {
      if (final >= 75) {
        color = "verde";
        nivel = "Contexto favorable";
        interpretacion = "El contexto económico general es razonablemente favorable para operaciones equilibradas.";
      } else if (final >= 50) {
        color = "naranja";
        nivel = "Contexto prudente";
        interpretacion = "El contexto económico permite operaciones viables, aunque exige prudencia en compras ajustadas.";
      } else {
        color = "rojo";
        nivel = "Contexto tensionado";
        interpretacion = "El contexto macroeconómico aconseja reforzar margen financiero, ahorro y prudencia antes de comprar.";
      }
    }

    res.json(ok({
      fuente: "Motor macroeconómico InmoRecursos",
      estado_dato: final !== null ? "OK" : "NO_DISPONIBLE",
      score: final,
      semaforo: { color, nivel },
      indicadores_usados: indicadores,
      interpretacion,
      contexto: c,
      aviso: "La macrodecisión interpreta únicamente indicadores oficiales con estado_dato OK."
    }));
  } catch (e) {
    res.json(fail("No se pudo generar macrodecisión.", { detalle: e.message }));
  }
});

/* =========================================================
   AMPLIACIÓN SEGURA · PUNTO CONTROL VENDEDOR
   NO MODIFICA ENDPOINTS EXISTENTES
========================================================= */

async function pcvSafeGet(url) {
  try {
    const r = await http.get(url);
    return r.data;
  } catch (e) {
    return null;
  }
}

function pcvOkDato(endpoint) {
  return endpoint && endpoint.estado_dato === "OK";
}

function pcvVariacion(actual, anterior) {
  const a = toNumber(actual);
  const b = toNumber(anterior);
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / b) * 100;
}

function pcvUltimosDos(serie) {
  if (!serie?.Data || serie.Data.length < 2) return null;

  const actual = serie.Data[0];
  const anterior = serie.Data[1];

  return {
    actual: toNumber(actual.Valor),
    anterior: toNumber(anterior.Valor),
    fecha_actual: actual.Anyo,
    periodo_actual: actual.FK_Periodo,
    fecha_anterior: anterior.Anyo,
    periodo_anterior: anterior.FK_Periodo,
    variacion: pcvVariacion(actual.Valor, anterior.Valor)
  };
}

function pcvNormalizarTerritorio(v = "") {
  return cleanText(v)
    .replace(/^\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pcvBuscarSerie(rows, patrones = [], excluidos = []) {
  if (!Array.isArray(rows)) return null;

  return rows.find(r => {
    const nombre = cleanText(r.Nombre || "");
    const incluye = patrones.every(p => nombre.includes(cleanText(p)));
    const excluye = excluidos.some(p => nombre.includes(cleanText(p)));
    return incluye && !excluye;
  }) || null;
}

function pcvBuscarSerieTerritorio(rows, territorio, patrones = [], excluidos = []) {
  if (!Array.isArray(rows)) return null;

  const t = pcvNormalizarTerritorio(territorio);

  return rows.find(r => {
    const nombre = cleanText(r.Nombre || "");
    const nombreSinCodigo = pcvNormalizarTerritorio(r.Nombre || "");

    const territorioOk =
      nombre.includes(t) ||
      nombreSinCodigo.includes(t) ||
      nombre.includes(` ${t}.`) ||
      nombre.includes(` ${t} `) ||
      nombre.includes(`${t}.`) ||
      nombre.includes(`${t},`);

    const incluye = patrones.every(p => nombre.includes(cleanText(p)));
    const excluye = excluidos.some(p => nombre.includes(cleanText(p)));

    return territorioOk && incluye && !excluye;
  }) || null;
}

function pcvBuscarSerieMunicipioExacto(rows, municipio, patrones = [], excluidos = []) {
  if (!Array.isArray(rows)) return null;

  const objetivo = pcvNormalizarTerritorio(municipio);

  return rows.find(r => {
    const nombre = cleanText(r.Nombre || "");
    const partes = String(r.Nombre || "")
      .split(".")
      .map(p => pcvNormalizarTerritorio(p))
      .filter(Boolean);

    const primeraParte = partes[0] || "";
    const municipioOk = primeraParte === objetivo;

    const incluye = patrones.every(p => nombre.includes(cleanText(p)));
    const excluye = excluidos.some(p => nombre.includes(cleanText(p)));

    return municipioOk && incluye && !excluye;
  }) || null;
}

function pcvPuntosSemaforo(endpoint) {
  const color = endpoint?.semaforo?.color;
  if (color === "verde") return 10;
  if (color === "naranja") return 3;
  if (color === "rojo") return -10;
  return 0;
}

/* =========================================================
   INE · COMPRAVENTAS DE VIVIENDA
========================================================= */

app.get("/api/ine/compraventas", async (req, res) => {
  try {
    const territorio = String(req.query.territorio || req.query.provincia || "Total Nacional").trim();
    const tabla = process.env.INE_COMPRAVENTAS_TABLA || "6150";

    const rows = await ineTablaJson(tabla, 13);

    const serie =
      pcvBuscarSerieTerritorio(rows, territorio, ["viviendas: total"], ["solares"]) ||
      pcvBuscarSerieTerritorio(rows, territorio, ["viviendas", "total"], ["solares"]) ||
      pcvBuscarSerieTerritorio(rows, territorio, ["viviendas"], ["solares"]) ||
      pcvBuscarSerieTerritorio(rows, `10 ${territorio}`, ["viviendas: total"], ["solares"]) ||
      pcvBuscarSerie(rows, ["total nacional", "viviendas: total"], ["solares"]) ||
      pcvBuscarSerie(rows, ["total nacional", "viviendas", "total"], ["solares"]);

    if (!serie) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        territorio,
        aviso: "No se localizó serie de compraventas de viviendas."
      }));
    }

    const datos = pcvUltimosDos(serie);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: datos ? "OK" : "NO_DISPONIBLE",
      territorio,
      indicador: serie.Nombre,
      actual: datos?.actual ?? null,
      anterior: datos?.anterior ?? null,
      variacion: datos?.variacion ?? null,
      fecha_actual: datos?.fecha_actual ?? null,
      periodo_actual: datos?.periodo_actual ?? null,
      fecha_anterior: datos?.fecha_anterior ?? null,
      periodo_anterior: datos?.periodo_anterior ?? null,
      lectura:
        datos?.variacion === null || datos?.variacion === undefined
          ? "No se puede calcular la evolución."
          : datos.variacion > 0
          ? "Las compraventas aumentan. Este dato favorece la posición del vendedor."
          : datos.variacion >= -5
          ? "Las compraventas se mantienen relativamente estables."
          : "Las compraventas retroceden. Puede existir menor presión compradora.",
      semaforo:
        datos?.variacion === null || datos?.variacion === undefined
          ? { color: "gris", nivel: "No disponible" }
          : datos.variacion > 0
          ? { color: "verde", nivel: "Favorable al vendedor" }
          : datos.variacion >= -5
          ? { color: "naranja", nivel: "Mercado prudente" }
          : { color: "rojo", nivel: "Favorable al comprador" },
      aviso: "Dato real INE. Mide actividad de compraventa, no precio de cierre."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Compraventas",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudieron obtener compraventas.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · HIPOTECAS SOBRE VIVIENDAS
========================================================= */

app.get("/api/ine/hipotecas", async (req, res) => {
  try {
    const territorio = String(req.query.territorio || req.query.provincia || "Total Nacional").trim();
    const tabla = process.env.INE_HIPOTECAS_TABLA || "3200";

    const rows = await ineTablaJson(tabla, 13);

    const serie =
      pcvBuscarSerieTerritorio(rows, territorio, ["viviendas", "numero"], ["importe"]) ||
      pcvBuscarSerieTerritorio(rows, territorio, ["viviendas"], ["importe"]) ||
      pcvBuscarSerie(rows, ["total nacional", "viviendas", "numero"], ["importe"]) ||
      pcvBuscarSerie(rows, ["total nacional", "viviendas"], ["importe"]);

    if (!serie) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        territorio,
        aviso: "No se localizó serie de hipotecas sobre viviendas."
      }));
    }

    const datos = pcvUltimosDos(serie);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: datos ? "OK" : "NO_DISPONIBLE",
      territorio,
      indicador: serie.Nombre,
      actual: datos?.actual ?? null,
      anterior: datos?.anterior ?? null,
      variacion: datos?.variacion ?? null,
      fecha_actual: datos?.fecha_actual ?? null,
      periodo_actual: datos?.periodo_actual ?? null,
      fecha_anterior: datos?.fecha_anterior ?? null,
      periodo_anterior: datos?.periodo_anterior ?? null,
      lectura:
        datos?.variacion === null || datos?.variacion === undefined
          ? "No se puede calcular la evolución."
          : datos.variacion > 0
          ? "Aumentan las hipotecas. Puede haber más compradores financiables."
          : datos.variacion >= -5
          ? "Las hipotecas se mantienen relativamente estables."
          : "Caen las hipotecas. Puede reducirse la fuerza compradora.",
      semaforo:
        datos?.variacion === null || datos?.variacion === undefined
          ? { color: "gris", nivel: "No disponible" }
          : datos.variacion > 0
          ? { color: "verde", nivel: "Favorece venta" }
          : datos.variacion >= -5
          ? { color: "naranja", nivel: "Prudencia" }
          : { color: "rojo", nivel: "Demanda debilitada" },
      aviso: "Dato real INE. Refleja financiación hipotecaria inscrita."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Hipotecas",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudieron obtener hipotecas.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · DEMOGRAFÍA MUNICIPAL
========================================================= */

app.get("/api/ine/demografia", async (req, res) => {
  try {
    const municipio = String(req.query.municipio || "").trim();
    const tabla = process.env.INE_DEMOGRAFIA_TABLA || "29005";

    if (!municipio) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse municipio."
      }));
    }

    const rows = await ineTablaJson(tabla, 2);

    const serie =
      pcvBuscarSerieMunicipioExacto(rows, municipio, ["total habitantes"]) ||
      pcvBuscarSerieMunicipioExacto(rows, municipio, ["total"]) ||
      pcvBuscarSerieMunicipioExacto(rows, municipio);

    if (!serie) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        municipio,
        aviso: "No se localizó población municipal."
      }));
    }

    const datos = pcvUltimosDos(serie);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: datos ? "OK" : "NO_DISPONIBLE",
      municipio,
      indicador: serie.Nombre,
      poblacion_actual: datos?.actual ?? null,
      poblacion_anterior: datos?.anterior ?? null,
      variacion: datos?.variacion ?? null,
      fecha_actual: datos?.fecha_actual ?? null,
      fecha_anterior: datos?.fecha_anterior ?? null,
      lectura:
        datos?.variacion === null || datos?.variacion === undefined
          ? "No se puede calcular evolución demográfica."
          : datos.variacion > 0
          ? "El municipio gana población. Puede favorecer demanda residencial."
          : datos.variacion === 0
          ? "Población estable."
          : "El municipio pierde población. Puede limitar la demanda futura.",
      semaforo:
        datos?.variacion === null || datos?.variacion === undefined
          ? { color: "gris", nivel: "No disponible" }
          : datos.variacion > 0
          ? { color: "verde", nivel: "Favorable" }
          : datos.variacion >= -1
          ? { color: "naranja", nivel: "Estable / prudente" }
          : { color: "rojo", nivel: "Desfavorable" },
      aviso: "Dato real INE de población municipal."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · Demografía municipal",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener demografía municipal.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · IRAV ALQUILER
========================================================= */

app.get("/api/ine/irav", async (req, res) => {
  try {
    res.json(ok({
      fuente: "INE · Índice de Referencia de Arrendamientos de Vivienda",
      estado_dato: "NO_DISPONIBLE",
      valor: null,
      semaforo: { color: "gris", nivel: "No disponible" },
      aviso: "Endpoint preparado. Pendiente de conectar a una URL estructurada estable del INE para evitar lecturas frágiles desde HTML."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "INE · IRAV",
      estado_dato: "NO_DISPONIBLE",
      aviso: "No se pudo obtener IRAV.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   MOTOR DE LECTURA VENDEDOR
========================================================= */

function pcvGenerarOpinionVendedor({ macro, compraventas, hipotecas, demografia, mivau, servicios, entorno }) {
  const datos = [];
  let score = 50;

  function add(nombre, valor, lectura, puntos, fuente) {
    if (valor === null || valor === undefined || valor === "No disponible") return;
    score += puntos;
    datos.push({ nombre, valor, lectura, puntos, fuente });
  }

  const bce = macro?.bce?.tipos?.operaciones_principales?.valor ?? null;
  if (bce !== null) {
    add(
      "Tipos oficiales BCE",
      `${bce}%`,
      bce <= 2.5 ? "Tipos moderados: mejoran la capacidad compradora." :
      bce <= 4 ? "Tipos sensibles: obligan a ajustar precio y expectativas." :
      "Tipos elevados: reducen capacidad de compra.",
      bce <= 2.5 ? 8 : bce <= 4 ? 2 : -8,
      macro?.bce?.fuente
    );
  }

  const ipc = macro?.ipc?.valor ?? null;
  if (ipc !== null) {
    add(
      "IPC anual",
      `${Number(ipc).toFixed(2)}%`,
      ipc <= 2.5 ? "Inflación contenida: favorece estabilidad." :
      ipc <= 4 ? "Inflación moderada: puede presionar renta disponible." :
      "Inflación elevada: reduce margen de compra.",
      ipc <= 2.5 ? 6 : ipc <= 4 ? 1 : -6,
      macro?.ipc?.fuente
    );
  }

  const pib = macro?.pib?.variacion_anual ?? macro?.pib?.valor ?? null;
  if (pib !== null) {
    add(
      "PIB variación anual",
      `${Number(pib).toFixed(2)}%`,
      pib > 2 ? "Economía expansiva: favorece actividad." :
      pib >= 0 ? "Crecimiento moderado." :
      "Desaceleración: prudencia.",
      pib > 2 ? 6 : pib >= 0 ? 2 : -6,
      macro?.pib?.fuente
    );
  }

  const paroProv = macro?.paro_provincia?.valor ?? null;
  if (paroProv !== null) {
    add(
      "Paro provincial",
      `${Number(paroProv).toFixed(2)}%`,
      paroProv <= 8 ? "Mercado laboral sólido." :
      paroProv <= 14 ? "Mercado laboral sensible." :
      "Paro elevado: limita compradores solventes.",
      paroProv <= 8 ? 8 : paroProv <= 14 ? 1 : -8,
      macro?.paro_provincia?.fuente
    );
  }

  if (pcvOkDato(compraventas)) {
    add(
      "Compraventas de vivienda",
      `${compraventas.actual} viviendas · ${compraventas.variacion > 0 ? "+" : ""}${Number(compraventas.variacion).toFixed(2)}%`,
      compraventas.lectura,
      pcvPuntosSemaforo(compraventas),
      compraventas.fuente
    );
  }

  if (pcvOkDato(hipotecas)) {
    add(
      "Hipotecas sobre viviendas",
      `${hipotecas.actual} hipotecas · ${hipotecas.variacion > 0 ? "+" : ""}${Number(hipotecas.variacion).toFixed(2)}%`,
      hipotecas.lectura,
      pcvPuntosSemaforo(hipotecas),
      hipotecas.fuente
    );
  }

  if (pcvOkDato(demografia)) {
    add(
      "Demografía municipal",
      `${demografia.poblacion_actual} habitantes · ${demografia.variacion > 0 ? "+" : ""}${Number(demografia.variacion).toFixed(2)}%`,
      demografia.lectura,
      pcvPuntosSemaforo(demografia),
      demografia.fuente
    );
  }

  const mivauValor = mivau?.ultimo?.valor_tasado_total ?? null;
  if (mivauValor !== null) {
    add(
      "Valor tasado MIVAU",
      `${Number(mivauValor).toFixed(0)} €/m²`,
      "Referencia oficial útil para contextualizar el precio, no como precio exacto de cierre.",
      4,
      mivau?.fuente
    );
  }

  const puntosServicios = servicios?.puntuacion_servicios ?? null;
  if (puntosServicios !== null) {
    add(
      "Servicios cercanos",
      `${puntosServicios}/100`,
      servicios.lectura,
      puntosServicios >= 70 ? 8 : puntosServicios >= 40 ? 2 : -6,
      servicios.fuente
    );
  }

  const aire = entorno?.lectura_entorno?.puntuacion_aire ?? null;
  if (aire !== null) {
    add(
      "Calidad ambiental",
      `${aire}/100`,
      entorno?.lectura_entorno?.lectura || "Dato ambiental disponible.",
      aire >= 70 ? 3 : aire >= 45 ? 1 : -3,
      entorno.fuente
    );
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let opinion = "No hay datos suficientes para emitir una opinión de mercado.";
  let resumen = "La herramienta no inventa datos. Si faltan indicadores reales, no fuerza una conclusión.";

  if (datos.length >= 5) {
    if (score >= 70) {
      opinion = "Momento favorable al vendedor";
      resumen = "Los datos muestran actividad de mercado, capacidad compradora razonable y un contexto suficiente para salir a vender con una estrategia de precio bien justificada.";
    } else if (score >= 45) {
      opinion = "Mercado equilibrado";
      resumen = "No hay una ventaja clara para vendedor o comprador. La operación dependerá mucho del precio de salida, la presentación y la competencia real.";
    } else {
      opinion = "Momento más favorable al comprador";
      resumen = "Los datos aconsejan prudencia: puede haber menor fuerza compradora o más presión negociadora sobre el precio.";
    }
  }

  return {
    score,
    opinion,
    resumen,
    datos_usados: datos,
    datos_suficientes: datos.length >= 5
  };
}

/* =========================================================
   API AGRUPADA · PUNTO CONTROL VENDEDOR
========================================================= */

app.get("/api/punto-control-vendedor", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();
    const radio = Number(req.query.radio || 1000);

    if (!direccion) {
      return res.json(ok({
        fuente: "Punto Control Vendedor · InmoRecursos",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse una dirección."
      }));
    }

    const host = `${req.protocol}://${req.get("host")}`;

    const geo = await pcvSafeGet(`${host}/api/geo?direccion=${encodeURIComponent(direccion)}`);
    const geocoding = geo?.geocoding || null;

    const municipio = geocoding?.municipio || geocoding?.nombre || null;
    const provincia = geocoding?.provincia || geocoding?.county || null;

    const [
      servicios,
      entorno,
      mivau,
      renta,
      macro,
      compraventas,
      hipotecas,
      demografia,
      irav
    ] = await Promise.all([
      pcvSafeGet(`${host}/api/servicios?direccion=${encodeURIComponent(direccion)}&radio=${radio}`),
      pcvSafeGet(`${host}/api/entorno?direccion=${encodeURIComponent(direccion)}`),
      municipio ? pcvSafeGet(`${host}/api/mivau/valor-tasado?municipio=${encodeURIComponent(municipio)}`) : null,
      municipio ? pcvSafeGet(`${host}/api/ine/renta?municipio=${encodeURIComponent(municipio)}`) : null,
      pcvSafeGet(`${host}/api/contexto-economico`),
      provincia ? pcvSafeGet(`${host}/api/ine/compraventas?territorio=${encodeURIComponent(provincia)}`) : pcvSafeGet(`${host}/api/ine/compraventas`),
      provincia ? pcvSafeGet(`${host}/api/ine/hipotecas?territorio=${encodeURIComponent(provincia)}`) : pcvSafeGet(`${host}/api/ine/hipotecas`),
      municipio ? pcvSafeGet(`${host}/api/ine/demografia?municipio=${encodeURIComponent(municipio)}`) : null,
      pcvSafeGet(`${host}/api/ine/irav`)
    ]);

    const opinion = pcvGenerarOpinionVendedor({
      macro,
      compraventas,
      hipotecas,
      demografia,
      mivau,
      servicios,
      entorno
    });

    res.json(ok({
      fuente: "Punto Control Vendedor · InmoRecursos",
      estado_dato: "OK",
      direccion_solicitada: direccion,
      municipio,
      provincia,
      geocoding,
      opinion_mercado: opinion,
      datos_reales: {
        macro,
        compraventas,
        hipotecas,
        demografia,
        mivau,
        renta,
        servicios,
        entorno,
        irav
      },
      aviso_consumidor:
        "La opinión se genera sólo con datos reales devueltos por las APIs. Los datos no disponibles no se inventan ni se usan para justificar la conclusión."
    }));
  } catch (e) {
    res.json(fail("No se pudo generar Punto Control Vendedor.", {
      detalle: e.message
    }));
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
