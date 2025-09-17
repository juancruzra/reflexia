// api/visual.js — Genera insight + fábula; guarda opcionalmente en Supabase si hay credenciales
import OpenAI from "openai";
import { randomUUID } from "crypto";

const MODEL = process.env.MODEL || "gpt-4o-mini";

// Flags Supabase (si no están, no guarda y NO importa el SDK)
const HAS_SB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let supabase = null;

async function getSupabase() {
  if (!HAS_SB) return null;
  if (supabase) return supabase; // cache
  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  return supabase;
}

function buildSystemPrompt() {
  return `
Eres un coach reflexivo en español rioplatense. Habla de manera cálida, concreta y empática, nunca como oráculo ni terapeuta.

El usuario te da:
- Una pregunta o inquietud personal (texto libre).
- Tres cartas visuales que eligió (solo los nombres sirven como disparador, no los repitas literalmente).
- Notas breves que escribió sobre lo que sintió o pensó al ver las cartas.

Tu tarea es devolver SOLO JSON con dos campos:

{
  "insight": "...",
  "miniStory": "..."
}

### Reglas para "insight"
- Escribe 2–3 párrafos (7–10 líneas en total).
- Usa segunda persona (“vos”).
- Reformula brevemente la pregunta del usuario.
- Refleja tensiones, recursos internos y posibilidades de acción. Acá si puedes utilizar las cartas elegidas o sus simbolismos para hacer asociaciones o comparaciones si es necesario.
- Sé práctico y cercano, como un coach: ofrecé invitaciones o preguntas, no mandatos.
- Cerrá con una pregunta poderosa o reflexión abierta.

### Reglas para "miniStory"
- Escribe una fábula o cuento de 180–350 palabras.
- Debe tener inicio, desarrollo y desenlace claros.
- Usa personajes simples (viajero, jardinero, ave, niño, artesano, son solo ejemplos puedes usar otros).
- Crea una escena concreta y visual (bosque, mar, montaña, ciudad, taller, son solo ejemplos puedes usar otros).
- El aprendizaje debe emerger del relato, no de explicaciones forzadas.
- Está estrictamente prohibido que uses las cartas y sus símbolos en la fábula. La fábula es para ver el caso desde otra mirada y desempalagarnos de las cartas.
- Cerrá SIEMPRE con esta línea final en mayúsculas:
  "MORALEJA: <frase breve, amable y accionable>"

Devolvé SOLO JSON válido con claves "insight" y "miniStory". Comillas dobles en todo. Sin texto extra fuera del JSON.
`.trim();
}

// Compat Responses API (por si algún día volvés)
function extractJSON(resObj) {
  try {
    const out = resObj.output || [];
    for (const block of out) {
      for (const item of (block.content || [])) {
        if (item.type === "json" && item.json) return item.json;
      }
    }
  } catch {}
  const txt = (resObj.output_text || "").trim();
  if (!txt) throw new Error("Respuesta vacía de IA");
  const fence = txt.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : txt;
  try { return JSON.parse(raw); } catch {}
  const fixed = raw
    .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  return JSON.parse(fixed);
}

function getAnonId(req, res) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/anon_id=([a-f0-9-]+)/i);
  if (m) return m[1];
  const id = randomUUID();
  res.setHeader("Set-Cookie", `anon_id=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { question = "", cards = [], notes = [] } = req.body || {};
    if (!question || !Array.isArray(cards) || cards.length !== 3)
      return res.status(400).json({ error: "Payload inválido" });

    const anonId = getAnonId(req, res);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    if (!client.apiKey) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });

    const user = `
Pregunta: ${JSON.stringify(question)}
Cartas elegidas (nombres):
${cards.map((c, i) => `${i + 1}) ${c.name}`).join("\n")}
Notas del usuario:
${notes.map(n => `- ${n.note}`).join("\n")}
`.trim();

    // IA — Chat Completions con JSON Schema (estable)
    const schema = {
      type: "object",
      properties: { insight: { type: "string" }, miniStory: { type: "string" } },
      required: ["insight", "miniStory"],
      additionalProperties: false
    };

    const ai = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: user }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ReflexiaV2",
          schema,
          strict: true
        }
      }
    });

    // Parseo del JSON
    let txt = ai.choices?.[0]?.message?.content?.trim() || "";
    if (!txt) throw new Error("Respuesta vacía de IA");
    let out;
    try {
      out = JSON.parse(txt);
    } catch {
      const fence = txt.match(/```json\s*([\s\S]*?)```/i);
      if (fence && fence[1]) out = JSON.parse(fence[1]);
      else {
        const fixed = txt
          .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/'/g, '"');
        out = JSON.parse(fixed);
      }
    }

    const insight = (out.insight || "").trim();
    const miniStory = (out.miniStory || "").trim();
    if (!insight || !miniStory) throw new Error("IA devolvió vacío");

    // Guardado opcional en Supabase (solo si hay credenciales)
    let sessionId = null;
    if (HAS_SB) {
      try {
        const sb = await getSupabase();
        if (sb) {
          // sessions
          const { data: sData, error: sErr } = await sb
            .from("sessions")
            .insert([{
              id: randomUUID(),
              anon_id: anonId,
              question,
              insight,
              mini_story: miniStory
            }])
            .select("id")
            .single();
          if (sErr) console.error("[SB sessions] ", sErr);
          sessionId = sData?.id || null;

          // session_cards
          if (sessionId) {
            const cardRows = cards.map((c, i) => ({
              id: randomUUID(),
              session_id: sessionId,
              name: c.name,
              image_path: c.image_path || null,
              position: i + 1
            }));
            const { error: cErr } = await sb.from("session_cards").insert(cardRows);
            if (cErr) console.error("[SB cards] ", cErr);
          }

          // session_notes
          if (sessionId && notes?.length) {
            const noteRows = notes
              .filter(n => (n.note || "").trim())
              .map(n => ({
                id: randomUUID(),
                session_id: sessionId,
                card_name: n.name || n.card_name || "",
                note: n.note
              }));
            if (noteRows.length) {
              const { error: nErr } = await sb.from("session_notes").insert(noteRows);
              if (nErr) console.error("[SB notes] ", nErr);
            }
          }
        }
      } catch (e) {
        console.error("[SB error]", e?.message || e);
      }
    }

    return res.status(200).json({ insight, miniStory, sessionId, stored: !!sessionId });
  } catch (e) {
    console.error("[API error]", e);
    return res.status(500).json({ error: e?.message || "AI/Server error" });
  }
}
