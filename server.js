import express from "express";
import cors from "cors";
import axios from "axios";
import xml2js from "xml2js";
import XLSX from "xlsx";
import iconv from "iconv-lite";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const CACHE = new Map();

const TTL = {
  GEO: 1000 * 60 * 60 * 24,
  ENTORNO: 1000 * 60 * 30,
  CATASTRO: 1000 * 60 * 60 * 24,
  BDE: 1000 * 60 * 60 * 6,
  BCE: 1000 * 60 * 60 * 6,
  INE: 1000 * 60 * 60 * 12,
  MIVAU: 1000 * 60 * 60 * 24,
  CIS: 1000 * 60 * 60 * 12
};

function ok(res, data = {}) {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    ...data
  });
}

function errorResponse(res, fuente, e, status = 200) {
  res.status(status).json({
    status: "ERROR",
    timestamp: new Date().toISOString(),
    fuente,
    mensaje: readableError(e)
  });
}

function readableError(e) {
  if (!e) return "Error desconocido";
  if (e.code) return `${e.code}: ${e.message || "sin detalle"}`;
  if (e.response?.status) return `HTTP ${e.response.status}: ${e.message || "sin detalle"}`;
  return e.message || String(e);
}

function cacheGet(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() > item.expira) {
    CACHE.delete(key);
    return null;
  }
  return item.data;
}

function cacheSet(key, data, ttl) {
  CACHE.set(key, {
    data,
    expira: Date.now() + ttl
  });
  return data;
}

async function cached(key, ttl, fn) {
  const found = cacheGet(key);
  if (found) return found;
  const data = await fn();
  return cacheSet(key, data, ttl);
}

function limpiarTexto(t = "") {
  return String(t)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function limpiarRC(rc = "") {
  return String(rc)
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/-/g, "")
    .trim();
}

function toNumber(v) {
  if (v === null || v === undefined) return null;

  let s = String(v).trim();

  if (!s || s === "_" || limpiarTexto(s) === "nr") return null;

  s = s.replace(/\s+/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(",", ".");
  }

  s = s.replace(/[^\d.-]/g, "");

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function parseXML(xml) {
  return await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: true
  });
}

function noDisponible(fuente, motivo, extra = {}) {
  return {
    estado_dato: "NO_DISPONIBLE",
    fuente,
    valor: null,
    fecha: null,
    motivo,
    lectura: {
      estado: "NO_DISPONIBLE",
      color: "gris",
      lectura: "Dato oficial no disponible.",
      impacto: "No entra en la decisión final."
    },
    ...extra
  };
}

function lecturaIndicador(nombre, valor) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
    return {
      estado: "NO_DISPONIBLE",
      color: "gris",
      lectura: "Dato oficial no disponible.",
      impacto: "No entra en la decisión final."
    };
  }

  const v = Number(valor);

  if (nombre === "ipc") {
    if (v <= 2.5) return { estado: "FAVORABLE", color: "verde", lectura: "Inflación contenida.", impacto: "Menor presión sobre coste de vida, ahorro y dinero libre." };
    if (v <= 4) return { estado: "PRUDENTE", color: "naranja", lectura: "Inflación relevante.", impacto: "Puede reducir margen real mensual." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Inflación elevada.", impacto: "Aumenta la presión sobre suministros, alimentación, mantenimiento y ahorro." };
  }

  if (nombre === "euribor") {
    if (v < 2) return { estado: "FAVORABLE", color: "verde", lectura: "Euríbor bajo o moderado.", impacto: "Menor presión hipotecaria." };
    if (v <= 4) return { estado: "PRUDENTE", color: "naranja", lectura: "Euríbor en zona de prudencia.", impacto: "Conviene medir cuota actual, cuota con estrés y margen mensual." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Euríbor elevado.", impacto: "Mayor sensibilidad de cuota y riesgo en hipoteca variable." };
  }

  if (nombre === "bce") {
    if (v < 2) return { estado: "FAVORABLE", color: "verde", lectura: "Tipos BCE bajos o moderados.", impacto: "Contexto financiero más favorable." };
    if (v <= 4) return { estado: "PRUDENTE", color: "naranja", lectura: "Tipos BCE relevantes.", impacto: "La financiación exige más prudencia." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Tipos BCE elevados.", impacto: "Mayor coste financiero y más exigencia bancaria." };
  }

  if (nombre === "paro") {
    if (v <= 10) return { estado: "FAVORABLE", color: "verde", lectura: "Paro contenido.", impacto: "Contexto laboral relativamente favorable." };
    if (v <= 15) return { estado: "PRUDENTE", color: "naranja", lectura: "Paro relevante.", impacto: "Conviene valorar estabilidad laboral y colchón." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Paro elevado.", impacto: "Mayor riesgo de contexto económico y empleo." };
  }

  if (nombre === "pib") {
    if (v >= 2) return { estado: "FAVORABLE", color: "verde", lectura: "Crecimiento económico positivo.", impacto: "Contexto macroeconómico favorable." };
    if (v >= 0) return { estado: "PRUDENTE", color: "naranja", lectura: "Crecimiento débil.", impacto: "Conviene prudencia en endeudamiento." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Contracción económica.", impacto: "Mayor incertidumbre para decisiones de compra." };
  }

  if (nombre === "confianza") {
    if (v >= 100) return { estado: "FAVORABLE", color: "verde", lectura: "Confianza del consumidor positiva.", impacto: "Percepción económica favorable." };
    if (v >= 75) return { estado: "PRUDENTE", color: "naranja", lectura: "Confianza media o débil.", impacto: "La percepción económica exige prudencia." };
    return { estado: "TENSIONADO", color: "rojo", lectura: "Confianza baja.", impacto: "Puede reflejar menor seguridad del consumidor." };
  }

  return {
    estado: "INFORMATIVO",
    color: "azul",
    lectura: "Dato recibido.",
    impacto: "Dato contextual."
  };
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur.trim());
  return out;
}

/* =========================
   GEOCODING
========================= */

async function geocode(direccion) {
  return cached(`geo:${limpiarTexto(direccion)}`, TTL.GEO, async () => {
    const r = await axios.get("https://geocoding-api.open-meteo.com/v1/search", {
      timeout: 20000,
      params: {
        name: direccion,
        count: 10,
        language: "es",
        format: "json",
        countryCode: "ES"
      }
    });

    const item =
      (r.data?.results || []).find(x => String(x.country_code || "").toUpperCase() === "ES") ||
      r.data?.results?.[0];

    if (!item) throw new Error("No se pudo localizar la dirección o municipio en España");

    return {
      lat: item.latitude,
      lon: item.longitude,
      municipio: item.name || "",
      provincia: item.admin2 || "",
      comunidad: item.admin1 || "",
      pais: item.country || "",
      country_code: item.country_code || ""
    };
  });
}

/* =========================
   OPEN-METEO
========================= */

async function openMeteo(lat, lon) {
  return cached(`entorno:${lat}:${lon}`, TTL.ENTORNO, async () => {
    const [air, weather] = await Promise.all([
      axios.get("https://air-quality-api.open-meteo.com/v1/air-quality", {
        timeout: 20000,
        params: {
          latitude: lat,
          longitude: lon,
          current: "pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi",
          timezone: "Europe/Madrid"
        }
      }),
      axios.get("https://api.open-meteo.com/v1/forecast", {
        timeout: 20000,
        params: {
          latitude: lat,
          longitude: lon,
          current: "temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index",
          timezone: "Europe/Madrid"
        }
      })
    ]);

    const a = air.data.current || {};
    const m = weather.data.current || {};

    return {
      fuente: "Open-Meteo",
      aire: {
        pm10: toNumber(a.pm10),
        pm25: toNumber(a.pm2_5),
        no2: toNumber(a.nitrogen_dioxide),
        ozono: toNumber(a.ozone),
        aqi_europeo: toNumber(a.european_aqi)
      },
      meteo: {
        temperatura: toNumber(m.temperature_2m),
        humedad: toNumber(m.relative_humidity_2m),
        viento: toNumber(m.wind_speed_10m),
        uvi: toNumber(m.uv_index)
      }
    };
  });
}

function scoreAire(aire) {
  let score = 100;

  if (aire.pm25 !== null) score -= aire.pm25 > 25 ? 28 : aire.pm25 > 10 ? 12 : 0;
  if (aire.pm10 !== null) score -= aire.pm10 > 40 ? 20 : aire.pm10 > 20 ? 8 : 0;
  if (aire.no2 !== null) score -= aire.no2 > 40 ? 20 : aire.no2 > 20 ? 8 : 0;
  if (aire.ozono !== null) score -= aire.ozono > 120 ? 14 : aire.ozono > 100 ? 6 : 0;
  if (aire.aqi_europeo !== null) score -= aire.aqi_europeo > 50 ? 20 : aire.aqi_europeo > 20 ? 8 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* =========================
   CATASTRO REALISTA
========================= */

async function intentoCatastro(nombre, url, params) {
  try {
    const r = await axios.get(url, {
      timeout: 30000,
      params,
      validateStatus: () => true,
      headers: {
        "User-Agent": "InmoRecursos-Punto-Control/1.0",
        Accept: "application/xml,text/xml,*/*"
      }
    });

    let parsed = null;

    try {
      parsed = await parseXML(r.data);
    } catch {}

    return {
      nombre,
      ok: r.status >= 200 && r.status < 300 && Boolean(parsed),
      statusHTTP: r.status,
      parsed: Boolean(parsed),
      params,
      raw: parsed,
      sample: typeof r.data === "string" ? r.data.slice(0, 600) : String(r.data).slice(0, 600)
    };
  } catch (e) {
    return {
      nombre,
      ok: false,
      error: readableError(e),
      params
    };
  }
}

async function diagnosticarCatastro(rcOriginal) {
  const rc20 = limpiarRC(rcOriginal);
  const rc14 = rc20.slice(0, 14);

  if (![14, 18, 20].includes(rc20.length)) {
    throw new Error("La referencia catastral debe tener 14, 18 o 20 caracteres");
  }

  return cached(`catastro:${rc20}`, TTL.CATASTRO, async () => {
    const rutas = [];

    rutas.push(
      await intentoCatastro(
        "REST WCF · RefCat completo",
        "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
        { RefCat: rc20 }
      )
    );

    rutas.push(
      await intentoCatastro(
        "REST WCF · RefCat 14",
        "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
        { RefCat: rc14 }
      )
    );

    rutas.push(
      await intentoCatastro(
        "ASMX clásico · RefCat completo",
        "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
        { RefCat: rc20 }
      )
    );

    const valido = rutas.find(x => x.ok && x.parsed);

    return {
      referencia_introducida: rc20,
      referencia_14: rc14,
      endpoint_valido: valido ? valido.nombre : null,
      exito: Boolean(valido),
      resultado_valido: valido || null,
      intentos: rutas.map(x => ({
        nombre: x.nombre,
        ok: x.ok,
        statusHTTP: x.statusHTTP || null,
        parsed: x.parsed || false,
        error: x.error || null,
        params: x.params,
        sample: x.sample || null
      }))
    };
  });
}

function findDeep(obj, keys = []) {
  const resultados = [];

  function walk(x, path = []) {
    if (!x || typeof x !== "object") return;

    for (const [k, v] of Object.entries(x)) {
      const kNorm = limpiarTexto(k);

      if (keys.some(target => kNorm === limpiarTexto(target))) {
        resultados.push({
          key: k,
          path: [...path, k].join("."),
          value: v
        });
      }

      if (typeof v === "object") walk(v, [...path, k]);
    }
  }

  walk(obj);
  return resultados;
}

function resumenCatastro(raw) {
  if (!raw) {
    return {
      estado_dato: "NO_DISPONIBLE",
      campos: {},
      lectura: "Catastro no devolvió una respuesta interpretable.",
      advertencias: [
        "No se inventan datos catastrales.",
        "Debe revisarse la referencia introducida y documentación alternativa."
      ]
    };
  }

  const rc = findDeep(raw, ["rc", "refcat"]).at(0)?.value || null;
  const direccion = findDeep(raw, ["ldt", "direccion", "dir"]).at(0)?.value || null;
  const uso = findDeep(raw, ["uso", "destino"]).at(0)?.value || null;
  const superficie = findDeep(raw, ["sfc", "superficie", "stl"]).at(0)?.value || null;
  const antiguedad = findDeep(raw, ["ant", "antiguedad"]).at(0)?.value || null;

  const campos = {
    referencia: rc,
    direccion,
    uso,
    superficie,
    antiguedad
  };

  const disponibles = Object.values(campos).filter(Boolean).length;

  return {
    estado_dato: disponibles > 0 ? "OK_PARCIAL" : "SIN_CAMPOS_NORMALIZADOS",
    campos,
    lectura:
      disponibles > 0
        ? "Catastro devuelve datos descriptivos parciales. Deben contrastarse con nota simple, IBI, anuncio, visita y documentación urbanística."
        : "Catastro confirma respuesta, pero no se han podido normalizar campos suficientes.",
    advertencias: [
      "Catastro ayuda a identificar física y descriptivamente el inmueble cuando el dato está disponible.",
      "No sustituye nota simple, Registro de la Propiedad, revisión urbanística, cargas ni comprobación jurídica.",
      "No permite afirmar por sí solo si una ampliación está legalizada o si existe coherencia completa con Registro."
    ]
  };
}

/* =========================
   BANCO DE ESPAÑA · EURÍBOR
========================= */

function parseFechaBDE(txt) {
  const meses = {
    ene: 0,
    feb: 1,
    mar: 2,
    abr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    ago: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dic: 11
  };

  const m = String(txt || "")
    .toLowerCase()
    .replace(/"/g, "")
    .match(/(\d{1,2})\s+([a-záéíóúñ]{3})\s+(\d{4})/i);

  if (!m) return null;

  const mesKey = m[2]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .slice(0, 3);

  const mes = meses[mesKey];

  if (mes === undefined) return null;

  return new Date(Number(m[3]), mes, Number(m[1]));
}

function parseBdeCSV(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const parsed = lines.map(splitCSVLine);

  const aliasRow = parsed.find(row => limpiarTexto(row[0]).includes("alias de la serie"));
  const descRow = parsed.find(row => limpiarTexto(row[0]).includes("descripcion de la serie"));

  if (!aliasRow) throw new Error("No se encontró la fila de alias de series en el CSV del Banco de España");

  const indexEuribor12 = aliasRow.findIndex(x => limpiarTexto(x) === "ti_1_7.7");

  if (indexEuribor12 === -1) {
    throw new Error("No se localizó la serie TI_1_7.7 correspondiente a Euríbor 12 meses");
  }

  const descripcion = descRow?.[indexEuribor12] || "Euríbor 12 meses";
  const valores = [];

  for (const row of parsed) {
    const fecha = parseFechaBDE(row[0]);
    if (!fecha) continue;

    const valor = toNumber(row[indexEuribor12]);

    if (valor !== null) {
      valores.push({
        fecha: fecha.toISOString().slice(0, 10),
        valor
      });
    }
  }

  if (!valores.length) throw new Error("La serie Euríbor 12 meses no contiene valores numéricos");

  valores.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const ultimo = valores[valores.length - 1];
  const maximo = valores.reduce((a, b) => (b.valor > a.valor ? b : a), valores[0]);
  const minimo = valores.reduce((a, b) => (b.valor < a.valor ? b : a), valores[0]);

  const fechaLimite10y = new Date();
  fechaLimite10y.setFullYear(fechaLimite10y.getFullYear() - 10);

  const ultimos10 = valores.filter(x => new Date(x.fecha) >= fechaLimite10y);
  const media10y = ultimos10.length
    ? ultimos10.reduce((sum, x) => sum + x.valor, 0) / ultimos10.length
    : null;

  return {
    fuente: "Banco de España · ti_1_7.csv",
    serie: "TI_1_7.7",
    descripcion,
    total_valores: valores.length,
    euribor_12m_actual: ultimo,
    maximo_historico: maximo,
    minimo_historico: minimo,
    media_10y: media10y !== null ? Number(media10y.toFixed(3)) : null,
    lectura: lecturaIndicador("euribor", ultimo.valor),
    muestra_ultimos_5: valores.slice(-5),
    aviso: "Dato extraído del CSV oficial del Banco de España. La serie TI_1_7.7 corresponde al Euríbor a 12 meses."
  };
}

async function bdeEuribor() {
  return cached("bde:euribor12m", TTL.BDE, async () => {
    const url = "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv";

    const r = await axios.get(url, {
      timeout: 30000,
      responseType: "arraybuffer"
    });

    const text = iconv.decode(Buffer.from(r.data), "latin1");

    return parseBdeCSV(text);
  });
}

/* =========================
   MIVAU · VALOR TASADO
========================= */

const MIVAU_BASE = "https://apps.fomento.gob.es/boletinonline2/";
const MIVAU_XLS_MUNICIPIOS = "sedal/35103500.XLS";

function parsePeriodoMivau(sheetName) {
  const m = String(sheetName || "").match(/^T([1-4])A(\d{4})$/i);
  if (!m) return null;

  return {
    trimestre: Number(m[1]),
    anyo: Number(m[2]),
    etiqueta: `T${m[1]} ${m[2]}`,
    orden: Number(m[2]) * 10 + Number(m[1])
  };
}

async function leerMivauMunicipios() {
  return cached("mivau:municipios", TTL.MIVAU, async () => {
    const url = MIVAU_BASE + MIVAU_XLS_MUNICIPIOS;

    const r = await axios.get(url, {
      timeout: 60000,
      responseType: "arraybuffer"
    });

    const wb = XLSX.read(r.data, { type: "buffer" });
    const registros = [];

    for (const sheetName of wb.SheetNames) {
      const periodo = parsePeriodoMivau(sheetName);
      if (!periodo) continue;

      const sheet = wb.Sheets[sheetName];

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: null,
        raw: false
      });

      for (let i = 0; i < rows.length; i++) {
        const fila = rows[i];
        const municipio = String(fila?.[2] || "").trim();

        if (!municipio) continue;

        const municipioLimpio = limpiarTexto(municipio);

        if (!municipioLimpio || municipioLimpio.includes("municipio")) continue;

        let valorNueva = toNumber(fila[3]);
        let valorUsada = toNumber(fila[4]);
        let valorTotal = toNumber(fila[5]);
        let tasacionesNueva = toNumber(fila[7]);
        let tasacionesUsada = toNumber(fila[8]);
        let tasacionesTotal = toNumber(fila[9]);

        if (periodo.anyo < 2010) {
          valorNueva = null;
          valorUsada = null;
          valorTotal = toNumber(fila[3]);
          tasacionesNueva = null;
          tasacionesUsada = null;
          tasacionesTotal = toNumber(fila[5]);
        }

        if (valorNueva === null && valorUsada === null && valorTotal === null) continue;

        registros.push({
          municipio,
          municipio_limpio: municipioLimpio,
          archivo: MIVAU_XLS_MUNICIPIOS,
          hoja: sheetName,
          fila_numero: i + 1,
          periodo: periodo.etiqueta,
          anyo: periodo.anyo,
          trimestre: periodo.trimestre,
          orden: periodo.orden,
          valor_tasado_nueva: valorNueva,
          valor_tasado_usada: valorUsada,
          valor_tasado_total: valorTotal,
          tasaciones_nueva: tasacionesNueva,
          tasaciones_usada: tasacionesUsada,
          tasaciones_total: tasacionesTotal
        });
      }
    }

    return registros;
  });
}

async function mivauValorTasado(municipio) {
  const objetivo = limpiarTexto(municipio);
  const registros = await leerMivauMunicipios();

  const serie = registros
    .filter(r => r.municipio_limpio === objetivo)
    .sort((a, b) => a.orden - b.orden);

  if (!serie.length) {
    return {
      fuente: "MIVAU · Valor tasado vivienda · municipios >25.000 habitantes",
      municipio_buscado: municipio,
      estado_dato: "NO_DISPONIBLE",
      mensaje: "No se localizó el municipio en el XLS oficial de municipios.",
      lectura: "En municipios pequeños puede no existir dato municipal oficial MIVAU. No se sustituye por portales ni estimaciones.",
      aviso: "No se inventa dato alternativo."
    };
  }

  const ultimo = serie[serie.length - 1];

  return {
    fuente: "MIVAU · Valor tasado vivienda · municipios >25.000 habitantes",
    municipio_buscado: municipio,
    estado_dato: "OK",
    ultimo_periodo: ultimo.periodo,
    ultimo: {
      municipio: ultimo.municipio,
      periodo: ultimo.periodo,
      anyo: ultimo.anyo,
      trimestre: ultimo.trimestre,
      valor_tasado_nueva: ultimo.valor_tasado_nueva,
      valor_tasado_usada: ultimo.valor_tasado_usada,
      valor_tasado_total: ultimo.valor_tasado_total,
      tasaciones_nueva: ultimo.tasaciones_nueva,
      tasaciones_usada: ultimo.tasaciones_usada,
      tasaciones_total: ultimo.tasaciones_total
    },
    serie_historica_ultimos_8: serie.slice(-8).map(r => ({
      periodo: r.periodo,
      valor_tasado_nueva: r.valor_tasado_nueva,
      valor_tasado_usada: r.valor_tasado_usada,
      valor_tasado_total: r.valor_tasado_total,
      tasaciones_total: r.tasaciones_total
    })),
    aviso: "Dato extraído del XLS oficial MIVAU de municipios. Usar como referencia oficial de valor tasado, no como precio exacto de cierre."
  };
}

/* =========================
   INE RENTA
========================= */

async function ineRentaTabla30896(municipio) {
  return cached(`ine:renta30896:${limpiarTexto(municipio)}`, TTL.INE, async () => {
    const url = "https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/30896?nult=1";

    const r = await axios.get(url, { timeout: 45000 });
    const data = Array.isArray(r.data) ? r.data : [];
    const objetivo = limpiarTexto(municipio);

    const registrosMunicipio = data.filter(item => {
      const nombre = limpiarTexto(item.Nombre || "");
      return nombre.startsWith(objetivo + ".");
    });

    function ultimoValor(item) {
      const arr = Array.isArray(item?.Data) ? item.Data : [];
      const valido = arr.find(x => x && x.Valor !== undefined && x.Valor !== null);

      return valido
        ? {
            anyo: valido.Anyo,
            valor: toNumber(valido.Valor),
            secreto: Boolean(valido.Secreto)
          }
        : null;
    }

    function buscar(contiene) {
      const encontrado = registrosMunicipio.find(item =>
        limpiarTexto(item.Nombre || "").includes(limpiarTexto(contiene))
      );

      if (!encontrado) return null;

      const valor = ultimoValor(encontrado);

      return {
        cod: encontrado.COD,
        nombre: encontrado.Nombre,
        ...(valor || { anyo: null, valor: null, secreto: null })
      };
    }

    const renta_media_persona = buscar("Renta neta media por persona");
    const renta_media_hogar = buscar("Renta neta media por hogar");
    const renta_unidad_consumo = buscar("Media de la renta por unidad de consumo");
    const mediana_unidad_consumo = buscar("Mediana de la renta por unidad de consumo");
    const renta_mediana_hogar = buscar("Renta mediana por hogar");

    const algunDato =
      renta_media_persona ||
      renta_media_hogar ||
      renta_unidad_consumo ||
      mediana_unidad_consumo ||
      renta_mediana_hogar;

    return {
      fuente: "INE WSTempus · Tabla 30896",
      municipio_buscado: municipio,
      registros_totales: data.length,
      registros_municipio: registrosMunicipio.length,
      estado_dato: algunDato ? "OK" : "NO_DISPONIBLE",
      renta: {
        renta_media_persona,
        renta_media_hogar,
        renta_unidad_consumo,
        mediana_unidad_consumo,
        renta_mediana_hogar
      },
      aviso:
        algunDato
          ? "Dato de renta localizado en tabla INE 30896."
          : "No se localizaron datos útiles para este municipio. No se sustituye por estimaciones."
    };
  });
}

/* =========================
   INE CONFIGURABLE
========================= */

async function ineSerieConfigurada(envTable, descripcion, tipoLectura) {
  const tabla = process.env[envTable];

  if (!tabla) {
    return noDisponible(
      `INE · ${descripcion}`,
      `No hay tabla INE configurada en ${envTable}. No se inventa dato.`
    );
  }

  return cached(`ine:${envTable}:${tabla}`, TTL.INE, async () => {
    const url = `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${tabla}?nult=1`;

    const r = await axios.get(url, { timeout: 45000 });
    const data = Array.isArray(r.data) ? r.data : [];

    const primerDato = data
      .map(x => ({
        nombre: x.Nombre,
        data: Array.isArray(x.Data) ? x.Data[0] : null
      }))
      .find(x => x.data && x.data.Valor !== undefined && x.data.Valor !== null);

    if (!primerDato) {
      return noDisponible(`INE · ${descripcion}`, "La tabla respondió, pero no se encontró un valor utilizable.");
    }

    const valor = toNumber(primerDato.data.Valor);

    if (valor === null) {
      return noDisponible(`INE · ${descripcion}`, "El valor recibido no es numérico.");
    }

    return {
      estado_dato: "OK",
      fuente: `INE · ${descripcion}`,
      tabla,
      indicador: primerDato.nombre,
      valor,
      fecha: primerDato.data.Anyo || primerDato.data.Fecha || null,
      unidad: "%",
      lectura: lecturaIndicador(tipoLectura, valor)
    };
  });
}

async function ineIPC() {
  return ineSerieConfigurada("INE_TABLA_IPC", "IPC / inflación general", "ipc");
}

async function ineParo() {
  return ineSerieConfigurada("INE_TABLA_PARO", "Tasa de paro", "paro");
}

async function inePIB() {
  return ineSerieConfigurada("INE_TABLA_PIB", "Crecimiento PIB", "pib");
}

async function ineSalarios() {
  return ineSerieConfigurada("INE_TABLA_SALARIOS", "Salarios medios", "salarios");
}

/* =========================
   BCE · TIPOS
========================= */

async function bceTipos() {
  return cached("bce:tipos", TTL.BCE, async () => {
    const url = "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.MRR_RT.LEV?lastNObservations=1&format=csvdata";

    try {
      const r = await axios.get(url, {
        timeout: 30000,
        responseType: "text"
      });

      const text = String(r.data || "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];

      if (!last || !last.includes(",")) {
        return noDisponible("BCE · Data Portal", "La respuesta del BCE no contiene una observación utilizable.");
      }

      const parts = last.split(",");
      const nums = parts.map(toNumber).filter(x => x !== null);
      const valor = nums.at(-1) ?? null;
      const fecha = parts.find(x => /^\d{4}/.test(x)) || null;

      if (valor === null) {
        return noDisponible("BCE · Data Portal", "No se pudo convertir el tipo BCE a número.");
      }

      return {
        estado_dato: "OK",
        fuente: "BCE · Data Portal · Main refinancing operations",
        indicador: "Tipo principal de financiación BCE",
        valor,
        fecha,
        unidad: "%",
        lectura: lecturaIndicador("bce", valor)
      };
    } catch (e) {
      return {
        estado_dato: "ERROR",
        fuente: "BCE · Data Portal",
        valor: null,
        mensaje: readableError(e),
        lectura: lecturaIndicador("bce", null)
      };
    }
  });
}

/* =========================
   CIS
========================= */

async function cisConfianza() {
  const url = process.env.CIS_CONFIANZA_JSON_URL;

  if (!url) {
    return noDisponible(
      "CIS · Índice de Confianza del Consumidor",
      "No hay endpoint JSON/CSV oficial configurado. El CIS publica estudios, pero no se debe inventar una API estable."
    );
  }

  return cached("cis:confianza", TTL.CIS, async () => {
    try {
      const r = await axios.get(url, { timeout: 30000 });
      const data = r.data;
      const valor = toNumber(data.valor ?? data.ultimo ?? data.indice ?? null);

      if (valor === null) {
        return noDisponible("CIS · Índice de Confianza del Consumidor", "La fuente configurada no contiene un valor utilizable.");
      }

      return {
        estado_dato: "OK",
        fuente: "CIS · Índice de Confianza del Consumidor",
        indicador: "Índice de Confianza del Consumidor",
        valor,
        fecha: data.fecha ?? null,
        lectura: lecturaIndicador("confianza", valor)
      };
    } catch (e) {
      return {
        estado_dato: "ERROR",
        fuente: "CIS · Índice de Confianza del Consumidor",
        valor: null,
        mensaje: readableError(e),
        lectura: lecturaIndicador("confianza", null)
      };
    }
  });
}

async function cisIntencionCompra() {
  const url = process.env.CIS_INTENCION_COMPRA_JSON_URL;

  if (!url) {
    return noDisponible(
      "CIS · Intención de compra",
      "No hay endpoint JSON/CSV oficial configurado para intención de compra. No se inventa dato."
    );
  }

  return cached("cis:intencion-compra", TTL.CIS, async () => {
    try {
      const r = await axios.get(url, { timeout: 30000 });
      const data = r.data;
      const valor = toNumber(data.valor ?? data.ultimo ?? data.porcentaje ?? null);

      if (valor === null) {
        return noDisponible("CIS · Intención de compra", "La fuente configurada no contiene un valor utilizable.");
      }

      return {
        estado_dato: "OK",
        fuente: "CIS · Intención de compra",
        indicador: "Intención de compra",
        valor,
        fecha: data.fecha ?? null,
        unidad: "%",
        lectura: {
          estado: "INFORMATIVO",
          color: "azul",
          lectura: "Dato recibido.",
          impacto: "Ayuda a interpretar demanda percibida, pero no sustituye la viabilidad personal."
        }
      };
    } catch (e) {
      return {
        estado_dato: "ERROR",
        fuente: "CIS · Intención de compra",
        valor: null,
        mensaje: readableError(e),
        lectura: lecturaIndicador("confianza", null)
      };
    }
  });
}

/* =========================
   CONTEXTO ECONÓMICO
========================= */

function lecturaContextoEconomico(datos) {
  const indicadores = [
    datos.ipc,
    datos.euribor,
    datos.bce,
    datos.paro,
    datos.pib,
    datos.salarios,
    datos.cis_confianza,
    datos.cis_intencion_compra
  ];

  const validos = indicadores.filter(x => x && x.estado_dato === "OK");
  const tensionados = validos.filter(x => x.lectura?.estado === "TENSIONADO").length;
  const prudentes = validos.filter(x => x.lectura?.estado === "PRUDENTE").length;
  const favorables = validos.filter(x => x.lectura?.estado === "FAVORABLE").length;

  let estado = "NO_CONCLUYENTE";
  let color = "gris";
  let lectura = "No hay suficientes datos oficiales consolidados para valorar el contexto económico.";
  let impacto = "La decisión debe basarse principalmente en viabilidad personal, LTV, CTR, colchón y documentación.";

  if (validos.length >= 3) {
    if (tensionados >= 2) {
      estado = "TENSIONADO";
      color = "rojo";
      lectura = "El contexto económico aconseja máxima prudencia.";
      impacto = "Si la operación es viable, debería reforzarse colchón, negociar precio y revisar estrés financiero.";
    } else if (prudentes + tensionados >= 3) {
      estado = "PRUDENTE";
      color = "naranja";
      lectura = "El contexto económico no impide comprar, pero exige prudencia.";
      impacto = "La operación debe soportar cambios de tipos, inflación y reducción de margen mensual.";
    } else if (favorables >= 3) {
      estado = "FAVORABLE";
      color = "verde";
      lectura = "El contexto económico acompaña razonablemente.";
      impacto = "Puede apoyar una decisión favorable si la operación personal también es sólida.";
    }
  }

  return {
    estado,
    color,
    lectura,
    impacto,
    datos_validos: validos.length,
    datos_no_disponibles: indicadores.filter(x => x && x.estado_dato !== "OK").length
  };
}

async function contextoEconomico() {
  const [ipc, euriborRaw, bce, paro, pib, salarios, cisConf, cisCompra] = await Promise.all([
    ineIPC(),
    bdeEuribor(),
    bceTipos(),
    ineParo(),
    inePIB(),
    ineSalarios(),
    cisConfianza(),
    cisIntencionCompra()
  ]);

  const euribor = euriborRaw?.euribor_12m_actual
    ? {
        estado_dato: "OK",
        fuente: euriborRaw.fuente,
        indicador: "Euríbor 12 meses",
        valor: euriborRaw.euribor_12m_actual.valor,
        fecha: euriborRaw.euribor_12m_actual.fecha,
        unidad: "%",
        lectura: lecturaIndicador("euribor", euriborRaw.euribor_12m_actual.valor),
        maximo_historico: euriborRaw.maximo_historico,
        minimo_historico: euriborRaw.minimo_historico,
        media_10y: euriborRaw.media_10y
      }
    : {
        estado_dato: "ERROR",
        fuente: "Banco de España · Euríbor",
        valor: null,
        lectura: lecturaIndicador("euribor", null)
      };

  const datos = {
    ipc,
    euribor,
    bce,
    paro,
    pib,
    salarios,
    cis_confianza: cisConf,
    cis_intencion_compra: cisCompra
  };

  return {
    fuente: "Contexto económico · INE + Banco de España + BCE + CIS",
    estado_dato: "OK",
    datos,
    lectura_global: lecturaContextoEconomico(datos),
    aviso: "El contexto económico modula la recomendación, pero no sustituye la viabilidad personal de la operación."
  };
}

/* =========================
   ENDPOINTS
========================= */

app.get("/", (_, res) => {
  ok(res, {
    servicio: "InmoRecursos · Punto de Control de Compra",
    version: "server completo premium",
    principio: "Nunca inventar datos. Si una fuente no devuelve dato fiable, se muestra NO_DISPONIBLE.",
    endpoints: [
      "/health",
      "/api/geocode?direccion=Plasencia",
      "/api/entorno?direccion=Plasencia",
      "/api/catastro?rc=REFERENCIA",
      "/api/bde/euribor",
      "/api/mivau/valor-tasado?municipio=Plasencia",
      "/api/ine-renta?municipio=Plasencia",
      "/api/ine/ipc",
      "/api/ine/paro",
      "/api/ine/pib",
      "/api/ine/salarios",
      "/api/bce/tipos",
      "/api/cis/confianza",
      "/api/cis/intencion-compra",
      "/api/contexto-economico",
      "/api/test/all?municipio=Plasencia&direccion=Plasencia&rc=REFERENCIA"
    ]
  });
});

app.get("/health", (_, res) => {
  ok(res, {
    estado: "Servidor activo",
    cache_items: CACHE.size
  });
});

app.get("/api/geocode", async (req, res) => {
  try {
    if (!req.query.direccion) throw new Error("Falta el parámetro direccion");

    ok(res, {
      fuente: "Open-Meteo Geocoding",
      geocoding: await geocode(req.query.direccion)
    });
  } catch (e) {
    errorResponse(res, "Open-Meteo Geocoding", e);
  }
});

app.get("/api/entorno", async (req, res) => {
  try {
    if (!req.query.direccion) throw new Error("Falta el parámetro direccion");

    const geo = await geocode(req.query.direccion);
    const meteo = await openMeteo(geo.lat, geo.lon);
    const puntuacion = scoreAire(meteo.aire);

    ok(res, {
      fuente: "Open-Meteo Geocoding España + Open-Meteo",
      direccion_solicitada: req.query.direccion,
      geocoding: geo,
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      aire: meteo.aire,
      meteo: meteo.meteo,
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura:
          puntuacion >= 70
            ? "Entorno ambiental favorable"
            : puntuacion >= 45
              ? "Entorno ambiental funcional"
              : "Entorno ambiental condicionante"
      }
    });
  } catch (e) {
    errorResponse(res, "Entorno", e);
  }
});

app.get("/api/catastro", async (req, res) => {
  try {
    if (!req.query.rc) throw new Error("Falta la referencia catastral");

    const data = await diagnosticarCatastro(req.query.rc);

    if (!data.exito) {
      ok(res, {
        fuente: "Dirección General del Catastro",
        disponible: false,
        estado_dato: "NO_DISPONIBLE",
        mensaje: "Catastro no devolvió datos válidos con ninguno de los métodos probados.",
        lectura_catastro: {
          estado_dato: "NO_DISPONIBLE",
          campos: {},
          lectura: "No se puede realizar lectura catastral.",
          advertencias: [
            "No se inventan datos catastrales.",
            "Debe revisarse la referencia introducida y documentación alternativa."
          ]
        },
        catastro_test: data
      });
      return;
    }

    const lectura = resumenCatastro(data.resultado_valido.raw);

    ok(res, {
      fuente: "Dirección General del Catastro",
      disponible: true,
      estado_dato: lectura.estado_dato,
      endpoint_usado: data.endpoint_valido,
      lectura_catastro: lectura,
      catastro: data.resultado_valido.raw,
      catastro_test: data
    });
  } catch (e) {
    errorResponse(res, "Dirección General del Catastro", e);
  }
});

app.get("/api/bde/euribor", async (_, res) => {
  try {
    ok(res, await bdeEuribor());
  } catch (e) {
    errorResponse(res, "Banco de España · Euríbor", e);
  }
});

app.get("/api/mivau/valor-tasado", async (req, res) => {
  try {
    if (!req.query.municipio) throw new Error("Falta el parámetro municipio");

    ok(res, await mivauValorTasado(req.query.municipio));
  } catch (e) {
    errorResponse(res, "MIVAU · Valor tasado", e);
  }
});

app.get("/api/ine-renta", async (req, res) => {
  try {
    if (!req.query.municipio) throw new Error("Falta el parámetro municipio");

    ok(res, await ineRentaTabla30896(req.query.municipio));
  } catch (e) {
    errorResponse(res, "INE · Renta", e);
  }
});

app.get("/api/ine/ipc", async (_, res) => {
  try {
    ok(res, await ineIPC());
  } catch (e) {
    errorResponse(res, "INE · IPC", e);
  }
});

app.get("/api/ine/paro", async (_, res) => {
  try {
    ok(res, await ineParo());
  } catch (e) {
    errorResponse(res, "INE · Tasa de paro", e);
  }
});

app.get("/api/ine/pib", async (_, res) => {
  try {
    ok(res, await inePIB());
  } catch (e) {
    errorResponse(res, "INE · PIB", e);
  }
});

app.get("/api/ine/salarios", async (_, res) => {
  try {
    ok(res, await ineSalarios());
  } catch (e) {
    errorResponse(res, "INE · Salarios", e);
  }
});

app.get("/api/bce/tipos", async (_, res) => {
  try {
    ok(res, await bceTipos());
  } catch (e) {
    errorResponse(res, "BCE · Tipos oficiales", e);
  }
});

app.get("/api/cis/confianza", async (_, res) => {
  try {
    ok(res, await cisConfianza());
  } catch (e) {
    errorResponse(res, "CIS · Confianza consumidor", e);
  }
});

app.get("/api/cis/intencion-compra", async (_, res) => {
  try {
    ok(res, await cisIntencionCompra());
  } catch (e) {
    errorResponse(res, "CIS · Intención de compra", e);
  }
});

app.get("/api/contexto-economico", async (_, res) => {
  try {
    ok(res, await contextoEconomico());
  } catch (e) {
    errorResponse(res, "Contexto económico", e);
  }
});

app.get("/api/test/all", async (req, res) => {
  const municipio = req.query.municipio || "Plasencia";
  const direccion = req.query.direccion || municipio;
  const rc = req.query.rc || "";

  const tests = {};

  async function run(name, fn) {
    try {
      tests[name] = {
        status: "OK",
        data: await fn()
      };
    } catch (e) {
      tests[name] = {
        status: "ERROR",
        mensaje: readableError(e)
      };
    }
  }

  await run("geocode", async () => geocode(direccion));

  await run("entorno", async () => {
    const geo = await geocode(direccion);
    const meteo = await openMeteo(geo.lat, geo.lon);

    return {
      geocoding: geo,
      ...meteo,
      lectura_entorno: {
        puntuacion_aire: scoreAire(meteo.aire)
      }
    };
  });

  if (rc) {
    await run("catastro", async () => {
      const c = await diagnosticarCatastro(rc);

      return {
        referencia_introducida: c.referencia_introducida,
        referencia_14: c.referencia_14,
        exito: c.exito,
        endpoint_valido: c.endpoint_valido,
        lectura: c.exito ? resumenCatastro(c.resultado_valido.raw) : null
      };
    });
  } else {
    tests.catastro = {
      status: "NO_PROBADO",
      mensaje: "Añada rc para probar Catastro."
    };
  }

  await run("banco_espana", bdeEuribor);
  await run("mivau", async () => mivauValorTasado(municipio));
  await run("ine_renta", async () => ineRentaTabla30896(municipio));
  await run("bce", bceTipos);
  await run("contexto_economico", contextoEconomico);

  ok(res, {
    municipio,
    direccion,
    tests
  });
});

app.listen(PORT, () => {
  console.log(`Servidor Punto de Control activo en puerto ${PORT}`);
});
