import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================================================
   🧠 MOTOR DECISIÓN
========================================================= */

function evaluarOperacion({ ingresos, cuota, precio, entorno }) {
  const ratio = (cuota / ingresos) * 100;

  let viabilidad = "VIABLE";
  let nivel = "ÓPTIMA";

  if (ratio > 40) {
    viabilidad = "NO VIABLE";
    nivel = "CRÍTICA";
  } else if (ratio > 35) {
    viabilidad = "JUSTA";
    nivel = "RIESGO";
  }

  return { ratio: Math.round(ratio), viabilidad, nivel };
}

/* =========================================================
   🤝 NEGOCIACIÓN
========================================================= */

function negociacion(precio, objetivo) {
  const margen = precio - objetivo;
  const porcentaje = (margen / precio) * 100;

  return {
    margen,
    porcentaje: porcentaje.toFixed(1),
    recomendacion:
      porcentaje > 10
        ? "Existe margen claro de negociación"
        : "Margen de negociación limitado"
  };
}

/* =========================================================
   📈 PREDICCIÓN
========================================================= */

function prediccion(precio, crecimiento = 3, años = 10) {
  return Math.round(precio * Math.pow(1 + crecimiento / 100, años));
}

/* =========================================================
   🧮 CTR
========================================================= */

function ctr(precio, interes, años) {
  const intereses = precio * (interes / 100) * años;
  return Math.round(precio + intereses + precio * 0.1);
}

/* =========================================================
   📊 EURIBOR
========================================================= */

async function getEuribor() {
  try {
    const r = await axios.get("https://www.bde.es/webbe/es/estadisticas/temas/tipos-interes/euribor/series/euribor_1m.csv");
    const lines = r.data.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const row = lines[i].split(";");
      if (row[1]) return parseFloat(row[1].replace(",", "."));
    }
  } catch {}
  return 2.5;
}

/* =========================================================
   🌍 ENTORNO SIMPLE
========================================================= */

async function getEntorno(lat, lon) {
  try {
    const air = await axios.get(`https://api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=european_aqi&timezone=auto`);
    const aqi = air.data.hourly.european_aqi.slice(-1)[0];

    let score = 50;
    if (aqi < 25) score = 90;
    else if (aqi < 50) score = 75;
    else if (aqi < 75) score = 60;

    return score;
  } catch {
    return 50;
  }
}

/* =========================================================
   🧾 GENERADOR INFORME
========================================================= */

function generarInforme(data) {
  return {
    resumen: `Operación ${data.viabilidad} con un ratio del ${data.ratio}%`,
    recomendacion:
      data.viabilidad === "NO VIABLE"
        ? "Se recomienda no continuar sin ajustes"
        : "Operación viable con análisis detallado",
    decision:
      data.viabilidad === "VIABLE" ? "SEGUIR" : "REPLANTEAR"
  };
}

/* =========================================================
   🎯 ENDPOINT FINAL PRODUCTO
========================================================= */

app.post("/api/analisis-completo", async (req, res) => {
  try {
    const {
      ingresos,
      cuota,
      precio,
      objetivo,
      lat,
      lon,
      interes,
      años
    } = req.body;

    const euribor = await getEuribor();
    const entorno = await getEntorno(lat, lon);

    const evaluacion = evaluarOperacion({ ingresos, cuota, precio, entorno });
    const neg = negociacion(precio, objetivo);
    const valorFuturo = prediccion(precio);
    const costeTotal = ctr(precio, interes || euribor, años || 25);

    const informe = generarInforme(evaluacion);

    res.json({
      ok: true,
      evaluacion,
      negociacion: neg,
      valor_futuro: valorFuturo,
      coste_total: costeTotal,
      entorno,
      euribor,
      informe
    });

  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

/* ========================================================= */

app.get("/", (req, res) => {
  res.send("Backend 10.0 PRODUCTO FINAL ACTIVO");
});

app.listen(PORT, () => {
  console.log("Servidor 10.0 listo para producción");
});
