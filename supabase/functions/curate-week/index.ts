import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WORKWEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Escapes raw control characters and stray double quotes inside JSON string values.
// A quote is treated as closing only when the next non-space character is , } ] or :
function repairJsonStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (j >= json.length || ",}]:".includes(json[j])) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch.charCodeAt(0) < 0x20) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

function extractJson(rawText: string): any {
  const unfenced = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON found in model output");
  }
  const candidate = unfenced.substring(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    try {
      return JSON.parse(repairJsonStrings(candidate));
    } catch (_) {
      throw new Error(`Curation JSON could not be parsed: ${(firstErr as Error).message}`);
    }
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { garments, heroAnchor, dailySchedules, locationName, target_day, locked_outfits, previous_outfit } = await req.json();

    if (!garments || garments.length === 0) {
      return new Response(JSON.stringify({ error: "No garments provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret not found in Supabase" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const activeModel = "claude-sonnet-5-5";

    const catalogSummary = garments.map((g: any) => ({
      id: g.id,
      brand: g.brand || "Unspecified",
      name: g.name,
      cat: g.category,
      sub: g.sub_category || "",
      col: g.color || "",
      form: g.formality || "Executive Casual"
    }));

    // Inventory preflight: distinct pieces per slot, so the model knows where reuse is permitted
    const countCategory = (cat: string) => catalogSummary.filter((g: any) => g.cat === cat).length;
    const inventory = {
      Top: countCategory("Top"),
      Layer: countCategory("Layer"),
      Bottom: countCategory("Bottom"),
      Footwear: countCategory("Footwear")
    };

    const isSingleDay = Boolean(target_day);
    if (isSingleDay && !WORKWEEK_DAYS.includes(target_day)) {
      return new Response(JSON.stringify({ error: `Invalid target_day: ${target_day}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const styleRules = `4. ADAPTIVE METEOROLOGY & CONTEXT:
- Synchronize with each day's SPECIFIC temperature and conditions (cooler temperatures mandate knits, flannels, chore jackets; milder temperatures allow lighter layers).
- Match each day's SPECIFIC ACTIVITY:
 * "In-Person Meeting": Tailored, elevated (blazers, structured sport coats, dress chinos/trousers, clean leather loafers/shoes).
 * "Work From Home / Focus": Elevated comfort (merino knits, luxury tees, 5-pocket pants, elevated sneakers).
 * "Executive Casual / Office": Refined balance (overshirts, casual blazers, oxfords, derbies/boots).
 * "Client Dinner / Evening": Sharp, richer tones (monochrome, dark charcoal/navy, elevated boots or dress shoes).
 * "Travel / Transit": Versatile stretch, comfortable layering.
5. EXECUTIVE HARMONY: Anchor outfits in elevated neutrals (navy, charcoal, tobacco, olive, grey) with at most one textured statement piece per outfit.`;

    const jsonRules = `- Never wrap the JSON in markdown code fences (no \`\`\`json or \`\`\`). The first character must be { and the last must be }.
- Never use unescaped double quotes inside string values (executiveBriefing, rationale). To quote a phrase or garment name, use single quotes ('quiet luxury'); for inch measurements write "in" instead of the " symbol.
- Keep each string value on a single line with no line breaks.
- Garment slots contain only the garment id. Do not add names, descriptions, or per-slot commentary.`;

    const weekPrompt = `You are Sloane, an elite executive wardrobe architect.
Curate a tailored 5-day workweek board (Monday through Friday) for an executive in ${locationName || "Minnetonka, MN"}.

STRICT RULES:
1. ROTATION INTEGRITY (INVENTORY-AWARE): The payload includes "inventory", the number of distinct pieces in each category (Top, Layer, Bottom, Footwear). Apply rotation per category:
- Tops (shirts, knits, tees): No top may repeat across Monday through Friday. Only if inventory.Top is fewer than 5 may a top be worn twice; then repeat the fewest tops possible, never on consecutive days.
- Layers (outerwear), Bottoms (trousers, chinos), and Footwear: Prioritize variety and use every suitable distinct piece before repeating any. Only if a category has fewer distinct pieces than the 5 days require, re-style versatile staple pieces (neutral trousers, a navy blazer, brown loafers) across 2 non-consecutive days, paired with different complementary garments each time.
- Use a repeated piece on at most 2 days. Only if a category has so few pieces that 5 days cannot be covered otherwise (e.g. 1 or 2 bottoms) may a piece appear on more days; still avoid consecutive days wherever the inventory allows.
- When a piece repeats, say so in that day's rationale and explain how the restyle makes the outfit distinct.
2. HERO ANCHOR INTEGRITY: If active, lock it to THAT SINGLE DAY ONLY in its category. Harmonize other pieces around it. Never assign that piece to any other day, even when inventory is limited.
3. COMPLETE SCHEDULE: Always return all 5 days with all four slots (top_id, layer_id, bottom_id, footwear_id) filled with an id from the wardrobe. Never drop a day, return null, or invent an id because inventory is limited. If a category is depleted, restyle its best-matching piece with distinct complementary garments. Only if a category has zero pieces, set that slot to an empty string "" for every day and note the gap in the executiveBriefing.
${styleRules}

OUTPUT FORMAT:
- Return ONLY raw JSON matching this schema exactly: the same keys, all five day keys, no extra fields, no commentary.
${jsonRules}
- Keep the executiveBriefing to 2-3 concise sentences.
- Keep each day's rationale strictly under 2 sentences, covering only the style intent and any repeated pieces.
{
"executiveBriefing": "2-3 concise sentences on the weekly strategy, weather shifts, and activity adaptability.",
"days": {
"Monday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "Under 2 sentences: style intent and any repeated pieces." },
"Tuesday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "Under 2 sentences: style intent and any repeated pieces." },
"Wednesday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "Under 2 sentences: style intent and any repeated pieces." },
"Thursday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "Under 2 sentences: style intent and any repeated pieces." },
"Friday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "Under 2 sentences: style intent and any repeated pieces." }
}
}`;

    const dayPrompt = `You are Sloane, an elite executive wardrobe architect.
Re-curate ONLY ${target_day} of an existing 5-day workweek board for an executive in ${locationName || "Minnetonka, MN"}. The other days are locked and must not change.

STRICT RULES:
1. ROTATION AGAINST LOCKED DAYS: The payload includes "locked_outfits" (the garment ids already assigned to the other days) and "inventory" (distinct pieces per category).
- Top: Must not be any top_id in locked_outfits. Only if inventory.Top is fewer than 5 may you reuse a locked top, and never one worn on a day adjacent to ${target_day}.
- Layer, Bottom, Footwear: Prefer pieces not in locked_outfits. Only if no suitable unused piece exists, re-style a versatile staple, provided it appears on at most 1 locked day and that day is not adjacent to ${target_day}.
- If a piece repeats, say so in the rationale.
2. HERO ANCHOR INTEGRITY: If the anchor's day is ${target_day}, you must use the anchor piece in its category. Otherwise never use the anchor piece.
3. COMPLETE OUTFIT: Fill all four slots with ids from the wardrobe. Never return null or invent an id. Only if a category has zero pieces, use an empty string "".
4. DIFFERENTIATION FROM PREVIOUS OUTFIT: The user is changing the activity or requesting a re-roll. You MUST select an outfit distinct from previous_outfit, adapting formality and comfort strictly to the new activity (e.g., Work From Home demands relaxed knits, casual bottoms, and sneakers rather than tailored trousers, blazers, or dress shoes). Replace every slot for which a suitable alternative exists; keep a previous piece only when its category has no other usable option.
${styleRules.replace("4. ADAPTIVE", "5. ADAPTIVE").replace("5. EXECUTIVE", "6. EXECUTIVE")}

OUTPUT FORMAT:
- Return ONLY raw JSON matching this schema exactly, with no extra fields and no commentary.
${jsonRules}
- The rationale is exactly 1 concise sentence on the style intent and any repeated pieces.
{
"day": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence." }
}`;

    const systemPrompt = isSingleDay ? dayPrompt : weekPrompt;

    const userPayload = JSON.stringify(isSingleDay
      ? {
          location: locationName || "Minnetonka, MN",
          wardrobe: catalogSummary,
          inventory,
          anchor: heroAnchor || null,
          target_day,
          schedule: dailySchedules?.[target_day] || null,
          locked_outfits: locked_outfits || {},
          previous_outfit: previous_outfit || null
        }
      : {
          location: locationName || "Minnetonka, MN",
          wardrobe: catalogSummary,
          inventory,
          anchor: heroAnchor || null,
          dailySchedules: dailySchedules || null
        });

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: activeModel,
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPayload }]
      })
    });

    const anthropicData = await anthropicRes.json();

    if (anthropicData.error) {
      return new Response(JSON.stringify({ error: `[${activeModel}] ${anthropicData.error.message}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const textBlocks = anthropicData.content?.filter((b: any) => b.type === "text") || [];
    const rawText = textBlocks.map((b: any) => b.text).join("").trim();

    if (!rawText) {
      return new Response(JSON.stringify({ error: "Empty response from curation model" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (anthropicData.stop_reason === "max_tokens") {
      return new Response(JSON.stringify({ error: "Curation response was truncated (max_tokens reached)" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const curatedPlan = extractJson(rawText);

    if (isSingleDay) {
      const day = curatedPlan.day;
      const validIds = new Set(catalogSummary.map((g: any) => g.id));
      const slots = ["top_id", "layer_id", "bottom_id", "footwear_id"];
      if (!day || slots.some((s) => day[s] !== "" && !validIds.has(day[s]))) {
        return new Response(JSON.stringify({ error: `Re-curation for ${target_day} returned an invalid outfit` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      // Reject an unchanged outfit unless the wardrobe offers no alternative in any slot
      const slotCategories = ["Top", "Layer", "Bottom", "Footwear"] as const;
      const isUnchanged = previous_outfit && slots.every((s) => day[s] === previous_outfit[s]);
      const hasAlternative = slotCategories.some((c) => inventory[c] > 1);
      if (isUnchanged && hasAlternative) {
        return new Response(JSON.stringify({ error: `Re-curation for ${target_day} returned the same outfit; tap ↻ to try again` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ target_day, day }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify(curatedPlan), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});