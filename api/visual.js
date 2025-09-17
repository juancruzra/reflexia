// api/visual.js — Vercel Serverless (Node.js runtime)
import OpenAI from "openai";

const MODEL = process.env.MODEL || "gpt-4o-mini";

function buildSystemPrompt() {
  return `
Eres un coach reflexivo en español rioplatense. Habla cálido, concreto, empático; no terapeuta ni oráculo.

El usuario te da:
- Una pregunta personal (texto libre).
- Tres cartas visuales que eligió (solo nombres; no los repitas).
- Notas breves que escribió (lo que sintió/pensó).

Devolvé SOLO JSON con dos campos:
{
  "insight": "...",
  "miniStory": "..."
}

### "insight"
- 2–3 párrafos (7–10 líneas totales), segunda persona (“vos”).
- Reformulá brevemente la pregunta.
- Reflejá tensiones, puntos ciegos, recursos internos y posibilidades de acción.
- Sé práctico y cercano, como un coach: ofrecé invitaciones o preguntas, no mandatos.
- Cerrá con una pregunta poderosa o reflexión abierta.

### "miniStory"
- Fábula/cuento de 180–350 palabras con inicio, desarrollo, desenlace.
- Personajes simples (viajero, jardinera, ave, niño, artesano).
- Escena concreta (bosque, mar, ciudad, montaña, taller).
- Sin mencionar en la historia nombres de cartas ni forzar símbolos con estas.
- Cerrar SIEMPRE:
  "MORALEJA: <frase breve, amable y accionable>"

  Devolvé SOLO JSON válido con claves "insight" y "miniStory". Comillas dobles en todo. Sin texto extra fuera del JSON.
`.trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { question = "", cards = [], notes = [] } = req.body || {};
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const user = `
Pregunta: ${JSON.stringify(question)}

Cartas elegidas (nombres):
${cards.map((c, i) => `${i + 1}) ${c.name}`).join("\n")}

Notas del usuario:
${notes.map(n => `- ${n.note}`).join("\n")}
`.trim();

    const schema = {
      type: "object",
      properties: { insight: { type: "string" }, miniStory: { type: "string" } },
      required: ["insight", "miniStory"],
      additionalProperties: false
    };

    const r = await client.responses.create({
      model: MODEL,
      instructions: buildSystemPrompt(),
      input: user,
      response_format: { type: "json_schema", json_schema: { name: "ReflexiaV2", schema, strict: true } }
    });

    // Extraer JSON
    let out = null;
    try {
      const blocks = r.output || [];
      for (const b of blocks) {
        for (const item of (b.content || [])) {
          if (item.type === "json" && item.json) out = item.json;
        }
      }
      if (!out) out = JSON.parse(r.output_text || "{}");
    } catch {
      out = { insight: "", miniStory: "" };
    }

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "AI error" });
  }
}
