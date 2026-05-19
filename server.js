import express from "express";
import cors from "cors";
import axios from "axios";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 30000,
  headers: { "User-Agent": "InmoRecursos-Punto-Control/1.0" }
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
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

function normalizarTipoBCE(v) {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 20 ? n / 100 : n;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json(ok({
    estado: "Servidor activo",
    endpoints: [
      "/api/entorno?municipio=Plasencia",
      "/api/mivau/valor-tasado?municipio=Plasencia",
      "/api/ine/renta?municipio=Plasencia",
      "/api/ine/salarios",
      "/api/contexto-economico",
      "/api/macro-decision"
    ]
  }));
});

/* =========================================================
   ENTORNO · OPEN-METEO
========================================================= */

app.get("/api/entorno", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || req.query.municipio || "").trim();

    if (!direccion) {
      return res.json(ok({
        fuente: "Open-Meteo",
        estado_dato: "NO_DISPONIBLE",
        aviso: "Debe indicarse dirección o municipio."
      }));
    }

    const geoUrl = "https://geocoding-api.open-meteo.com/v1/search";

    const geoResponse = await http.get(geoUrl, {
      params: {
        name: direccion,
        count: 1,
        language: "es",
        format: "json",
        countryCode: "ES"
      }
    });

    const item = geoResponse.data?.results?.[0];

    if (!item) {
      return res.json(ok({
        fuente: "Open-Meteo Geocoding",
        estado_dato: "NO_DISPONIBLE",
        direccion_solicitada: direccion,
        aviso: "No se pudo geocodificar el municipio o dirección."
      }));
    }

    const lat = item.latitude;
    const lon = item.longitude;

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
      fuente: "Open-Meteo Geocoding España + Open-Meteo Air Quality",
      estado_dato: "OK",
      direccion_solicitada: direccion,
      geocoding: {
        lat,
        lon,
        municipio: item.name,
        provincia: item.admin2 || item.admin1 || null,
        comunidad: item.admin1 || null,
        pais: item.country,
        country_code: item.country_code
      },
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
      aviso: "Datos obtenidos de Open-Meteo. No sustituye mediciones locales oficiales de estaciones concretas."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "Open-Meteo",
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
   MIVAU · VALOR TASADO MUNICIPIOS
========================================================= */

function parseMivauNumber(v) {
  return toNumber(v);
}

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

            const nums = row.map(parseMivauNumber);

            let valorNueva = null;
            let valorUsada = null;
            let valorTotal = null;
            let tasNueva = null;
            let tasUsada = null;
            let tasTotal = null;

            if (nums.length >= 10) {
              valorNueva = nums[3];
              valorUsada = nums[4];
              valorTotal = nums[5];
              tasNueva = nums[7];
              tasUsada = nums[8];
              tasTotal = nums[9];
            } else {
              valorTotal = nums.find(n => n !== null && n > 300 && n < 6000);
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
   INE · PIB VARIACIÓN ANUAL
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
   INE · SALARIO MEDIO BRUTO · AMBOS SEXOS · ESPAÑA
========================================================= */

app.get("/api/ine/salarios", async (req, res) => {
  try {
    const tabla = process.env.INE_SALARIOS_TABLA || "10882";
    const rows = await ineTablaJson(tabla, 1);

    const candidato =
      elegirSerie(rows, ["salario medio bruto", "ambos sexos", "espana"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio bruto", "ambos sexos"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio", "ambos sexos", "espana"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio", "ambos sexos"], ["mujeres", "hombres"]) ||
      elegirSerie(rows, ["salario medio bruto"], ["mujeres"]) ||
      elegirSerie(rows, ["salario medio"], ["mujeres"]);

    if (!candidato) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso: "No se localizó salario medio bruto de ambos sexos."
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

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
